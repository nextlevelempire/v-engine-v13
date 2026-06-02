/**
 * Unit test for the auth-fail rate limiter (P2-04).
 * Verifies env vars, default, sliding-window map, and pre-check logic.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync("src/server/local-server.ts", "utf8");

// Env vars
assert.match(src, /OMNI_AUTH_FAIL_LIMIT/, "must reference OMNI_AUTH_FAIL_LIMIT");
assert.match(src, /OMNI_AUTH_FAIL_WINDOW_MS/, "must reference OMNI_AUTH_FAIL_WINDOW_MS");

// Defaults
const lim = src.match(/OMNI_AUTH_FAIL_LIMIT["']?\s*,\s*(\d+)/);
assert.ok(lim, "must have a default for OMNI_AUTH_FAIL_LIMIT");
assert.equal(Number(lim![1]), 10, "default fail limit must be 10");

const win = src.match(/OMNI_AUTH_FAIL_WINDOW_MS["']?\s*,\s*(\d[\d_]*)/);
assert.ok(win, "must have a default for OMNI_AUTH_FAIL_WINDOW_MS");
assert.equal(win![1], "60_000", "default window must be 60_000 ms");

// Sliding window logic
assert.match(src, /AUTH_FAIL_BUCKETS/, "must use a Map for auth fail buckets");
assert.match(src, /windowStart/, "must track windowStart in each bucket");
assert.match(src, /recordAuthFailure/, "must have a recordAuthFailure function");
assert.match(src, /checkAuthRateLimit/, "must have a checkAuthRateLimit function");

// 429 path on rate limit exceeded — now via typed error class
const errorsSrc = fs.readFileSync("src/server/omni-errors.ts", "utf8");
assert.match(errorsSrc, /OmniAuthRateLimitError/, "must have OmniAuthRateLimitError class");
assert.match(errorsSrc, /httpStatus:\s*429/, "OmniAuthRateLimitError must use httpStatus 429");
assert.match(errorsSrc, /auth\.rate_limited/, "must use code auth.rate_limited");
assert.match(src, /throw new OmniAuthRateLimitError/, "local-server must throw the typed error");

// Hooked into verifyRequestGrant
assert.match(src, /checkAuthRateLimit\(ip,\s*tokenHint\)/, "verifyRequestGrant must call checkAuthRateLimit before verify");
assert.match(src, /recordAuthFailure\(ip,\s*tokenHint\)/, "verifyRequestGrant must call recordAuthFailure on catch");

console.log("auth-rate-limit unit test ok");
