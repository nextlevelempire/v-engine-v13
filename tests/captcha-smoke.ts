/**
 * Smoke test for Wave 2 Task 6 — CAPTCHA handling.
 *
 * 3 new SessionCommand variants:
 *
 *   detect_captcha            -> { detected, type, locator, evidence }
 *   wait_for_human            -> pauses mission, emits handoff event
 *   navigate_with_fallback    -> tries primary URL, falls back to
 *                                alternate if CAPTCHA is detected
 *
 * Opt-in 2captcha solver via:
 *   CAPTCHA_SOLVER_API_KEY, CAPTCHA_SOLVER_PROVIDER=2captcha
 *
 * If no key is set, solver returns { solved: false, reason: "no_solver_key" }
 * and the caller falls back to wait_for_human / navigate_with_fallback.
 *
 * Detection covers reCAPTCHA, hCaptcha, Cloudflare via URL probes,
 * DOM iframes, class markers, and body text patterns.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const SERVICE_SRC = fs.readFileSync("src/server/service.ts", "utf8");
const SOLVER_SRC = fs.readFileSync("src/runtime/captcha-solver.ts", "utf8");

// ── 1. captcha-solver module exists and exports the 3 helpers ──────────────
assert.match(SOLVER_SRC, /export async function detectCaptcha/, "detectCaptcha must be exported");
assert.match(SOLVER_SRC, /export async function solveCaptcha/, "solveCaptcha must be exported");
assert.match(SOLVER_SRC, /export async function waitForHuman/, "waitForHuman must be exported");
assert.match(SOLVER_SRC, /export type CaptchaType/, "CaptchaType must be exported");
assert.match(SOLVER_SRC, /export type CaptchaDetection/, "CaptchaDetection must be exported");
assert.match(SOLVER_SRC, /export type CaptchaSolveResult/, "CaptchaSolveResult must be exported");

// ── 2. Detection covers reCAPTCHA, hCaptcha, Cloudflare ────────────────────
for (const marker of ["recaptcha", "hcaptcha", "cloudflare"]) {
  assert.ok(
    SOLVER_SRC.includes(marker),
    `detectCaptcha must cover ${marker}`,
  );
}
assert.match(SOLVER_SRC, /CAPTCHA_DOM_PROBES/, "must have a DOM probe table");
assert.match(SOLVER_SRC, /CAPTCHA_TEXT_PATTERNS/, "must have a text pattern list");

// ── 3. Solver is opt-in (2captcha only for v0.3) ──────────────────────────
assert.match(SOLVER_SRC, /CAPTCHA_SOLVER_API_KEY/, "must read CAPTCHA_SOLVER_API_KEY");
assert.match(SOLVER_SRC, /CAPTCHA_SOLVER_PROVIDER/, "must read CAPTCHA_SOLVER_PROVIDER");
assert.match(SOLVER_SRC, /provider !== "2captcha"/, "must reject non-2captcha providers");
assert.match(SOLVER_SRC, /no_solver_key/, "must return no_solver_key when key is missing");

// ── 4. 3 new SessionCommand variants in the union ─────────────────────────
const captchaCommands = ["detect_captcha", "wait_for_human", "navigate_with_fallback"] as const;
assert.equal(captchaCommands.length, 3, "must have exactly 3 new CAPTCHA commands");
for (const variant of captchaCommands) {
  assert.match(
    SERVICE_SRC,
    new RegExp(`type:\\s*"${variant}"`),
    `SessionCommand must include CAPTCHA variant ${variant}`,
  );
}

// ── 5. handleCaptcha routes all 3 variants ─────────────────────────────────
const handleCaptchaMatch = SERVICE_SRC.match(/private async handleCaptcha[\s\S]+?\n  \}/);
assert.ok(handleCaptchaMatch, "handleCaptcha must exist");
const handleCaptcha = handleCaptchaMatch![0];
for (const variant of captchaCommands) {
  assert.ok(handleCaptcha.includes(`case "${variant}"`), `handleCaptcha must route ${variant}`);
}
// Critical features
assert.match(handleCaptcha, /detectCaptcha\(page\)/, "detect_captcha must call detectCaptcha");
assert.match(handleCaptcha, /waitForHuman\(/, "wait_for_human must call waitForHuman");
assert.match(handleCaptcha, /pauseMission\(/, "wait_for_human must pause the mission");
assert.match(handleCaptcha, /solveCaptcha\(/, "navigate_with_fallback must try solveCaptcha");
assert.match(handleCaptcha, /navigate\(command\.fallback_url\)/, "navigate_with_fallback must try the fallback URL");
assert.match(handleCaptcha, /emit\(record, "captcha\.handoff"/);
assert.match(handleCaptcha, /emit\(record, "captcha\.detected"/);

// ── 6. describeCommandForActionLog handles the 3 new commands ──────────────
const summaryMatch = SERVICE_SRC.match(/function\s+describeCommandForActionLog[\s\S]+?\n\}/);
assert.ok(summaryMatch, "describeCommandForActionLog must exist");
const summary = summaryMatch![0];
for (const variant of captchaCommands) {
  assert.ok(
    summary.includes(`case "${variant}"`),
    `describeCommandForActionLog must handle ${variant}`,
  );
}

// ── 7. Zero-deletion: all 30 previous commands still in the union ─────────
const allPreviousCommands = [
  "navigate", "click", "type", "screenshot", "pause", "resume", "status",
  "computer", "directive", "assistant_reply",
  "right_click", "double_click", "hover", "shortcut", "drag", "scroll",
  "file_upload", "file_download", "screenshot_element", "fill_form",
  "scroll_until", "enter_frame", "exit_frame", "shadow_click",
  "plan", "execute_plan", "next_step", "describe_page", "find", "wait_for",
];
for (const variant of allPreviousCommands) {
  assert.ok(
    summary.includes(`case "${variant}"`),
    `describeCommandForActionLog must still handle ${variant} (zero-deletion)`,
  );
}

console.log("captcha smoke ok");
