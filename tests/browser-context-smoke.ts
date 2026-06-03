/**
 * Smoke test for Wave 2 Task 4 — session browser context.
 *
 * Per-session browser context (viewport, user_agent, locale, timezone,
 * geolocation, permissions, color_scheme, device emulation) is set at
 * session creation and cannot be changed afterward. Per-session overrides
 * win over global env defaults read in local-server.ts.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const SERVER_SRC = fs.readFileSync("src/server/local-server.ts", "utf8");
const SESSION_MGR_SRC = fs.readFileSync("src/runtime/omni-session-manager.ts", "utf8");
const SERVICE_SRC = fs.readFileSync("src/server/service.ts", "utf8");

// ── 1. BrowserContextOptions type exists in omni-session-manager.ts ───────
assert.match(
  SESSION_MGR_SRC,
  /export type BrowserContextOptions/,
  "BrowserContextOptions must be exported from omni-session-manager.ts",
);
const ctxTypeMatch = SESSION_MGR_SRC.match(
  /export type BrowserContextOptions\s*=\s*\{[\s\S]+?viewport\?:\s*\{[^}]+\};[\s\S]+?\};/,
);
assert.ok(ctxTypeMatch, "BrowserContextOptions type body must exist");
const ctxType = ctxTypeMatch![0];
assert.match(ctxType, /viewport\?:\s*\{\s*height:\s*number;\s*width:\s*number\s*\}/);
assert.match(ctxType, /userAgent\?:\s*string/);
assert.match(ctxType, /locale\?:\s*string/);
assert.match(ctxType, /timezoneId\?:\s*string/);
assert.match(ctxType, /geolocation\?:\s*\{\s*latitude:\s*number;\s*longitude:\s*number\s*\}/);
assert.match(ctxType, /permissions\?:\s*string\[\]/);
assert.match(ctxType, /colorScheme\?:\s*"dark"\s*\|\s*"light"\s*\|\s*"no-preference"/);
assert.match(ctxType, /device\?:\s*string/);

// ── 2. mergeBrowserContextOptions is exported and merges device + explicit ─
assert.match(
  SESSION_MGR_SRC,
  /export function mergeBrowserContextOptions/,
  "mergeBrowserContextOptions must be exported",
);
assert.match(
  SESSION_MGR_SRC,
  /const profile = \(devices as Record<string, Record<string, unknown>>\)\[device\]/,
  "mergeBrowserContextOptions must look up the device profile from playwright.devices",
);
assert.match(
  SESSION_MGR_SRC,
  /return\s*\{\s*\.\.\.profile,\s*\.\.\.explicit\s*\}/,
  "explicit fields must override device profile (spread order: profile first, explicit second)",
);

// ── 3. omni-session-manager.createSession accepts contextOptions ───────────
assert.match(
  SESSION_MGR_SRC,
  /createSession\(input: \{[\s\S]+?contextOptions\?:\s*BrowserContextOptions/,
  "createSession input must accept contextOptions",
);
assert.match(
  SESSION_MGR_SRC,
  /mergeBrowserContextOptions\(input\.contextOptions\)/,
  "createSession must call mergeBrowserContextOptions to build the per-session options",
);

// ── 4. omni-core-clone.initVault accepts contextOptions and forwards it ────
const coreSrc = fs.readFileSync("src/runtime/omni-core-clone.ts", "utf8");
assert.match(
  coreSrc,
  /import\s*\{[^}]*BrowserContextOptions[^}]*\}\s*from\s*"\.\/omni-session-manager\.js"/,
  "omni-core-clone must import BrowserContextOptions",
);
assert.match(
  coreSrc,
  /async initVault\([\s\S]+?contextOptions\?:\s*BrowserContextOptions/,
  "initVault must accept contextOptions as a third parameter",
);
assert.match(
  coreSrc,
  /this\.sessionManager\.createSession\(\{[\s\S]+?contextOptions,/,
  "initVault must forward contextOptions to sessionManager.createSession",
);

// ── 5. service.createSession accepts all 9 new fields and forwards them ──
const createInputMatch = SERVICE_SRC.match(
  /type CreateSessionInput\s*=\s*\{[\s\S]+?viewport\?:\s*\{[\s\S]+?\};\s*\};/,
);
assert.ok(createInputMatch, "CreateSessionInput type must exist");
const createInput = createInputMatch![0];
for (const field of [
  "viewport",
  "userAgent",
  "locale",
  "timezoneId",
  "geolocation",
  "permissions",
  "colorScheme",
  "device",
]) {
  assert.ok(
    createInput.includes(`${field}?:`),
    `CreateSessionInput must accept ${field} (zero-deletion rule: existing fields still accepted)`,
  );
}
assert.match(SERVICE_SRC, /core\.initVault\([\s\S]+?contextOptions[\s\S]+?\);/, "service must pass contextOptions to initVault");

// ── 6. local-server reads env vars and applies them as defaults ───────────
assert.match(SERVER_SRC, /readStringFromEnv\("OMNI_LOCALE"\)/, "must read OMNI_LOCALE");
assert.match(SERVER_SRC, /readStringFromEnv\("OMNI_TIMEZONE"\)/, "must read OMNI_TIMEZONE");
assert.match(SERVER_SRC, /readStringFromEnv\("OMNI_USER_AGENT"\)/, "must read OMNI_USER_AGENT");
assert.match(
  SERVER_SRC,
  /readViewportFromEnv\([\s\S]+?OMNI_VIEWPORT_WIDTH[\s\S]+?OMNI_VIEWPORT_HEIGHT[\s\S]+?\)/,
  "must read OMNI_VIEWPORT_WIDTH + OMNI_VIEWPORT_HEIGHT",
);
assert.match(SERVER_SRC, /readColorSchemeFromEnv/, "must read OMNI_COLOR_SCHEME");
assert.match(SERVER_SRC, /readDeviceFromEnv/, "must read OMNI_DEVICE");
assert.match(SERVER_SRC, /readGeolocationFromEnv/, "must read OMNI_GEOLOCATION");

// ── 7. Per-session overrides win over env defaults (spread order) ────────
assert.match(
  SERVER_SRC,
  /colorScheme: payload\.colorScheme\s*\?\?\s*readColorSchemeFromEnv\(\)/,
  "colorScheme: payload wins, then env",
);
assert.match(
  SERVER_SRC,
  /userAgent: payload\.userAgent\s*\?\?\s*readStringFromEnv\("OMNI_USER_AGENT"\)/,
  "userAgent: payload wins, then env",
);
assert.match(
  SERVER_SRC,
  /viewport:\s*payload\.viewport\s*\?\?\s*readViewportFromEnv/,
  "viewport: payload wins, then env",
);

// ── 8. POST /api/sessions accepts the new fields in the request body ─────
// Match from the POST /api/sessions handler up to the `return writeJson(..., 201, session)` line
// so the postSession slice covers the body type + the service call without
// the lazy-brace ambiguity from nested objects.
const postSessionMatch = SERVER_SRC.match(
  /if \(method === "POST" && url\.pathname === "\/api\/sessions"\)[\s\S]+?return writeJson\(response, 201, session\);/,
);
assert.ok(postSessionMatch, "POST /api/sessions handler must exist");
const postSession = postSessionMatch![0];
for (const field of [
  "colorScheme",
  "device",
  "geolocation",
  "locale",
  "permissions",
  "timezoneId",
  "userAgent",
  "viewport",
]) {
  assert.ok(
    postSession.includes(`${field}?:`),
    `POST /api/sessions body type must accept ${field}`,
  );
}

// ── 9. Zero-deletion: original createSession fields still accepted ────────
const originalCreateFields = [
  "agentId",
  "creditBudget",
  "objective",
  "operatorSessionId",
  "orgId",
  "persistent",
  "policyVersion",
  "sessionId",
  "userId",
];
for (const field of originalCreateFields) {
  assert.ok(
    createInput.includes(`${field}?:`),
    `CreateSessionInput must still accept original field ${field}`,
  );
}

console.log("browser-context smoke ok");
