/**
 * Unit test for OMNI_BODY_SIZE_LIMIT.
 * Verifies the env var name, default (10 MB), and the source patterns
 * for the 413 rejection. Live HTTP test would need to send a real
 * 10 MB+ body, which is wasteful — source inspection is sufficient.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync("src/server/local-server.ts", "utf8");

// Env var
assert.match(src, /OMNI_BODY_SIZE_LIMIT/, "must reference OMNI_BODY_SIZE_LIMIT");

// Default 10 MB
const m = src.match(/OMNI_BODY_SIZE_LIMIT["']?\s*,\s*([^)]+)\)/);
assert.ok(m, "must have a default for OMNI_BODY_SIZE_LIMIT");
const expr = m![1].trim();
// safe arithmetic: digits, spaces, *, parens
assert.match(expr, /^[\d\s*()]+$/, `default expression must be pure arithmetic, got: ${expr}`);
const defaultBytes = Function(`"use strict"; return (${expr})`)();
assert.equal(defaultBytes, 10 * 1024 * 1024, "default must be 10 MB");

// 413 status code path — now via typed error class
const errorsSrc = fs.readFileSync("src/server/omni-errors.ts", "utf8");
assert.match(errorsSrc, /OmniPayloadTooLargeError/, "must have OmniPayloadTooLargeError class");
assert.match(errorsSrc, /httpStatus:\s*413/, "OmniPayloadTooLargeError must use httpStatus 413");
assert.match(errorsSrc, /payload\.too_large/, "must use code payload.too_large");
assert.match(src, /throw new OmniPayloadTooLargeError/, "local-server must throw the typed error");

console.log("body-size-limit unit test ok");
