# VX-ENGINE POWER BUILD PLAN
**Next Level Empire — Coder AI Execution Document**
**Authored:** June 3 2026 | **Repo:** `~/Downloads/computer-use/v-engine-v13` | **Branch:** `wave/2-ai-capability`

---

## SECTION 0 — ACTUAL STATE AUDIT (Read Before Touching Anything)

The engine is more complete than the old plan assumed. All T1/T2/T3 features exist in source code.
The gaps are in **edge-case coverage**, **wire-up verification**, and **stress tolerance**.
Do NOT re-build what already exists. Fix what is broken. Stress what is untested.

### TRUTH TABLE — FEATURE STATUS

| Feature | File | Status | Tested? |
|---|---|---|---|
| Page load detection (networkidle) | `src/runtime/omni-agent-loop.ts:406` | ✅ LIVE | Smoke only |
| Circuit breaker (5-identical-action) | `src/runtime/omni-agent-loop.ts:347` | ✅ LIVE | Not stress-tested |
| Screenshot in SSE stream | `src/server/service.ts:601` | ✅ LIVE (`OMNI_SCREENSHOT_IN_EVENTS=1`) | Basic only |
| Screenshot in context endpoint | `src/server/local-server.ts:321` | ✅ LIVE (`?screenshot=1`) | Basic only |
| PII redaction in scratchpad | `src/security/pii-scanner.ts` → `src/runtime/omni-core-clone.ts:358` | ✅ LIVE | Happy path only |
| 2captcha HTTP solver | `src/runtime/captcha-solver.ts:146` | ✅ LIVE | Unit only |
| CAPTCHA detection (DOM + URL + text) | `src/runtime/captcha-solver.ts:56` | ✅ LIVE | smoke only |
| Credential vault (AES-256-GCM) | `src/runtime/credential-vault.ts` | ✅ LIVE | Basic CRUD |
| vault_fill HTTP command | `src/server/service.ts:462` | ✅ LIVE | Wired, untested on real forms |
| vault_fill_totp HTTP command | `src/server/service.ts:467` | ✅ LIVE | Wired |
| vault_store / vault_list commands | `src/server/service.ts:477-488` | ✅ LIVE | Wired |
| TOTP generator (RFC 6238) | `src/runtime/totp-generator.ts` | ✅ LIVE | Basic only |
| OAuth consent auto-click | `src/runtime/omni-agent-loop.ts:276` | ✅ LIVE (`OMNI_AUTO_CONSENT=1`) | Not tested |
| Parallel executor | `src/runtime/parallel-executor.ts` | ✅ LIVE | parallel-cap-smoke only |
| Shell executor (sandboxed) | `src/runtime/shell-executor.ts` | ✅ LIVE | Basic only |
| Context compressor | `src/runtime/context-compressor.ts` | ✅ LIVE | Threshold test only |
| Search service (SerpAPI + browser fallback) | `src/runtime/search-service.ts` | ✅ LIVE | Not tested |
| Email navigator (Gmail + OWA) | `src/runtime/email-navigator.ts` | ✅ LIVE | **ZERO tests** |
| AX tree trimmer | `src/runtime/context-compressor.ts:91` | ✅ LIVE | Basic only |

### TRUE REMAINING BUILD ITEMS

| Item | Priority | What To Build |
|---|---|---|
| **B1: `redactPii` in SSE emitter** | P0 | Verify SSE events sanitize before emit — `service.ts` SSE path must run `redactPii` on all string fields |
| **B2: `redactPii` in parallel task summaries** | P0 | `parallel-executor.ts:112` — summary field from task result is NOT redacted |
| **B3: email command wired in service.ts** | P1 | `email` command type exists in schema but handler is missing — add `case "email"` in `executeCommand` |
| **B4: search browser fallback returns real results** | P1 | `search-service.ts` browser fallback path needs AX tree result extraction verified against DDG |
| **B5: vault_fill on real login page** | P1 | Integration test against `https://github.com/login` — verify username + password fields fill |
| **B6: OMNI_SCREENSHOT_IN_EVENTS in SSE base64 validity** | P1 | Verify base64 is a valid PNG (not truncated, not corrupted) on real page navigate |
| **B7: circuit breaker reset after consent auto-click** | P1 | `omni-agent-loop.ts:293` resets fingerprints but test coverage is zero |
| **B8: email-navigator zero tests** | P2 | Full test suite for compose / read_inbox / reply flows |

---

## SECTION 1 — ENVIRONMENT SETUP

Every test file must export a `run()` function and use this header:

```typescript
// tests/round-N-description.ts
import assert from "node:assert/strict";
import http from "node:http";
import { createServer } from "../src/server/local-server.js"; // adjust to actual export

const BASE = "http://127.0.0.1";
const JWT_SECRET = "v-engine-test-jwt-secret-32chars!";
const VAULT_KEY  = "v-engine-test-vault-key-32chars-min!!";

// Env must be set before any engine import
process.env.OMNI_DASHBOARD_JWT_SECRET = JWT_SECRET;
process.env.OMNI_VAULT_KEY            = VAULT_KEY;
process.env.OMNI_SHELL_ENABLED        = "1";
process.env.OMNI_TAKEOVER_MODES       = "local_browser,local_computer";
process.env.OMNI_SCREENSHOT_IN_EVENTS = "1";
```

### How to run a single round

```bash
cd ~/Downloads/computer-use/v-engine-v13
npx tsx tests/round-N-<name>.ts
```

### How to run ALL 10 rounds consecutively

```bash
cd ~/Downloads/computer-use/v-engine-v13
for f in tests/round-{1..10}-*.ts; do
  echo "====== $f ======"
  npx tsx "$f" || echo "ROUND FAILED: $f"
done
```

---

## SECTION 2 — THE 10 CONSECUTIVE TEST ROUNDS

Each round:
1. Runs ALL tests from ALL previous rounds (cumulative regression)
2. Adds new tests for the feature under focus
3. Documents exact PASS/FAIL criteria
4. Lists what to fix if the round fails

---

### ROUND 1 — BASELINE TRUTH TABLE
**File:** `tests/round-1-baseline.ts`
**Purpose:** Know the exact state before any changes.
**Runs:** All existing smoke tests + 30-test battery.

```bash
# Run command for round 1
npx tsx tests/v-engine-30-tests.ts
npx tsx tests/captcha-smoke.ts
npx tsx tests/session-context-smoke.ts
npx tsx tests/high-level-commands-smoke.ts
npx tsx tests/p0-stress-test.ts
npx tsx tests/parallel-cap-smoke.ts
```

**PASS CRITERIA:**
- 30/30 on v-engine-30-tests.ts
- All smoke tests exit 0
- p0-stress-test.ts exits 0

**RECORD:** Save full terminal output to `tests/ROUND-1-RESULTS.md`

**If it fails:** Do NOT proceed to Round 2 until baseline is clean. Fix root cause first.

---

### ROUND 2 — PII REDACTION BLIND SPOTS
**File:** `tests/round-2-pii-blindspots.ts`
**Builds on:** Round 1 (all 30 tests + baseline suite)
**Focus:** Edge cases the happy-path tests miss

**Build item before testing:**
- [ ] **B1**: In `service.ts`, find the SSE emitter function that sends action results. Ensure every `string` field in the payload runs through `redactPii()` before being sent. The scratchpad is already guarded at `omni-core-clone.ts:358` — but the raw SSE event payload (type `"action.result"`) may bypass this.
- [ ] **B2**: In `parallel-executor.ts:112`, the `summary` field from `service.executeCommand(status)` response goes straight into `ParallelTaskResult.summary` — wrap it: `summary = redactPii(typeof status.objective === "string" ? status.objective : task.directive.slice(0, 100))`

**Test cases (8 new tests):**

```typescript
// R2-T01: SSN with dashes
const t1 = redactPii("User SSN is 123-45-6789 in our records");
assert.ok(t1.includes("[REDACTED:SSN]"), "SSN with dashes not caught");

// R2-T02: SSN without dashes (9 consecutive digits — should NOT be redacted; only dashed format is SSN)
const t2 = redactPii("Order ID: 123456789");
assert.ok(!t2.includes("[REDACTED:SSN]"), "9-digit order ID false-positive");

// R2-T03: JWT bearer token (3-part base64 with dots)
const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.abc123def456ghi789";
const t3 = redactPii(`Authorization: Bearer ${jwt}`);
assert.ok(t3.includes("[REDACTED"), "JWT bearer token not caught");

// R2-T04: Credit card with spaces
const t4 = redactPii("Card: 4111 1111 1111 1111");
// Note: the space-separated format may not be caught by current regex — document result
// PASS if caught, DOCUMENT if not (becomes B9 build item)

// R2-T05: Password inside JSON
const t5 = redactPii('{"username":"alice","password":"SuperSecret99!"}');
assert.ok(t5.includes("[REDACTED:PASSWORD]"), "Password in JSON not caught");

// R2-T06: API key in URL query string
const t6 = redactPii("https://api.example.com/v1/data?api_key=sk-live-abc123def456ghi789jkl");
assert.ok(t6.includes("[REDACTED"), "API key in URL not caught");

// R2-T07: Normal 32-char UUID — must NOT be false-positive redacted as KEY
// (the 32-char KEY regex catches long alphanumeric — UUIDs have hyphens so should be ok)
const uuid = "550e8400-e29b-41d4-a716-446655440000";
const t7 = redactPii(`Session ID: ${uuid}`);
// Document actual result — if UUID is caught, that's a false positive to fix

// R2-T08: Scratchpad write via HTTP → verify SSE event does not leak raw PII
// (Integration: create session, inject PII via scratchpad command, capture SSE, verify no raw PII in event stream)
```

**PASS CRITERIA:**
- T01, T03, T05, T06: all redacted → PASS
- T02, T07: not false-positive redacted → PASS (if they ARE caught, log as Build Item B9)
- T04: document result — credit card spaces (regex gap if not caught)
- T08: SSE event contains `[REDACTED:*]` not raw sensitive string → PASS

**Record failures as new build items (B9+).**

---

### ROUND 3 — CAPTCHA DETECTION BLIND SPOTS
**File:** `tests/round-3-captcha-blindspots.ts`
**Builds on:** Round 1 + Round 2 (cumulative)
**Focus:** CAPTCHA detection edge cases + 2captcha polling logic

**No build items required before testing** (2captcha HTTP call is fully wired).

**Test cases (8 new tests):**

```typescript
// R3-T01: detectCaptcha on page with no CAPTCHA → detected:false, type:"none"
// Navigate to https://en.wikipedia.org/wiki/Main_Page → detect → assert !detected

// R3-T02: detectCaptcha with injected reCAPTCHA DOM
// Inject <div class="g-recaptcha" data-sitekey="TESTKEY"> into a blank page
// → detected:true, type:"recaptcha", locator:"div.g-recaptcha"

// R3-T03: detectCaptcha with injected Cloudflare DOM
// Inject <div id="cf-challenge-running"> → detected:true, type:"cloudflare"

// R3-T04: detectCaptcha with CAPTCHA text in body
// page.setContent('<body>Please complete the security check to proceed</body>')
// → detected:true, type:"unknown"

// R3-T05: solveCaptcha with no CAPTCHA_SOLVER_API_KEY
// assert result.solved === false && result.reason === "no_solver_key"

// R3-T06: solveCaptcha with provider !== "2captcha"
// process.env.CAPTCHA_SOLVER_PROVIDER = "anticaptcha"
// assert result.solved === false && result.reason === "unsupported_provider"

// R3-T07: solveCaptcha with type:"none"
// assert result.solved === false (no point solving nothing)

// R3-T08: extractSitekey — real reCAPTCHA iframe src with k= param
// mock page returns iframe src="https://www.recaptcha.net/recaptcha/api2/anchor?k=6LcABCDEFG"
// → sitekey === "6LcABCDEFG"
```

**PASS CRITERIA:** T01-T08 all pass. If T02/T03/T04 fail, DOM injection approach needs adjustment.

---

### ROUND 4 — CREDENTIAL VAULT + VAULT_FILL BLIND SPOTS
**File:** `tests/round-4-vault-blindspots.ts`
**Builds on:** Rounds 1-3 (cumulative)
**Focus:** Edge cases in store/retrieve/fill

**Test cases (8 new tests):**

```typescript
// R4-T01: Credential with special chars in password
const cred = {
  hostname: "testsite.com",
  username: "alice@example.com",
  password: 'p@$$w0rd!#&"{}',
  notes: "test"
};
storeCredential(cred);
const retrieved = getCredential("testsite.com");
assert.equal(retrieved?.password, cred.password, "Special chars in password lost in encrypt/decrypt");

// R4-T02: Suffix match — store "google.com", retrieve "accounts.google.com"
storeCredential({ hostname: "google.com", username: "user@gmail.com", password: "pass123" });
const bySubdomain = getCredential("accounts.google.com");
assert.ok(bySubdomain?.username === "user@gmail.com", "Suffix match failed");

// R4-T03: vault_list with 0 stored credentials → returns []
// Fresh vault (temp OMNI_VAULT_KEY), call listCredentials() → assert Array.isArray && length === 0

// R4-T04: deleteCredential on non-existent hostname → returns false (not crash)
const deleted = deleteCredential("notexist.com");
assert.equal(deleted, false, "Delete of non-existent should return false");

// R4-T05: isVaultConfigured with OMNI_VAULT_KEY under 32 chars
const origKey = process.env.OMNI_VAULT_KEY;
process.env.OMNI_VAULT_KEY = "short";
assert.equal(isVaultConfigured(), false, "Short key should not configure vault");
process.env.OMNI_VAULT_KEY = origKey;

// R4-T06: vault_store via HTTP command then vault_list via HTTP — round-trip
// POST command {type:"vault_store", hostname:"http-test.com", username:"httpuser", password:"httppass"}
// POST command {type:"vault_list"} → response.data should contain "http-test.com"

// R4-T07: vault_fill via HTTP on page with real login fields
// Navigate to https://github.com/login → POST command {type:"vault_store", hostname:"github.com", ...}
// POST command {type:"vault_fill", hostname:"github.com"}
// → result.ok === true, result.username filled in page

// R4-T08: vault_fill on page with NO form fields → returns ok:false, reason:"page_error" or graceful response
// Navigate to https://en.wikipedia.org/wiki/Main_Page (no login form)
// POST command {type:"vault_fill", hostname:"wikipedia.org"}
// → ok:false (no fields to fill)
```

**PASS CRITERIA:** T01-T06 must pass. T07 depends on GitHub not blocking automation — acceptable failure with documented note. T08 must return ok:false cleanly.

---

### ROUND 5 — TOTP EDGE CASES
**File:** `tests/round-5-totp-edge-cases.ts`
**Builds on:** Rounds 1-4 (cumulative)
**Focus:** RFC 6238 correctness + clock edge cases + fillTotp failures

**Test cases (8 new tests):**

```typescript
// R5-T01: Known RFC 6238 test vector
// TOTP secret: JBSWY3DPEHPK3PXP (standard test seed from RFC 6238 Appendix B)
// At epoch 0 (counter=0): expected code is "282760" (or verify against otpauth library)
// Use generateTotp at known time: freeze Date.now with mock
import { generateTotp } from "../src/runtime/totp-generator.js";
// Verify: for seed JBSWY3DPEHPK3PXP, period 30, counter 1 (time 30-59s): known value

// R5-T02: totpSecondsRemaining() returns 1–30 always
const r = totpSecondsRemaining();
assert.ok(r >= 1 && r <= 30, `Remaining ${r} out of range`);

// R5-T03: generateTotp with empty string → throws or returns empty
// Document actual behavior — should be a thrown Error, not silent failure

// R5-T04: generateTotp with non-base32 chars (e.g. "!@#$%^&*()")
// Document: does it crash or return garbage code?
// Expected: should throw with descriptive error

// R5-T05: fillTotp returns ok:false when no OTP field exists
// Navigate to https://duckduckgo.com (no OTP field)
// const result = await fillTotp(page, "JBSWY3DPEHPK3PXP");
// assert.equal(result.ok, false);
// assert.equal(result.reason, "no_otp_field_found");

// R5-T06: fillTotp waits for fresh window when < 3s remaining
// Mock totpSecondsRemaining to return 2 → verify a setTimeout delay fires
// (Test via elapsed time: start time, call fillTotp, end time — should take ~2s longer)

// R5-T07: vault_fill_totp via HTTP when no totpSecret stored for hostname
// POST command {type:"vault_store", hostname:"noTotp.com", username:"u", password:"p"} (no totpSecret)
// POST command {type:"vault_fill_totp", hostname:"noTotp.com"}
// → result.reason === "no_totp_secret_for_hostname"

// R5-T08: generateTotp with digits=8 returns 8-digit code
const code8 = generateTotp("JBSWY3DPEHPK3PXP", 8);
assert.equal(code8.length, 8, "8-digit TOTP should be 8 chars");
assert.ok(/^\d{8}$/.test(code8), "8-digit TOTP should be numeric");
```

**PASS CRITERIA:** T01 requires verifying against a known source (otpauth npm package output or RFC Appendix B table). T02, T07, T08 are pure logic — must pass. T03/T04 document behavior (build items if they crash). T05/T06 are integration.

---

### ROUND 6 — SHELL EXECUTOR SAFETY BLIND SPOTS
**File:** `tests/round-6-shell-blindspots.ts`
**Builds on:** Rounds 1-5 (cumulative)
**Focus:** Safety policy completeness + timeout enforcement + output cap

**Test cases (10 new tests):**

```typescript
// R6-T01: rm -rf / → blocked
const r1 = await runShellCommand("rm -rf /");
assert.equal(r1.ok, false);
assert.ok(r1.error?.includes("blocked"), "rm -rf / should be blocked");

// R6-T02: sudo whoami → blocked
const r2 = await runShellCommand("sudo whoami");
assert.equal(r2.ok, false);

// R6-T03: cat /etc/passwd → blocked
const r3 = await runShellCommand("cat /etc/passwd");
assert.equal(r3.ok, false);

// R6-T04: cat ~/.ssh/id_rsa → blocked
const r4 = await runShellCommand("cat ~/.ssh/id_rsa");
assert.equal(r4.ok, false);

// R6-T05: dd if=/dev/urandom → blocked
const r5 = await runShellCommand("dd if=/dev/urandom of=/dev/null bs=1M count=1");
assert.equal(r5.ok, false);

// R6-T06: Output cap — command that generates > 512KB stdout
// echo a 600KB string: python3 -c "print('A' * 600000)"
const r6 = await runShellCommand("python3 -c \"print('A' * 600000)\"", 5000);
assert.ok(r6.stdout.length <= 8000, `stdout not capped: ${r6.stdout.length} chars`);

// R6-T07: Timeout enforcement — sleep 35 → killed at 30s hard cap
const before = Date.now();
const r7 = await runShellCommand("sleep 35", 31_000);
const elapsed = Date.now() - before;
assert.ok(elapsed < 32_000, `Timeout not enforced: ${elapsed}ms`);
assert.equal(r7.ok, false);

// R6-T08: OMNI_SHELL_ENABLED unset → disabled
process.env.OMNI_SHELL_ENABLED = "0";
const r8 = await runShellCommand("echo test");
assert.equal(r8.ok, false);
assert.ok(r8.error?.includes("disabled"), "Should return disabled message");
process.env.OMNI_SHELL_ENABLED = "1";

// R6-T09: Chained command (both parts execute)
const r9 = await runShellCommand("echo first && echo second", 3000);
assert.ok(r9.ok);
assert.ok(r9.stdout.includes("first") && r9.stdout.includes("second"));

// R6-T10: Exit code captured
const r10 = await runShellCommand("exit 42", 3000);
// /bin/sh -c "exit 42" — exit code should be 42
// Note: Node may return code 0 for some shells when using execFile — document actual behavior
```

**PASS CRITERIA:** T01-T05 must all block (ok:false). T06 stdout <= 8000 chars. T07 completes in < 32s. T08 returns disabled. T09/T10 document behavior.

---

### ROUND 7 — CIRCUIT BREAKER + PAGE LOAD STRESS
**File:** `tests/round-7-circuit-breaker-stress.ts`
**Builds on:** Rounds 1-6 (cumulative)
**Focus:** Agent loop under adversarial conditions (no real LLM — mock responses)

**Architecture note:** To test circuit breaker without a real LLM, use the `OMNI_LLM_PROVIDER=custom` + `OMNI_LLM_BASE_URL` pointing to a local mock HTTP server that returns controlled responses.

**Test cases (8 new tests):**

```typescript
// R7-T01: Circuit breaker fires after 5 identical actions
// Start mock LLM server that always returns: {"action":"click","selector":"#btn"}
// Run agent loop for 10 iterations
// → outcome should be "error", summary should contain "Circuit breaker"
// → iterations should be exactly 5

// R7-T02: Circuit breaker does NOT fire after 4 identical + 1 different
// Mock LLM: returns {"action":"click","selector":"#btn"} × 4,
// then {"action":"navigate","url":"https://en.wikipedia.org/wiki/Main_Page"} × 1
// Run loop → circuit should NOT fire at iteration 5

// R7-T03: Page load detection on Wikipedia (static, fast)
// Navigate to https://en.wikipedia.org/wiki/Artificial_intelligence
// Measure: does waitForLoadState("networkidle") resolve in < 10s? → PASS

// R7-T04: Page load detection on GitHub (semi-dynamic)
// Navigate to https://github.com
// Does networkidle resolve or fall back to domcontentloaded? → both acceptable, no crash

// R7-T05: Page load detection on BBC News (news SPA)
// Navigate to https://www.bbc.com/news
// networkidle or domcontentloaded → resolves in < 15s → PASS

// R7-T06: MAX_ITERATIONS reached gracefully
// Mock LLM: always returns {"action":"wait","ms":100} (valid action, never "done")
// Set OMNI_AGENT_MAX_ITERATIONS=5 via env
// → outcome === "max_iterations", iterations === 5

// R7-T07: LLM returns malformed JSON → loop retries (does not crash)
// Mock LLM: first 3 calls return "not json at all", 4th returns {"action":"done","summary":"ok"}
// → outcome === "complete" (parsed on 4th try)

// R7-T08: LLM call throws network error → loop returns outcome:"error" with error message
// Mock LLM server: crashes on request (returns 500)
// → outcome === "error", summary contains error text
```

**PASS CRITERIA:** T01, T02: exact circuit behavior verified. T03-T05: navigation completes in < 15s (adjust timeout if site is slow). T06: exact iterations count. T07: recovery from bad JSON. T08: graceful error return.

---

### ROUND 8 — PARALLEL EXECUTOR STRESS
**File:** `tests/round-8-parallel-stress.ts`
**Builds on:** Rounds 1-7 (cumulative)
**Focus:** Real concurrent sessions, error isolation, resource cleanup

**Test cases (7 new tests):**

```typescript
// R8-T01: 3 parallel Wikipedia lookups all succeed
// tasks: [
//   "Navigate to https://en.wikipedia.org/wiki/Artificial_intelligence and get the page title",
//   "Navigate to https://en.wikipedia.org/wiki/Machine_learning and get the page title",
//   "Navigate to https://en.wikipedia.org/wiki/Neural_network and get the page title"
// ]
// via POST command {type:"parallel", tasks:[...], max_concurrency:3}
// → response.ok:true, completedTasks:3, failedTasks:0

// R8-T02: 1 failing task does not kill the other 2
// tasks: ["Navigate to https://en.wikipedia.org/wiki/AI and close", INVALID_TASK, "Navigate to https://github.com and close"]
// → failedTasks:1, completedTasks:2 (others unaffected)

// R8-T03: Concurrency cap respected
// Set OMNI_MAX_PARALLEL=2, submit 6 tasks
// Track timing: batches should run sequentially (t0-t1, t2-t3, t4-t5)
// total_elapsed_ms ≥ (3 batch round-trips) — not all 6 concurrent

// R8-T04: Session cleanup after parallel run
// Submit 3 tasks → wait for completion → list sessions
// → child sessions should be closed (not leak open sessions)

// R8-T05: Empty task list
// POST command {type:"parallel", tasks:[]}
// → completedTasks:0, failedTasks:0, results:[]

// R8-T06: Max parallel cap — submit with max_concurrency:99 → clamped to 10
// Verify by inspecting the concurrency value used in the response (or logs)

// R8-T07: parallel via HTTP command returns results array
// POST {type:"parallel", tasks:["Navigate to https://en.wikipedia.org/wiki/Main_Page"]}
// → response has results array with at least 1 entry
// → each entry has: directive, elapsed_ms, ok, sessionId, summary
```

**PASS CRITERIA:** T01 must have all 3 succeed. T02 must show isolation (others unaffected). T03/T04/T05/T06 verify cleanup and caps. T07 verifies HTTP wire format.

---

### ROUND 9 — CONTEXT COMPRESSOR + 50-ITERATION MEMORY STRESS
**File:** `tests/round-9-compressor-stress.ts`
**Builds on:** Rounds 1-8 (cumulative)
**Focus:** Compression trigger, summary accuracy, AX tree trimming, long mission survival

**Test cases (11 new tests):**

```typescript
// R9-T01: 19 messages → NO compression (below threshold of 20)
const msgs19 = buildMockMessages(19); // 1 system + 18 user/assistant
const result19 = compressConversation(msgs19);
assert.equal(result19.length, 19, "Should not compress below threshold");

// R9-T02: 20 messages → compression fires
const msgs20 = buildMockMessages(20);
const result20 = compressConversation(msgs20);
assert.ok(result20.length < 20, "Should compress at threshold");

// R9-T03: 21 messages → compression fires
const msgs21 = buildMockMessages(21);
const result21 = compressConversation(msgs21);
assert.ok(result21.length < 21);

// R9-T04: System messages preserved after compression
const systemMsg = msgs21.find(m => m.role === "system");
const afterCompress = compressConversation(msgs21);
assert.ok(afterCompress.some(m => m.role === "system" && m.content === systemMsg?.content),
  "System message lost in compression");

// R9-T05: Last 8 messages preserved verbatim after compression
const last8 = msgs21.slice(-8);
const compressed = compressConversation(msgs21);
for (const msg of last8) {
  assert.ok(compressed.some(m => m.content === msg.content),
    `Recent message lost: ${msg.content.slice(0, 50)}`);
}

// R9-T06: Summary captures visited URLs from middle section
// Build messages where middle 10 contain "https://en.wikipedia.org/wiki/X" references
// → compressed summary message should include that URL

// R9-T07: trimAxTree at exactly 4000 chars → unchanged
const ax4000 = "A".repeat(4000);
assert.equal(trimAxTree(ax4000).length, 4000);

// R9-T08: trimAxTree at 4001 chars → truncated + truncation notice appended
const ax4001 = "A".repeat(4001);
const trimmed = trimAxTree(ax4001);
assert.ok(trimmed.length < 4001, "Should be trimmed");
assert.ok(trimmed.includes("[... AX tree truncated"), "Truncation notice missing");

// R9-T09: High-priority interactive roles preserved in trim
const axWithButtons = [
  "button Click me",
  "A".repeat(500),
  "button Submit form",
  "A".repeat(500),
  "link Learn more",
].join("\n");
const trimmedAX = trimAxTree(axWithButtons, 200);
assert.ok(trimmedAX.includes("button Click me"), "Button not preserved in trim");

// R9-T10: Static text trimmed first
// Build AX tree: 3000 chars of static text + 100 chars of button roles
// trimAxTree(tree, 500) → buttons preserved, static text cut
// → result.includes("button") && result.length <= 600

// R9-T11: 50-message stress test — agent loop runs 50 iterations without OOM/crash
// Requires OMNI_LLM_PROVIDER set OR mock LLM
// Set MAX_ITERATIONS=50, run agent loop
// → no JavaScript heap errors, no crash, outcome:"max_iterations"
// Monitor: process.memoryUsage().heapUsed at start vs end — delta < 200MB
```

**PASS CRITERIA:** T01-T10 pure logic — must all pass. T11 requires mock LLM server and memory monitoring.

---

### ROUND 10 — FULL GAUNTLET: ALL FEATURES SIMULTANEOUSLY
**File:** `tests/round-10-full-gauntlet.ts`
**Builds on:** Rounds 1-9 (ALL features must still pass — full regression)
**Focus:** Every feature active at once, maximum stress, zero regressions

**This is the final boss. Every feature in one run.**

#### Scenario 1: PII-Safe Research Task
```
1. Start session
2. Set OMNI_SCREENSHOT_IN_EVENTS=1, OMNI_SHELL_ENABLED=1, OMNI_VAULT_KEY set
3. Navigate to https://en.wikipedia.org/wiki/Artificial_intelligence
4. Issue 5 scratchpad writes containing PII (SSN, credit card, password)
5. Verify: scratchpad entries are redacted
6. Verify: SSE events do not contain raw PII
7. Verify: context endpoint returns screenshotBase64 (valid base64, length > 1000)
PASS: All PII redacted, screenshot valid
```

#### Scenario 2: Full Auth Flow Simulation
```
1. vault_store {hostname:"github.com", username:"testuser@nle.com", password:"TestP@ss123"}
2. Navigate to https://github.com/login
3. POST vault_fill {hostname:"github.com"}
4. Verify: username field contains "testuser@nle.com"
5. POST vault_store with totpSecret: "JBSWY3DPEHPK3PXP"
6. POST vault_fill_totp {hostname:"github.com"}
7. Verify: ok:true (code typed) OR ok:false with reason (no OTP field) — either is PASS
PASS: vault_fill fills username without crash; vault_fill_totp does not throw
```

#### Scenario 3: Parallel Research — 3 Real Sites
```
1. POST {type:"parallel", tasks:[
     "Navigate to https://en.wikipedia.org/wiki/Main_Page",
     "Navigate to https://github.com/trending",
     "Navigate to https://news.ycombinator.com"
   ], max_concurrency: 3}
2. Wait for results
PASS: completedTasks >= 2, no crash, results array has 3 entries
```

#### Scenario 4: Shell + Search Combo
```
1. POST {type:"shell", command:"echo 'V-Engine-Alive-$(date)'"}
   → ok:true, stdout contains "V-Engine-Alive"
2. POST {type:"search", query:"AI browser automation 2026", engine:"ddg", num_results:5}
   → ok:true, results array length >= 1, each result has title + url
PASS: Both commands return ok:true
```

#### Scenario 5: Circuit Breaker Under Parallel Load
```
1. Run parallel tasks with mock LLM (2 tasks)
2. Task 1: mock LLM returns 5 identical click actions → circuit fires in Task 1 session
3. Task 2: mock LLM returns varied actions → runs to completion
PASS: Task 1 returns error (circuit), Task 2 returns complete. Neither affects the other.
```

#### Scenario 6: Context Compression Active Throughout
```
1. Run agent loop with mock LLM for 25 iterations
2. Verify: compressConversation fires at iteration >= 20
3. Verify: final iteration count is 25 (loop didn't abort from compression error)
4. Verify: heap memory stable (< 200MB growth)
PASS: 25 iterations, compression fired, no crash
```

#### Scenario 7: Full 30-Test Regression
```
npx tsx tests/v-engine-30-tests.ts
PASS: 30/30 — zero regressions from new code
```

#### Scenario 8: SSE Screenshot Validity
```
1. Create session, OMNI_SCREENSHOT_IN_EVENTS=1
2. Navigate to https://en.wikipedia.org/wiki/Main_Page
3. Capture SSE event stream for 5 seconds
4. Find event with "screenshotBase64" field
5. Verify: value is valid base64 PNG
   - Buffer.from(val, "base64") succeeds
   - Buffer starts with PNG header: \x89PNG\r\n\x1a\n (bytes 0-7)
   - Buffer length > 5000 bytes (real screenshot, not empty)
PASS: Valid PNG in SSE stream
```

#### Scenario 9: CAPTCHA Detection on Real Pages
```
1. Navigate to https://www.google.com (may or may not show reCAPTCHA)
2. detectCaptcha(page) → verify it returns a valid CaptchaDetection object
3. Navigate to https://en.wikipedia.org/wiki/Main_Page
4. detectCaptcha(page) → detected:false (no CAPTCHA on Wikipedia)
PASS: detection runs without crash, returns correct shape
```

#### Scenario 10: Memory Under Load — 5 Sessions × 10 Commands
```
1. Spawn 5 sessions simultaneously
2. Send 10 commands to each (navigate, screenshot, AX tree, etc.)
3. Close all 5 sessions
4. Verify: process.memoryUsage().heapUsed growth < 300MB
5. Verify: no "ENOMEM" or heap errors in stdout/stderr
PASS: All 50 commands complete, memory stable
```

**ROUND 10 FINAL PASS CRITERIA:**
- All 9 scenarios pass (or document known-acceptable failure with reason)
- 30/30 regression test passes
- No memory leaks detected
- Zero uncaught exceptions across all 10 scenarios

---

## SECTION 3 — BUILD ORDER (Execute Before Testing)

Before running tests, execute these builds in order. Do NOT run a test round until its build item is done.

| Build | When Needed | File to Edit | What to Do |
|---|---|---|---|
| B1 | Before Round 2 | `src/server/service.ts` — SSE emit path | Wrap all string fields in SSE event payload with `redactPii()` |
| B2 | Before Round 2 | `src/runtime/parallel-executor.ts:112` | Wrap `summary` with `redactPii()` |
| B3 | Before Round 8 | `src/server/service.ts` — `executeCommand` | Add `case "email":` handler calling `navigateEmail(page, command)` |
| B4 | Before Round 8 | `src/runtime/search-service.ts` — browser fallback | Verify DDG AX tree extraction returns real titles + URLs |
| B5 | Before Round 4 | Test file only | Create test credential + navigate to `github.com/login` to test vault_fill |
| B6 | Before Round 10 | `tests/round-10-full-gauntlet.ts` | PNG header validation function |
| B7 | Before Round 7 | No code change — test only | Mock LLM server setup in test file |
| B8 | Before Round 10 | `tests/round-8-email-smoke.ts` (new file) | Email navigator smoke tests (read_inbox, compose shape) |

---

## SECTION 4 — HOW TO TRACK RESULTS

After each round, create a results file:

```bash
npx tsx tests/round-N-<name>.ts 2>&1 | tee tests/ROUND-N-RESULTS.txt
```

In `tests/ROUND-N-RESULTS.txt`, mark each test:
```
[PASS] R2-T01: SSN with dashes redacted
[FAIL] R2-T04: Credit card with spaces NOT caught — GAP IDENTIFIED
[SKIP] R7-T01: Circuit breaker — mock LLM server not running
```

Failures become new build items. Build items get executed in the next sprint. No test round is "done" until all non-SKIP items are PASS.

---

## SECTION 5 — RUN COMMAND REFERENCE

```bash
# Run ONE round
cd ~/Downloads/computer-use/v-engine-v13
npx tsx tests/round-1-baseline.ts

# Run ALL 10 rounds consecutively (the full gauntlet)
for n in 1 2 3 4 5 6 7 8 9 10; do
  file=$(ls tests/round-${n}-*.ts 2>/dev/null | head -1)
  if [ -z "$file" ]; then echo "Round $n: FILE MISSING"; continue; fi
  echo "====== ROUND $n: $file ======"
  npx tsx "$file" && echo "ROUND $n PASS" || echo "ROUND $n FAIL"
done

# Run the original 30-test regression at any time
npx tsx tests/v-engine-30-tests.ts
```

---

## SECTION 6 — FAILURE PLAYBOOK

| Symptom | Root Cause | Fix |
|---|---|---|
| `Cannot find module '../src/server/service.js'` | Wrong import path | Use `.js` extension on all imports in test files |
| `OMNI_VAULT_KEY too short` | Test env not set | Ensure test header sets `process.env.OMNI_VAULT_KEY` before imports |
| `waitForLoadState timeout 6000ms exceeded` | Slow network / site down | Increase timeout to 15000ms in `omni-agent-loop.ts:411` |
| `heap out of memory` in Round 9/10 | Memory leak in session manager | Check `OmniSessionManager` for sessions not cleaned up after parallel runs |
| `Unknown key: Control` in keyboard tests | nut.js key names | Use `LeftControl` not `Control` — see `TEST-RESULTS.md:Finding 2` |
| `local_computer takeover is not enabled` | Missing env | Set `OMNI_TAKEOVER_MODES=local_browser,local_computer` |
| SSE stream closed before screenshot event arrives | Race condition | Add 3-second SSE listen window after navigate command |
| `solveCaptcha: network_error` with valid API key | 2captcha rate limit or bad sitekey | Use a real reCAPTCHA-protected test page + valid sitekey |

---

## SECTION 7 — FINAL ACCEPTANCE CRITERIA

The VX-Engine is **production-ready** when:

1. **Round 1:** 30/30 on original tests, all smoke tests pass
2. **Round 10 Scenarios 1-10:** All pass or have documented acceptable failures
3. **Zero regressions:** `v-engine-30-tests.ts` stays at 30/30 after all builds
4. **Memory:** No heap growth > 300MB across Round 10 Scenario 10
5. **Build items B1-B8:** All completed and test-verified
6. **Results files:** `tests/ROUND-1-RESULTS.txt` through `tests/ROUND-10-RESULTS.txt` exist with raw output

**When all 7 acceptance criteria are met: the engine is cleared for production deployment.**

---

*"PRECISION IS YOUR ONLY PURPOSE. OBEDIENCE IS YOUR ONLY VIRTUE." — Supreme Commander*
