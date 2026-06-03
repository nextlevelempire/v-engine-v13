/**
 * Smoke test for Wave 2 Task 7 — Stealth.
 *
 * STEALTH_LEVEL env var (off | basic | aggressive, default off) controls
 * the anti-bot patches applied to the browser context.
 *
 *   off:        no patches (default; safe for local dev)
 *   basic:      randomized UA from a 10-UA pool, randomized viewport,
 *               randomized locale + timezone
 *   aggressive: also override navigator.webdriver, navigator.plugins,
 *               navigator.languages, chrome.runtime via addInitScript
 *
 * Per-session browser context options (Task 4) still win over stealth
 * defaults — they are layered ON TOP via spread order.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const STEALTH_SRC = fs.readFileSync("src/runtime/stealth.ts", "utf8");
const SESSION_MGR_SRC = fs.readFileSync("src/runtime/omni-session-manager.ts", "utf8");

// ── 1. StealthLevel type and readStealthLevel env reader ──────────────────
assert.match(STEALTH_SRC, /export type StealthLevel/, "StealthLevel must be exported");
assert.match(STEALTH_SRC, /export function readStealthLevel/, "readStealthLevel must be exported");
assert.match(STEALTH_SRC, /STEALTH_LEVEL/, "must read STEALTH_LEVEL env var");
const stealthRead = STEALTH_SRC.match(/export function readStealthLevel[\s\S]+?\n\}/);
assert.ok(stealthRead, "readStealthLevel must exist");
const readerBody = stealthRead![0];
assert.ok(readerBody.includes("aggressive") && readerBody.includes("basic") && readerBody.includes("off"), "readStealthLevel must accept all 3 levels");
assert.match(readerBody, /return "off"/, "must default to off");

// ── 2. UA / locale / timezone / viewport pools exist with the right size ─
assert.match(STEALTH_SRC, /USER_AGENT_POOL/, "must have a UA pool");
assert.match(STEALTH_SRC, /LOCALE_POOL/, "must have a locale pool");
assert.match(STEALTH_SRC, /TIMEZONE_POOL/, "must have a timezone pool");
assert.match(STEALTH_SRC, /VIEWPORT_POOL/, "must have a viewport pool");
const uaPool = STEALTH_SRC.match(/USER_AGENT_POOL: string\[\] = \[([\s\S]+?)\];/);
assert.ok(uaPool, "UA pool literal must exist");
const uaCount = (uaPool![1].match(/Mozilla/g) ?? []).length;
assert.ok(uaCount >= 10, `UA pool must have at least 10 entries, got ${uaCount}`);

// ── 3. applyStealth function exists with aggressive addInitScript ────────
assert.match(STEALTH_SRC, /export async function applyStealth/, "applyStealth must be exported");
assert.match(STEALTH_SRC, /context\.addInitScript\(/, "applyStealth must call addInitScript");
assert.match(STEALTH_SRC, /navigator\.webdriver/, "aggressive patch must override navigator.webdriver");
assert.match(STEALTH_SRC, /navigator\.languages/, "aggressive patch must override navigator.languages");
assert.match(STEALTH_SRC, /navigator\.plugins/, "aggressive patch must override navigator.plugins");
assert.match(STEALTH_SRC, /chrome\.runtime/, "aggressive patch must fake chrome.runtime");
assert.match(STEALTH_SRC, /permissions\.query/, "aggressive patch must override permissions.query");
assert.match(STEALTH_SRC, /notifications/, "aggressive patch must handle notifications permission");

// ── 4. stealthContextOptions returns randomized values for basic+ ────────
assert.match(STEALTH_SRC, /export function stealthContextOptions/, "stealthContextOptions must be exported");
// Read the function body via indexOf to avoid the lazy-brace ambiguity.
const stealthFnStart = STEALTH_SRC.indexOf("export function stealthContextOptions");
const stealthFnBody = STEALTH_SRC.slice(stealthFnStart, STEALTH_SRC.indexOf("\n}\n", stealthFnStart) + 3);
assert.ok(stealthFnBody.length > 0, "stealthContextOptions body must exist");
assert.match(stealthFnBody, /level\s*===\s*"off"[\s\S]+?return\s*\{\}/, "off level must return empty options");
assert.match(stealthFnBody, /pick\(USER_AGENT_POOL\)/, "must randomize UA from pool");
assert.match(stealthFnBody, /pick\(LOCALE_POOL\)/, "must randomize locale from pool");
assert.match(stealthFnBody, /pick\(TIMEZONE_POOL\)/, "must randomize timezone from pool");
assert.match(stealthFnBody, /pick\(VIEWPORT_POOL\)/, "must randomize viewport from pool");

// ── 5. Session manager applies stealth in the createSession path ─────────
assert.match(
  SESSION_MGR_SRC,
  /import\s*\{[^}]*stealth[^}]*\}\s*from\s*"\.\/stealth\.js"/i,
  "omni-session-manager must import the stealth module",
);
assert.match(
  SESSION_MGR_SRC,
  /stealthContextOptions\(\)/,
  "createSession must call stealthContextOptions to pull randomized defaults",
);
assert.match(
  SESSION_MGR_SRC,
  /applyStealth\(context\)/,
  "createSession must call applyStealth for the aggressive-mode addInitScript",
);
assert.match(
  SESSION_MGR_SRC,
  /readStealthLevel\(\)/,
  "createSession must read the STEALTH_LEVEL env var",
);

// ── 6. Per-session context options still win over stealth defaults ──────
// The order in createSession must be: stealth (defaults) -> per-session (overrides).
assert.match(
  SESSION_MGR_SRC,
  /contextOptions\s*=\s*\{[\s\S]+?stealthOpts[\s\S]+?contextOptions[\s\S]+?\};/,
  "per-session context options must win over stealth defaults (stealth first, then per-session)",
);

// ── 7. No v0.1 surface changed (zero-deletion) ──────────────────────────
// Things that should still be present in the runtime.
const allSrc = [
  SESSION_MGR_SRC,
  fs.readFileSync("src/runtime/omni-ui-layer.ts", "utf8"),
  fs.readFileSync("src/server/takeover-config.ts", "utf8"),
].join("\n");
for (const retained of [
  "getEnabledTakeoverCapabilities",
  "registerOmniUiLayer",
  "connectLocalBrowserOverCdp",
  "forceInjectOmniUi",
]) {
  assert.ok(
    allSrc.includes(retained),
    `${retained} must still be present in the v0.3 surface`,
  );
}

console.log("stealth smoke ok");
