/**
 * Unit test for screenshots timeline endpoint (P4-05).
 * Verifies service.listScreenshots filters by type='screenshot' and
 * the HTTP endpoint is wired.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const serviceSrc = fs.readFileSync("src/server/service.ts", "utf8");
const localSrc = fs.readFileSync("src/server/local-server.ts", "utf8");

// service.listScreenshots
assert.match(serviceSrc, /listScreenshots\(/, "service must have listScreenshots method");
assert.match(serviceSrc, /listScreenshots[\s\S]{0,200}filter\(\(a\) => a\.type === "screenshot"\)/, "listScreenshots must filter on type='screenshot'");

// HTTP endpoint
assert.match(localSrc, /\/screenshots\$/, "must have /api/sessions/{id}/screenshots endpoint");
assert.match(localSrc, /service\.listScreenshots\(sessionId, claims\.sub\)/, "endpoint must call service.listScreenshots");
assert.match(localSrc, /artifacts\.read/, "endpoint must require artifacts.read scope");

// Response shape
assert.match(localSrc, /\{ sessionId, screenshots \}/, "response shape: { sessionId, screenshots }");

console.log("screenshots-timeline unit test ok");
