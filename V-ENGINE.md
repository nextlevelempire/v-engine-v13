# V-ENGINE.md — V-Engine API Reference

> The V-Engine is a standalone browser-automation runtime. It exposes an HTTP+SSE API for creating browser sessions, driving them with mouse/keyboard commands, observing them via screenshots, and persisting state.

**This document is the canonical field reference.** When the README and this document disagree, **this document wins**.

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
| `/livez` | GET | (none — K8s liveness probe) |
| `/readyz` | GET | (none — K8s readiness probe, 503 if `OMNI_SHUTTING_DOWN=1`) |
| `/healthz` | GET | (none — alias for `/livez`) |
| `/metrics` | GET | (none — Prometheus exposition, opt-out via `OMNI_METRICS_DISABLED=1`) |
| `/api/runtime/attach` | POST | `runtime.attach` |
| `/api/sessions` | GET | `sessions.create` |
| `/api/sessions` | POST | `sessions.create` |
| `/api/sessions/:sessionId/command` | POST | `sessions.command` |
| `/api/sessions/:sessionId/events` | GET | `sessions.read` |
| `/api/sessions/:sessionId` | GET | `sessions.read` |
| `/api/sessions/:sessionId/screenshot` | GET | `sessions.read` |
| `/api/sessions/:sessionId/artifacts` | GET | `sessions.read` |
| `/api/sessions/:sessionId/artifacts/:artifactId` | GET | `sessions.read` |
| `/api/sessions/:sessionId/action-log` | GET | `sessions.command` (paginated: `?limit=N&before=ISO_TS`) |
| `/api/sessions/:sessionId/screenshots` | GET | `artifacts.read` (screenshot-only timeline) |
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
// Request
{
  "sessionId": "optional-pre-generated-uuid",
  "objective": "Buy concert tickets",
  "creditBudget": 100,
  "persistent": false
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

**Command types (v0.1):** `navigate`, `click`, `type`, `screenshot`, `status`, `pause`, `resume`, `assistant_reply`, `directive`, `computer`.

### GET /api/sessions/:sessionId/events
Server-Sent Events stream. `event: <type>` / `data: <json>`. Includes `sessionId`, `eventId`, `timestamp`, `data` per event.

### GET /api/sessions/:sessionId
Returns current session state, including `status`, `lastActiveAt`, `commandCount`, `creditBudget`, `remainingBudget`, `actionLog` (recent entries), etc.

### GET /api/sessions/:sessionId/screenshot
Returns a PNG screenshot of the current viewport. May be slow on headless mode.

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
| `OMNI_METRICS_DISABLED` | `0` | If `1`, GET `/metrics` returns 404. |
| `OMNI_ACTION_LOG_MAX` | `10000` | Max actionLog entries kept per session. Older entries are dropped. |
| `OMNI_WEBHOOK_URL` | _(unset)_ | If set with `OMNI_WEBHOOK_SECRET`, runtime POSTs session/command events to this URL. |
| `OMNI_WEBHOOK_SECRET` | _(unset)_ | HMAC-SHA256 secret for signing webhook payloads (header `x-omni-signature: sha256=...`). |
| `OMNI_WEBHOOK_TIMEOUT_MS` | `5000` | Per-attempt delivery timeout. |
| `OMNI_WEBHOOK_MAX_RETRIES` | `3` | Max delivery retries (with exponential backoff). |
| `OMNI_WEBHOOK_RETRY_BASE_MS` | `500` | Base delay for retry backoff (doubled per attempt). |

> **v0.3 additions** (added in Wave 1): `OMNI_LISTEN_HOST`, `OMNI_MAX_PARALLEL_SESSIONS`, `OMNI_BODY_SIZE_LIMIT` (default 10485760 = 10 MB, returns 413), `OMNI_REQUEST_TIMEOUT_MS` (default 60000, returns 504), `OMNI_AUTH_FAIL_LIMIT` (default 10), `OMNI_AUTH_FAIL_WINDOW_MS` (default 60000), `OMNI_CORS_ALLOWED_ORIGINS`, `OMNI_ALLOW_LOOPBACK_CORS`, `/livez`+`/readyz`+`/healthz` probes, `OMNI_TLS_CERT`, `OMNI_TLS_KEY`, `OMNI_LOG_LEVEL` (default `info`), structured JSON logging via `log.info/warn/error` from `src/server/log.ts`, `OMNI_METRICS_DISABLED`, `/metrics` Prometheus endpoint with counters `omni_http_requests_total`, `omni_http_request_errors_total`, `omni_sessions_created_total`, `omni_sessions_evicted_total`, `omni_auth_failures_total`, `omni_body_too_large_total`, `omni_request_timeouts_total`, `omni_rate_limited_total` and gauge `omni_sessions_active`, request ID middleware + W3C `traceparent` propagation via `parseIncomingContext`/`mintRequestContext` in `src/server/request-context.ts` (echoed back on `x-omni-request-id` and `traceparent` response headers).

---

## 5. Error Response Shape

Errors are returned as JSON:
```json
{ "ok": false, "error": "human-readable message" }
```

> **v0.3 change:** Errors will be typed. Each error has a `code`, `message`, optional `hint`, and optional `retry_after_ms`. v0.1 used ad-hoc error strings — v0.3 normalizes them.

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

Plus v0.3 additions (being added in Wave 1): `session.evicted` (parallel cap fired), `frustration_handoff` (Wave 5), `error.typed` (typed error event).
