# V-Engine 30-Test Battery — Full Results History

**Test file:** `tests/v-engine-30-tests.ts`  
**Final score:** 30/30 (100%)  
**Real websites used:** Wikipedia, DuckDuckGo (no fake/synthetic URLs)

---

## FINAL RESULT — Round 4

**30/30 — ALL TESTS PASS**

```
T01: Server boots and /api/health returns ok                        PASS
T02: POST /api/sessions creates a session (status 200 or 201)       PASS
T03: GET /api/sessions lists all sessions                           PASS
T04: GET /api/sessions/:id/events returns SSE stream                PASS
T05: Minted grant token is valid (verifyRuntimeGrant)               PASS
T06: Expired grant token is rejected                                PASS
T07: Grant with wrong daemonInstanceId is rejected                  PASS
T08: navigate command sends browser to URL                          PASS
T09: screenshot command returns a path                              PASS
T10: Pause then resume round-trip                                   PASS
T11: POST /api/sessions returns 200 or 201                          PASS
T12: GET /api/sessions/:id returns session metadata + runtime       PASS
T13: AX tree is populated after navigation                          PASS
T14: Context endpoint returns URL + axSummary                       PASS
T15: Context axTreeHash is a non-empty string                       PASS
T16: Navigate to Wikipedia (Artificial Intelligence article)        PASS
T17: AX tree contains interactive elements from Wikipedia           PASS
T18: Credential vault stores and retrieves an entry                 PASS
T19: vault_fill command returns ok on current page                  PASS
T20: vault_list returns array of stored hostnames                   PASS
T21: Type search query into DuckDuckGo search box                   PASS
T22: Click DuckDuckGo search submit button                          PASS
T23: fill_form fills multiple fields on DDG page                    PASS
T24: scroll command scrolls the page                               PASS
T25: Keyboard shortcut LeftControl+A on DDG page (computer command) PASS
T26: Shell executor runs a simple command                           PASS
T27: Shell executor blocks dangerous commands (rm -rf /)            PASS
T28: PII redaction strips passwords from scratchpad entries         PASS
T29: Context compressor fires at 20+ messages                       PASS
T30: Context compressor fires at 20+ messages (stress: 28 msgs)     PASS

FINAL SCORE: 30/30 (100%)
```

---

## TEST HISTORY — All Rounds

### Round 1 — Initial Run
**Score: 24/30**

Failures:
- **T11:** Expected `status === 200` but `POST /api/sessions` returns `201 Created`. Fix: accept `200 || 201`.
- **T12:** Used wrong endpoint `/api/sessions/:id/status` (does not exist). Fix: changed to `/api/sessions/:id`.
- **T16:** Used `data:text/html,...` (synthetic URL). Fix: changed to `https://en.wikipedia.org/wiki/Artificial_intelligence`.
- **T22:** `click` command blocked because `humanControl === true`. Fix: send `resume` command before click.
- **T23–T25:** `"local_computer takeover is not enabled"` error. Fix: set `OMNI_TAKEOVER_MODES=local_browser,local_computer` in test env setup.
- **T25:** Used `keys: ["Control", "a"]` — nut.js has no `Control` key and no lowercase letters. Fix: changed to `["LeftControl", "A"]`.

### Round 2 — After Round 1 Fixes
**Score: 27/30**

Remaining failures:
- **T12:** Test still asserted `typeof b.state === "string"` but real response has `{ metadata, runtime }` — no top-level `state`. Root cause: misread the API shape.
- **T16:** Test still used `https://example.com` (placeholder). Commander order: FORBIDDEN to use fake data. Changed to Wikipedia.
- **T22–T24:** Human-control state still blocking some interaction tests on DuckDuckGo.

### Round 3 — After Round 2 Fixes
**Score: 28/30**

Remaining failures:
- **T12:** Assertion `typeof b.state === "string"` — STILL wrong. The real endpoint returns:
  ```json
  { "metadata": { "sessionId": "...", ... }, "runtime": { "currentUrl": "...", ... } }
  ```
  There is NO `state` field at any level. Fixed assertion to check `b.metadata.sessionId` and `b.runtime`.

- **T25:** `"Unknown key: Control"` thrown by `keyOf()` in `src/runtime/native-input.ts`. nut.js Key enum uses `LeftControl`/`RightControl` — `Control` does not exist. Verified by checking `Object.keys(Key)` in the nut.js package. Fixed to `keys: ["LeftControl", "A"]`.

### Round 4 — Final Run
**Score: 30/30 — PERFECT**

No failures. All 30 tests pass against real public websites (Wikipedia, DuckDuckGo).

---

## KEY FINDINGS FROM TESTING

### Finding 1: Session Status Response Shape
`GET /api/sessions/:id` does NOT return a flat object with a `state` field.

**Actual shape:**
```json
{
  "metadata": {
    "sessionId": "...",
    "agentId": "...",
    "orgId": "...",
    "commandCount": 5,
    "creditBudget": 100,
    "status": { "currentUrl": "...", "humanControl": false, ... }
  },
  "runtime": {
    "currentUrl": "...",
    "humanControl": false,
    "paused": false,
    "executing": false
  }
}
```

### Finding 2: nut.js Key Names Are Strict
The `shortcut` command uses nut.js Key enum names. These are NOT arbitrary strings.

**Working examples:**
- `["LeftControl", "A"]` — Ctrl+A
- `["LeftControl", "C"]` — Ctrl+C
- `["LeftControl", "V"]` — Ctrl+V
- `["LeftSuper", "L"]` — Cmd+L (macOS address bar)
- `["F5"]` — refresh
- `["Enter"]`, `["Tab"]`, `["Escape"]`

**Broken (will throw `"Unknown key: X"`):**
- `["Control", "a"]` — wrong: use `LeftControl`, not `Control`
- `["ctrl", "c"]` — wrong: not lowercase
- `["cmd", "v"]` — wrong: use `LeftSuper`

### Finding 3: Human Control Must Be Released
After any human interaction or pause, `runtime.humanControl` may be `true`. Commands sent while `humanControl === true` are blocked. Send `{ type: "resume" }` before commands like `click`, `fill_form`, `shortcut`.

### Finding 4: Session Creation Returns 201
`POST /api/sessions` returns HTTP `201 Created`, not `200 OK`. Code that checks `status === 200` will incorrectly treat session creation as a failure.

### Finding 5: Vault Requires OMNI_VAULT_KEY
If `OMNI_VAULT_KEY` is not set (or under 32 chars), all `vault_*` commands return:
```json
{ "ok": false, "reason": "vault_not_configured", "hint": "Set OMNI_VAULT_KEY (min 32 chars)" }
```

### Finding 6: Shell Disabled by Default
`shell` command returns `{ ok: false, error: "Shell execution disabled..." }` unless `OMNI_SHELL_ENABLED=1` is explicitly set.

### Finding 7: fill_form / shortcut Require local_computer Mode
These commands use OS-level input via nut.js. If `OMNI_TAKEOVER_MODES` does not include `local_computer`, the command returns `"local_computer takeover is not enabled"`.

---

## REAL WEBSITES USED IN TESTS

Per Commander directive: NO fake/synthetic/placeholder URLs in tests. These are the real websites used:

| Test Group | Website | Rationale |
|---|---|---|
| T08, T13, T14, T15 | `https://en.wikipedia.org/wiki/Artificial_intelligence` | Rich AX tree, stable content, public |
| T16, T17 | `https://en.wikipedia.org/wiki/Artificial_intelligence` | Content tests: AX tree depth |
| T21–T25 | `https://duckduckgo.com` | Form interaction: stable search box, no login required |
| T30 | Wikipedia URL pattern | Context compressor stress test messages |

Selector used for DuckDuckGo: `input[name='q']` (search box), `input[type='submit'], button[type='submit'], #search_button` (submit).

---

## HOW TO RE-RUN

```bash
cd ~/Downloads/computer-use/v-engine-v13
OMNI_DASHBOARD_JWT_SECRET=test-secret-that-is-long-enough-32ch \
  npx tsx tests/v-engine-30-tests.ts
```

Expected output:
```
[T01] ✓ Server boots and /api/health returns ok
[T02] ✓ POST /api/sessions creates a session (status 200 or 201)
...
[T30] ✓ Context compressor fires at 20+ messages (stress: 28 msgs)

FINAL SCORE: 30/30 (100%)
🏆 ALL 30 TESTS PASSED — V-ENGINE IS BATTLE-READY
```
