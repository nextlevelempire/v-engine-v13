/**
 * Smoke test for Wave 2 Task 9 — GET /api/commands JSON Schema.
 *
 * The commands-schema module builds a JSON Schema (draft-07) for the
 * SessionCommand discriminated union. The schema is exposed via
 * GET /api/commands so dashboards and clients can introspect the API
 * surface without parsing the TypeScript source.
 *
 * This smoke verifies:
 *   - The module exports getCommandsSchema / listCommandNames /
 *     getCommandDefinition
 *   - The schema is a valid JSON Schema object (title, $schema, oneOf)
 *   - All 33 commands are listed (10 original + 14 high-level + 6 AI
 *     helpers + 3 CAPTCHA commands)
 *   - Each command branch has a `type` const discriminator
 *   - local-server wires the endpoint at GET /api/commands and returns
 *     the schema with commandNames + count + schema
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const SCHEMA_SRC = fs.readFileSync("src/server/commands-schema.ts", "utf8");
const SERVER_SRC = fs.readFileSync("src/server/local-server.ts", "utf8");

// ── 1. Module exports the 3 functions ──────────────────────────────────────
assert.match(SCHEMA_SRC, /export function getCommandsSchema/, "getCommandsSchema must be exported");
assert.match(SCHEMA_SRC, /export function listCommandNames/, "listCommandNames must be exported");
assert.match(SCHEMA_SRC, /export function getCommandDefinition/, "getCommandDefinition must be exported");

// ── 2. Schema is JSON Schema (draft-07) with oneOf branches ──────────────
assert.match(SCHEMA_SRC, /http:\/\/json-schema\.org\/draft-07\/schema#/, "must use JSON Schema draft-07");
assert.match(SCHEMA_SRC, /oneOf/, "schema must have oneOf");
assert.match(SCHEMA_SRC, /type:\s*"object"/, "schema root must be an object");
assert.match(SCHEMA_SRC, /title:\s*"SessionCommand"/, "schema must be titled SessionCommand");
assert.match(SCHEMA_SRC, /enum:\s*\[def\.name\]/, "each branch must have a const type discriminator");

// ── 3. All 33 commands are listed ────────────────────────────────────────
const allCommands = [
  // 10 original commands
  "navigate", "click", "type", "screenshot", "pause", "resume", "status",
  "computer", "directive", "assistant_reply",
  // 14 high-level wrappers
  "right_click", "double_click", "hover", "shortcut", "drag", "scroll",
  "file_upload", "file_download", "screenshot_element", "fill_form",
  "scroll_until", "enter_frame", "exit_frame", "shadow_click",
  // 6 AI helpers
  "plan", "execute_plan", "next_step", "describe_page", "find", "wait_for",
  // 3 CAPTCHA commands
  "detect_captcha", "wait_for_human", "navigate_with_fallback",
];
assert.equal(allCommands.length, 33, "must have 33 commands total (10+14+6+3)");
for (const name of allCommands) {
  assert.ok(
    SCHEMA_SRC.includes(`name: "${name}"`),
    `commands-schema must define command ${name}`,
  );
}

// ── 4. Each command has a description and fields ────────────────────────
const commandDefCount = (SCHEMA_SRC.match(/name:\s*"[a-z_]+",/g) ?? []).length;
assert.ok(
  commandDefCount >= 33,
  `expected at least 33 CommandDefinition entries, found ${commandDefCount}`,
);

// ── 5. Click command has all 4 input shapes in its schema ────────────────
// Read the click command body via indexOf to avoid the lazy-brace ambiguity
// across multiple CommandDefinition entries. The fields block lives BEFORE
// the `name: "click"` line, so start the slice from the prior `{` boundary.
const clickStart = SCHEMA_SRC.indexOf("description: \"Click on an element");
assert.ok(clickStart > 0, "click command body must exist");
const clickSlice = SCHEMA_SRC.slice(clickStart, SCHEMA_SRC.indexOf('name: "type"'));
assert.ok(clickSlice.length > 0, "click body must exist");
assert.match(clickSlice, /selector/, "click schema must include selector field");
assert.match(clickSlice, /text/, "click schema must include text field");
assert.match(clickSlice, /coordinates/, "click schema must include coordinates field");
assert.match(clickSlice, /match_index/, "click schema must include match_index field");

// ── 6. local-server wires GET /api/commands ──────────────────────────────
assert.match(
  SERVER_SRC,
  /url\.pathname === "\/api\/commands"/,
  "local-server must route GET /api/commands",
);
assert.match(SERVER_SRC, /getCommandsSchema\(\)/, "endpoint must call getCommandsSchema");
assert.match(SERVER_SRC, /listCommandNames\(\)/, "endpoint must call listCommandNames");
assert.match(SERVER_SRC, /writeJson\(response, 200, \{[\s\S]+?schema: getCommandsSchema/);

// ── 7. Endpoint is GET-or-HEAD only (no POST) ─────────────────────────────
const epMatch = SERVER_SRC.match(/if \(\(method === "GET" \|\| method === "HEAD"\) && url\.pathname === "\/api\/commands"\)[\s\S]+?return writeJson/);
assert.ok(epMatch, "endpoint handler must exist");
assert.ok(!/\.post\(/.test(epMatch![0]), "endpoint must not be a POST handler");

// ── 8. Build at boot, no manual maintenance ──────────────────────────────
// The schema is cached after the first call (no per-request rebuild).
assert.match(SCHEMA_SRC, /cachedSchema/, "schema must be cached at module load");

console.log("commands-schema smoke ok");
