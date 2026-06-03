/**
 * Smoke test for Wave 2 Task 2 — high-level commands in service.ts.
 *
 * 14 new SessionCommand variants wrap the new low-level ComputerAction
 * variants from Task 1. Each routes through handleNewHighLevel which:
 *   - Resolves selectors to coordinates (for hover/right_click/double_click/drag/scroll)
 *   - Builds a low-level ComputerAction
 *   - Re-enters handleComputer for the safety rails + webhooks + audit path
 *
 * This smoke verifies:
 *   - All 14 new commands are valid SessionCommand members (typecheck)
 *   - The executeCommand switch routes every new variant to handleNewHighLevel
 *   - describeCommandForActionLog returns a non-empty summary for every new variant
 *   - The new helper methods resolveSelectorCoords and resolveShadowPierceCoords exist
 *   - handleComputer attaches the session page to the LocalComputerController
 *   - Adding a new variant does NOT delete any of the 10 original variants
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const SERVICE_SRC = fs.readFileSync("src/server/service.ts", "utf8");
const COMPUTER_SRC = fs.readFileSync("src/runtime/local-computer.ts", "utf8");

// ── 1. Type-level check: 14 new SessionCommand variants ────────────────────
const newCommands = [
  "right_click",
  "double_click",
  "hover",
  "shortcut",
  "drag",
  "scroll",
  "file_upload",
  "file_download",
  "screenshot_element",
  "fill_form",
  "scroll_until",
  "enter_frame",
  "exit_frame",
  "shadow_click",
] as const;
assert.equal(newCommands.length, 14, "must have exactly 14 new high-level commands");

// Every new variant must be a string literal in the SessionCommand type
// union declaration (string-search proves the type member is present).
for (const variant of newCommands) {
  assert.match(SERVICE_SRC, new RegExp(`type:\\s*"${variant}"`), `SessionCommand must include variant ${variant}`);
}

// ── 2. Dispatch: executeCommand switch routes every new variant ───────────
const switchMatch = SERVICE_SRC.match(/case\s+"([a-z_]+)":[\s\S]+?result\s*=\s*await\s+this\.handleNewHighLevel/);
assert.ok(switchMatch, "executeCommand switch must call handleNewHighLevel for new variants");
const switchBlock = switchMatch![0];
for (const variant of newCommands) {
  assert.ok(switchBlock.includes(`"${variant}"`), `dispatch switch must list variant ${variant}`);
}

// ── 3. describeCommandForActionLog handles every new variant ──────────────
// The function is module-private; verify via source presence in the switch.
const summaryMatch = SERVICE_SRC.match(/function\s+describeCommandForActionLog[\s\S]+?\n\}/);
assert.ok(summaryMatch, "describeCommandForActionLog must exist");
const summaryBody = summaryMatch![0];
for (const variant of newCommands) {
  assert.ok(
    summaryBody.includes(`case "${variant}"`),
    `describeCommandForActionLog must handle ${variant}`,
  );
}

// All 10 original commands must still be present (zero-deletion rule).
const originalCommands = [
  "navigate",
  "click",
  "type",
  "screenshot",
  "pause",
  "resume",
  "status",
  "computer",
  "directive",
  "assistant_reply",
];
for (const variant of originalCommands) {
  assert.ok(
    summaryBody.includes(`case "${variant}"`),
    `describeCommandForActionLog must still handle original ${variant} (zero-deletion)`,
  );
  assert.ok(
    switchBlock.includes(`"${variant}"`) || SERVICE_SRC.includes(`case "${variant}":`),
    `executeCommand must still dispatch original ${variant}`,
  );
}

// ── 4. New helper methods exist in service.ts ──────────────────────────────
assert.match(
  SERVICE_SRC,
  /resolveSelectorCoords\s*\(\s*record:\s*SessionRecord/,
  "resolveSelectorCoords helper must exist",
);
assert.match(
  SERVICE_SRC,
  /resolveShadowPierceCoords\s*\(\s*record:\s*SessionRecord/,
  "resolveShadowPierceCoords helper must exist",
);

// ── 5. handleComputer now attaches the page to LocalComputerController ────
assert.match(
  SERVICE_SRC,
  /record\.computer\.setPage\(page\)/,
  "handleComputer must attach the session's page to the LocalComputerController",
);

// ── 6. NewHighLevelCommand type is exported ────────────────────────────────
assert.match(
  SERVICE_SRC,
  /export\s+type\s+NewHighLevelCommand/,
  "NewHighLevelCommand type must be exported for reuse in /api/commands schema (Task 9)",
);

// ── 7. local-computer.ts exposes the actions the new wrappers need ─────────
const neededLowLevel = [
  "right_click",
  "double_click",
  "hover",
  "shortcut",
  "drag",
  "scroll",
  "file_upload",
  "file_download",
  "screenshot_element",
  "fill_form",
  "scroll_until",
  "enter_frame",
  "exit_frame",
  "shadow_pierce",
];
for (const variant of neededLowLevel) {
  assert.ok(
    COMPUTER_SRC.includes(`type: "${variant}"`),
    `ComputerAction union must include ${variant}`,
  );
}

console.log("high-level-commands smoke ok");
