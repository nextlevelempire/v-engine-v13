/**
 * Unit test for feature flags (P8-07).
 * Tests the isFeatureEnabled / setFeatureEnabled / listFeatureFlags API.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { isFeatureEnabled, setFeatureEnabled, listFeatureFlags, resetFeatureFlags } from "../src/server/feature-flags.js";

resetFeatureFlags();

// Default: unset flag is false
delete process.env.OMNI_FEATURE_MY_FLAG;
assert.equal(isFeatureEnabled("my_flag"), false, "unset flag must be false");

// Set via env: 1 / true / yes / on
process.env.OMNI_FEATURE_MY_FLAG = "1";
resetFeatureFlags();
assert.equal(isFeatureEnabled("my_flag"), true, "1 must be true");
process.env.OMNI_FEATURE_MY_FLAG = "true";
resetFeatureFlags();
assert.equal(isFeatureEnabled("my_flag"), true, "true must be true");
process.env.OMNI_FEATURE_MY_FLAG = "yes";
resetFeatureFlags();
assert.equal(isFeatureEnabled("my_flag"), true, "yes must be true");
process.env.OMNI_FEATURE_MY_FLAG = "on";
resetFeatureFlags();
assert.equal(isFeatureEnabled("my_flag"), true, "on must be true");

// Set via env: 0 / false / no / off
process.env.OMNI_FEATURE_MY_FLAG = "0";
resetFeatureFlags();
assert.equal(isFeatureEnabled("my_flag"), false, "0 must be false");
process.env.OMNI_FEATURE_MY_FLAG = "false";
resetFeatureFlags();
assert.equal(isFeatureEnabled("my_flag"), false, "false must be false");

// Case-insensitive env var name → flag name
process.env.OMNI_FEATURE_CASE_TEST = "1";
resetFeatureFlags();
assert.equal(isFeatureEnabled("case_test"), true, "flag name maps to uppercased env var");

// setFeatureEnabled overrides env
process.env.OMNI_FEATURE_FORCED = "0";
resetFeatureFlags();
assert.equal(isFeatureEnabled("forced"), false);
setFeatureEnabled("forced", true);
assert.equal(isFeatureEnabled("forced"), true, "setFeatureEnabled must override env");

// listFeatureFlags: includes env + cached
process.env.OMNI_FEATURE_VISIBLE = "1";
resetFeatureFlags();
setFeatureEnabled("memory_only", true);
const list = listFeatureFlags();
const visible = list.find((f) => f.name === "visible");
const mem = list.find((f) => f.name === "memory_only");
assert.ok(visible, "listFeatureFlags must include env-set flags");
assert.equal(visible!.enabled, true);
assert.equal(visible!.envVar, "OMNI_FEATURE_VISIBLE");
assert.ok(mem, "listFeatureFlags must include cache-only flags");
assert.equal(mem!.enabled, true);

// /api/features endpoint
const localSrc = fs.readFileSync("src/server/local-server.ts", "utf8");
assert.match(localSrc, /url\.pathname === "\/api\/features"/, "must have /api/features endpoint");
assert.match(localSrc, /listFeatureFlags\(\)/, "endpoint must call listFeatureFlags");

// Cleanup
delete process.env.OMNI_FEATURE_MY_FLAG;
delete process.env.OMNI_FEATURE_CASE_TEST;
delete process.env.OMNI_FEATURE_FORCED;
delete process.env.OMNI_FEATURE_VISIBLE;
resetFeatureFlags();

console.log("feature-flags unit test ok");
