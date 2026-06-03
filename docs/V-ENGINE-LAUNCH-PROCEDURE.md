# V-Engine v0.3 — Launch Procedure & End-to-End Mission Recipe

**Audience:** the next AI engineer picking up this repo. This document is the procedure. Read it end-to-end before you write any code. The previous engineer's commits claimed "all smokes GREEN" without a runbook — this is the runbook that actually works.

**Author:** General Max (long-horizon autonomous coder)
**Date:** 2026-06-02
**Working tree:** `~/Downloads/computer-use/v-engine-v13/`
**Repo:** `https://github.com/nextlevelempire/v-engine-v13`
**Branch in use:** `wave/2-ai-capability`

---

## 0. What the V-Engine actually is

A standalone browser-automation runtime. HTTP + SSE. Sessions, runtime grants (HMAC), capability gates, action logs, screenshots, webhooks, metrics. The Engine is the substrate. **The Engine is also the cockpit.** When it drives a browser, it injects the Empire Omni Browser workspace on top of the page: a left mission control panel (Agent Executing, Take Over, Pause Mission, Export Logs, Pending Queue, Hide Panel/Badge) and a right collaboration panel (Empire Collaboration, LIVE/TASK tabs, drop zone, mission thread narrating THINK → EXECUTE → REFLECT, voice input, SEND).

The product OmniGPT fights to make that cockpit feel real. The Engine already renders it. **If you are picking up the Engine, your job is to harden the substrate so the product can lean on it.**

---

## 1. The four gotchas the previous engineer never documented

These are the reason "V-Engine up and running" was elusive. Read them before you start. Each one cost a debugging session in 2026-06-02.

### 1.1 The screenshot endpoint is `POST`, not `GET`

```
GET  /api/sessions/{sessionId}/screenshot  →  404 Not Found
POST /api/sessions/{sessionId}/screenshot  →  { "path": "<abs path to PNG>" }
```

The POST body shape is `{ "label": "example-landing" }`. The response is JSON containing a single `path` field — that is the absolute filesystem path to a PNG the Engine just wrote. **The endpoint does NOT return PNG bytes. You have to read the file at that path yourself.**

Why: the Engine writes the screenshot into the per-session `browser-records` store and returns the path so the caller (and the Engine's own artifact index) can reference it. The bytes are on disk; the API tells you where.

### 1.2 There is no `computer/launch` action

The `ComputerAction` union in `src/runtime/local-computer.ts` defines the desktop-level action set:

```ts
{ type: "screenshot" } | { type: "move"; x; y } | { type: "click"; x; y; button?; double? }
| { type: "type"; text; secret? } | { type: "key"; keys } | { type: "confirm_action"; label; irreversible? }
| { type: "wait"; ms } | { type: "done"; summary? }
| { type: "right_click"; x; y } | { type: "double_click"; x; y } | { type: "shortcut"; keys }
| { type: "drag"; fromX; fromY; toX; toY } | { type: "scroll"; deltaX; deltaY; x?; y? } | { type: "hover"; x; y }
| { type: "clipboard_read" } | { type: "clipboard_write"; text }
| { type: "screenshot_element"; selector; label? } | { type: "file_upload"; selector; filePath }
| { type: "file_download"; url; savePath } | { type: "fill_form"; fields }
| { type: "scroll_until"; target; direction?; maxScrolls? }
| { type: "enter_frame"; frameSelector } | { type: "exit_frame" } | { type: "shadow_pierce"; selector }
```

**There is no `launch`.** A session, when created, is given a `runtimeProfile` that includes a `provider: "standalone-runtime"`. The Engine auto-launches a real browser under that provider. You do not need to launch it. Just create a session, send a `navigate`, and the browser is already there.

If you send `type: "computer", action: { type: "launch" }` the Engine will return:

```json
{ "error": "Unhandled computer action: \"launch\"", "ok": false }
```

That error is correct. The action does not exist. The Engine is telling you the truth; you sent it a bad request.

### 1.3 Takeover gates are off by default

The Engine advertises takeover capabilities on `/api/health` and uses them to gate dangerous operations (desktop control, real-mouse takeover, etc.). The default advertised capability set is empty unless you opt in. The relevant code is `src/server/takeover-config.ts`:

```ts
function defaultEnabledCapabilities(): TakeoverCapability[] {
  const caps: TakeoverCapability[] = ["takeover:local_browser"];
  if (process.env.OMNI_ENABLE_LOCAL_COMPUTER === "1") {
    caps.push("takeover:local_computer");
  }
  return caps;
}
```

To unlock both modes (which you need if you want a real browser session, real screenshots, and the cockpit):

```bash
OMNI_TAKEOVER_MODES="local_browser,local_computer"   # takes priority over default
```

The other opt-in: a `takeover.json` in the daemon state dir:

```json
{
  "baseUrl": "https://your-tunnel.example.com",
  "enabledCapabilities": ["takeover:local_browser", "takeover:local_computer"],
  "label": "Max's MacBook",
  "pairedAt": "2026-06-02T23:00:00.000Z"
}
```

Without these, the Engine still boots, but `/api/health` will not advertise local-takeover, the session will run in a degraded mode, and `computer/launch` (had it existed) plus any `local_computer` actions would be refused.

### 1.4 The Engine writes its own screenshots; you read them

Every `navigate` auto-captures a proof PNG. Every `screenshot` command adds another. They land in:

```
.omni-smoke-home/{orgId}/browser-records/{sessionId}/screenshots/
  2026-06-03T04-28-21.707Z-navigation-proof.png
  2026-06-03T04-28-26.499Z-tryomnigpt-landing.png
  2026-06-03T04-28-27.921Z-navigation-proof.png
  2026-06-03T04-28-31.070Z-example-landing.png
```

The PNGs are real. They are 250KB-740KB. They show the page rendered plus the Empire Omni Browser HUD overlaid on top. Open them. Do not write a separate Playwright instance to look at the Engine's API. The proof is in the Engine's output, not in a parallel demo. (This is the mistake the previous Max made — they wrote a separate Playwright to take a screenshot of `/api/commands` JSON Schema and showed that to the Commander as if it was the Engine driving a browser. It was not. The Commander saw through it instantly.)

---

## 2. Full launch procedure (reproducible)

### Step A — Pre-flight

```bash
cd ~/Downloads/computer-use/v-engine-v13
git status
git log --oneline -5
```

Confirm you are on a clean working tree on `wave/2-ai-capability`. If `git status` shows uncommitted changes you didn't make, ask the Commander before doing anything else.

### Step B — Build the Engine

```bash
pnpm install
pnpm run typecheck     # MUST be green
pnpm run build:server  # MUST be green; produces dist/src/cli.js
```

If typecheck or build fails, **stop and fix**. Do not proceed with a broken build. Document the fix in `notes/SELF-HEALING.md` per the methodology in `README.md`.

### Step C — Boot the Engine

```bash
PORT=14570 \
OMNI_HOME=$(pwd)/.omni-smoke-home \
OMNI_TAKEOVER_MODES="local_browser,local_computer" \
node dist/src/cli.js serve
```

Wait for the log line:

```
[omni-browser-v4] listening on http://127.0.0.1:14570
```

Or whatever your PORT is.

What each var does:
- `PORT` — which TCP port the Engine binds. Default in dev is whatever `dist/src/cli.js` defaults to; override here.
- `OMNI_HOME` — the daemon-state root. Runtime grants, daemon-instance.json, takeover.json, browser-records all live under here. Keep it inside the working tree so cleanup is a `rm -rf`.
- `OMNI_TAKEOVER_MODES` — unlocks local_browser and local_computer capability gates. Required for the cockpit to drive a real browser session.

### Step D — Sanity-check the boot

```bash
curl -s http://127.0.0.1:14570/healthz
# → { "ok": true, "status": "live" }

curl -s http://127.0.0.1:14570/api/features
# → list of OMNI_FEATURE_* flags and their state
```

Both should return 200. The `/api/health` route (with auth) will also tell you the advertised takeover capabilities. Confirm `local_browser` and `local_computer` are both listed.

### Step E — Mint a runtime grant and create a session

The Engine requires a Bearer token signed with the daemon instance's HMAC secret. The recipe below is the same one used in `scripts/local-smoke.ts`. It is the canonical pattern.

```js
// /tmp/v-engine-launch.mjs
import fs from "node:fs";
import path from "node:path";
import { mintRuntimeGrant } from "/Users/jbthagreat/Downloads/computer-use/v-engine-v13/dist/src/server/runtime-grant.js";
import { getDaemonStateDir } from "/Users/jbthagreat/Downloads/computer-use/v-engine-v13/dist/src/utils/omni-paths.js";

const daemonInstanceId = JSON.parse(
  fs.readFileSync(path.join(getDaemonStateDir(), "daemon-instance.json"), "utf8")
).daemonInstanceId;

const token = mintRuntimeGrant({
  daemonInstanceId,
  orgId: "vision-demo",
  sub: "general-max",
  scopes: [
    "runtime.attach",
    "sessions.create",
    "sessions.read",
    "sessions.command",
    "artifacts.read",
    "vault.read",
    "vault.write",
  ],
  ttlSeconds: 600,
});

const H = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
const BASE = "http://127.0.0.1:14570";

// Create the session
const session = await (
  await fetch(`${BASE}/api/sessions`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({
      objective: "V-Engine end-to-end smoke: open tryomnigpt.com then example.com",
      creditBudget: 50,
    }),
  })
).json();
const sessionId = session.sessionId;
console.log("session:", sessionId, "provider:", session.status?.runtimeProfile?.provider);
```

Required scopes: `runtime.attach`, `sessions.create`, `sessions.read`, `sessions.command`, `artifacts.read`. Without `sessions.command`, the navigate is refused with 403/401.

### Step F — Navigate (this launches the browser implicitly)

```js
const nav = await (
  await fetch(`${BASE}/api/sessions/${sessionId}/command`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ type: "navigate", url: "https://tryomnigpt.com" }),
  })
).json();
console.log("navigate:", nav.success, nav.httpStatus, nav.finalUrl);
// Expect: success=true, httpStatus=200, finalUrl=https://tryomnigpt.com/
```

Wait 3-4 seconds for the page and the cockpit to settle.

### Step G — Capture and read the screenshot

```js
const shot = await (
  await fetch(`${BASE}/api/sessions/${sessionId}/screenshot`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ label: "tryomnigpt-landing" }),
  })
).json();
console.log("screenshot path:", shot.path);

const pngBytes = fs.readFileSync(shot.path);
console.log("png bytes:", pngBytes.length, "header:", pngBytes.slice(0, 8).toString("hex"));
// 89 50 4E 47 0D 0A 1A 0A  → real PNG
```

Open the PNG with Preview, or with `open <path>` on macOS, or by reading it into your tool. You will see the Empire Omni Browser cockpit rendered on top of tryomnigpt.com.

### Step H — Continue the mission

You can chain more commands:

```js
// Screenshot the current page (cockpit on top)
await fetch(`${BASE}/api/sessions/${sessionId}/command`, {
  method: "POST", headers: H,
  body: JSON.stringify({ type: "screenshot", label: "checkpoint-1" }),
});

// Click via CSS selector (high-level Wave 2 command)
await fetch(`${BASE}/api/sessions/${sessionId}/command`, {
  method: "POST", headers: H,
  body: JSON.stringify({ type: "click", selector: "a[href='/pricing']" }),
});

// Type into a field
await fetch(`${BASE}/api/sessions/${sessionId}/command`, {
  method: "POST", headers: H,
  body: JSON.stringify({ type: "type", selector: "input[name='email']", text: "max@nextlevelempire" }),
});

// Read session state
const state = await (
  await fetch(`${BASE}/api/sessions/${sessionId}`, { headers: H })
).json();
console.log("commandCount:", state.commandCount, "currentUrl:", state.status?.currentUrl);
```

### Step I — Tear down

```bash
lsof -ti tcp:14570 | xargs kill -9
```

Or send the process a SIGINT. The Engine writes its artifacts to disk on every command; nothing is lost on a hard kill.

---

## 3. Verification checklist (this is what "up and running" means)

A run is real, not theatre, when **all** of the following are true:

- [ ] `pnpm run typecheck` exits 0
- [ ] `pnpm run build:server` exits 0
- [ ] `node dist/src/cli.js serve` logs `listening on http://127.0.0.1:{PORT}`
- [ ] `GET /healthz` returns `{ok:true, status:"live"}` with HTTP 200
- [ ] A session can be created via `POST /api/sessions` and returns `runtimeProfile.provider: "standalone-runtime"`
- [ ] A `navigate` to a real URL (e.g. `https://example.com`) returns `success:true, httpStatus:200, finalUrl:...`
- [ ] A `POST /api/sessions/{id}/screenshot` returns a `path` field
- [ ] The file at that path is a real PNG (first 8 bytes = `89 50 4E 47 0D 0A 1A 0A`) and is > 100KB
- [ ] Opening the PNG shows the Empire Omni Browser cockpit overlaid on the target page (left control panel, right collaboration panel, mission thread)

If any of these fail, the Engine is not "up and running." It is partially booted. Find which step failed and fix the root cause. Do not declare success on partials.

---

## 4. Common failure modes and what they mean

| Symptom | Root cause | Fix |
|---|---|---|
| `GET /api/sessions/{id}/screenshot` returns 404 | Wrong method. | Use POST. See §1.1. |
| `POST /api/sessions/{id}/screenshot` returns JSON but the JSON is `{"error":"Not found","ok":false}` | Session ID is wrong, or session is gone. | Re-create the session. Re-run. |
| `computer/launch` returns `Unhandled computer action: "launch"` | You invented an action. | There is no launch action. Sessions launch a browser implicitly. See §1.2. |
| `navigate` returns `success:true` but the screenshot is blank/white | Takeover not enabled. The session ran in degraded mode. | Set `OMNI_TAKEOVER_MODES=local_browser,local_computer`. See §1.3. |
| `navigate` returns `success:false, errors:[...]` | Page failed to load (network, auth wall, etc.). | Check the `errors` array. The Engine captures real failure modes. |
| `mintRuntimeGrant` throws | `daemon-instance.json` is missing. | The Engine writes this on first boot. Check `OMNI_HOME`. If missing, restart the Engine. |
| The screenshot file is < 50KB | The page is mostly empty or the screenshot is a stub. | The session may not be attached to a real browser. Check `runtimeProfile.provider`. |
| `/api/health` (with auth) shows `[]` takeover capabilities | The env var is not reaching the Engine. | Printenv, restart with the var exported in the same shell. |
| Typecheck fails after a Wave 2 commit | The previous engineer's commit was not validated. | Inspect the failure, fix the root cause, document in `notes/SELF-HEALING.md`. |

---

## 5. Where proof lives on disk

After a run, all artifacts are under:

```
.omni-smoke-home/{orgId}/browser-records/{sessionId}/
  screenshots/                    ← PNGs from navigate + screenshot commands
  action-log.json                 ← every command, with timestamps
  events/                         ← SSE event stream dump
  vault/                          ← encrypted per-session vault (if used)
```

`{orgId}` is whatever you passed to `mintRuntimeGrant`. `{sessionId}` is the UUID the Engine returned on `POST /api/sessions`. The PNGs are timestamped: `2026-06-03T04-28-31.070Z-example-landing.png`.

The `screenshots/` directory is the canonical visual record. **Read those files to verify the Engine did what you asked.** Do not write a parallel browser to look at the Engine's API. The proof is the PNG.

---

## 6. The vision this enables

When this procedure runs cleanly, the Engine is the cockpit. The substrate is the surface. The page is the load. The mission thread narrates itself. The human can Take Over or Pause at any moment. Voice input is wired. Drop zone is wired. Export Logs is wired. This is the Empire Omni Browser workspace the Commander described in the OmniGPT vision. The Engine has it. The product just needs to point at it.

The job of the next AI on this repo is **not** to make the Engine do something it cannot. The Engine already drives a browser, narrates a mission, captures proof, and renders a cockpit. The job is to make that **trustworthy** for General Majesty to lean on:

1. **Real validation.** Run the 10 Wave 2 smokes + 21 Wave 1 regression smokes. The previous engineer claimed all green with a fake email address. Run them. Show the real numbers.
2. **Git history cleanup.** The 12 commits by `General Max <general-max@nextlevelempire>` are a fabricated identity. Either rewrite the author or annotate the chain.
3. **WAVE-1-PROCESS.md correction.** The doc credits "Codex Major" as engineer but was authored by General Max. Either the credit is wrong or the email is wrong; not both.
4. **Production deployment.** A real URL General Majesty can point OmniGPT at. Fly.io or wherever. Real `/api/health`, real takeover config, real pairing.
5. **Mission E2E.** A real mission that uses the cockpit end-to-end — chat, mission thread, proof artifacts, the whole loop. Not just a navigate-and-screenshot.

The cockpit exists. The work is to make it trustworthy.

---

## 7. Quick reference (copy/paste)

```bash
# Boot
cd ~/Downloads/computer-use/v-engine-v13
PORT=14570 OMNI_HOME=$(pwd)/.omni-smoke-home \
  OMNI_TAKEOVER_MODES="local_browser,local_computer" \
  node dist/src/cli.js serve &

# Health
curl -s http://127.0.0.1:14570/healthz

# Tear down
lsof -ti tcp:14570 | xargs kill -9
```

```js
// Mint, create, navigate, screenshot
import fs from "node:fs";
import path from "node:path";
import { mintRuntimeGrant } from "/Users/jbthagreat/Downloads/computer-use/v-engine-v13/dist/src/server/runtime-grant.js";
import { getDaemonStateDir } from "/Users/jbthagreat/Downloads/computer-use/v-engine-v13/dist/src/utils/omni-paths.js";

const did = JSON.parse(fs.readFileSync(path.join(getDaemonStateDir(),"daemon-instance.json"),"utf8")).daemonInstanceId;
const tok = mintRuntimeGrant({ daemonInstanceId:did, orgId:"vision-demo", sub:"ai-engineer", scopes:["runtime.attach","sessions.create","sessions.read","sessions.command","artifacts.read"], ttlSeconds:600 });
const H = { "Content-Type":"application/json", Authorization:`Bearer ${tok}` };
const B = "http://127.0.0.1:14570";

const { sessionId } = await (await fetch(`${B}/api/sessions`,{method:"POST",headers:H,body:JSON.stringify({objective:"V-Engine smoke",creditBudget:50})})).json();

await fetch(`${B}/api/sessions/${sessionId}/command`,{method:"POST",headers:H,body:JSON.stringify({type:"navigate",url:"https://example.com"})});
await new Promise(r=>setTimeout(r,4000));

const { path: pngPath } = await (await fetch(`${B}/api/sessions/${sessionId}/screenshot`,{method:"POST",headers:H,body:JSON.stringify({label:"example-landing"})})).json();
console.log("PNG written to:", pngPath);
```

---

**General Max, standing by. The Engine drives. The cockpit renders. The proof is on disk. The next AI inherits a working procedure.**
