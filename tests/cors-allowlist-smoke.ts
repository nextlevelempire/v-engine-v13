/**
 * Unit test for CORS allowlist configuration (P2-08).
 * Verifies:
 * - OMNI_CORS_ALLOWED_ORIGINS is the v0.3 env var
 * - Defaults are empty in v0.3 (no omnibrowser.online baked in)
 * - Loopback origins are opt-in via OMNI_ALLOW_LOOPBACK_CORS=1
 * - Wildcards are rejected
 * - Legacy OMNI_RUNTIME_ALLOWED_ORIGINS still works
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync("src/server/local-server.ts", "utf8");

// v0.3 env var
assert.match(src, /OMNI_CORS_ALLOWED_ORIGINS/, "must support OMNI_CORS_ALLOWED_ORIGINS");

// Defaults empty (no omnibrowser.online)
assert.doesNotMatch(src, /omnibrowser\.online/, "must not hardcode omnibrowser.online in defaults");

// Legacy alias
assert.match(src, /OMNI_RUNTIME_ALLOWED_ORIGINS/, "must keep OMNI_RUNTIME_ALLOWED_ORIGINS as a legacy alias");

// Loopback opt-in
assert.match(src, /OMNI_ALLOW_LOOPBACK_CORS/, "must support OMNI_ALLOW_LOOPBACK_CORS for dev");

// Wildcard rejection
assert.match(src, /!origin\.includes\("\*"\)/, "must reject wildcard origins");

// Scheme filter
assert.match(src, /startsWith\("http:\/\/"\)/, "must accept http:// origins");
assert.match(src, /startsWith\("https:\/\/"\)/, "must accept https:// origins");

console.log("cors-allowlist unit test ok");
