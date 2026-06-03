# V-Engine Architecture

**Source of truth for system structure.** When this doc disagrees with the code, the code wins; open a deviation in `notes/SELF-HEALING.md`.

**Audience:** engineers extending the engine (adding a command, swapping the runtime, integrating with an external auth provider).

---

## 1. One-paragraph model

The V-Engine is a long-running Node.js process that exposes an HTTP+SSE API for creating browser sessions and driving them with a typed command set. Each session is a Playwright `BrowserContext` plus a `Page`, scoped to a runtime grant and a `userId`/`orgId`. Commands mutate the page (navigate, click, type, etc.); reads return context (URL, title, AX tree, console, network). The action log records every command for replay/audit. Webhooks fire on `session.created`, `session.closed`, `command.completed`, `session.evicted`. A static-asset handler serves `client/index.html` at `GET /` for an operator UI.

## 2. Top-level layout

```
v-engine-v13/
├── src/
│   ├── cli.ts                          # Entry point: `node dist/src/cli.js serve`
│   ├── server/                         # HTTP+SSE surface (18 files)
│   │   ├── local-server.ts             # main request handler, ~800 lines
│   │   ├── service.ts                  # session manager + command dispatcher (~1900 lines)
│   │   ├── runtime-grant.ts            # HMAC grant minter + verifier
│   │   ├── daemon-instance.ts          # persistent daemon identity
│   │   ├── commands-schema.ts          # JSON Schema dump for /api/commands
│   │   ├── model-guard.ts              # LLM output safety (Wave 4)
│   │   ├── takeover-config.ts          # CDP takeover capabilities
│   │   ├── webhooks.ts                 # HMAC-signed outbound events
│   │   ├── structured-logger.ts        # JSON log lines
│   │   ├── metrics.ts                  # Prometheus counters/gauges
│   │   ├── request-context.ts          # request-id + W3C traceparent
│   │   ├── feature-flags.ts            # OMNI_FEATURE_* reader
│   │   ├── tenant-scoping.ts           # cross-session orgId guard
│   │   ├── parallel-cap.ts             # OMNI_MAX_PARALLEL_SESSIONS eviction
│   │   ├── auth-rate-limit.ts          # 401/429 sliding window
│   │   ├── tls-bootstrap.ts            # OMNI_TLS_CERT/KEY listener
│   │   ├── omni-errors.ts              # OmniError hierarchy
│   │   └── auto-pair.ts                # cloud pairing bootstrap
│   ├── runtime/                        # Playwright + browser (26 files)
│   │   ├── omni-core-clone.ts          # BrowserContext lifecycle (~92KB)
│   │   ├── local-computer.ts           # ComputerAction executor (24 types)
│   │   ├── omni-session-manager.ts     # session CRUD + per-session context
│   │   ├── session-telemetry.ts        # console + network ring buffers
│   │   ├── omni-planner.ts             # Plan → Observe → Execute → Verify
│   │   ├── omni-ax-observer.ts         # accessibility-tree distiller
│   │   ├── omni-checkpoint.ts          # mission checkpoints
│   │   ├── stealth.ts                  # STEALTH_LEVEL anti-bot patches
│   │   ├── captcha-solver.ts           # detect + 2captcha integration
│   │   ├── native-input.ts             # desktop input via nut.js
│   │   ├── proof-capture.ts            # auto-screenshots on navigate
│   │   ├── session-persistence.ts      # persistent session storage
│   │   ├── rate-limiter.ts             # per-agent/per-session RPM
│   │   ├── action-log.ts               # bounded per-session command history
│   │   └── vault.ts                    # per-session encrypted vault
│   ├── security/                       # trade-secret guard, etc.
│   ├── utils/                          # paths, env readers, formatters
│   ├── persistence/                    # durable session storage backends
│   └── types/                          # shared type aliases
├── tests/                              # 32 smoke tests (source-regex + 1 runtime)
├── scripts/                            # mint-grant.ts, local-smoke.ts, etc.
├── client/                             # static UI (single index.html)
├── docs/                               # this file + operator cookbook + launch procedure
├── notes/                              # SELF-HEALING.md, wave journals
└── dist/                               # tsc output (build:server → dist/src/)
```

## 3. Request lifecycle

```
HTTP request
  ↓
local-server.ts (port $PORT, default 4011)
  ├─ /livez, /readyz, /healthz           # K8s probes, scope-free
  ├─ /metrics                              # Prometheus, opt-out via OMNI_METRICS_DISABLED
  ├─ /api/runtime/attach (POST)            # verify grant, return claims
  ├─ /api/whoami (GET)                     # echo grant claims
  ├─ /api/features (GET)                   # list OMNI_FEATURE_* state
  ├─ /api/commands (GET)                   # JSON Schema of all commands
  ├─ /api/sessions (POST)                  # create — service.createSession
  ├─ /api/sessions (GET)                   # list (per orgId/userId)
  ├─ /api/sessions/{id}/command (POST)     # executeCommand → switch on command.type
  ├─ /api/sessions/{id}/events (GET)       # SSE stream (text/event-stream)
  ├─ /api/sessions/{id}/context (GET)      # page state snapshot
  ├─ /api/sessions/{id}/console (GET)      # captured console ring buffer
  ├─ /api/sessions/{id}/network (GET)      # captured network ring buffer
  ├─ /api/sessions/{id}/screenshot (POST)  # capture + persist PNG
  ├─ /api/sessions/{id}/screenshots (GET)  # screenshot timeline
  ├─ /api/sessions/{id}/action-log (GET)   # paginated command history
  ├─ /api/sessions/{id}/artifacts (GET)    # all artifacts (incl. recordings)
  ├─ /api/sessions/{id}/artifacts/{aid} (GET)  # single artifact
  └─ serveClientAsset()                    # GET /, /assets/*, etc. (if !DISABLE_CLIENT_ASSETS)
```

Every `/api/*` route (except `/api/whoami`, `/api/features`, `/api/commands`) goes through `verifyRequestGrant` which:
1. Parses the `Authorization: Bearer <token>` header (or `?token=` query param)
2. Verifies the HMAC-SHA256 signature against `OMNI_DASHBOARD_JWT_SECRET`
3. Checks the `daemonInstanceId` claim matches the server's
4. Checks `exp` is in the future
5. Checks the requested scope is in the grant's `scopes` array

## 4. Command dispatch (the 33 commands)

`service.ts:executeCommand` switches on `command.type`:

```
Original 10          High-level 14                AI helpers 6        CAPTCHA 3
─────────────────    ───────────────────────      ──────────────────   ─────────────────────
navigate             right_click                   plan                detect_captcha
click                double_click                  execute_plan        wait_for_human
type                 hover                         next_step           navigate_with_fallback
screenshot           shortcut                      describe_page
status               drag                          find
pause                scroll                        wait_for
resume               file_upload
computer             file_download
directive            screenshot_element
assistant_reply      fill_form
                     scroll_until
                     enter_frame
                     exit_frame
                     shadow_click

Plus (added Phase 1):
close                ← new, see SELF-HEALING.md H-02
```

Each command routes to a private handler in `service.ts`. The `close` command (new in this session) calls a private `closeSessionInternal()` that delegates to the existing `closeSession()` and returns `{ok, sessionId, closed: true, reason}`.

Unknown command types and missing-required-field errors now throw typed `OmniValidationError` (HTTP 400) instead of plain `Error` (HTTP 500). See SELF-HEALING.md H-02.

## 5. Session lifecycle

```
POST /api/sessions
  ↓
service.createSession(input)
  ├─ Mint sessionId (or use input.sessionId)
  ├─ checkBudget against input.creditBudget
  ├─ OmniSessionManager.createSession(...)
  │   ├─ mergeBrowserContextOptions(input + OMNI_* env defaults + stealth defaults)
  │   ├─ browser.newContext({...merged})
  │   ├─ context.newPage()
  │   ├─ attachTelemetryListeners(page, sessionId)  ← Wave 2 Task 10
  │   └─ if STEALTH_LEVEL=aggressive → context.addInitScript(...)
  ├─ Sync snapshot to disk (if persistent=true)
  ├─ emitWebhookEvent("session.created", ...)
  └─ Return 201 with session payload

POST /api/sessions/{id}/command
  ↓
service.executeCommand(sessionId, command, ctx)
  ├─ requireSession(sessionId) → throw OmniNotFoundError if unknown
  ├─ rateLimiter.consumeAgent(agentId) → throw OmniRateLimitError on miss
  ├─ rateLimiter.consumeSession(sessionId) → throw OmniRateLimitError on miss
  ├─ checkBudget → throw OmniValidationError("budget exceeded") on miss
  ├─ switch (command.type) → handler
  ├─ record.commandCount += 1
  ├─ record.actionLog.unshift({...})
  ├─ syncSessionSnapshot(record, status)
  └─ Return 200 with {ok, result: {...}}

POST /api/sessions/{id}/command { type: "close" }
  ↓
service.closeSessionInternal(record, reason)
  ├─ service.closeSession(sessionId)
  │   ├─ emit("session.closing")
  │   ├─ syncSessionSnapshot(record, "closed", runtimeStatus)
  │   ├─ syncArtifacts(record)
  │   ├─ sessions.delete(sessionId)
  │   ├─ record.core.close()    ← Playwright context.close()
  │   ├─ record.sessionManager.dispose()
  │   └─ emitWebhookEvent("session.closed", ...)
  └─ Return 200 with {ok, closed: true, reason}
```

## 6. Computer actions (the 24 low-level types)

`local-computer.ts:execute()` handles 24 `ComputerAction` types. They split into two paths:

**Desktop-level** (8 types — route through `NativeInputAdapter`, requires `OMNI_TAKEOVER_MODES` containing `local_computer`):
`move`, `click` (coords), `double_click`, `right_click`, `shortcut`, `drag`, `scroll` (coords + deltaY), `hover`, `clipboard_read`, `clipboard_write`, `key`, `wait`, `screenshot`, `done`, `confirm_action`, `type` (coords).

**Page-DOM** (routed through Playwright when a page is attached; 7 types):
`screenshot_element`, `file_upload`, `file_download`, `fill_form`, `scroll_until`, `enter_frame`, `exit_frame`, `shadow_pierce`.

A page-DOM action without an attached page returns `{ok: false, blockedReason: "no_page"}` (fail-closed) rather than throwing.

The `handleComputer` dispatch in `service.ts` runs every high-level command (hover, right_click, double_click, drag, scroll, etc.) through `handleComputer` so the capability gate, credential gate, irreversible-confirmation, and page-required check apply uniformly.

## 7. Telemetry (Wave 2 Task 10)

`session-telemetry.ts:SessionTelemetryStore` keeps two ring buffers per session:
- `console`: page.on("console", ...) → `{ts, type, text, location}`
- `network`: page.on("request"|"response"|"requestfailed", ...) → `{ts, kind, method, url, status, durationMs}`

Bounded by `OMNI_TELEMETRY_BUFFER_SIZE` (default 1000, hard cap 10_000). Newest-first.

`attachTelemetryListeners(page, sessionId)` is called from BOTH `context.on("page", ...)` paths in `omni-session-manager.ts` (the default `newContext` path and the persistent-CDP `newPageOnPersistentContext` path).

## 8. Stealth (Wave 2 Task 7)

`stealth.ts:readStealthLevel()` reads `STEALTH_LEVEL` env:
- `off` (default) → no patches
- `basic` → randomized UA from 10-UA pool, randomized viewport from 5-viewport pool, randomized locale from 8-locale pool, randomized timezone from 7-timezone pool
- `aggressive` → also `context.addInitScript` patches:
  - `navigator.webdriver` → `false`
  - `navigator.languages` → `[primary, "en-US", "en"]`
  - `navigator.plugins` → non-empty stub
  - `window.chrome.runtime` → stub
  - `permissions.query` for `notifications` → returns `Notification.permission`

Per-session context options (viewport, userAgent, etc.) win over stealth defaults via spread order. See `mergeBrowserContextOptions()` in `omni-session-manager.ts`.

## 9. CAPTCHA (Wave 2 Task 6)

`captcha-solver.ts:detectCaptcha()` is a 3-pronged probe:
1. URL match (recaptcha/hcaptcha substring)
2. DOM iframe + class markers (reCAPTCHA `iframe[src*=recaptcha]`, hCaptcha `iframe[src*=hcaptcha]`, Cloudflare `div.cf-challenge`)
3. Body text patterns ("I'm not a robot", "verify you are human", Cloudflare copy)

`solveCaptcha()` is opt-in via `CAPTCHA_SOLVER_API_KEY` + `CAPTCHA_SOLVER_PROVIDER=2captcha`. v0.3 returns a synthetic token from the sitekey (the real 2captcha call is wired but the v0.3 skeleton returns a stub so the smoke path proves the wire-up end-to-end without a paid API key).

`waitForHuman()` reuses `pauseMission` from Wave 1 and emits a `captcha.handoff` event for the cockpit. Default timeout 300s, max 3600s.

`navigateWithFallback` tries the primary URL, sleeps 250ms, calls `detectCaptcha`. If detected AND solver configured AND solves → returns `{detected, solver}`. If detected but no solver / solve failed → navigates to fallback URL.

## 10. Webhooks

`webhooks.ts:emitWebhookEvent(event, sessionId, orgId, userId, data)` fires on:
- `session.created`
- `session.closed`
- `command.completed`
- `session.evicted` (parallel cap)

Configuration: `OMNI_WEBHOOK_URL` + `OMNI_WEBHOOK_SECRET` (HMAC-SHA256). Headers: `x-omni-event`, `x-omni-event-id`, `x-omni-timestamp`, `x-omni-signature: sha256=...`. Retries with exponential backoff (`Math.pow(2, attempt-1) * OMNI_WEBHOOK_RETRY_BASE_MS`), timeout per attempt (`OMNI_WEBHOOK_TIMEOUT_MS`), max attempts (`OMNI_WEBHOOK_MAX_RETRIES`). Fire-and-forget via `void deliverWithRetry(...)`.

## 11. Vault

`vault.ts` provides per-session encrypted storage. Encryption: AES-256-GCM with a key derived from `OMNI_PAYLOAD_ENCRYPTION_KEY` (32+ char secret) + a per-entry salt. Key versioning via `OMNI_PAYLOAD_ENCRYPTION_KEY_VERSION` (default `v1`).

Endpoints: `GET/POST /api/vault/:service` (list/save), `GET /api/vault/:service/load` (POST). Scopes: `vault.read` / `vault.write`.

## 12. Errors

`omni-errors.ts` defines a hierarchy. Every typed error carries `httpStatus`, `code`, `hint`, optional `retryAfterMs`, optional `details`. Server maps them to their declared `httpStatus`. The `error.typed` SSE event fires whenever one is thrown so the cockpit can render it.

| Class | httpStatus | When |
|---|---|---|
| `OmniValidationError` | 400 | bad payload, missing field, unknown command |
| `OmniAuthError` | 401 | bad/missing grant, expired token |
| `OmniNotFoundError` | 404 | unknown session, no matches |
| `OmniCapabilityError` | 403 | grant lacks required scope |
| `OmniRequestTimeoutError` | 504 | wait_for timeout, request body timeout |
| `OmniRateLimitError` | 429 | agent or session rate limit hit |
| `OmniBudgetError` | 402 | creditBudget exhausted |
| `OmniBodyTooLargeError` | 413 | request body > OMNI_BODY_SIZE_LIMIT |
| `OmniTlsError` | 525 | TLS handshake failure |

## 13. Concurrency and eviction

`OMNI_MAX_PARALLEL_SESSIONS` (default 50) is the global cap. When exceeded, the oldest session is evicted:

```
parallel-cap.ts:evictOldestIfNeeded()
  ├─ find oldest session by lastActiveAt
  ├─ emit("session.evicted") on that session
  └─ closeSession(oldest.sessionId)
```

Per-session rate limits: `OMNI_AGENT_RPM` (default 30/min/agent) + `OMNI_BURST_RPS` (default 10/s/agent) + `OMNI_SESSION_RPM` (default 60/min/session). Auth-fail rate limit: `OMNI_AUTH_FAIL_LIMIT` (10) within `OMNI_AUTH_FAIL_WINDOW_MS` (60s) per (ip, token-prefix) before 429.

## 14. Static asset serving

`local-server.ts:serveClientAsset(pathname)` looks for `dist/client/{pathname}`. If found, serves it with the right `content-type`. If not found, falls back to `dist/client/index.html` (SPA fallback). If `dist/client/index.html` doesn't exist, returns 404.

Gated by `OMNI_DISABLE_CLIENT_ASSETS=1` (off by default; set this in cloud deployments where the operator UI is served by a different host).

## 15. Where to extend

| Adding... | Start here |
|---|---|
| A new command | `src/server/service.ts` — add to `SessionCommand` union, dispatch in `executeCommand`, add case to `describeCommandForActionLog`, add to `commands-schema.ts` (the source of truth for the schema) |
| A new HTTP endpoint | `src/server/local-server.ts` — add a `method === "X" && url.pathname === "/api/..."` block. The static-asset fallback at the bottom catches non-`/api/*` paths. |
| A new env var | `local-server.ts` for `OMNI_*` reads (top of file) + add to `V-ENGINE.md` env-vars table |
| A new ComputerAction | `src/runtime/local-computer.ts` — extend the `ComputerAction` union, add a case in `execute()` or `executePageDom()` |
| A new SSE event | `src/server/service.ts` — call `this.emit(record, "your.event", {...})` from the right hook |
| A new typed error | `src/server/omni-errors.ts` — extend the `OmniError` class with new subclass + httpStatus/code/hint |
| A new browser capability | `src/runtime/omni-session-manager.ts` — extend `mergeBrowserContextOptions()` to merge the new field |
| A new webhook event type | `src/server/webhooks.ts` — add the string to the `KNOWN_EVENTS` set |
| A new endpoint for the operator UI | `client/index.html` — vanilla JS, no build step |

## 16. Known gaps (deferred)

These are documented but not implemented in v0.3. See `docs/PLAN-ENGINE-HARDENING.md` for the wave-3+ plan:

- Wave 3 — Persistence & Multi-Engine: real session durability, multi-engine federation
- Wave 4 — Security Hardening: mTLS, token rotation, secret scanning
- Wave 5 — Performance & Polish: streaming responses, large-DOM optimization, frustration handoff
- Per-orgId instead of per-userId in screenshot paths
- Visible-Chrome error message when `OMNI_ALLOW_HEADLESS_FALLBACK=0` and no display
- `describe_page` returning a flat shape (currently returns the same context payload)
- Real 2captcha call (currently returns a synthetic token from the sitekey)
- `frustration_handoff` SSE event (deferred from Wave 1)
