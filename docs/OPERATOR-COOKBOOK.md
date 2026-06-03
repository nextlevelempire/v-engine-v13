# V-Engine Operator Cookbook

**Audience:** anyone who needs to drive a real browser session through the V-Engine from a shell, a CI job, or a future operator UI. Assumes you can run `pnpm`, `curl`, and have a Chrome install (system or Playwright's bundled chromium).

**Source of truth:** `V-ENGINE.md` (API reference) and `ARCHITECTURE.md` (system map). This document is the recipes; those are the contracts.

---

## 1. Boot the engine

```bash
# Required env
export PORT=14570                                    # any free port; default 4011
export OMNI_HOME=$HOME/.omni-smoke-home-cookbook    # any writable dir; daemon state lives here
export OMNI_TAKEOVER_MODES="local_browser,local_computer"  # unlock takeover gates
export OMNI_LOG_LEVEL=info                            # debug | info | warn | error

# Optional: headed mode (visible Chrome window)
export OMNI_ALLOW_HEADLESS_FALLBACK=0                 # 0 = headed, 1 = allow fallback
export OMNI_CHROME_EXECUTABLE="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

# Build (only needed after source changes)
pnpm run build:server

# Boot
node dist/src/cli.js serve
# → "[omni-browser-v4] listening on http://127.0.0.1:14570"
```

The engine binds `127.0.0.1` by default (`OMNI_LISTEN_HOST`). To expose on the network, set `OMNI_LISTEN_HOST=0.0.0.0`.

## 2. Verify the engine is up

```bash
curl -s http://127.0.0.1:14570/healthz     # 200, no auth
curl -s http://127.0.0.1:14570/livez      # 200, no auth
curl -s http://127.0.0.1:14570/readyz     # 200 unless OMNI_SHUTTING_DOWN=1
```

All three are scope-free K8s-style probes. `OMNI_SHUTTING_DOWN=1` flips `/readyz` to 503.

## 3. Mint a runtime grant

The engine requires an HMAC-signed runtime grant on every `/api/*` call. The CLI does the mint:

```bash
pnpm run mint-grant
# → prints:
#   export OMNI_TOKEN='eyJhbGc...'
#   curl -s -H "Authorization: Bearer $OMNI_TOKEN" http://127.0.0.1:14570/api/whoami
#   ...

export OMNI_TOKEN='...'   # paste the printed token
```

Customize the grant:

```bash
OMNI_GRANT_ORG=acme OMNI_GRANT_SUB=alice OMNI_GRANT_TTL=60 pnpm run mint-grant
```

`OMNI_GRANT_TTL` is in seconds. The default 600s is plenty for a single mission.

## 4. Confirm the grant is valid

```bash
curl -s -H "Authorization: Bearer $OMNI_TOKEN" http://127.0.0.1:14570/api/whoami
# → { "claims": { "daemonInstanceId": "...", "orgId": "operator", "sub": "operator-cli",
#                  "scopes": [...], "exp": 1780..., "iat": 1780... },
#      "daemonInstanceId": "...",
#      "tenantScoping": "off" }
```

If you get `401`, the token is either expired (`exp` in the past) or signed against a different daemon instance id. Re-run `pnpm run mint-grant` after a server restart — the daemon instance id changes whenever the engine boots fresh.

## 5. Discover the API surface

```bash
# JSON Schema for all 33 commands
curl -s -H "Authorization: Bearer $OMNI_TOKEN" http://127.0.0.1:14570/api/commands | jq '.count, .commandNames'
# → 33
# → ["navigate", "click", "type", "screenshot", "pause", "resume", "status",
#    "computer", "directive", "assistant_reply", "right_click", "double_click",
#    "hover", "shortcut", "drag", "scroll", "file_upload", "file_download",
#    "screenshot_element", "fill_form", "scroll_until", "enter_frame",
#    "exit_frame", "shadow_click", "plan", "execute_plan", "next_step",
#    "describe_page", "find", "wait_for", "detect_captcha", "wait_for_human",
#    "navigate_with_fallback", "close"]

# Feature flags (returns 0 flags unless you've set OMNI_FEATURE_* env vars)
curl -s -H "Authorization: Bearer $OMNI_TOKEN" http://127.0.0.1:14570/api/features
```

## 6. Drive a real mission

### 6.1 Create a session

```bash
SID=$(curl -s -X POST -H "Authorization: Bearer $OMNI_TOKEN" -H "content-type: application/json" \
  -d '{"objective":"hello world","creditBudget":200,"viewport":{"width":1280,"height":800},"locale":"en-US","timezoneId":"America/Los_Angeles","colorScheme":"dark"}' \
  http://127.0.0.1:14570/api/sessions | jq -r .sessionId)
echo "session=$SID"
```

Available session options (Wave 1 + 2): `sessionId` (pre-generate), `objective`, `creditBudget` (default 0), `persistent` (default false), `policyVersion`, `operatorSessionId`, `orgId`, `userId`, `viewport`, `userAgent`, `locale`, `timezoneId`, `geolocation`, `permissions`, `colorScheme`, `device` (Playwright device name like "iPhone 12").

### 6.2 Send commands

```bash
H="-H Authorization:Bearer\ $OMNI_TOKEN -H content-type:application/json"

# Navigate
curl -s -X POST $H -d '{"type":"navigate","url":"https://tryomnigpt.com"}' \
  http://127.0.0.1:14570/api/sessions/$SID/command

# Wait for the page to settle
sleep 2

# Screenshot (POST, not GET — the response is JSON with a path to a PNG on disk)
curl -s -X POST $H -d '{"type":"screenshot","label":"after-navigate"}' \
  http://127.0.0.1:14570/api/sessions/$SID/command | jq -r '.result.result.path'
# → /Users/.../browser-records/<userId>/<sessionId>/screenshots/2026-06-03T...-after-navigate.png
```

### 6.3 Get page context (lighter than describe_page)

```bash
curl -s -H "Authorization: Bearer $OMNI_TOKEN" \
  http://127.0.0.1:14570/api/sessions/$SID/context
# → { sessionId, runtime, url, title, axSummary (2000 chars), axTreeHash,
#      authWallHint, captchaHint, capturedAt }
```

### 6.4 Find an element by text

```bash
curl -s -X POST $H -d '{"type":"find","text":"Get Started","fuzzy":true}' \
  http://127.0.0.1:14570/api/sessions/$SID/command
# → { count, fuzzy, matches: [{ match_index, selector, label }], query }
```

### 6.5 Click + type + key

```bash
# Click using a selector
curl -s -X POST $H -d '{"type":"click","selector":"button:has-text(\"Get Started\")"}' \
  http://127.0.0.1:14570/api/sessions/$SID/command

# Type into a field
curl -s -X POST $H -d '{"type":"type","selector":"input[name=email]","text":"hello@example.com"}' \
  http://127.0.0.1:14570/api/sessions/$SID/command

# Keyboard shortcut
curl -s -X POST $H -d '{"type":"shortcut","keys":["Control","a"]}' \
  http://127.0.0.1:14570/api/sessions/$SID/command
# Note: there's no "key" command — use "shortcut" with an array of key names.
```

### 6.6 Pause / resume / status

```bash
curl -s -X POST $H -d '{"type":"pause","reason":"waiting for human"}' \
  http://127.0.0.1:14570/api/sessions/$SID/command
curl -s -X POST $H -d '{"type":"resume"}' \
  http://127.0.0.1:14570/api/sessions/$SID/command
curl -s -X POST $H -d '{"type":"status"}' \
  http://127.0.0.1:14570/api/sessions/$SID/command
```

### 6.7 Close the session

```bash
curl -s -X POST $H -d '{"type":"close","reason":"mission complete"}' \
  http://127.0.0.1:14570/api/sessions/$SID/command
# → { ok: true, result: { ok: true, sessionId, closed: true, reason: "..." } }
```

There is no `DELETE /api/sessions/{id}` route. Use the `close` SessionCommand.

## 7. See the proof

PNGs land at:

```
${OMNI_HOME}/{userId}/browser-records/{sessionId}/screenshots/{ISO-timestamp}-{label}.png
```

The `{userId}` segment comes from the grant's `sub` claim, not the `orgId`. A grant with `sub: "codex-major"` writes to `codex-major/`. A grant with `sub: "operator-cli"` writes to `operator-cli/`.

To list every screenshot for a session:

```bash
curl -s -H "Authorization: Bearer $OMNI_TOKEN" \
  http://127.0.0.1:14570/api/sessions/$SID/screenshots | jq '.screenshots[].path'
```

## 8. Watch the live mission thread (SSE)

```bash
curl -N -H "Authorization: Bearer $OMNI_TOKEN" \
  http://127.0.0.1:14570/api/sessions/$SID/events
```

Event types you'll see: `stream.ready`, `session.snapshot`, `command.started`, `execution`, `mission_log`, `observation.captured`, `verification.result`, `command.completed`, plus `error.typed` on errors and `captcha.detected` / `captcha.handoff` on CAPTCHA walls.

The Empire Omni Browser HUD on the page itself is a separate concern — the engine injects the cockpit overlay into every page it drives (left mission panel + right collaboration panel). The PNGs show the HUD overlaid on the target page.

## 9. Use the operator UI (cockpit)

The engine serves `client/index.html` at `GET /` if the file exists at `dist/client/index.html`.

```bash
# After building, the file is in place automatically.
# Open in a browser:
open http://127.0.0.1:14570/
# Paste a runtime grant (from `pnpm run mint-grant`) into the auth input.
# Click "+ New Mission" — the SSE consumer in the right panel streams events live.
# Use the chat input: `navigate https://example.com`, `find "Sign In"`, `close`, etc.
```

The cockpit is vanilla HTML/CSS/JS. No build step. Single file. Dark mode by default.

## 10. Run a 3-session stress test

`/tmp/v-engine-demo/stress.mjs` (not in the repo — see SELF-HEALING.md H-05) creates 3 parallel sessions against tryomnigpt.com, example.com, and wikipedia.org, navigates each, screenshots each, closes each. Run it from any working tree:

```bash
node /tmp/v-engine-demo/stress.mjs
# → 3/3 concurrent missions completed cleanly
```

For more than 3 concurrent sessions, raise the cap: `OMNI_MAX_PARALLEL_SESSIONS=20 node dist/src/cli.js serve`.

## 11. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `pnpm run mint-grant` → `no daemon-instance.json` | engine not running | `node dist/src/cli.js serve` in another shell, then re-run |
| `GET /api/whoami` → 401 | grant expired or wrong daemon id | re-run `pnpm run mint-grant`; grants are 600s default |
| `POST /api/sessions/{id}/command` → 402 `budget.exceeded` | `creditBudget` too low | create a new session with `creditBudget: 500+` |
| `POST /api/sessions/{id}/command` → 429 `rate_limited` | too many requests in the window | wait `retry_after_ms`, then retry |
| `POST /api/sessions/{id}/command` → 400 `validation` | wrong command shape | check `GET /api/commands` for the schema |
| `POST /api/sessions/{id}/command` → 500 plain error | bug in the engine | check `notes/SELF-HEALING.md` for known issues; capture the request + response and file a regression |
| `navigate` hangs forever | headed mode but no display | set `OMNI_ALLOW_HEADLESS_FALLBACK=1` |
| `client/index.html` not served at `GET /` | file missing from `dist/client/` | `cp client/index.html dist/client/index.html` |
| Screenshot path is `undefined` in the response | result is wrapped | the response is `{ok, result: {ok, result: {path, label, sessionId}}}` — unwrap twice |

## 12. Reference

- **API contracts:** `V-ENGINE.md`
- **System architecture:** `docs/ARCHITECTURE.md`
- **Bug + fix log:** `notes/SELF-HEALING.md`
- **Launch gotchas:** `docs/V-ENGINE-LAUNCH-PROCEDURE.md` (4 known gotchas: screenshot is POST, no launch action, takeover env var, screenshots-to-disk)
- **Hardening plan:** `docs/PLAN-ENGINE-HARDENING.md`
- **Wave 1 journal:** `notes/wave-1.md`
- **Demo scripts:** `/tmp/v-engine-demo/{mission,stress,verify-fixes}.mjs`
