/**
 * Unit test for TLS support (P2-03).
 * Verifies env vars, https module usage, and PEM file read pattern.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync("src/server/local-server.ts", "utf8");

// Env vars
assert.match(src, /OMNI_TLS_CERT/, "must reference OMNI_TLS_CERT");
assert.match(src, /OMNI_TLS_KEY/, "must reference OMNI_TLS_KEY");

// TLS_ENABLED logic — both must be set
assert.match(src, /TLS_ENABLED/, "must have TLS_ENABLED flag");
assert.match(src, /TLS_CERT_PATH.*&&.*TLS_KEY_PATH|TLS_KEY_PATH.*&&.*TLS_CERT_PATH/, "TLS_ENABLED must require both paths");

// https module imported
assert.match(src, /from "node:https"/, "must import node:https");

// Read PEM files at boot
assert.match(src, /readFileSync\(TLS_CERT_PATH/, "must read cert file at boot");
assert.match(src, /readFileSync\(TLS_KEY_PATH/, "must read key file at boot");

// Conditional server creation
assert.match(src, /createHttpsServer/, "must use createHttpsServer when TLS is enabled");
assert.match(src, /createHttpServer/, "must use createHttpServer when TLS is not enabled");

// Log the protocol
assert.match(src, /TLS_ENABLED \? "https" : "http"/, "must log which protocol is in use");

console.log("tls unit test ok");
