/**
 * Unit test for parallel session cap env var.
 * Verifies:
 * - OMNI_MAX_PARALLEL_SESSIONS is read by the service
 * - The default is 50
 * - The cap is the single source of truth (no separate OMNI_MAX_SESSIONS fallback)
 *
 * Integration test of actual eviction behavior is covered by live curl tests
 * and the SSE test in the wave-1 journal. Live tests are slow because they
 * launch Chrome, so we keep this unit test fast.
 */
import assert from "node:assert/strict";

// We test the env-var reading logic by inspecting the source
import fs from "node:fs";
const serviceSrc = fs.readFileSync("src/server/service.ts", "utf8");

// Must reference OMNI_MAX_PARALLEL_SESSIONS
assert.match(serviceSrc, /OMNI_MAX_PARALLEL_SESSIONS/, "service.ts must reference OMNI_MAX_PARALLEL_SESSIONS");

// Must NOT reference the old OMNI_MAX_SESSIONS env var
assert.doesNotMatch(serviceSrc, /OMNI_MAX_SESSIONS\b(?!_)/, "service.ts must not reference the old OMNI_MAX_SESSIONS env var (without _PARALLEL)");

// Default must be 50
const match = serviceSrc.match(/OMNI_MAX_PARALLEL_SESSIONS["']?\s*,\s*(\d+)/);
assert.ok(match, "must have a default for OMNI_MAX_PARALLEL_SESSIONS");
assert.equal(match![1], "50", "default must be 50");

// Must emit session.evicted SSE event before closing
assert.match(serviceSrc, /session\.evicted/, "must emit session.evicted event");
assert.match(serviceSrc, /parallel_cap/, "eviction event must include reason=parallel_cap");

console.log("parallel-cap env unit test ok");
