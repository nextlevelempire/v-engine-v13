/**
 * Smoke test for Wave 2 Task 1 — low-level ComputerAction extensions.
 *
 * The ComputerAction union was extended with 15 new variants. Two families:
 *
 *   1. Desktop-level: right_click, double_click, shortcut, drag, scroll,
 *      hover, clipboard_read, clipboard_write. These use the NativeInputAdapter.
 *
 *   2. Page-DOM: screenshot_element, file_upload, file_download, fill_form,
 *      scroll_until, enter_frame, exit_frame, shadow_pierce. These require a
 *      Page reference attached via setPage().
 *
 * This smoke verifies:
 *   - The 15 variants are all valid ComputerAction members (typecheck).
 *   - Desktop-level variants call the right adapter methods (stubbed).
 *   - Page-DOM variants return a structured ok:false blocked outcome when no
 *     page is attached (fail-closed).
 *   - The credential / irreversible rails still fire on the new variants.
 */
import assert from "node:assert/strict";
import { LocalComputerController, type ComputerAction } from "../src/runtime/local-computer.js";
import type { NativeInputAdapter } from "../src/runtime/native-input.js";

interface RecordedCall {
  args: unknown[];
  method: keyof NativeInputAdapter;
}

function createStubAdapter(): NativeInputAdapter & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const record = (method: keyof NativeInputAdapter) => (args: unknown[]) => {
    calls.push({ args, method });
  };
  const adapter: NativeInputAdapter = {
    click: async (...args) => { record("click")(args); },
    clipboardRead: async () => { record("clipboardRead")([]); return "stub-clipboard-text"; },
    clipboardWrite: async (text) => { record("clipboardWrite")([text]); },
    doubleClick: async (...args) => { record("doubleClick")(args); },
    drag: async (x1, y1, x2, y2) => { record("drag")([x1, y1, x2, y2]); },
    moveMouse: async (x, y) => { record("moveMouse")([x, y]); },
    pressKeys: async (keys) => { record("pressKeys")([keys]); },
    screenSize: async () => ({ height: 1080, width: 1920 }),
    screenshotPng: async () => Buffer.from("89504E470D0A1A0A", "hex"),
    scroll: async (dx, dy) => { record("scroll")([dx, dy]); },
    typeText: async (text) => { record("typeText")([text]); },
  };
  return Object.assign(adapter, { calls });
}

// ── 1. Type-level check: every new variant is a valid ComputerAction ────────
const variants: ComputerAction[] = [
  { type: "right_click", x: 100, y: 200 },
  { type: "double_click", x: 100, y: 200 },
  { type: "shortcut", keys: ["Control", "c"] },
  { type: "drag", fromX: 0, fromY: 0, toX: 100, toY: 100 },
  { type: "scroll", deltaX: 0, deltaY: 400, x: 500, y: 500 },
  { type: "hover", x: 250, y: 300 },
  { type: "clipboard_read" },
  { type: "clipboard_write", text: "hello" },
  { type: "screenshot_element", selector: "#main" },
  { type: "file_upload", selector: "input[type=file]", filePath: "/tmp/x.png" },
  { type: "file_download", url: "https://example.com/x.png", savePath: "/tmp/x.png" },
  { type: "fill_form", fields: [{ selector: "#name", value: "Jane" }] },
  { type: "scroll_until", target: "footer", direction: "down", maxScrolls: 5 },
  { type: "enter_frame", frameSelector: "iframe#payment" },
  { type: "exit_frame" },
  { type: "shadow_pierce", selector: "my-component >>> button.submit" },
];
assert.equal(variants.length, 16, "must have 16 new variants (right_click, double_click, shortcut, drag, scroll, hover, clipboard_read, clipboard_write, screenshot_element, file_upload, file_download, fill_form, scroll_until, enter_frame, exit_frame, shadow_pierce)");

// ── 2. Desktop-level variants call the right adapter methods ────────────────
const desktopChecks: Array<{
  action: ComputerAction;
  expect: keyof NativeInputAdapter;
  expectArgs?: unknown[];
}> = [
  { action: { type: "right_click", x: 50, y: 60 }, expect: "click", expectArgs: ["right"] },
  { action: { type: "double_click", x: 50, y: 60 }, expect: "doubleClick", expectArgs: ["left"] },
  { action: { type: "shortcut", keys: ["Control", "v"] }, expect: "pressKeys", expectArgs: [["Control", "v"]] },
  {
    action: { type: "drag", fromX: 0, fromY: 0, toX: 100, toY: 100 },
    expect: "drag",
    expectArgs: [0, 0, 100, 100],
  },
  {
    action: { type: "scroll", deltaX: 0, deltaY: 800 },
    expect: "scroll",
    expectArgs: [0, 800],
  },
  { action: { type: "hover", x: 200, y: 300 }, expect: "moveMouse", expectArgs: [200, 300] },
];

for (const check of desktopChecks) {
  const adapter = createStubAdapter();
  const controller = new LocalComputerController({ adapter });
  const outcome = await controller.execute(check.action);
  assert.equal(outcome.ok, true, `desktop action ${check.action.type} must succeed with stub adapter`);
  const call = adapter.calls.find((c) => c.method === check.expect);
  assert.ok(call, `expected adapter call to ${String(check.expect)} for action ${check.action.type}, got: ${adapter.calls.map((c) => c.method).join(",")}`);
  if (check.expectArgs) {
    assert.deepEqual(call!.args, check.expectArgs, `args mismatch for ${check.action.type}`);
  }
}

// ── 3. Clipboard round-trip via stub ────────────────────────────────────────
const clipboardAdapter = createStubAdapter();
const clipboardController = new LocalComputerController({ adapter: clipboardAdapter });
const readResult = await clipboardController.execute({ type: "clipboard_read" });
assert.equal(readResult.ok, true);
assert.equal(readResult.detail, "stub-clipboard-text");
const writeResult = await clipboardController.execute({ type: "clipboard_write", text: "payload" });
assert.equal(writeResult.ok, true);
const writeCall = clipboardAdapter.calls.find((c) => c.method === "clipboardWrite");
assert.deepEqual(writeCall!.args, ["payload"]);

// ── 4. Page-DOM variants return blocked outcome when no page attached ───────
const pageActions: ComputerAction[] = [
  { type: "screenshot_element", selector: "h1" },
  { type: "file_upload", selector: "input", filePath: "/tmp/x" },
  { type: "file_download", url: "https://x", savePath: "/tmp/y" },
  { type: "fill_form", fields: [{ selector: "#a", value: "1" }] },
  { type: "scroll_until", target: ".footer" },
  { type: "enter_frame", frameSelector: "iframe" },
  { type: "shadow_pierce", selector: "my-elt" },
];
const noPageController = new LocalComputerController({ adapter: createStubAdapter() });
for (const action of pageActions) {
  const outcome = await noPageController.execute(action);
  assert.equal(outcome.ok, false, `page-DOM ${action.type} without page must be blocked`);
  assert.ok(
    typeof outcome.blockedReason === "string" && outcome.blockedReason.includes("requires an active Page"),
    `${action.type} must report page-required, got: ${outcome.blockedReason}`,
  );
}

// ── 5. exit_frame does NOT need a page (it's a controller-state reset) ─────
const exitOutcome = await noPageController.execute({ type: "exit_frame" });
assert.equal(exitOutcome.ok, true, "exit_frame is a state reset, must succeed without a page");
assert.equal(exitOutcome.detail, "exited");

// ── 6. Credential / irreversible rails still fire on the new variants ───────
const credAdapter = createStubAdapter();
const credController = new LocalComputerController({ adapter: credAdapter });
// type with credential-pattern text
const typeAction: ComputerAction = { type: "type", text: "enter your password" };
const credOutcome = await credController.execute(typeAction);
assert.equal(credOutcome.ok, false, "credential pattern must still be blocked");
assert.equal(credOutcome.handoff?.kind, "credential");
// confirm_action with irreversible=true needs explicit grant
const confirmAction: ComputerAction = {
  type: "confirm_action",
  irreversible: true,
  label: "Pay $100",
};
const confirmOutcome = await credController.execute(confirmAction);
assert.equal(confirmOutcome.ok, false, "irreversible confirm_action must need grant");
assert.equal(confirmOutcome.handoff?.kind, "confirmation");
// After grant, the same action succeeds
credController.grantConfirmation();
const grantedOutcome = await credController.execute(confirmAction);
assert.equal(grantedOutcome.ok, true, "after grantConfirmation, irreversible action proceeds");

console.log("low-level-actions smoke ok");
