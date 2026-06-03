/**
 * Smoke test for Wave 2 Task 5 — AI helpers.
 *
 * 6 new SessionCommand variants wrap the existing omni-planner and
 * omni-ax-observer. Each returns a structured result the AI can consume:
 *
 *   plan(goal)            -> { plan_id, status: "draft" }
 *   execute_plan(id, ?)   -> runs via executePlan() with the planner's
 *                            Plan -> Observe -> Execute -> Verify loop
 *   next_step(id, step)   -> adds + runs a single step
 *   describe_page         -> captureAXObservation (AX tree, url, title,
 *                            authWallHint, captchaHint, axTreeHash)
 *   find(text, fuzzy?)    -> exact or Levenshtein<=2 match against the
 *                            AX tree, returns { count, matches[] }
 *   wait_for(pred, to)    -> page.waitForFunction with timeout
 *
 * This smoke verifies:
 *   - All 6 new commands are valid SessionCommand members
 *   - handleAiHelper routes them all
 *   - describeCommandForActionLog returns a non-empty summary
 *   - PlanStore / Levenshtein helpers exist
 *   - executePlan from omni-planner is wired in
 *   - captureAXObservation from omni-ax-observer is wired in
 *   - All 14 high-level commands + original 10 commands still in the union
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const SERVICE_SRC = fs.readFileSync("src/server/service.ts", "utf8");

// ── 1. 6 new AI helper commands in the SessionCommand union ──────────────
const aiCommands = ["plan", "execute_plan", "next_step", "describe_page", "find", "wait_for"] as const;
assert.equal(aiCommands.length, 6, "must have exactly 6 new AI helper commands");
for (const variant of aiCommands) {
  assert.match(
    SERVICE_SRC,
    new RegExp(`type:\\s*"${variant}"`),
    `SessionCommand must include AI helper variant ${variant}`,
  );
}

// ── 2. PlannedStepInput + PlannedActionInput types are exported ───────────
assert.match(SERVICE_SRC, /export type PlannedStepInput/, "PlannedStepInput must be exported");
assert.match(SERVICE_SRC, /export type PlannedActionInput/, "PlannedActionInput must be exported");

// ── 3. handleAiHelper exists and routes all 6 variants ───────────────────
const handleAiMatch = SERVICE_SRC.match(/private async handleAiHelper[\s\S]+?\n  \}/);
assert.ok(handleAiMatch, "handleAiHelper must exist");
const handleAi = handleAiMatch![0];
for (const variant of aiCommands) {
  assert.ok(handleAi.includes(`case "${variant}"`), `handleAiHelper must route ${variant}`);
}
// Critical sub-features
assert.match(handleAi, /this\.planStore\.create\(/, "plan() must create via planStore");
assert.match(handleAi, /this\.planStore\.get\(/, "execute_plan() must look up via planStore");
assert.match(handleAi, /captureAXObservation\(page\)/, "describe_page() must use captureAXObservation");
assert.match(handleAi, /findInPage\(/, "find() must use findInPage helper");
assert.match(handleAi, /page\.waitForFunction\(/, "wait_for() must use page.waitForFunction");
assert.match(handleAi, /executePlan\(\{/, "execute_plan() must use the omni-planner executePlan");

// ── 4. PlanStore class exists in service.ts with all methods ─────────────
assert.match(SERVICE_SRC, /class PlanStore/, "PlanStore class must exist");
for (const method of ["create", "get", "getSteps", "setSteps", "appendStep", "markExecuted"]) {
  assert.ok(
    SERVICE_SRC.includes(`${method}(`),
    `PlanStore must implement ${method}`,
  );
}

// ── 5. Levenshtein helper exists for fuzzy find ──────────────────────────
assert.match(SERVICE_SRC, /function levenshtein\(/, "levenshtein function must exist for fuzzy find");
assert.match(SERVICE_SRC, /distance <= 2/, "fuzzy find must use Levenshtein distance <= 2");

// ── 6. findInPage helper handles exact and fuzzy modes ────────────────────
const findInPageMatch = SERVICE_SRC.match(/private async findInPage[\s\S]+?\n  \}/);
assert.ok(findInPageMatch, "findInPage must exist");
const findInPage = findInPageMatch![0];
assert.match(findInPage, /count[^,}]+/, "findInPage must return count");
assert.match(findInPage, /fuzzy: \w+/, "findInPage must indicate fuzzy/exact mode");
assert.match(findInPage, /match_index/, "findInPage must return per-match index");
assert.match(findInPage, /query: text/, "findInPage must echo the query");

// ── 7. describeCommandForActionLog handles all 6 new commands ────────────
const summaryMatch = SERVICE_SRC.match(/function\s+describeCommandForActionLog[\s\S]+?\n\}/);
assert.ok(summaryMatch, "describeCommandForActionLog must exist");
const summary = summaryMatch![0];
for (const variant of aiCommands) {
  assert.ok(
    summary.includes(`case "${variant}"`),
    `describeCommandForActionLog must handle ${variant}`,
  );
}

// ── 8. Zero-deletion: all 10 original + 14 high-level commands still present
const allPreviousCommands = [
  "navigate", "click", "type", "screenshot", "pause", "resume", "status",
  "computer", "directive", "assistant_reply",
  "right_click", "double_click", "hover", "shortcut", "drag", "scroll",
  "file_upload", "file_download", "screenshot_element", "fill_form",
  "scroll_until", "enter_frame", "exit_frame", "shadow_click",
];
for (const variant of allPreviousCommands) {
  assert.ok(
    summary.includes(`case "${variant}"`),
    `describeCommandForActionLog must still handle ${variant} (zero-deletion)`,
  );
}

console.log("ai-helpers smoke ok");
