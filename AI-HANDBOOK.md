# V-Engine AI Handbook — Complete Activation & Operating Guide

> **For any AI reading this:** This document is your complete brief. Read it top to bottom once. You will know exactly how to activate, command, and observe the V-Engine from any language or framework.

**Version:** v0.3 (Wave 1 + Wave 2 shipped)  
**Repo:** `v-engine-v13` branch `wave/2-ai-capability`  
**Port:** `4011` (default; `OMNI_PORT` overrides)  
**Architecture:** HTTP + Server-Sent Events  
**Proof of life:** `GET /api/health` — must return `"ok": true`

---

## 1. ARCHITECTURE — The Body and the Brain

The V-Engine is the **Body**. You are the **Brain**.

```
YOU (AI with vision + reasoning)
        │
        │  POST /api/sessions/:id/command   ← you send commands
        │  GET  /api/sessions/:id/events    ← you receive events (SSE)
        │  GET  /api/sessions/:id/context   ← you read page state
        ▼
V-ENGINE (Node.js + Playwright + nut.js)
        │
        ▼
  Real Chromium browser → Real websites
```

The V-Engine does NOT reason or plan. It executes physical actions (click, type, navigate, screenshot) and returns rich data. You reason over that data and issue the next command. You are the only intelligence in this loop.

**What the V-Engine gives you:**
- A real Chromium browser controlled via Playwright
- Screenshots delivered in the SSE stream and on request
- AX accessibility tree of every page (text representation of all interactive elements)
- Credential vault (encrypted, TOTP-capable)
- Shell execution sandbox
- Parallel multi-session orchestration
- Context compressor (keeps your conversation memory from overflowing on long missions)

---

## 2. PREREQUISITES

```bash
# Node.js 20+ required
node --version   # must be >= 20.0.0

# Install dependencies
cd v-engine-v13
pnpm install     # or npm install

# Install Playwright browsers (Chromium)
npx playwright install chromium

# Optional: nut.js for desktop takeover (keyboard/mouse at OS level)
# On macOS: grant Accessibility permissions in System Preferences
# On Linux: sudo apt-get install libxtst-dev xdotool
```

---

## 3. START THE SERVER

### Minimum viable start (development)
```bash
cd v-engine-v13
OMNI_DASHBOARD_JWT_SECRET=your-32-char-secret pnpm run dev
```

### Production start
```bash
cd v-engine-v13
pnpm run build:server
OMNI_DASHBOARD_JWT_SECRET=your-32-char-secret \
OMNI_PORT=4011 \
OMNI_HOME=/data/omni-browser \
node dist/server/cli.js
```

### Full-power start (all Wave 2 features enabled)
```bash
OMNI_DASHBOARD_JWT_SECRET=your-32-char-secret \
OMNI_VAULT_KEY=your-32-char-vault-encryption-key!! \
OMNI_SHELL_ENABLED=1 \
OMNI_SCREENSHOT_IN_EVENTS=1 \
OMNI_TAKEOVER_MODES=local_browser,local_computer \
OMNI_LLM_PROVIDER=anthropic \
OMNI_AUTO_CONSENT=1 \
OMNI_MAX_PARALLEL=5 \
node dist/server/cli.js
```

### Verify the server is alive
```bash
curl http://127.0.0.1:4011/api/health
# Expected: {"ok":true,"transport":"http+sse","daemonInstanceId":"...","version":"4.0.0","capabilities":["browser"]}
```

---

## 4. AUTHENTICATION — Mint a Runtime Grant Token

Every API call requires a signed JWT. Generate one with Node.js:

```javascript
import crypto from "node:crypto";

function mintGrant({ secret, daemonInstanceId, orgId, sub, scopes, ttlMs = 300_000 }) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: "omni-runtime",
    sub,
    orgId,
    daemonInstanceId,
    scopes,
    exp: Math.floor((Date.now() + ttlMs) / 1000),
    iat: Math.floor(Date.now() / 1000),
  })).toString("base64url");
  const sig = crypto
    .createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${sig}`;
}

// Usage:
const token = mintGrant({
  secret: process.env.OMNI_DASHBOARD_JWT_SECRET,
  daemonInstanceId: "get-this-from-GET /api/health response",
  orgId: "my-org",
  sub: "my-agent",
  scopes: ["sessions.create", "sessions.command", "sessions.read", "vault.read", "vault.write"],
});
```

**Get the `daemonInstanceId` first:**
```bash
curl http://127.0.0.1:4011/api/health | jq .daemonInstanceId
```

**Send the token with every request:**
```
Authorization: Bearer <token>
```

**Token lifetime:** 5 minutes default. Mint a fresh one before it expires. The server returns `401` with `code: "OMNI_AUTH_EXPIRED"` when a token is expired.

---

## 5. CREATING A SESSION

```bash
curl -X POST http://127.0.0.1:4011/api/sessions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "objective": "Research AI news on Hacker News",
    "creditBudget": 100,
    "persistent": false,
    "viewport": { "width": 1280, "height": 720 }
  }'
```

**Response (201):**
```json
{
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "launching",
  "createdAt": "2026-06-03T12:00:00.000Z",
  "objective": "Research AI news on Hacker News",
  "creditBudget": 100,
  "remainingBudget": 100,
  "orgId": "my-org",
  "userId": "my-agent"
}
```

Save the `sessionId` — you need it for every subsequent call.

---

## 6. COMPLETE COMMAND REFERENCE (43 COMMANDS)

All commands go to:
```
POST /api/sessions/:sessionId/command
Authorization: Bearer <token>
Content-Type: application/json
```

### GROUP 1 — Navigation & Page Control (10 commands)

#### navigate
```json
{ "type": "navigate", "url": "https://news.ycombinator.com" }
```
Response: `{ "ok": true, "result": { "url": "...", "title": "..." } }`  
After navigating, always wait before the next command (page needs to load).

#### click
```json
{ "type": "click", "selector": "button[type='submit']", "x": 640, "y": 360 }
```
`selector` (CSS) or `x`/`y` coordinates. At least one required.

#### type
```json
{ "type": "type", "selector": "input[name='q']", "text": "OmniGPT browser automation" }
```
Types text into the focused or targeted element. Uses human-like timing.

#### screenshot
```json
{ "type": "screenshot", "label": "after-login" }
```
Writes PNG to disk. Returns `{ "ok": true, "result": { "path": "...", "label": "...", "sessionId": "..." } }`.  
Read the file at `path` from the filesystem. Not returned inline (use context endpoint for inline base64).

#### status
```json
{ "type": "status" }
```
Returns the current runtime status: `{ "ok": true, "result": { "currentUrl": "...", "humanControl": false, "paused": false, ... } }`

#### pause
```json
{ "type": "pause", "reason": "Waiting for human to solve CAPTCHA" }
```
Pauses the agent loop. Human takes control. Session stays alive.

#### resume
```json
{ "type": "resume", "reason": "Human completed CAPTCHA, resuming" }
```
Resumes after a pause. **Always send resume before commands that require human-control to be released.**

#### assistant_reply
```json
{ "type": "assistant_reply", "content": "I found 5 results. Here is the summary..." }
```
Writes a message to the mission scratchpad thread (visible to the human operator).

#### directive
```json
{ "type": "directive", "goal": "Find the top 3 AI stories on Hacker News and summarize them" }
```
**The most powerful command.** When `OMNI_LLM_PROVIDER` is set, this activates the autonomous agent loop — the engine uses the connected AI to execute the goal step by step without human intervention. The agent THINK→EXECUTE→REFLECT loop runs until the goal is complete or `max_iterations` is hit.

#### computer
```json
{ "type": "computer", "action": { "type": "shortcut", "keys": ["LeftControl", "A"] } }
```
Raw passthrough to the local computer controller. Requires `local_computer` in `OMNI_TAKEOVER_MODES`.

---

### GROUP 2 — High-Level Browser Actions (14 commands)

#### scroll
```json
{ "type": "scroll", "direction": "down", "amount": 500 }
```

#### hover
```json
{ "type": "hover", "selector": ".nav-menu" }
```

#### right_click
```json
{ "type": "right_click", "selector": ".file-item" }
```

#### double_click
```json
{ "type": "double_click", "selector": ".icon" }
```

#### shortcut
```json
{ "type": "shortcut", "keys": ["LeftControl", "A"] }
```
**CRITICAL:** Use nut.js key names exactly:
- Ctrl: `LeftControl` or `RightControl` (NOT `Control`, NOT `ctrl`)
- Cmd (macOS): `LeftSuper` or `RightSuper`
- Alt: `LeftAlt` or `RightAlt`
- Letters: `A`–`Z` uppercase (NOT `a`–`z`)
- Function keys: `F1`–`F12`
- Special: `Enter`, `Tab`, `Escape`, `Space`, `Backspace`, `Delete`
- Arrows: `Up`, `Down`, `Left`, `Right`

#### drag
```json
{ "type": "drag", "fromSelector": ".draggable", "toSelector": ".drop-zone" }
```

#### file_upload
```json
{ "type": "file_upload", "selector": "input[type='file']", "filePath": "/tmp/resume.pdf" }
```

#### file_download
```json
{ "type": "file_download", "url": "https://example.com/file.pdf", "savePath": "/tmp/file.pdf" }
```

#### screenshot_element
```json
{ "type": "screenshot_element", "selector": ".chart-container", "label": "revenue-chart" }
```

#### fill_form
```json
{
  "type": "fill_form",
  "fields": [
    { "selector": "input[name='email']", "value": "user@example.com" },
    { "selector": "input[name='name']", "value": "John Doe" }
  ]
}
```
Requires `local_computer` in `OMNI_TAKEOVER_MODES`.

#### scroll_until
```json
{ "type": "scroll_until", "selector": ".load-more-button", "maxScrolls": 10 }
```
Scrolls until the target element is visible or max scrolls reached.

#### enter_frame
```json
{ "type": "enter_frame", "selector": "iframe#content-frame" }
```
Enter an iframe context. All subsequent commands target that frame.

#### exit_frame
```json
{ "type": "exit_frame" }
```
Return to main page context from an iframe.

#### shadow_click
```json
{ "type": "shadow_click", "hostSelector": "my-web-component", "shadowSelector": "button.inner" }
```
Click inside a Shadow DOM element.

---

### GROUP 3 — AI Helper Commands (6 commands)

These require an AI provider configured OR work as structured planning tools.

#### plan
```json
{ "type": "plan", "goal": "Buy a flight ticket from NYC to LA for next Friday" }
```
Generates a structured plan (array of steps) for the given goal. Returns `plan_id` and step list.

#### execute_plan
```json
{ "type": "execute_plan", "plan_id": "plan-uuid-here" }
```
Executes all steps of a previously created plan sequentially.

#### next_step
```json
{ "type": "next_step", "plan_id": "plan-uuid-here", "step_index": 2 }
```
Execute a single step of a plan by index.

#### describe_page
```json
{ "type": "describe_page" }
```
Returns a rich description of the current page including AX tree, visible text, interactive elements, and form fields. More detailed than the context endpoint.

#### find
```json
{ "type": "find", "query": "the checkout button" }
```
Finds an element matching a natural-language description. Returns a CSS selector you can use in subsequent commands.

#### wait_for
```json
{ "type": "wait_for", "condition": "the loading spinner disappears", "timeout_ms": 10000 }
```
Waits until a condition is met (AX tree polling) or times out.

---

### GROUP 4 — CAPTCHA Commands (3 commands)

#### detect_captcha
```json
{ "type": "detect_captcha" }
```
Scans the current page for CAPTCHA challenges. Returns `{ "detected": true/false, "type": "recaptcha_v2/hcaptcha/..." }`.

#### wait_for_human
```json
{ "type": "wait_for_human", "reason": "CAPTCHA detected — please solve it", "timeout_ms": 120000 }
```
Pauses the session and notifies the human operator to take action.

#### navigate_with_fallback
```json
{ "type": "navigate_with_fallback", "url": "https://target-site.com", "fallback_url": "https://fallback.com" }
```
Navigates to `url`; if CAPTCHA or auth wall detected, navigates to `fallback_url` instead.

---

### GROUP 5 — Credential Vault Commands (4 commands)

**Requires:** `OMNI_VAULT_KEY` env var (32+ character secret)

#### vault_store
```json
{
  "type": "vault_store",
  "hostname": "github.com",
  "username": "myuser",
  "password": "mysecretpassword",
  "totpSecret": "BASE32TOTPSEED",
  "notes": "personal account"
}
```
Stores credentials encrypted with AES-256-GCM. The safety rail that normally blocks password entry does NOT apply here — vault credentials are pre-authorized by the user.

#### vault_fill
```json
{ "type": "vault_fill", "hostname": "github.com" }
```
Looks up credentials for `hostname` in the vault, then automatically fills the username + password fields on the current page. Bypasses the password-entry safety rail.

#### vault_fill_totp
```json
{ "type": "vault_fill_totp", "hostname": "github.com" }
```
Generates the current 6-digit TOTP code from the vault entry's `totpSecret` using RFC 6238 (pure math, no external service) and types it into the focused field.

#### vault_list
```json
{ "type": "vault_list" }
```
Returns all vault entries (hostnames only, no passwords exposed). Response: `{ "ok": true, "result": { "entries": ["github.com", "google.com"] } }`

---

### GROUP 6 — Power Commands (3 commands)

#### search
```json
{
  "type": "search",
  "query": "best AI browser automation tools 2026",
  "engine": "google",
  "num_results": 10
}
```
`engine` options: `"google"` (requires `OMNI_SERPAPI_KEY`), `"bing"`, `"ddg"`, `"news"`.  
Falls back to navigating the search engine UI if no API key.  
Returns structured results: `[{ "title": "...", "url": "...", "snippet": "..." }]`

#### shell
```json
{ "type": "shell", "command": "ls ~/Downloads | head -20", "timeout_ms": 10000 }
```
**Requires:** `OMNI_SHELL_ENABLED=1`  
Executes in a sandboxed subprocess. Blocked: `sudo`, `rm -rf /`, `.ssh`, `/etc/passwd`, `/private`.  
Returns: `{ "ok": true, "result": { "stdout": "...", "stderr": "...", "exitCode": 0 } }`

#### parallel
```json
{
  "type": "parallel",
  "tasks": [
    "Navigate to https://techcrunch.com and summarize the top headline",
    "Navigate to https://bbc.com/news and summarize the top headline",
    "Navigate to https://news.ycombinator.com and list the top 3 stories"
  ],
  "max_concurrency": 3,
  "credit_budget_per_task": 10
}
```
Spawns N browser sessions simultaneously, runs each task, returns merged results. Cap: `OMNI_MAX_PARALLEL` (default 5). Use this to do in 2 minutes what sequential execution takes 20 minutes.

---

## 7. READING PAGE STATE (The Context Endpoint)

After every command, poll the context endpoint to see what the browser shows:

```bash
GET /api/sessions/:sessionId/context
Authorization: Bearer <token>
```

**Response:**
```json
{
  "sessionId": "550e8400...",
  "runtime": "local",
  "url": "https://news.ycombinator.com",
  "title": "Hacker News",
  "axSummary": "heading: Hacker News\nlink: Ask HN\nlink: Show HN\n...(2000 chars max)...",
  "axTreeHash": "sha256:abc123...",
  "authWallHint": "none",
  "captchaHint": "none",
  "capturedAt": "2026-06-03T12:01:00.000Z"
}
```

**Key fields:**
- `axSummary` — AX accessibility tree of the page. This is your primary way to understand what's on screen. Interactive elements (buttons, inputs, links) are prioritized over static text.
- `axTreeHash` — Hash of the AX tree. If this changes between polls, the page changed.
- `authWallHint` — `"none"`, `"google_oauth"`, `"email_password"`, etc. Tells you if a login wall is present.
- `captchaHint` — `"none"`, `"recaptcha_v2"`, `"hcaptcha"`, etc.

**When `OMNI_SCREENSHOT_IN_EVENTS=1`:** The SSE stream includes `screenshotBase64` in every `observation.captured` event. If you are a vision model, you can literally see the browser screen in your event stream.

---

## 8. THE SSE EVENT STREAM

Subscribe to events for real-time feedback:

```bash
curl -N -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:4011/api/sessions/$SESSION_ID/events"
```

**Event format:**
```
event: execution
data: {"sessionId":"...","eventId":"...","timestamp":"...","data":{"commandType":"navigate","ok":true,"result":{"url":"...","title":"..."}}}

event: observation.captured
data: {"sessionId":"...","data":{"label":"auto","path":"/path/to/screenshot.png","screenshotBase64":"iVBOR..."}}
```

**Key event types:**
| Event | Meaning |
|---|---|
| `execution` | A command completed (success or failure) |
| `observation.captured` | Screenshot taken; includes `screenshotBase64` if enabled |
| `checkpoint.created` | Session state snapshot saved |
| `handoff.requested` | Agent needs human help |
| `captcha.detected` | CAPTCHA found on page |
| `plan.created` | AI helper created a plan |
| `plan.completed` | Plan finished; includes steps completed/failed |
| `error.typed` | Typed error with `code`, `message`, `hint`, `retry_after_ms` |
| `session.evicted` | Parallel cap hit, session was evicted |

---

## 9. READING SESSION STATUS

```bash
GET /api/sessions/:sessionId
Authorization: Bearer <token>
```

**Response shape:**
```json
{
  "metadata": {
    "sessionId": "550e8400...",
    "agentId": "my-agent",
    "orgId": "my-org",
    "objective": "Research AI news",
    "createdAt": "...",
    "lastActiveAt": "...",
    "commandCount": 5,
    "creditBudget": 100,
    "remainingBudget": 95,
    "status": { "currentUrl": "...", "humanControl": false, "paused": false, ... },
    "persistent": false
  },
  "runtime": {
    "currentUrl": "https://news.ycombinator.com",
    "humanControl": false,
    "paused": false,
    "executing": false,
    "sessionId": "550e8400..."
  }
}
```

**CRITICAL:** There is NO top-level `state` field. The response has `metadata` and `runtime`. Do not look for `body.state`.

---

## 10. ENVIRONMENT VARIABLES — Complete Reference

### Core (required in production)
| Variable | Required | Description |
|---|---|---|
| `OMNI_DASHBOARD_JWT_SECRET` | YES | 32+ char HMAC secret for signing/verifying runtime grants |
| `OMNI_PORT` | no (4011) | HTTP port |
| `OMNI_HOME` | no (~/.omni-browser) | Storage root for sessions, screenshots, vault |
| `OMNI_LISTEN_HOST` | no (127.0.0.1) | Bind address. Set `0.0.0.0` to expose on network |

### Wave 2 Feature Flags
| Variable | Default | Description |
|---|---|---|
| `OMNI_VAULT_KEY` | unset | 32+ char key for AES-256-GCM credential vault encryption. Required for vault_* commands |
| `OMNI_SHELL_ENABLED` | `0` | Set `1` to enable the `shell` command sandbox |
| `OMNI_SCREENSHOT_IN_EVENTS` | `0` | Set `1` to include base64 screenshots in SSE `observation.captured` events |
| `OMNI_TAKEOVER_MODES` | unset | Comma-separated: `local_browser` (Playwright), `local_computer` (nut.js OS-level). Set both for full control |
| `OMNI_LLM_PROVIDER` | unset | Enable autonomous agent loop. Values: `anthropic`, `openai`, `google` |
| `OMNI_AUTO_CONSENT` | `0` | Set `1` to auto-click OAuth "Allow"/"Authorize" buttons |
| `OMNI_MAX_PARALLEL` | `5` | Max concurrent sessions for `parallel` command |
| `OMNI_SERPAPI_KEY` | unset | API key for SerpAPI-powered `search` command |

### LLM Keys (for autonomous agent loop)
| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API key (when `OMNI_LLM_PROVIDER=anthropic`) |
| `OPENAI_API_KEY` | OpenAI API key (when `OMNI_LLM_PROVIDER=openai`) |

### Security & Rate Limiting
| Variable | Default | Description |
|---|---|---|
| `OMNI_MAX_PARALLEL_SESSIONS` | `50` | Global concurrent session cap |
| `OMNI_AUTH_FAIL_LIMIT` | `10` | Max auth failures per (ip, token-prefix) before 429 |
| `OMNI_AUTH_FAIL_WINDOW_MS` | `60000` | Sliding window for auth-fail counter |
| `OMNI_CORS_ALLOWED_ORIGINS` | empty | Comma-separated allowed CORS origins |
| `OMNI_ALLOW_LOOPBACK_CORS` | `0` | Set `1` to allow localhost CORS |
| `OMNI_BODY_SIZE_LIMIT` | `10485760` | Max request body (10 MB). Returns 413 if exceeded |
| `OMNI_REQUEST_TIMEOUT_MS` | `60000` | Per-request hard timeout. Returns 504 if exceeded |

### Browser Configuration
| Variable | Default | Description |
|---|---|---|
| `STEALTH_LEVEL` | `off` | Anti-bot mode: `off`, `basic`, `aggressive` |
| `OMNI_VIEWPORT_WIDTH` | unset | Default viewport width (e.g., `1280`) |
| `OMNI_VIEWPORT_HEIGHT` | unset | Default viewport height (e.g., `720`) |
| `OMNI_USER_AGENT` | unset | Default user agent string |
| `OMNI_LOCALE` | unset | Default locale (e.g., `en-US`) |
| `OMNI_TIMEZONE` | unset | Default timezone (e.g., `America/Los_Angeles`) |
| `OMNI_ALLOW_HEADLESS_FALLBACK` | `0` | Allow headless Chrome if headed launch fails |

### Observability
| Variable | Default | Description |
|---|---|---|
| `OMNI_LOG_LEVEL` | `info` | Logging level: `debug`, `info`, `warn`, `error` |
| `OMNI_TELEMETRY_BUFFER_SIZE` | `1000` | Per-session console+network ring buffer size (max 10,000) |
| `OMNI_WEBHOOK_URL` | unset | Webhook URL for session/command events |
| `OMNI_WEBHOOK_SECRET` | unset | HMAC-SHA256 secret for webhook payload signing |

---

## 11. COMPLETE SESSION WORKFLOW

Here is a full working example (Node.js):

```javascript
import crypto from "node:crypto";

const BASE = "http://127.0.0.1:4011";
const SECRET = process.env.OMNI_DASHBOARD_JWT_SECRET;

// Step 1: Get the daemonInstanceId
const health = await fetch(`${BASE}/api/health`).then(r => r.json());
const daemonInstanceId = health.daemonInstanceId;

// Step 2: Mint a token
function mintGrant(daemonInstanceId) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: "omni-runtime", sub: "ai-agent", orgId: "my-org",
    daemonInstanceId, scopes: ["sessions.create", "sessions.command", "sessions.read"],
    exp: Math.floor((Date.now() + 300_000) / 1000),
    iat: Math.floor(Date.now() / 1000),
  })).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

const token = mintGrant(daemonInstanceId);
const headers = { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" };

// Step 3: Create a session
const session = await fetch(`${BASE}/api/sessions`, {
  method: "POST", headers,
  body: JSON.stringify({ objective: "Read top Hacker News stories", creditBudget: 50 })
}).then(r => r.json());
const { sessionId } = session;

// Step 4: Navigate to a real website
await fetch(`${BASE}/api/sessions/${sessionId}/command`, {
  method: "POST", headers,
  body: JSON.stringify({ type: "navigate", url: "https://news.ycombinator.com" })
}).then(r => r.json());

// Wait for page to load
await new Promise(r => setTimeout(r, 3000));

// Step 5: Read the page state
const context = await fetch(`${BASE}/api/sessions/${sessionId}/context`, { headers }).then(r => r.json());
console.log("Current URL:", context.url);
console.log("AX Tree:", context.axSummary.slice(0, 500));

// Step 6: Click a link
await fetch(`${BASE}/api/sessions/${sessionId}/command`, {
  method: "POST", headers,
  body: JSON.stringify({ type: "click", selector: ".titleline a" })
}).then(r => r.json());

// Step 7: Take a screenshot
const shot = await fetch(`${BASE}/api/sessions/${sessionId}/command`, {
  method: "POST", headers,
  body: JSON.stringify({ type: "screenshot", label: "hn-story" })
}).then(r => r.json());
console.log("Screenshot at:", shot.result?.path);
```

---

## 12. AUTONOMOUS AGENT LOOP (The directive Command)

When `OMNI_LLM_PROVIDER` is set, the `directive` command activates a full AI agent loop:

```json
{ "type": "directive", "goal": "Go to news.ycombinator.com, read the top 5 stories, and write a summary to the scratchpad" }
```

The loop runs THINK → EXECUTE → REFLECT until the goal is done. It:
1. Takes a screenshot + reads the AX tree
2. Reasons about what to do next
3. Executes the action
4. Checks if the goal is achieved
5. Repeats (up to `max_iterations`, default 25)

**Context compressor:** When the conversation history exceeds 20 messages, the engine automatically compresses it — keeps the system prompt + first 4 messages + a mid-point summary + the last 8 messages. This prevents context overflow on 50+ iteration missions.

**Circuit breaker:** If the last 5 actions are identical (stuck loop), the engine emits a `frustration_handoff` event and stops.

---

## 13. CREDENTIAL VAULT WORKFLOW (Login Automation)

Store credentials once, reuse forever:

```javascript
// Store credentials for a site
await command(sessionId, {
  type: "vault_store",
  hostname: "github.com",
  username: "myuser",
  password: "my-github-password",
  totpSecret: "BASE32TOTP" // optional, from your 2FA app
});

// Navigate to the login page
await command(sessionId, { type: "navigate", url: "https://github.com/login" });
await sleep(3000);

// Auto-fill username + password
await command(sessionId, { type: "vault_fill", hostname: "github.com" });
await sleep(1000);

// Click Sign In
await command(sessionId, { type: "click", selector: "input[type='submit']" });
await sleep(3000);

// Auto-fill 2FA code (if prompted)
await command(sessionId, { type: "vault_fill_totp", hostname: "github.com" });
```

---

## 14. ERROR HANDLING

All errors return:
```json
{
  "ok": false,
  "error": "Session not found",
  "code": "OMNI_NOT_FOUND",
  "httpStatus": 404,
  "hint": "Check the sessionId — it must belong to your orgId",
  "retry_after_ms": null
}
```

**Common error codes:**
| Code | HTTP | Meaning |
|---|---|---|
| `OMNI_AUTH_INVALID` | 401 | Bad/missing token |
| `OMNI_AUTH_EXPIRED` | 401 | Token expired — mint a new one |
| `OMNI_AUTH_SCOPE` | 403 | Token lacks required scope |
| `OMNI_NOT_FOUND` | 404 | Session not found |
| `OMNI_VALIDATION_ERROR` | 400 | Bad request body |
| `OMNI_REQUEST_TIMEOUT` | 504 | Command took > `OMNI_REQUEST_TIMEOUT_MS` |
| `OMNI_CAPABILITY_ERROR` | 403 | Feature not enabled (check env var) |

---

## 15. OBSERVABILITY ENDPOINTS

### Console logs from the browser
```bash
GET /api/sessions/:sessionId/console?limit=50
```
Returns browser console messages (newest first). Useful for debugging JS errors on pages.

### Network traffic
```bash
GET /api/sessions/:sessionId/network?limit=100
```
Returns captured request/response events. See what XHR calls the page is making.

### Action log
```bash
GET /api/sessions/:sessionId/action-log?limit=20&before=2026-06-03T12:00:00Z
```
Paginated log of all commands executed in this session.

### Screenshots timeline
```bash
GET /api/sessions/:sessionId/screenshots
```
All screenshots captured in this session with timestamps.

---

## 16. KNOWN GOTCHAS (Learned from 30 Real Tests)

1. **Session status shape:** `GET /api/sessions/:id` returns `{ metadata: {...}, runtime: {...} }`. There is NO top-level `state` field. `metadata.sessionId` is the session ID. `runtime.currentUrl` is the current URL.

2. **nut.js key names:** The `shortcut` command uses nut.js Key enum names. `Control` does not exist — use `LeftControl` or `RightControl`. Letters must be uppercase: `A` not `a`. See [nut.js Key enum](https://github.com/nut-tree/nut.js/blob/develop/packages/nut-js/lib/provider/native/template/keyboard-key.enum.ts) for the full list.

3. **Human control blocking:** If `runtime.humanControl === true`, commands will be blocked. Send `{ type: "resume" }` first.

4. **Session creation returns 201:** `POST /api/sessions` returns HTTP 201, not 200. Don't treat non-200 as an error here.

5. **Page load timing:** After `navigate`, wait at least 3 seconds before reading the context. Some SPAs need 5+. The engine waits for `networkidle` but client-side rendering continues after that.

6. **Vault requires OMNI_VAULT_KEY:** If `OMNI_VAULT_KEY` is unset, vault commands return `{ ok: false, reason: "vault_not_configured" }`. Set the key before using vault.

7. **Shell disabled by default:** `shell` command returns `{ ok: false }` unless `OMNI_SHELL_ENABLED=1` is set.

8. **local_computer for fill_form/shortcut:** Commands like `fill_form`, `shortcut`, `scroll` use `local_computer` takeover. Set `OMNI_TAKEOVER_MODES=local_browser,local_computer` or these commands return `"local_computer takeover is not enabled"`.

9. **TOTP is pure math:** `vault_fill_totp` generates TOTP codes using RFC 6238 math internally — no external service, no internet connection needed for this feature.

10. **PII redaction is always on:** The scratchpad scanner automatically redacts passwords, SSNs, credit card numbers, API keys from mission log entries. This is not configurable — it is always active.

---

## 17. TEST SUITE

The V-Engine includes a 30-test battery at `tests/v-engine-30-tests.ts`:

```bash
cd v-engine-v13
npx tsx tests/v-engine-30-tests.ts
```

Tests run against real websites (Wikipedia, DuckDuckGo). No fake/synthetic URLs. All 30 tests pass. See `tests/TEST-RESULTS.md` for the full test history and fix log.

---

## 18. QUICK REFERENCE CARD

```
START SERVER:    OMNI_DASHBOARD_JWT_SECRET=<secret> pnpm run dev
HEALTH CHECK:    GET /api/health
GET DAEMON ID:   curl /api/health | jq .daemonInstanceId
MINT TOKEN:      mintGrant({ secret, daemonInstanceId, orgId, sub, scopes })
CREATE SESSION:  POST /api/sessions  → { sessionId }
RUN COMMAND:     POST /api/sessions/:id/command  → { ok, result }
READ PAGE:       GET  /api/sessions/:id/context  → { url, axSummary, axTreeHash }
LIVE EVENTS:     GET  /api/sessions/:id/events   → SSE stream
SESSION STATE:   GET  /api/sessions/:id          → { metadata, runtime }
SCREENSHOTS:     GET  /api/sessions/:id/screenshots
CONSOLE LOGS:    GET  /api/sessions/:id/console
NETWORK EVENTS:  GET  /api/sessions/:id/network

KEY ENV VARS:
  OMNI_DASHBOARD_JWT_SECRET=<32-char-secret>       # REQUIRED
  OMNI_VAULT_KEY=<32-char-key>                      # vault_* commands
  OMNI_SHELL_ENABLED=1                              # shell command
  OMNI_SCREENSHOT_IN_EVENTS=1                       # base64 in SSE
  OMNI_TAKEOVER_MODES=local_browser,local_computer  # full control
  OMNI_LLM_PROVIDER=anthropic                       # autonomous loop
  ANTHROPIC_API_KEY=<key>                           # Claude for agent loop
```
