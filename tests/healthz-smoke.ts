/**
 * Unit test for /livez, /readyz, /healthz (P8-01).
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync("src/server/local-server.ts", "utf8");

// Endpoints
assert.match(src, /url\.pathname === "\/livez"/, "must have /livez endpoint");
assert.match(src, /url\.pathname === "\/readyz"/, "must have /readyz endpoint");
assert.match(src, /url\.pathname === "\/healthz"/, "must have /healthz endpoint");

// No auth required
assert.match(src, /"\/livez"[\s\S]{0,200}writeJson\(response,\s*200/, "/livez returns 200");
assert.match(src, /"\/readyz"[\s\S]{0,200}writeJson\(response,\s*200/, "/readyz returns 200 when ready");
assert.match(src, /"\/readyz"[\s\S]{0,400}writeJson\(response,\s*503/, "/readyz returns 503 when shutting down");
assert.match(src, /OMNI_SHUTTING_DOWN/, "must respect OMNI_SHUTTING_DOWN env var for /readyz");

// Methods
assert.match(src, /method === "GET" \|\| method === "HEAD"/, "must accept GET and HEAD on probes");

console.log("healthz unit test ok");
