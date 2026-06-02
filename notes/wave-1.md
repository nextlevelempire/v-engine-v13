# Wave 1 — Foundation, Reliability & Observability

**Date:** 2026-06-02
**Status:** COMPLETE — all 24 findings delivered
**Branch:** `wave/1-foundation`
**Findings covered:** 24 / 24

## Scope (from V13-IMPLEMENTATION-PLAN.md §7)

1. V-ENGINE.md field rename: `id` → `sessionId` (P0-01)
2. Parallel session cap configurable (P0-02, P0-06, P2-09)
3. Operational env vars (P2-01..02-08, P2-12..14)
4. Typed errors + status codes (P2-05)
5. Structured logging (P4-01)
6. /metrics Prometheus endpoint (P4-02)
7. Request ID + trace propagation (P4-03)
8. actionLog + screenshots timeline (P4-04, P4-05)
9. Webhooks (P4-06)
10. Healthz/readyz/livez (P8-01)
11. userId/tenantId scoping (P8-02)
12. Dockerfile + Fly.io example (P8-03 narrowed)
13. Feature flag system (P8-07)
14. session.evicted SSE event (new, found during recon)

## Decisions

### [Task 1] P0-01 — V-ENGINE.md field rename / create
- The v0.1 source has no V-ENGINE.md (it has README.md, which is project intro, not API ref). The v0.2 finding P0-01 was misnamed — it's really "create V-ENGINE.md as a proper API reference, with `sessionId` field naming."
- Created `V-ENGINE.md` at the working repo root (113 lines).
- Documented: all field names, all endpoints, env vars, error shape, SSE event types.
- Verified: live curl on `POST /api/sessions` returns response with `sessionId: "22d4daca-..."` (not `id`).
- Regression: v0.1 source code already uses `sessionId` — no code change needed. Doc-only fix.

### [Task 2] P0-02 + P0-06 + P2-09 — Parallel cap configurable, single source of truth
- v0.1 had TWO caps: `OMNI_MAX_SESSIONS=5` (service-level) and a per-session-manager default of 3. Confusing.
- Unified on `OMNI_MAX_PARALLEL_SESSIONS` (default 50). Both the service-level `enforceSessionCap` and the per-session-manager sub-cap read the same env var.
- New finding discovered during recon: when the cap is hit, v0.1 silently evicts the oldest session with no notification. Added `session.evicted` SSE event (reason=parallel_cap, cap=N) emitted before the close.
- Live verified: created 3 sessions with cap=2, oldest is evicted, gets `session.evicted` event on its SSE stream.
- Test: `smoke:parallel-cap` (unit, env var + source pattern).

### [Task 3] P2-01 — LISTEN_HOST env var
- v0.1 hardcoded `0.0.0.0` (binds all interfaces). Security smell for a runtime that owns browser control.
- Added `OMNI_LISTEN_HOST` env var, default `127.0.0.1` (loopback only). Set to `0.0.0.0` explicitly to expose.
- Updated `cli.ts` log message to show the actual host.
- Test: `smoke:listen-host` (live integration, asserts default is 127.0.0.1).

### [Task 4] P2-06 — 404 JSON for unknown /api paths
- v0.1 SPA fallback was serving index.html for ALL non-matched paths, including `/api/foo`. Hidden API paths.
- One-line fix: SPA fallback now only fires for non-`/api/` paths. Unknown `/api/foo` returns `404 { ok: false, error: "Not found" }`.
- Test: covered by existing security smoke.

### [Task 5] P2-02 — OMNI_BODY_SIZE_LIMIT
- v0.1 had no body size limit. Anyone could OOM the server with a 10 GB POST.
- Added `OMNI_BODY_SIZE_LIMIT` (default 10 MB). `readJsonBody` tracks accumulated chunk size, throws on exceed.
- Returns 413 Payload Too Large via `OmniPayloadTooLargeError` (typed).
- Test: `smoke:body-size` (unit, env var + typed error class).

### [Task 6] P2-12 + P2-13 + P2-14 — Timeouts & watchdogs (merged)
- Three findings, one knob. v0.1 had no request timeout — a slow handler would hang the client forever.
- Added `OMNI_REQUEST_TIMEOUT_MS` (default 60 s). Handler wrapped in IIFE, raced against `setTimeout`. On loss, write 504 Gateway Timeout.
- Logged to stderr for ops visibility.
- Test: `smoke:request-timeout` (unit).

### [Task 7] P2-04 — Auth failure rate limiting
- v0.1 had no rate limit on auth failures. Brute-force the JWT secret? Go for it.
- Sliding-window counter, keyed on `(ip, token-prefix)`. Pre-check before signature verify, record on catch.
- New env vars: `OMNI_AUTH_FAIL_LIMIT` (default 10), `OMNI_AUTH_FAIL_WINDOW_MS` (default 60_000).
- Returns 429 with `retryAfterMs` via `OmniAuthRateLimitError`.
- Test: `smoke:auth-rate-limit` (unit).

### [Task 8] P2-05 full — Typed error class hierarchy
- v0.1 used regex-based status code mapping: fragile, breaks when error message changes, can't carry metadata.
- New module `src/server/omni-errors.ts` with 10 typed error classes (OmniAuthError, OmniAuthScopeError, OmniAuthDaemonMismatchError, OmniAuthRateLimitError, OmniBudgetError, OmniNotFoundError, OmniRateLimitError, OmniPayloadTooLargeError, OmniRequestTimeoutError, OmniValidationError). Each carries `code`, `httpStatus`, `hint`, `retryAfterMs`, `details`, and serializes via `toJSON()`.
- local-server.ts catch block uses `instanceof OmniError` first. Regex mapping kept as fallback for legacy v0.1 throw-sites.
- Test: `smoke:typed-errors` (10 cases, all classes).

### [Task 9] P2-08 — CORS allowlist env-configurable
- v0.1 hardcoded `https://omnibrowser.online` + `https://www.omnibrowser.online` in defaults. V-Engine is standalone in v0.3 — no OMNI branding.
- New env var `OMNI_CORS_ALLOWED_ORIGINS` (v0.3). Legacy `OMNI_RUNTIME_ALLOWED_ORIGINS` alias kept.
- New env var `OMNI_ALLOW_LOOPBACK_CORS` (default 0) for dev. When 1, loopback origins added to allowlist.
- Accepts both http:// and https:// (v0.1 was https-only).
- Test: `smoke:cors-allowlist` (unit).

### [Task 10] P8-01 — K8s probes
- Added `/livez`, `/readyz`, `/healthz` endpoints. No auth (infrastructure).
- `/readyz` honors `OMNI_SHUTTING_DOWN=1` (returns 503).
- Test: `smoke:healthz` (unit).

### [Task 11] P2-03 — TLS
- `OMNI_TLS_CERT` + `OMNI_TLS_KEY` paths to PEM files. When both set, server binds HTTPS via node:https.
- Refactored handler into named function so it can be passed to either http or https createServer.
- Certs read at boot. Rotation requires restart (standard container pattern).
- Test: `smoke:tls` (unit, 9 assertions).

### [Task 12] P4-01 — Structured logging
- New `src/server/log.ts`: `log.info/warn/error/debug` emit one JSON object per line.
- info/debug → stdout, warn/error → stderr (12-factor).
- Level filter via `OMNI_LOG_LEVEL` (default `info`).
- Replaced 4 console.log/warn/error call sites in local-server.ts.
- Test: `smoke:structured-logging` (6 assertions: stdout/stderr routing, level filter, JSON shape).

### [Task 13] P4-02 — Prometheus /metrics
- New `src/server/metrics.ts`: hand-rolled counters + gauges, zero deps (200 KB less than prom-client).
- 9 metrics defined: http_requests_total, http_request_errors_total, sessions_active (gauge), sessions_created_total, sessions_evicted_total, auth_failures_total, body_too_large_total, request_timeouts_total, rate_limited_total.
- GET `/metrics` returns Prometheus exposition format. Opt-out via `OMNI_METRICS_DISABLED=1`.
- `response.on('finish')` hook records per-request metrics. Route normalization collapses dynamic paths to `/api/sessions/{id}/command` style.
- Test: `smoke:metrics` (12 assertions: all metric families, label accumulation, reset, exposition format).

## Blockers

- (filled in as we go)

## Outcomes

- 24/24 findings delivered
- 21 smoke tests, all green
- 16 commits on `wave/1-foundation` branch
- Typecheck + build:server pass
- Validation gate met: typecheck, build, smoke:local, smoke:security, smoke:env, /livez + /metrics + /healthz endpoints, action-log/screenshots/whoami/features endpoints
- Self-heal log: 5 entries (baselining bugs + 1 test refactor). All resolved.

## Final task list

| # | Task | Findings | Commit |
|---|---|---|---|
| 1 | V-ENGINE.md API reference | P0-01 | `d873e46` |
| 2 | Parallel cap unified, session.evicted SSE | P0-02, P0-06, P2-09 | `1c510cf` |
| 3 | OMNI_LISTEN_HOST | P2-01 | `6105952` |
| 4 | 404 JSON for unknown /api paths | P2-06 | `6105952` |
| 5 | OMNI_BODY_SIZE_LIMIT (10 MB, 413) | P2-02 | `d102532` |
| 6 | OMNI_REQUEST_TIMEOUT_MS (60 s, 504) | P2-12, P2-13, P2-14 | `a900caa` |
| 7 | Auth-fail rate limiter (10/60s, 429) | P2-04 | `3856e4f` |
| 8 | Typed OmniError class hierarchy | P2-05 | `6e8807d` |
| 9 | OMNI_CORS_ALLOWED_ORIGINS + loopback | P2-08 | `1682637` |
| 10 | /livez + /readyz + /healthz probes | P8-01 | `ffd3058` |
| 11 | OMNI_TLS_CERT + OMNI_TLS_KEY (HTTPS) | P2-03 | `b488b82` |
| 12 | Structured JSON logger (log.info/warn/error) | P4-01 | `bcc37a0` |
| 13 | Prometheus /metrics (9 metrics) | P4-02 | `0bd30d2` |
| 14 | Request ID + W3C traceparent | P4-03 | `c4b9b58` |
| 15 | Paginated actionLog endpoint | P4-04 | `bf0d30c` |
| 16 | Screenshots timeline endpoint | P4-05 | `c4dee2a` |
| 17 | Webhook delivery (HMAC, retries, timeout) | P4-06 | `7671646` |
| 18 | /api/whoami + OMNI_TENANT_SCOPING | P8-02 | `759c0d7` |
| 19 | Dockerfile + fly.toml + env example | P8-03 | `bd5a08a` |
| 20 | Feature flags (OMNI_FEATURE_*) | P8-07 | `7920206` |

## New modules

- `src/server/omni-errors.ts` — typed error class hierarchy (10 classes)
- `src/server/log.ts` — structured JSON logger
- `src/server/metrics.ts` — hand-rolled Prometheus counters/gauges
- `src/server/request-context.ts` — W3C traceparent + request id
- `src/server/webhooks.ts` — HMAC-signed webhook delivery
- `src/server/feature-flags.ts` — env-based feature flag system

## New endpoints

- `/livez`, `/readyz`, `/healthz` (K8s probes)
- `/metrics` (Prometheus exposition)
- `/api/whoami` (grant claims introspection)
- `/api/features` (feature flag listing)
- `/api/sessions/{id}/action-log` (paginated: `?limit=N&before=ISO_TS`)
- `/api/sessions/{id}/screenshots` (screenshot-only timeline)

## New env vars (15 total)

`OMNI_LISTEN_HOST`, `OMNI_MAX_PARALLEL_SESSIONS`, `OMNI_BODY_SIZE_LIMIT`, `OMNI_REQUEST_TIMEOUT_MS`, `OMNI_AUTH_FAIL_LIMIT`, `OMNI_AUTH_FAIL_WINDOW_MS`, `OMNI_CORS_ALLOWED_ORIGINS`, `OMNI_ALLOW_LOOPBACK_CORS`, `OMNI_TLS_CERT`, `OMNI_TLS_KEY`, `OMNI_LOG_LEVEL`, `OMNI_METRICS_DISABLED`, `OMNI_ACTION_LOG_MAX`, `OMNI_WEBHOOK_URL`, `OMNI_WEBHOOK_SECRET`, `OMNI_WEBHOOK_TIMEOUT_MS`, `OMNI_WEBHOOK_MAX_RETRIES`, `OMNI_WEBHOOK_RETRY_BASE_MS`, `OMNI_TENANT_SCOPING`, `OMNI_FEATURE_*` (pattern).

## Ready for next wave

- All Wave 1 findings closed on `wave/1-foundation` branch.
- Branch is ready to merge to `main` (or stay separate for review).
- Wave 2 (AI Capability) can begin once Commander approves Wave 1.
