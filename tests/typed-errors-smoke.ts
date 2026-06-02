/**
 * Unit test for the typed OmniError class hierarchy (P2-05 full).
 * Tests by importing the module and exercising each class.
 */
import assert from "node:assert/strict";
import {
  OmniError,
  OmniAuthError,
  OmniAuthScopeError,
  OmniAuthDaemonMismatchError,
  OmniAuthRateLimitError,
  OmniBudgetError,
  OmniNotFoundError,
  OmniRateLimitError,
  OmniPayloadTooLargeError,
  OmniRequestTimeoutError,
  OmniValidationError,
} from "../src/server/omni-errors.js";

const cases: Array<[OmniError, number, string]> = [
  [new OmniAuthError("bad token"), 401, "auth.invalid"],
  [new OmniAuthScopeError("sessions.create"), 401, "auth.scope"],
  [new OmniAuthDaemonMismatchError("tok-123", "daemon-456"), 401, "auth.daemon_mismatch"],
  [new OmniAuthRateLimitError(30_000), 429, "auth.rate_limited"],
  [new OmniBudgetError(100, 50), 402, "budget.exceeded"],
  [new OmniNotFoundError("session", "abc"), 404, "not_found"],
  [new OmniRateLimitError(5_000, "test"), 429, "rate_limited"],
  [new OmniPayloadTooLargeError(99, 10), 413, "payload.too_large"],
  [new OmniRequestTimeoutError(60_001, 60_000), 504, "request.timeout"],
  [new OmniValidationError("bad shape"), 400, "validation"],
];

for (const [err, expectedStatus, expectedCode] of cases) {
  assert.ok(err instanceof OmniError, `${err.constructor.name} must extend OmniError`);
  assert.equal(err.httpStatus, expectedStatus, `${err.constructor.name} must have status ${expectedStatus}`);
  assert.equal(err.code, expectedCode, `${err.constructor.name} must have code ${expectedCode}`);
  assert.ok(err.hint, `${err.constructor.name} must carry a hint`);
  const json = err.toJSON();
  assert.equal(json.ok, false);
  assert.equal(json.code, expectedCode);
  assert.equal(json.hint, err.hint);
  assert.equal(json.error, err.message);
}

// retryAfterMs propagation
const rl = new OmniRateLimitError(12_345);
assert.equal(rl.retryAfterMs, 12_345);
assert.equal(rl.toJSON().retryAfterMs, 12_345);

console.log(`typed-errors unit test ok (${cases.length} cases)`);
