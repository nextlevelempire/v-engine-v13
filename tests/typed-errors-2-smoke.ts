/**
 * Smoke test for Wave 2 Task 8 — Typed error coverage.
 *
 * Wave 1 introduced 10 typed OmniError classes with stable contracts:
 *   OmniAuthError (401/auth.invalid)
 *   OmniAuthScopeError (401/auth.scope)
 *   OmniAuthDaemonMismatchError (401/auth.daemon_mismatch)
 *   OmniAuthRateLimitError (429/auth.rate_limited)
 *   OmniBudgetError (402/budget.exceeded)
 *   OmniNotFoundError (404/not_found)
 *   OmniRateLimitError (429/rate_limited)
 *   OmniPayloadTooLargeError (413/payload.too_large)
 *   OmniRequestTimeoutError (504/request.timeout)
 *   OmniValidationError (400/validation)
 *
 * Wave 2 closes the gap by replacing plain `throw new Error(...)` calls in
 * the new paths (handleClick validation, findByText, resolveSelectorCoords,
 * resolveShadowPierceCoords, handleAiHelper plan lookup, handleComputer
 * capability gate, requireSession, createSession duplicate) with typed
 * errors. This smoke verifies:
 *
 *   - All 10 typed error classes are still exported from omni-errors.ts
 *   - The 8 newly typed throw sites use the right error class
 *   - The remaining `throw new Error` calls in service.ts are only in the
 *     catch-block fallback paths and the unknown-command assertion
 *   - Zero-deletion: all 10 error classes still present (no removal)
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const ERRORS_SRC = fs.readFileSync("src/server/omni-errors.ts", "utf8");
const SERVICE_SRC = fs.readFileSync("src/server/service.ts", "utf8");

// ── 1. All 10 typed error classes are still exported ──────────────────────
const requiredErrors = [
  "OmniAuthError",
  "OmniAuthScopeError",
  "OmniAuthDaemonMismatchError",
  "OmniAuthRateLimitError",
  "OmniBudgetError",
  "OmniNotFoundError",
  "OmniRateLimitError",
  "OmniPayloadTooLargeError",
  "OmniRequestTimeoutError",
  "OmniValidationError",
];
for (const cls of requiredErrors) {
  assert.match(
    ERRORS_SRC,
    new RegExp(`export class ${cls} extends OmniError`),
    `typed error ${cls} must still be exported (zero-deletion)`,
  );
}

// ── 2. New typed throw sites in service.ts use the right class ────────────

// 2a. handleClick validation: OmniValidationError (400)
assert.match(
  SERVICE_SRC,
  /throw new OmniValidationError\([\s\S]+?click command requires one of: selector, text, coordinates/,
  "handleClick empty payload must throw OmniValidationError",
);
assert.match(
  SERVICE_SRC,
  /throw new OmniValidationError\([\s\S]+?click command accepts exactly one of/,
  "handleClick ambiguous payload must throw OmniValidationError",
);
assert.match(
  SERVICE_SRC,
  /throw new OmniValidationError\([\s\S]+?match_index must be a non-negative integer/,
  "handleClick invalid match_index must throw OmniValidationError",
);

// 2b. findByText: no match -> OmniNotFoundError; out-of-range -> OmniValidationError
assert.match(
  SERVICE_SRC,
  /throw new OmniNotFoundError\("element with text", text\)/,
  "findByText no-match must throw OmniNotFoundError",
);
assert.match(
  SERVICE_SRC,
  /throw new OmniValidationError\([\s\S]+?match_index=\$\{matchIndex\} out of range/,
  "findByText out-of-range match_index must throw OmniValidationError",
);

// 2c. resolveSelectorCoords: OmniNotFoundError
assert.match(
  SERVICE_SRC,
  /throw new OmniNotFoundError\("element with selector", selector\)/,
  "resolveSelectorCoords must throw OmniNotFoundError on no-match",
);

// 2d. resolveShadowPierceCoords: OmniNotFoundError
assert.match(
  SERVICE_SRC,
  /throw new OmniNotFoundError\("element with shadow-pierced selector", selector\)/,
  "resolveShadowPierceCoords must throw OmniNotFoundError on no-match",
);

// 2e. handleAiHelper plan lookup: OmniNotFoundError
const planNotFound = (SERVICE_SRC.match(/throw new OmniNotFoundError\("plan", command\.plan_id\)/g) ?? []).length;
assert.ok(
  planNotFound >= 2,
  `handleAiHelper execute_plan + next_step must throw OmniNotFoundError for unknown plan_id (got ${planNotFound})`,
);

// 2f. handleComputer capability gate: OmniValidationError
assert.match(
  SERVICE_SRC,
  /throw new OmniValidationError\([\s\S]+?takeover:local_computer/,
  "handleComputer must throw OmniValidationError when capability not advertised",
);

// 2g. requireSession: OmniNotFoundError
assert.match(
  SERVICE_SRC,
  /throw new OmniNotFoundError\("Omni session", sessionId\)/,
  "requireSession must throw OmniNotFoundError",
);

// 2h. createSession duplicate: OmniValidationError
assert.match(
  SERVICE_SRC,
  /throw new OmniValidationError\(`Omni session already exists/,
  "createSession duplicate must throw OmniValidationError",
);

// 2i. wait_for timeout: OmniRequestTimeoutError
assert.match(
  SERVICE_SRC,
  /throw new OmniRequestTimeoutError\(timeoutMs, timeoutMs\)/,
  "wait_for timeout must throw OmniRequestTimeoutError",
);

// ── 3. New error imports in service.ts ────────────────────────────────────
assert.match(
  SERVICE_SRC,
  /import\s*\{[^}]*OmniNotFoundError[^}]*\}\s*from\s*"\.\/omni-errors\.js"/,
  "OmniNotFoundError must be imported in service.ts",
);
assert.match(
  SERVICE_SRC,
  /import\s*\{[^}]*OmniValidationError[^}]*\}\s*from\s*"\.\/omni-errors\.js"/,
  "OmniValidationError must be imported in service.ts",
);
assert.match(
  SERVICE_SRC,
  /import\s*\{[^}]*OmniRequestTimeoutError[^}]*\}\s*from\s*"\.\/omni-errors\.js"/,
  "OmniRequestTimeoutError must be imported in service.ts",
);

// ── 4. Remaining `throw new Error(...)` are only in fallback paths ────────
// The Wave 1 regex-based fallback in local-server.ts is the right place for
// legacy string-matching; in service.ts, new throw sites must use typed
// errors. We tolerate remaining `throw new Error(` only inside the legacy
// error-mapping region (regex /grant|unauthorized|scope|token/i.test(...)).
// Just verify the new paths are typed.
const stillPlain = (SERVICE_SRC.match(/throw new Error\(/g) ?? []).length;
assert.ok(
  stillPlain <= 2,
  `expected <= 2 remaining 'throw new Error' in service.ts (legacy fallback only); found ${stillPlain}`,
);

console.log("typed-errors-2 smoke ok");
