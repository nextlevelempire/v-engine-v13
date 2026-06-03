/**
 * Smoke test for Wave 2 Task 10 — session context endpoints.
 *
 * Three new read-only endpoints on /api/sessions/{id}/:
 *
 *   GET /context  — rich page snapshot: URL, title, AX tree summary
 *                   (capped 2000 chars), axTreeHash, auth/captcha hints,
 *                   runtime status. Lighter than `describe_page`.
 *
 *   GET /console  — ring buffer of captured console messages, newest
 *                   first; ?limit=N (default 200, max 1000). Buffer
 *                   size is OMNI_TELEMETRY_BUFFER_SIZE (default 1000,
 *                   hard cap 10_000).
 *
 *   GET /network  — ring buffer of captured request/response events,
 *                   newest first; ?limit=N (default 200, max 1000).
 *
 * The capture is wired in omni-session-manager via the context's
 * 'page' event listener; the SessionTelemetryStore keeps the buffers
 * in memory keyed by sessionId.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const SERVER_SRC = fs.readFileSync("src/server/local-server.ts", "utf8");
const SERVICE_SRC = fs.readFileSync("src/server/service.ts", "utf8");
const TELEMETRY_SRC = fs.readFileSync("src/runtime/session-telemetry.ts", "utf8");
const SESSION_MGR_SRC = fs.readFileSync("src/runtime/omni-session-manager.ts", "utf8");

// ── 1. session-telemetry module exports ───────────────────────────────────
assert.match(TELEMETRY_SRC, /export class SessionTelemetryStore/, "SessionTelemetryStore must be exported");
assert.match(TELEMETRY_SRC, /export function getTelemetryStore/, "getTelemetryStore must be exported");
assert.match(TELEMETRY_SRC, /export function attachTelemetryListeners/, "attachTelemetryListeners must be exported");
assert.match(TELEMETRY_SRC, /export function resetTelemetryStore/, "resetTelemetryStore must be exported");
assert.match(TELEMETRY_SRC, /export type CapturedConsoleEntry/, "CapturedConsoleEntry must be exported");
assert.match(TELEMETRY_SRC, /export type CapturedNetworkEntry/, "CapturedNetworkEntry must be exported");

// ── 2. Buffer is bounded by OMNI_TELEMETRY_BUFFER_SIZE (default 1000) ────
assert.match(
  TELEMETRY_SRC,
  /OMNI_TELEMETRY_BUFFER_SIZE/,
  "telemetry module must read OMNI_TELEMETRY_BUFFER_SIZE",
);
assert.match(TELEMETRY_SRC, /MAX_BUFFER = 10_000/, "telemetry must hard-cap at 10_000 entries");
assert.match(TELEMETRY_SRC, /DEFAULT_BUFFER = 1000/, "telemetry default must be 1000");

// ── 3. Listeners cover console, request, response, requestfailed ─────────
for (const ev of ["console", "request", "response", "requestfailed"]) {
  assert.ok(
    TELEMETRY_SRC.includes(`page.on("${ev}"`),
    `attachTelemetryListeners must wire page.on("${ev}")`,
  );
}

// ── 4. Newest-first ring buffer (unshift + length cap) ───────────────────
assert.match(TELEMETRY_SRC, /buf\.console\.unshift/, "console buffer must be newest-first (unshift)");
assert.match(TELEMETRY_SRC, /buf\.network\.unshift/, "network buffer must be newest-first (unshift)");
assert.match(TELEMETRY_SRC, /if \(buf\.console\.length > this\.size\)/, "console buffer must be capped at size");
assert.match(TELEMETRY_SRC, /if \(buf\.network\.length > this\.size\)/, "network buffer must be capped at size");

// ── 5. Service exposes getSessionContext ─────────────────────────────────
assert.match(
  SERVICE_SRC,
  /async getSessionContext\(sessionId: string\)/,
  "service must expose getSessionContext",
);
assert.match(SERVICE_SRC, /getSessionContext[\s\S]+?axSummary/, "context must include axSummary");
assert.match(SERVICE_SRC, /getSessionContext[\s\S]+?axTreeHash/, "context must include axTreeHash");
assert.match(SERVICE_SRC, /getSessionContext[\s\S]+?authWallHint/, "context must include authWallHint");
assert.match(SERVICE_SRC, /getSessionContext[\s\S]+?captchaHint/, "context must include captchaHint");
assert.match(SERVICE_SRC, /captureAXObservation\(page\)/, "context must call captureAXObservation");

// ── 6. Three endpoints in local-server ──────────────────────────────────
// Each endpoint is wired as: const <name>Match = url.pathname.match(/...<path>$/);
// followed by if (method === "GET" && <name>Match) { ... }.
// We check the variable definition + the GET gate + the path literal.

assert.ok(
  /const contextMatch = url\.pathname\.match\(\/[^`]*?\/context\$\/\)/.test(SERVER_SRC),
  "/context endpoint regex must exist in local-server",
);
assert.ok(
  /const consoleMatch = url\.pathname\.match\(\/[^`]*?\/console\$\/\)/.test(SERVER_SRC),
  "/console endpoint regex must exist in local-server",
);
assert.ok(
  /const networkMatch = url\.pathname\.match\(\/[^`]*?\/network\$\/\)/.test(SERVER_SRC),
  "/network endpoint regex must exist in local-server",
);

// /context
assert.ok(
  SERVER_SRC.includes('if (method === "GET" && contextMatch)'),
  "/context endpoint must be wired (GET-only)",
);
assert.match(SERVER_SRC, /service\.getSessionContext\(sessionId\)/, "/context must call getSessionContext");

// /console
assert.ok(
  SERVER_SRC.includes('if (method === "GET" && consoleMatch)'),
  "/console endpoint must be wired (GET-only)",
);
assert.match(SERVER_SRC, /getTelemetryStore\(\)/, "/console must use getTelemetryStore");
assert.match(SERVER_SRC, /buf\?\.console/, "/console must read from the console buffer");

// /network
assert.ok(
  SERVER_SRC.includes('if (method === "GET" && networkMatch)'),
  "/network endpoint must be wired (GET-only)",
);
assert.match(SERVER_SRC, /buf\?\.network/, "/network must read from the network buffer");

// limit param support
const limitParam = (SERVER_SRC.match(/url\.searchParams\.get\("limit"\)/g) ?? []).length;
assert.ok(limitParam >= 2, "/console and /network must support ?limit= (got ${limitParam})");

// ── 7. Endpoints are GET-only (no POST/PUT/DELETE) ───────────────────────
for (const path of ["/context", "/console", "/network"]) {
  const pathPattern = `/api/sessions/([^/]+)${path}`;
  const ep = SERVER_SRC.match(
    new RegExp(`if \\(method === "GET" && url\\.pathname\\.match\\(/\\^\\${pathPattern.replace(/\//g, "\\\\/")}\\$\\/\\)\\)`),
  );
  // Simpler: just check the source has `if (method === "GET"` near the path
  const lines = SERVER_SRC.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(pathPattern)) {
      // The previous 3 lines should include the method check
      const before = lines.slice(Math.max(0, i - 3), i).join("\n");
      assert.ok(
        before.includes('method === "GET"'),
        `${path} endpoint must be GET-only`,
      );
    }
  }
}

// ── 8. Session manager wires the listeners on every new page ────────────
assert.match(
  SESSION_MGR_SRC,
  /import\s*\{[^}]*attachTelemetryListeners[^}]*\}\s*from\s*"\.\/session-telemetry\.js"/,
  "omni-session-manager must import attachTelemetryListeners",
);
const attachCount = (SESSION_MGR_SRC.match(/attachTelemetryListeners\(page, sessionId\)/g) ?? []).length;
assert.ok(
  attachCount >= 2,
  `attachTelemetryListeners must be called on every new page (expected >= 2 call sites: persistent + default; got ${attachCount})`,
);

// ── 9. Auth: endpoints require grant + sessions.command scope ───────────
const verifyContext = SERVER_SRC.match(/contextMatch[\s\S]+?verifyRequestGrant[\s\S]+?\)/);
assert.ok(verifyContext, "/context must call verifyRequestGrant");

console.log("session-context smoke ok");
