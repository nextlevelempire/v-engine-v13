# V-ENGINE.md — V-Engine API Reference (v0.3)

> The V-Engine is a standalone browser-automation runtime. It exposes an HTTP+SSE API for creating browser sessions, driving them with mouse/keyboard commands, observing them via screenshots, and persisting state. v0.3 is **production-grade** — it is what the v0.1 source grew into after Wave 1 (foundation, reliability, observability) and Wave 2 (AI capability, Commander's vision).

**This document is the canonical field reference.** When the README and this document disagree, **this document wins**. When source code and this document disagree, fix this document (and open a deviation in `notes/SELF-HEALING.md`).

**Wave status:** Wave 1 (24 findings) — SHIPPED · Wave 2 (24 findings) — SHIPPED · Wave 3 (persistence + multi-engine) — PLANNED · Wave 4 (security hardening) — PLANNED · Wave 5 (performance + polish) — PLANNED.

---

## 1. Field Reference

All session identifiers use the field name **`sessionId`**. The v0.1 README occasionally referred to the field as `id`; that was wrong. Every API request body, response body, SSE event, and log line uses `sessionId`.

| Field | Type | Where | Description |
|---|---|---|---|
| `sessionId` | string (UUID) | request, response, SSE | The unique session identifier. |
| `orgId` | string | request, response | The organization the session belongs to. Required when scopes are scoped to an org. |
| `userId` | string | request, response | The user/agent who owns the session. |
| `agentId` | string | request, response | The agent id (typically same as `userId`). |
| `creditBudget` | integer | request, response | Optional integer cap on session resource consumption. Default 0. |
| `objective` | string | request | Optional human-readable description of what the session is for. |
| `policyVersion` | string | request | Optional policy version override. |
| `operatorSessionId` | integer | request | Optional correlation id for operator-mode sessions. |
| `persistent` | boolean | request | If true, the session is persisted across restarts. Default false. |
| `type` | string | SSE | The event type, e.g. `checkpoint.created`, `execution`, `observation.captured`. |
| `data` | object | SSE | The event payload, type-specific. |
| `eventId` | string | SSE | Unique event id. |
| `timestamp` | string (ISO 8601) | SSE, status | When the event was emitted or the status was sampled. |

> **Breaking change from v0.1:** If you were following the v0.1 README, you were looking for `id`. Use `sessionId` instead.

---

## 2. Authentication

All requests (including `/api/health`) require a runtime grant. Grant format is `header.payload.signature` (base64url-encoded, HMAC-SHA256).

**Sending a grant:**
```http
Authorization: Bearer <token>
```
or
```http
GET /api/sessions?token=<token>
```

**Required claims:**
- `daemonInstanceId` — must match the server's instance id
- `exp` — must be in the future
- `iss`, `orgId`, `sub`, `scopes` — see `src/server/runtime-grant.ts` for the full schema

**Default scopes by endpoint:**
| Endpoint | Method | Required scope |
|---|---|---|
| `/api/health` | GET | (none — scope-free preflight) |
| `/api/runtime/attach` | POST | `runtime.attach` |
| `/api/whoami` | GET | (none — returns grant claims, useful for debugging; aliases `orgId` as `tenantId` in response) |
| `/api/features` | GET | (none — lists all OMNI_FEATURE_* flags and their enabled state) |
| `/api/sessions` | GET | `sessions.create` |
| `/api/sessions` | POST | `sessions.create` |
| `/api/sessions/:sessionId/command` | POST | `sessions.command` |
| `/api/sessions/:sessionId/events` | GET | `sessions.read` |
| `/api/sessions/:sessionId` | GET | `sessions.read` |
| `/api/sessions/:sessionId/screenshot` | POST | `sessions.command` (returns JSON `{ path, label, sessionId }`; PNG is on disk at `path`) |
| `/api/sessions/:sessionId/artifacts` | GET | `sessions.read` |
| `/api/sessions/:sessionId/artifacts/:artifactId` | GET | `sessions.read` |
| `/api/sessions/:sessionId/action-log` | GET | `sessions.command` (paginated: `?limit=N&before=ISO_TS`) |
| `/api/sessions/:sessionId/screenshots` | GET | `artifacts.read` (screenshot-only timeline) |
| `/api/sessions/:sessionId/context` | GET | `sessions.command` (page state: URL, title, AX tree summary, axTreeHash, auth/captcha hints) |
| `/api/sessions/:sessionId/console` | GET | `sessions.command` (ring buffer of `console` events; `?limit=N`, default 200, max 1000) |
| `/api/sessions/:sessionId/network` | GET | `sessions.command` (ring buffer of `request`/`response`/`requestfailed` events; `?limit=N`, default 200, max 1000) |
| `/api/commands` | GET | (none — JSON Schema dump of all 33 commands for client introspection) |
| `/api/vault/:service` | GET | `vault.read` |
| `/api/vault/:service/load` | POST | `vault.read` |
| `/api/vault/:service/save` | POST | `vault.write` |

---

## 3. Endpoints

### GET /api/health
**Scope-free.** Used as a preflight by control planes.
```json
{
  "ok": true,
  "transport": "http+sse",
  "daemonInstanceId": "...",
  "version": "4.0.0",
  "capabilities": ["browser"]
}
```

### POST /api/sessions
Create a new session. Requires `sessions.create` scope.
```json
// Request — all fields optional except none required
{
  "sessionId": "optional-pre-generated-uuid",
  "objective": "Buy concert tickets",
  "creditBudget": 100,
  "persistent": false,

  // Wave 2 — Browser context options (override global env var defaults)
  "viewport": { "width": 1280, "height": 720 },
  "userAgent": "Mozilla/5.0 ...",
  "device": "iPhone 12",
  "locale": "en-US",
  "timezoneId": "America/Los_Angeles",
  "geolocation": { "latitude": 37.7749, "longitude": -122.4194 },
  "permissions": ["geolocation", "microphone"],
  "colorScheme": "dark"
}

// 201 Response
{
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "launching",
  "createdAt": "2026-06-02T13:55:00.000Z",
  "objective": "Buy concert tickets",
  "creditBudget": 100,
  "remainingBudget": 100,
  "userId": "...",
  "orgId": "..."
}
```

### POST /api/sessions/:sessionId/command
Send a command to a session.
```json
// Request
{
  "type": "navigate",
  "url": "https://example.com"
}

// Response
{
  "ok": true,
  "result": { "url": "https://example.com", "title": "Example" }
}
```

**Command types (v0.3):** 33 commands across 4 groups — 10 original (`navigate`, `click`, `type`, `screenshot`, `status`, `pause`, `resume`, `assistant_reply`, `directive`, `computer`), 14 high-level wrappers (`scroll`, `hover`, `right_click`, `double_click`, `shortcut`, `drag`, `file_upload`, `file_download`, `screenshot_element`, `fill_form`, `scroll_until`, `enter_frame`, `exit_frame`, `shadow_click`), 6 AI helpers (`plan`, `execute_plan`, `next_step`, `describe_page`, `find`, `wait_for`), and 3 CAPTCHA (`detect_captcha`, `wait_for_human`, `navigate_with_fallback`). Get the full JSON Schema (input/output shape, validation rules) from `GET /api/commands`.

### GET /api/sessions/:sessionId/events
Server-Sent Events stream. `event: <type>` / `data: <json>`. Includes `sessionId`, `eventId`, `timestamp`, `data` per event.

### GET /api/sessions/:sessionId
Returns current session state, including `status`, `lastActiveAt`, `commandCount`, `creditBudget`, `remainingBudget`, `actionLog` (recent entries), etc.

### POST /api/sessions/:sessionId/screenshot
Captures the current viewport. **POST** (not GET — this is a side-effecting action, scoped to `sessions.command`).
```json
// Request
{ "label": "after-login" }

// Response (200)
{
  "ok": true,
  "result": {
    "ok": true,
    "sessionId": "550e8400-e29b-41d4-a716-446655440000",
    "label": "after-login",
    "path": "/Users/.../browser-records/<orgId>/<sessionId>/screenshots/2026-06-03T05-04-12-345Z-after-login.png"
  }
}
```
The PNG is written to disk at `path`; read it from the filesystem (the engine does not return PNG bytes in-band). The `screenshots` timeline (`GET /api/sessions/:sessionId/screenshots`) and the `artifacts` list (`GET /api/sessions/:sessionId/artifacts`) both surface the captured frame.

### GET /api/sessions/:sessionId/context
Page state snapshot (URL, title, AX tree summary capped 2000 chars, axTreeHash, auth/captcha hints, runtime, capturedAt). Lighter than the `describe_page` command because it does not require a round-trip through the command queue.
```json
// Response (200)
{
  "sessionId": "...",
  "runtime": "local",
  "url": "https://example.com",
  "title": "Example",
  "axSummary": "... (2000 chars max) ...",
  "axTreeHash": "sha256:...",
  "authWallHint": "none",
  "captchaHint": "none",
  "capturedAt": "2026-06-03T05:04:12.345Z"
}
```

### GET /api/sessions/:sessionId/console
Ring buffer of captured browser console messages, newest first. `?limit=N` defaults to 200, max 1000. Buffer is bounded by `OMNI_TELEMETRY_BUFFER_SIZE` (default 1000, hard cap 10_000).
```json
// Response (200)
{
  "sessionId": "...",
  "count": 47,
  "total": 312,
  "entries": [
    { "ts": "2026-06-03T05:04:12.345Z", "type": "log", "text": "...", "location": { "url": "...", "lineNumber": 42 } }
  ]
}
```

### GET /api/sessions/:sessionId/network
Ring buffer of captured network events (`request`, `response`, `requestfailed`), newest first. Same `?limit=N` semantics as `/console`.
```json
// Response (200)
{
  "sessionId": "...",
  "count": 23,
  "total": 118,
  "entries": [
    { "ts": "2026-06-03T05:04:12.345Z", "kind": "response", "method": "GET", "url": "https://...", "status": 200, "durationMs": 142 }
  ]
}
```

### GET /api/commands
Read-only introspection of the API surface. Returns the JSON Schema (draft-07) for every command's input, plus the flat list of command names. **No auth required.**
```json
// Response (200)
{
  "commandNames": ["navigate", "click", "type", "..."],
  "count": 33,
  "schema": { "$schema": "http://json-schema.org/draft-07/schema#", "oneOf": [ ... ] }
}
```
Clients and dashboards should `GET /api/commands` at boot to validate their payloads rather than hand-rolling the schema.

### GET /api/sessions/:sessionId/artifacts
Lists saved artifacts (screenshots, recordings, logs).

### GET /api/sessions/:sessionId/artifacts/:artifactId
Returns a single artifact (binary or JSON depending on type).

### GET/POST /api/vault/:service
Per-session encrypted vault. See `docs/PLAN-ENGINE-HARDENING.md` for details.

---

## 4. Environment Variables

All env vars use the `OMNI_*` prefix. This is the V-Engine's own naming convention; do not change.

| Variable | Default | Description |
|---|---|---|
| `OMNI_PAYLOAD_ENCRYPTION_KEY` | (required in prod) | 32+ char secret for payload encryption |
| `OMNI_PAYLOAD_ENCRYPTION_KEY_VERSION` | `v1` | Key version tag |
| `OMNI_PORT` | `4011` | Local HTTP port |
| `OMNI_HOME` | `~/.omni-browser` | Storage root |
| `OMNI_ATTACH_TOKEN_TTL_MS` | `300000` | Attach-token lifetime |
| `OMNI_AGENT_RPM` | `30` | Per-agent requests/minute |
| `OMNI_BURST_RPS` | `10` | Short-burst requests/second |
| `OMNI_SESSION_RPM` | `60` | Per-session requests/minute |
| `OMNI_DASHBOARD_JWT_SECRET` | (dev fallback) | HMAC secret for runtime grants |
| `OMNI_ALLOW_HEADLESS_FALLBACK` | `0` | Allow headless if visible Chrome launch fails |
| `OMNI_LISTEN_HOST` | `127.0.0.1` | Bind address. Default loopback for safety. Set to `0.0.0.0` to expose. |
| `OMNI_MAX_PARALLEL_SESSIONS` | `50` | Global cap on concurrent sessions. Was `OMNI_MAX_SESSIONS=5` in v0.1. |
| `OMNI_BODY_SIZE_LIMIT` | `10485760` (10 MB) | Max JSON request body in bytes. Exceeding returns 413. |
| `OMNI_REQUEST_TIMEOUT_MS` | `60000` (60 s) | Hard timeout per HTTP request. Exceeding returns 504. |
| `OMNI_AUTH_FAIL_LIMIT` | `10` | Max auth failures per (ip, token-prefix) within window before 429. |
| `OMNI_AUTH_FAIL_WINDOW_MS` | `60000` (60 s) | Sliding window for the auth-fail counter. |
| `OMNI_CORS_ALLOWED_ORIGINS` | _(empty)_ | Comma-separated list of origins allowed to call the API. v0.3 defaults to empty (operator must set). Legacy alias: `OMNI_RUNTIME_ALLOWED_ORIGINS`. |
| `OMNI_ALLOW_LOOPBACK_CORS` | `0` | If `1`, allow `http://127.0.0.1` and `http://localhost` in CORS. Off by default. |
| `OMNI_TLS_CERT` | _(unset)_ | Path to PEM certificate file. With `OMNI_TLS_KEY`, binds HTTPS. |
| `OMNI_TLS_KEY` | _(unset)_ | Path to PEM private key file. With `OMNI_TLS_CERT`, binds HTTPS. |
| `OMNI_LOG_LEVEL` | `info` | One of `debug`, `info`, `warn`, `error`. Logs below this level are suppressed. |
| `OMNI_ACTION_LOG_MAX` | `10000` | Max actionLog entries kept per session. Older entries are dropped. |
| `OMNI_WEBHOOK_URL` | _(unset)_ | If set with `OMNI_WEBHOOK_SECRET`, runtime POSTs session/command events to this URL. |
| `OMNI_WEBHOOK_SECRET` | _(unset)_ | HMAC-SHA256 secret for signing webhook payloads (header `x-omni-signature: sha256=...`). |
| `OMNI_WEBHOOK_TIMEOUT_MS` | `5000` | Per-attempt delivery timeout. |
| `OMNI_WEBHOOK_MAX_RETRIES` | `3` | Max delivery retries (with exponential backoff). |
| `OMNI_WEBHOOK_RETRY_BASE_MS` | `500` | Base delay for retry backoff (doubled per attempt). |
| `OMNI_TENANT_SCOPING` | `off` | If `enforce`, runtime rejects requests where grant's orgId doesn't match the session's orgId on cross-session operations. |
| `OMNI_FEATURE_*` | _(unset)_ | Feature flag pattern: `OMNI_FEATURE_<NAME>=1` enables a flag. Read via `isFeatureEnabled("name")`. |
| `STEALTH_LEVEL` | `off` | Anti-bot stealth mode: `off` (default — no patches), `basic` (randomized UA/viewport/locale/timezone from per-session pools), `aggressive` (also `addInitScript` patches for `navigator.webdriver`, `navigator.languages`, `navigator.plugins`, `chrome.runtime`, `permissions.query`). Per-session context options (viewport/userAgent/etc.) win over stealth defaults. |
| `OMNI_VIEWPORT_WIDTH` / `OMNI_VIEWPORT_HEIGHT` | _(unset)_ | Global default viewport (e.g. `1280`, `720`). Per-session `viewport: { width, height }` in `POST /api/sessions` overrides. |
| `OMNI_USER_AGENT` | _(unset)_ | Global default user agent. Per-session `userAgent` overrides. |
| `OMNI_LOCALE` | _(unset)_ | Global default locale (e.g. `en-US`). Per-session `locale` overrides. |
| `OMNI_TIMEZONE` | _(unset)_ | Global default timezone (e.g. `America/Los_Angeles`). Per-session `timezoneId` overrides. |
| `OMNI_DEVICE` | _(unset)_ | Playwright device descriptor (e.g. `iPhone 12`, `Pixel 5`); per-session `device` overrides. When set, viewport/UA/locale/timezone defaults from the device are applied unless explicitly overridden. |
| `OMNI_COLOR_SCHEME` | _(unset)_ | Global default color scheme: `dark` / `light` / `no-preference`. Per-session `colorScheme` overrides. |
| `OMNI_GEOLOCATION` | _(unset)_ | Global default geolocation as `"lat,lon"` (e.g. `37.7749,-122.4194`). Per-session `geolocation: { latitude, longitude }` overrides. |
| `OMNI_TELEMETRY_BUFFER_SIZE` | `1000` | Max entries kept in the per-session console + network ring buffers. Hard cap 10_000. |
| `CAPTCHA_SOLVER_API_KEY` | _(unset)_ | API key for the configured CAPTCHA solver (v0.3 supports `2captcha`). If unset, `detect_captcha` returns detected but `solve` returns `{ solved: false, reason: "no_solver_key" }`; callers fall back to `wait_for_human` or `navigate_with_fallback`. |
| `CAPTCHA_SOLVER_PROVIDER` | `2captcha` | Solver provider. v0.3 supports `2captcha` only. |

> **v0.3 additions** (added in Wave 1): `OMNI_LISTEN_HOST`, `OMNI_MAX_PARALLEL_SESSIONS`, `OMNI_BODY_SIZE_LIMIT` (default 10485760 = 10 MB, returns 413), `OMNI_REQUEST_TIMEOUT_MS` (default 60000, returns 504), `OMNI_AUTH_FAIL_LIMIT` (default 10), `OMNI_AUTH_FAIL_WINDOW_MS` (default 60000), `OMNI_CORS_ALLOWED_ORIGINS`, `OMNI_ALLOW_LOOPBACK_CORS`, `/livez`+`/readyz`+`/healthz` probes, `OMNI_TLS_CERT`, `OMNI_TLS_KEY`, `OMNI_LOG_LEVEL` (default `info`), structured JSON logging via `log.info/warn/error` from `src/server/log.ts`, `OMNI_METRICS_DISABLED`, `/metrics` Prometheus endpoint with counters `omni_http_requests_total`, `omni_http_request_errors_total`, `omni_sessions_created_total`, `omni_sessions_evicted_total`, `omni_auth_failures_total`, `omni_body_too_large_total`, `omni_request_timeouts_total`, `omni_rate_limited_total` and gauge `omni_sessions_active`, request ID middleware + W3C `traceparent` propagation via `parseIncomingContext`/`mintRequestContext` in `src/server/request-context.ts` (echoed back on `x-omni-request-id` and `traceparent` response headers).

---

## 5. Error Response Shape

Errors are returned as JSON. The v0.1 ad-hoc error strings are gone; every error path in v0.3 emits a typed error with a stable shape:
```json
{
  "ok": false,
  "error": "human-readable message",
  "code": "OMNI_NOT_FOUND",
  "httpStatus": 404,
  "hint": "Check the sessionId — it must belong to your orgId",
  "retry_after_ms": null
}
```

See `src/server/omni-errors.ts` for the full class hierarchy (`OmniError` → `OmniValidationError` 400, `OmniAuthError` 401, `OmniNotFoundError` 404, `OmniRequestTimeoutError` 504, `OmniCapabilityError` 403, etc.). Each `OmniError` carries a stable `code`, a human `message`, an optional actionable `hint`, and an optional `retry_after_ms`. The server also emits an `error.typed` SSE event for cockpit consumption whenever a typed error fires.

---

## 6. SSE Event Types

`type` values include:
- `checkpoint.created` — session state was snapshotted
- `execution` — a command completed
- `handoff.requested` — session wants to handoff to a human
- `human_message` — a message from the human
- `mission_log` — a log entry
- `observation.captured` — a screenshot/observation was captured
- `plan.created` — a plan was generated
- `replay.bundle_created` — a replay bundle was saved
- `verification.result` — a verification step completed

Plus Wave 1 (shipped) additions: `session.evicted` (parallel cap fired), `error.typed` (typed error event with `{ code, message, hint, retry_after_ms }`).

Plus Wave 2 (shipped) additions: `captcha.detected` (CAPTCHA detection probe found a challenge), `captcha.handoff` (mission paused awaiting human to solve CAPTCHA), `plan.created` (AI helper `plan(goal)` materialized a plan_id), `plan.completed` (AI helper `execute_plan` finished; payload includes `success`, `stepsCompleted`, `stepsFailed`, `handoffTriggered`). `frustration_handoff` remains Wave 5.
