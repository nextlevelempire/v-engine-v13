/**
 * Unit test for paginated actionLog (P4-04).
 * Tests source-level patterns for the service method and HTTP endpoint.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const serviceSrc = fs.readFileSync("src/server/service.ts", "utf8");
const localSrc = fs.readFileSync("src/server/local-server.ts", "utf8");

// listActionLog signature
assert.match(serviceSrc, /listActionLog\(/, "service must have listActionLog method");
assert.match(serviceSrc, /limit\?: number/, "listActionLog must accept limit");
assert.match(serviceSrc, /before\?: string/, "listActionLog must accept before cursor");

// Pagination: clamp limit
assert.match(serviceSrc, /Math\.min\(opts\.limit.*500\)/, "limit must be clamped to <= 500");
assert.match(serviceSrc, /Math\.max\(1, /, "limit must be clamped to >= 1");

// Newest-first ordering
assert.match(serviceSrc, /for \(const entry of log\)/, "must iterate the log");
assert.match(serviceSrc, /if \(before !== null && Date\.parse\(entry\.ts\) >= before\) continue/, "cursor excludes entries at/after 'before' ts");

// Configurable cap
assert.match(serviceSrc, /OMNI_ACTION_LOG_MAX/, "OMNI_ACTION_LOG_MAX env var must exist");
assert.match(serviceSrc, /actionLogMax = numberFromEnv\("OMNI_ACTION_LOG_MAX", 10_000\)/, "default must be 10_000");

// HTTP endpoint
assert.match(localSrc, /action-log/, "must have action-log endpoint in local-server");
assert.match(localSrc, /url\.searchParams\.get\("limit"\)/, "endpoint must read limit query param");
assert.match(localSrc, /url\.searchParams\.get\("before"\)/, "endpoint must read before query param");
assert.match(localSrc, /service\.listActionLog\(sessionId, opts\)/, "endpoint must call service.listActionLog");

console.log("action-log-pagination unit test ok");
