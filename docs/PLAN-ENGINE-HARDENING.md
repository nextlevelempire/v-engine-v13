# PLAN — Engine Hardening (omni-browser-v4)

**Status:** Proposal — awaiting Commander approval  
**Author:** Coder  
**Date:** 2026-06-01  
**Repo:** `omni-browser-v4` (this repo — engine image)  
**Source of truth (seam):** `src/server/services/cloud-computer/engine-bootstrap.ts` in the control-plane repo (`omni-browser-app`)  

> **Host-agnostic rule enforced throughout:** the engine must NOT know it is "in the cloud."  
> It reads env vars, binds to whatever host is given, and calls endpoints.  
> All cloud semantics (TLS termination, ingress, Azure secret refs, volume mounts) belong to the control-plane orchestrator / infra layer.

---

## E1 — Public Bind + Grant-Token-Only Auth

### What exists today
- `src/server/local-server.ts` — Node `http.createServer` listening on `0.0.0.0:4011` (already public-bind, line 233: `server.listen(port, LISTEN_HOST, resolve)` where `LISTEN_HOST = "0.0.0.0"`).
- `src/server/runtime-grant.ts` — full HMAC-SHA256 grant verification: `verifyRuntimeGrant()` checks signature, expiry, `daemonInstanceId` match, and optional scope + sessionId pinning.
- Port already read from env: `process.env.OMNI_PORT` (or `PORT`), default 4011 — `src/cli.ts:9`.
- **Missing guard:** the `/api/health` endpoint (line 41) has NO grant check. It returns health data to *any* caller. The existing `verifyRequestGrant` is only called on `/api/runtime/attach`, `/api/sessions`, `/api/sessions/:id/command`, and vault endpoints.

### What changes

**1. Stricter host-binding guard (no change needed)**  
The `LISTEN_HOST` is already `"0.0.0.0"` in production. The Dockerfile already `EXPOSE 4011`. The cloud Container App ingress terminates TLS at the edge; the engine sees plain HTTP internally — no engine-level TLS needed. Only the auth gap below needs fixing.

**2. Add grant-token verification to `/api/health` — scope-free**  
The health endpoint must verify that the grant token is valid (signature OK, not expired, daemonInstanceId matches) but must NOT require a specific scope. Why: the control plane's `pingRuntimeHealth` calls `/api/health` as a preflight *before* issuing any session-scoped grants. If health required a scope, the preflight would fail and no session could ever start.

**Implementation:**  
In `local-server.ts`, add a lightweight verification path for health that uses the existing `readRuntimeGrantToken(request, url)` to extract the token and `verifyRuntimeGrant()` for signature + expiry + daemon match — but skips the scope check. This can be done by adding a new function or a `null`/empty `requiredScope` sentinel in `verifyRequestGrant` that means "validate structure but skip scope."

Specifically, modify `verifyRequestGrant` (or add a parallel `verifyTokenOnly`) so that when `requiredScope` is `null`/`undefined`, it still calls `readRuntimeGrantToken`, calls `verifyRuntimeGrant` without a `requiredScope`, and returns the claims. The `/api/health` handler calls this scope-free validator. All other endpoints continue to require their specific scope as today.

**3. Disable client asset serving via opt-in env var**  
Line 207: `return serveClientAsset(url.pathname, response)` — in the cloud there is no client to serve. Change behavior: when `OMNI_DISABLE_CLIENT_ASSETS=1` is set, the fallthrough returns `{"error":"Not found","ok":false}` instead of trying to serve `dist/client/index.html`.

**New env var:** `OMNI_DISABLE_CLIENT_ASSETS` — opt-in disable. Default `"0"` (unset = backward compatible, client assets served). When set to `"1"`, the fallthrough at line 207 returns `404` JSON. The control plane sets this to `1` in the cloud Container App env.

### No changes needed
- `runtime-grant.ts` — already correct, already shares `OMNI_DASHBOARD_JWT_SECRET` with the control plane
- Port binding — already `0.0.0.0`

### Files changed
- `src/server/local-server.ts`

---

## E2 — Headless Chrome + Xvfb Headed-Stealth Mode

### What exists today
- `Dockerfile` line 25: `ENV OMNI_ALLOW_HEADLESS_FALLBACK=0` (tells Chrome to prefer headed mode)
- `Dockerfile` line 35: Xvfb (`x11-utils`) is installed
- `scripts/start-production.sh`: Xvfb starts on `:99` with `1280x800x24`, waits until ready, then launches `pnpm start`
- The engine (via Playwright) connects to the headed browser on the virtual display

### What's missing
Playwright's default browser launch for headed mode on Xvfb still leaks `HeadlessChrome` in the User-Agent string and sets `navigator.webdriver = true`. Google login detection is known to check both.

### What changes

**1. Chrome launch args in the engine's browser context**  
The engine uses Playwright (`playwright-core` or `playwright`) to launch Chrome. We need to add specific launch arguments that mask headless detection. The canonical args (proven in anti-bot-detection practice):

```
--disable-blink-features=AutomationControlled
--disable-features=IsolateOrigins,site-per-process
--disable-session-crashed-bubble
--no-first-run
--no-default-browser-check
--window-size=1280,800
--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36
```

**Where to add them:** Find the Playwright `browserType.launch()` call in the engine's browser initialization (likely in `omni-core-clone.ts` or a browser-manager module). Add the args to `launchPersistentContext()` or `launch()` call.

**2. Stealth script injection**  
On every new page (page-level init), inject a stealth script before any navigation that:
- Overrides `navigator.webdriver` to `undefined`
- Patches `navigator.plugins` to return a non-empty array
- Patches `navigator.languages` to `["en-US", "en"]`
- Spoofs `chrome.runtime` presence (optional but helps)
- Hides the `ChromeDriver` / `webdriver` property from `navigator`

This is minimal: a ~20-line `beforeEach` page hook that runs via `page.addInitScript()`.

**3. No engine-level User-Agent manipulation**  
The engine already passes the browser's real UA to the control plane. The control plane's `agent-context.ts` or downstream code may set the UA — leave that as-is. The engine just needs to appear as a real headed browser to the page's JS.

**4. Dockerfile: no changes needed**  
Xvfb is already installed. The `start-production.sh` already starts it. The display size matches the `--window-size` arg.

**5. Playwright channel vs system Chrome**  
The `Dockerfile` line 31 runs `pnpm exec playwright install --with-deps chrome`. This installs Playwright's bundled Chromium. For Google login realism, the system Chrome (`/opt/google/chrome/chrome` set via `OMNI_CHROME_EXECUTABLE`) is preferred. Verify the engine reads `OMNI_CHROME_EXECUTABLE` env var to select which binary to launch. The Dockerfile already sets this env var. No change needed.

### Files changed
- `src/runtime/omni-core-clone.ts` (or wherever Playwright browser launch lives) — add launch args
- Browser-init module — add `addInitScript()` stealth script

---

## E3 — Configurable Persistent Profile Path

### What exists today
- `src/utils/omni-paths.ts` — `getOmniHome()` resolves `process.env.OMNI_HOME ?? ~/.omni-browser`
- All subdirectories (daemon-state, browser-sessions, vault, recordings, checkpoints, downloads, etc.) resolve relative to `getOmniHome()`
- The browser profile (Chrome user data dir) is determined by the engine's Playwright launch — currently defaults to an ephemeral temp dir

### What changes

**1. New env var: `OMNI_PROFILE_DIR`**  
The control plane will mount an Azure Files volume and set this env var to the mount point (e.g., `/mnt/profiles/<orgId>/<userId>`).

**Behavior:**
- When `OMNI_PROFILE_DIR` is set (non-empty, absolute path): use it as the Playwright persistent context directory (i.e., the Chrome user data dir). This means the browser session cookie store lives on the mounted volume.
- When `OMNI_PROFILE_DIR` is NOT set: fall back to default behavior (ephemeral temp dir).

**2. Changes in `omni-paths.ts`**  
Add a new function:
```ts
export function getChromeProfileDir(): string | null {
  const configured = process.env.OMNI_PROFILE_DIR?.trim();
  if (configured && path.isAbsolute(configured)) {
    return ensureDir(configured);
  }
  return null; // caller falls back to ephemeral
}
```

**3. Changes in browser launch**  
Where the engine calls Playwright's `browserType.launchPersistentContext(userDataDir, ...)` or `launch()`, replace the ephemeral `userDataDir` with `getChromeProfileDir()` when available. If a persistent profile is set:
- The context is launched with `userDataDir: getChromeProfileDir()`
- All cookies, localStorage, extensions, and session state survive container restarts
- The daemon's own state dir (daemon-instance.json, checkpoint state) should also map under `OMNI_PROFILE_DIR` when set — via an override of `getDaemonStateDir()` / `getOmniHome()`.

**Design decision:** Rather than creating a separate OMNI_PROFILE_DIR that lives *alongside* OMNI_HOME, the cleanest approach is: when `OMNI_PROFILE_DIR` is set, it becomes an **override for OMNI_HOME entirely** for the daemon state + browser profile. The function `getOmniHome()` already exists and is the root for everything. We add a new resolution order:

```ts
export function getOmniHome(): string {
  // 1. If OMNI_PROFILE_DIR is set AND is absolute, it overrides OMNI_HOME
  const profileDir = process.env.OMNI_PROFILE_DIR?.trim();
  if (profileDir && path.isAbsolute(profileDir)) {
    return ensureDir(profileDir);
  }
  // 2. Fall back to existing OMNI_HOME logic
  const configured = process.env.OMNI_HOME?.trim();
  const omniHome = configured
    ? (path.isAbsolute(configured) ? configured : path.join(os.homedir(), configured))
    : DEFAULT_OMNI_HOME;
  return ensureDir(omniHome);
}
```

This means the Azure Files volume gets EVERYTHING: browser cookies, daemon instance identity, checkpoints, vault, recordings — not just the Chrome profile. The control plane only sets `OMNI_PROFILE_DIR`; the engine doesn't need to know what's behind it.

**Critical consequence — daemon instance ID persistence:** Because `getDaemonStateDir()` resolves under `getOmniHome()` → `OMNI_PROFILE_DIR`, the file `daemon-instance.json` (written by `src/server/daemon-instance.ts`) now lives on the mounted Azure Files volume and survives container restarts. This means the engine reuses the same `daemonInstanceId` after a restart/park/wake cycle. This is CORRECT behavior: the control plane's `RuntimeDevice` is keyed by `daemonInstanceId` + `orgId`/`userId`, so reusing the same ID means the existing device record remains valid and the container does NOT need to re-pair on every wake cycle — it auto-pairs once on first provision and reuses its identity on subsequent wakes.

**Env var naming rationale:** The plan's contract (`engine-bootstrap.ts`) already defines `OMNI_DAEMON_PORT`. Following the same `OMNI_*` convention, `OMNI_PROFILE_DIR` is the natural name. It's host-agnostic and self-documenting.

### Files changed
- `src/utils/omni-paths.ts`
- Browser-launch code (where `userDataDir` or `launchPersistentContext` is called)

---

## E4 — Auto-Redeem Pairing Token on Boot

### What exists today
- The engine has NO boot-time pairing flow. Pairing is manual (user pastes a token from the CLI).
- `src/server/control-plane-sync.ts` already reads `OMNI_CONTROL_PLANE_URL` for session snapshot sync — but only when `OMNI_INGEST_SECRET` is also set.
- The engine does NOT currently read `OMNI_PAIRING_TOKEN`.

### What changes

**1. New module: `src/server/auto-pair.ts`**  

A new self-contained module that runs at daemon startup, after the server is listening (so the daemon knows its own port). Logic:

```
read OMNI_PAIRING_TOKEN, OMNI_CONTROL_PLANE_URL, OMNI_DEVICE_LABEL, OMNI_DAEMON_PORT from env
if any required var missing → skip pairing (existing local/development behavior)
else:
  baseUrl = determinePublicBaseUrl()   // see below
  daemonInstanceId = getDaemonInstanceId()
  capabilities = getRuntimeCapabilities()
  POST {OMNI_CONTROL_PLANE_URL}/api/runtime/pair
    body: { token, baseUrl, daemonInstanceId, label, capabilities }
  on 200 → device registered, log success, continue boot
  on 401 → log warning (token expired/invalid), retry with backoff 3×, then exit 1
  on network error → retry with backoff 3×, then exit 1
```

**Decision: Use existing `OMNI_AGENT_PUBLIC_URL` env var**  
The engine's auto-pair module reads this env var for its public base URL. The var name is already used by the pairing flow (no change to `engine-bootstrap.ts`). The control plane sets `OMNI_AGENT_PUBLIC_URL` to the container's ingress FQDN at provision time.

**Resolution logic:**
```
if OMNI_AGENT_PUBLIC_URL is set and non-empty → use it as baseUrl
else → construct http://127.0.0.1:{port} (local/dev fallback)
```

The fallback means local development works unchanged; the cloud Container App always has this var set.

Add `OMNI_AGENT_PUBLIC_URL` as a documented env var in the engine's `.env.example`. No change to `engine-bootstrap.ts` in the control-plane repo — the bootstrap contract already includes the four core vars (pairingToken, controlPlaneUrl, deviceLabel, daemonPort). The public URL is an engine-side implementation detail.

**3. Integration point in boot**  
In `src/cli.ts`: after `startStandaloneServer(port)` returns (server is listening), call `autoPair({ pairingToken, controlPlaneUrl, deviceLabel, daemonPort })`. The auto-pair runs async and does not block the server from accepting requests.

**4. Retry with backoff**  
Implement fixed increments: immediate → 5s → 30s → exit with status 1. 15-min TTL means retries are bounded — if the token expired, we fail fast.

**5. No new `api/` files** — the engine just calls the existing `POST /api/runtime/pair` on the control plane. The endpoint already accepts the exact shape `{ token, baseUrl, daemonInstanceId, label, capabilities }`.

**6. Token safety**  
The token is read once on startup, used, and the env variable value stays in memory (no logging of the token content, only log `paired: true/false`). This mirrors the existing treatment of `OMNI_INGEST_SECRET`.

### Files changed (NEW)
- `src/server/auto-pair.ts` (new file)
- `src/cli.ts` (call auto-pair after server starts)
- `src/server/local-server.ts` (export the server instance or provide a startup signal)

### New env vars
- `OMNI_PAIRING_TOKEN` — from `engine-bootstrap.ts` (already in contract)
- `OMNI_DEVICE_LABEL` — from `engine-bootstrap.ts` (already in contract)
- `OMNI_PUBLIC_BASE_URL` — NEW; the container's public ingress URL

---

## E5 — Loop / No-Progress Signal

### What exists today
- `src/runtime/omni-core-clone.ts` contains the main agent work loop. It emits events via `p0EmitEvent()`.
- Events include: `execution`, `observation.captured`, `extraction.captured`, `plan.created`, `checkpoint.created`, etc.
- Each event carries: `url`, `axTreeHash`, `action`, `title`, etc.
- `src/server/control-plane-sync.ts` forwards session snapshots to the control plane's `/api/runtime/ingest` endpoint via `syncRuntimeSessionSnapshot`.
- The control plane ingests these events. The runaway circuit breaker is a **control-plane concern** (Phase 3, §8 of the plan).

### What's needed
The engine must emit a raw signal that the control plane can use to detect loops. The control plane owns the circuit-breaker logic (check for repeated near-identical steps / no new URLs or artifacts over N minutes). The engine just needs to surface what it's doing and what artifacts it's produced.

**Design principle:** Minimal engine change. The existing event stream already carries enough data for loop detection. The only gap is a structured "progress checkpoint" that makes it cheap for the control plane to assess progress without re-parsing every event.

### What changes

**1. Add structured progress metadata to session snapshots**  
Extend the existing `syncRuntimeSessionSnapshot` payload with an in-memory rolling action log.

**Data structure** — maintained on `SessionRecord` in `service.ts` (no new file I/O):

```ts
// In-memory, fixed-size ring buffer on SessionRecord
const MAX_ACTION_LOG = 10;

type ActionLogEntry = {
  url: string;              // URL the action operated on (e.g. page.url())
  actionType: string;       // e.g. "navigate", "click", "type", "screenshot", "extraction"
  timestamp: string;        // ISO timestamp
  newArtifactCount: number; // how many new artifacts were created by this action (0 = none)
  pageTitle: string;        // document.title at time of action
};

// Added to SessionRecord (service.ts):
// actionLog: ActionLogEntry[] — newest first, max MAX_ACTION_LOG entries
// totalArtifactCount: number — running total across the session
```

**How populated** — in `service.ts:executeCommand()`, after every completed command (line 274-293), push a new `ActionLogEntry` to `record.actionLog`, trimming to MAX_ACTION_LOG. Read the URL and title from `record.core.getStatus()` or from the result of the action.

**How sent** — in `syncRuntimeSessionSnapshot` (via `control-plane-sync.ts`), include the full action log array and the total artifact count:

```ts
interface SnapshotPayload {
  // ... existing fields unchanged ...
  // NEW fields:
  actionLog: ActionLogEntry[];         // newest first, max 10 entries
  totalArtifactCount: number;          // running total
}
```

The `control-plane-sync.ts` `syncRuntimeSessionSnapshot` function signature is extended to accept these new fields and includes them in the POST body. No new endpoint is created.

**Consumer** — the control plane's circuit breaker (Phase 3, `omni-browser-app` side) reads the `actionLog` from each snapshot and:

- Compares consecutive entries for near-duplicates (same URL + same actionType + 0 new artifacts repeated N+ times)
- If >5 entries in a row have identical URL + actionType and zero `newArtifactCount`, it's a loop → trigger pause
- If the entire log is identical across 3+ consecutive snapshots, it's a loop → trigger pause
- If `totalArtifactCount` has not changed across N minutes of snapshots, it's stalled → trigger pause

**4. The engine's responsibility ends at emitting the data.**  
The circuit-breaker logic lives in the control plane (`omni-browser-app`), not the engine. The engine is host-agnostic — it emits progress data regardless of where it runs.

### Files changed
- `src/server/control-plane-sync.ts` — extend `syncRuntimeSessionSnapshot` input type
- `src/runtime/omni-core-clone.ts` — maintain rolling URL/action buffer
- `src/server/service.ts` — pass buffer data into snapshot calls

---

## E6 — Clean Pause/Resume on Credit-Out and Handoff

### What exists today

**Engine side:**
- `src/runtime/omni-core-clone.ts:1602` — `pauseMission(reason?: string)`: sets `this.isPaused = true`, writes a scratchpad entry, syncs control state. The agent work loop respects `this.isPaused` and does not execute actions while paused.
- `omni-core-clone.ts:1613` — `resumeMission(reason?: string)`: runs resume verification (checks page state, auth wall, CAPTCHA status against last checkpoint), then calls `this.resumeAI()`.
- Both are exposed via the `SessionCommand` type in `service.ts:72-73` as `type: "pause"` and `type: "resume"`.
- The control plane's `sendRuntimeControlSignal` (in `runtime-daemons.ts:218`) already routes pause/resume as non-billable commands via `POST /api/sessions/:id/command` with a grant token but NO credit authorization.

**Control plane side:**
- `sendRuntimeControlSignal` is already the non-billable pathway (§11, plan §15 requirement E6).
- Credit-out: `service.ts:223-227` already checks `record.remainingBudget < cost` and calls `record.core.pauseMission("Credit budget exhausted")` automatically — then throws. The control plane receives the error, preserves the session, and shows the top-up card.
- Handoff: `core.resolveLoginHandoff()` is called via `command.type: "handoff_resolve"` in `service.ts:266`.

### Gaps for cloud context

**1. No cloud-specific changes needed in the engine.**  
Pause/resume control signals are already correct. The engine reacts to `pause` and `resume` commands regardless of where it runs. Credit exhaustion auto-pauses via existing budget check.

**2. Confirm: browser state is preserved on pause.**  
When `pauseMission()` is called, the Playwright browser context is NOT closed. The page stays open, cookies stay in memory, and the Chrome user data dir persists. On resume, the engine verifies page state and continues. Verified by reading `omni-core-clone.ts` — `pauseMission` does NOT call `this.context.close()` or `this.currentPage.close()`, only sets `isPaused = true`.

**3. Auto-pause on container stop signal.**  
The `scripts/start-production.sh` has a `cleanup()` trap (`INT TERM EXIT`) that kills Xvfb. However, if the container is being scaled to zero (park), the SIGTERM should ideally trigger a proper shutdown that:
- Pauses all active sessions
- Syncs final snapshots to the control plane
- Closes the Playwright browser context cleanly (flushing cookies to the persisted profile dir)

**Change:** In `start-production.sh` or `cli.ts`, add a graceful shutdown handler (`process.on("SIGTERM", ...)` in Node) that:
- Calls `service.shutdown()` which pauses sessions and syncs final snapshots
- Closes the HTTP server gracefully
- (Xvfb is killed by the existing trap)

This ensures that when the orchestrator parks the container (scale-to-zero), the last session snapshot includes the paused/closed status and the profile cookies are flushed to disk.

**4. Resume after park/wake cycle.**  
When the container wakes (orchestrator starts a new Container App replica), the engine boots fresh, reads `OMNI_PROFILE_DIR`, and the Chrome user data dir is still there with session cookies. There is no "resume a specific session from disk" — the control plane sends a new `resume` command after the daemon re-pairs and re-attaches. The engine's existing `resumeMission` verification handles this: it checks the current page state against the last checkpoint and if the page is gone (closed by the old container dying), the agent will detect it and re-navigate.

**No engine changes needed beyond the graceful shutdown handler.**

### Files changed
- `src/cli.ts` — add `process.on("SIGTERM", ...)` graceful shutdown handler
- Potentially `scripts/start-production.sh` — minor adjustment to the trap sequence

---

## Summary of changes by file (engine repo)

| File | Change | E# |
|---|---|---|
| `src/server/local-server.ts` | Add grant-token check to `/api/health`; disable static asset fallthrough via `OMNI_ALLOW_CLIENT_ASSETS` | E1 |
| `src/server/runtime-grant.ts` | No change needed (already correct) | E1 |
| Browser-launch code (find in `omni-core-clone.ts` or browser manager) | Add headless-stealth launch args + `addInitScript()` stealth | E2 |
| `src/utils/omni-paths.ts` | Make `OMNI_PROFILE_DIR` override `getOmniHome()`; add `getChromeProfileDir()` | E3 |
| `src/server/auto-pair.ts` | **NEW** — boot-time token redemption against `/api/runtime/pair` with retry | E4 |
| `src/cli.ts` | Call `autoPair()` after server starts; add SIGTERM graceful shutdown | E4, E6 |
| `src/server/control-plane-sync.ts` | Extend `syncRuntimeSessionSnapshot` to accept `actionLog[]` + `totalArtifactCount` | E5 |
| `src/server/service.ts` | Add `actionLog` + `totalArtifactCount` to `SessionRecord`; push entries after each command; wire into snapshot call | E5 |
| `scripts/start-production.sh` | No changes needed (already correct) | E2 |

## Env var summary

| Variable | Source | Purpose | E# |
|---|---|---|---|
| `OMNI_PAIRING_TOKEN` | `engine-bootstrap.ts` | Boot-time pairing JWT | E4 |
| `OMNI_CONTROL_PLANE_URL` | `engine-bootstrap.ts` | Where to POST pair + ingest | E4 |
| `OMNI_DEVICE_LABEL` | `engine-bootstrap.ts` | Device label for registration | E4 |
| `OMNI_DAEMON_PORT` | `engine-bootstrap.ts` (rename of `OMNI_PORT`) | Listening port | E1, E4 |
| `OMNI_PROFILE_DIR` | **NEW** | Override `OMNI_HOME` to point at Azure Files mount; daemon instance ID persists across restarts | E3 |
| `OMNI_AGENT_PUBLIC_URL` | **NEW** (engine-side) | Container's public ingress FQDN for pairing; no change to `engine-bootstrap.ts` | E4 |
| `OMNI_DISABLE_CLIENT_ASSETS` | **NEW** | Opt-in disable of static asset serving (`=1` to disable); backward-compatible default | E1 |
| `OMNI_DASHBOARD_JWT_SECRET` | Already exists (both repos) | HMAC secret for grant verification | E1 |

## Host-agnostic compliance check

The engine remains fully host-agnostic:

- **No cloud/Azure references** in code, comments, or logs
- **No changes** to the existing `sendRuntimeControlSignal` contract
- **No changes** to `engine-bootstrap.ts` (the seam in the control-plane repo) — all new env vars are engine-side additions
- **No new `api/` endpoints** added to either repo
- **No coupling** to Container Apps APIs, Azure SDK, or cloud metadata endpoints
- The engine reads env vars and calls HTTP endpoints — exactly as it does today