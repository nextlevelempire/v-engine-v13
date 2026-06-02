/**
 * Unit test for OMNI_REQUEST_TIMEOUT_MS / watchdog.
 * Verifies the env var name, default, source patterns for the
 * 504 timeout response. Live timing test is impractical for a smoke
 * test — would need to wait 60 s real time.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync("src/server/local-server.ts", "utf8");

// Env var
assert.match(src, /OMNI_REQUEST_TIMEOUT_MS/, "must reference OMNI_REQUEST_TIMEOUT_MS");

// Default 60s
const m = src.match(/OMNI_REQUEST_TIMEOUT_MS["']?\s*,\s*([^)]+)\)/);
assert.ok(m, "must have a default for OMNI_REQUEST_TIMEOUT_MS");
const expr = m![1].trim();
assert.match(expr, /^[\d_\s*]+$/, `default expression must be pure digits/underscores/asterisks, got: ${expr}`);
const defaultMs = Function(`"use strict"; return (${expr})`)();
assert.equal(defaultMs, 60_000, "default must be 60_000 ms (60 s)");

// 504 path
assert.match(src, /writeJson\(response,\s*504/, "must write a 504 on timeout");
assert.match(src, /Promise\.race/, "must use Promise.race to enforce timeout");
assert.match(src, /timedOut|request-timeout/i, "must log/track timed-out requests");

console.log("request-timeout unit test ok");
