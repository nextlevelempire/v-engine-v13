/**
 * P0 Browser Operator Engine Stress Tests
 *
 * These are unit/integration tests that validate the P0 guarantees WITHOUT
 * requiring a live browser. They test the logic contracts directly.
 *
 * Run with: npx tsx tests/p0-stress-test.ts
 *
 * All 7 tests must pass before Phase A is considered complete.
 */

import { captureAXObservation, hashAXTree } from "../src/runtime/omni-ax-observer.js";
import { capturePreActionContext, verifyAction } from "../src/runtime/omni-verifier.js";
import type { Page } from "playwright";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✅ PASS: ${message}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${message}`);
    failed++;
  }
}

function assertThrows(fn: () => unknown, message: string): void {
  try {
    fn();
    console.error(`  ❌ FAIL: ${message} (expected throw, got none)`);
    failed++;
  } catch {
    console.log(`  ✅ PASS: ${message}`);
    passed++;
  }
}

// ---------------------------------------------------------------------------
// Mock Page factory — simulates Playwright Page for unit testing
// ---------------------------------------------------------------------------

function makeMockPage(overrides: {
  url?: string;
  axSnapshot?: Record<string, unknown> | null;
  inputValue?: string;
  evalResult?: unknown;
  axEvalResult?: string; // explicit AX tree string for hashAXTree
}): Page {
  const url = overrides.url ?? "https://example.com/dashboard";
  // Build a default AX tree string from axSnapshot if provided
  const defaultAxTree = overrides.axSnapshot
    ? JSON.stringify(overrides.axSnapshot)
    : overrides.axEvalResult ?? "button: Submit\ntextbox: Email";
  let evaluateCallCount = 0;
  return {
    url: () => url,
    title: async () => "Mock Page",
    accessibility: {
      snapshot: async () =>
        overrides.axSnapshot !== undefined
          ? overrides.axSnapshot
          : {
              role: "WebArea",
              name: "Dashboard",
              children: [
                { role: "button", name: "Submit" },
                { role: "textbox", name: "Email" },
              ],
            },
    },
    evaluate: async (fn: unknown, ...args: unknown[]) => {
      evaluateCallCount++;
      // If evalResult is explicitly set (for input value tests), return it
      if (overrides.evalResult !== undefined) return overrides.evalResult;
      // For AX tree extraction calls, return the AX tree string
      return defaultAxTree;
    },
    waitForTimeout: async () => {},
  } as unknown as Page;
}

// ---------------------------------------------------------------------------
// TEST 1: AX Observer produces a non-empty, sanitized observation
// ---------------------------------------------------------------------------

console.log("\n[TEST 1] AX Observer — produces valid observation from page");
{
  const mockPage = makeMockPage({});
  const obs = await captureAXObservation(mockPage);
  assert(typeof obs.axTree === "string" && obs.axTree.length > 0, "axTree is a non-empty string");
  assert(typeof obs.axTreeHash === "string" && obs.axTreeHash.length === 16, "axTreeHash is 16 chars");
  assert(typeof obs.url === "string", "url is a string");
  assert(typeof obs.authWallHint === "boolean", "authWallHint is a boolean");
  assert(typeof obs.captchaHint === "boolean", "captchaHint is a boolean");
  assert(!obs.axTree.includes("<script"), "axTree does not contain script tags");
}

// ---------------------------------------------------------------------------
// TEST 2: AX Observer detects auth-wall hint from URL
// ---------------------------------------------------------------------------

console.log("\n[TEST 2] AX Observer — detects auth-wall hint from login URL");
{
  const mockPage = makeMockPage({ url: "https://accounts.google.com/signin/v2/identifier" });
  const obs = await captureAXObservation(mockPage);
  assert(obs.authWallHint === true, "authWallHint is true for Google sign-in URL");
}

// ---------------------------------------------------------------------------
// TEST 3: Verifier — URL change = pass
// ---------------------------------------------------------------------------

console.log("\n[TEST 3] Verifier — URL change after navigate = pass");
{
  const beforePage = makeMockPage({ url: "https://example.com/" });
  const preCtx = await capturePreActionContext(beforePage, "navigate", "https://example.com/dashboard");
  // Simulate page after navigation (different URL)
  const afterPage = makeMockPage({ url: "https://example.com/dashboard" });
  const result = await verifyAction(afterPage, preCtx);
  assert(result.pass === true, "verification passes when URL changes");
  assert(result.checkType === "url-changed", "checkType is url-changed");
}

// ---------------------------------------------------------------------------
// TEST 4: Verifier — inconclusive = FAIL (no hallucinated success)
// ---------------------------------------------------------------------------

console.log("\n[TEST 4] Verifier — inconclusive evidence = fail (no hallucinated success)");
{
  const url = "https://example.com/static-page";
  const axSnapshot = {
    role: "WebArea",
    name: "Static Page",
    children: [{ role: "heading", name: "Welcome" }],
  };
  const beforePage = makeMockPage({ url, axSnapshot });
  const preCtx = await capturePreActionContext(beforePage, "click", "#some-button");
  // After page: same URL, same AX tree (nothing changed)
  const afterPage = makeMockPage({ url, axSnapshot });
  const result = await verifyAction(afterPage, preCtx);
  assert(result.pass === false, "verification FAILS when nothing changed (no hallucinated success)");
  assert(result.checkType === "inconclusive", "checkType is inconclusive");
}

// ---------------------------------------------------------------------------
// TEST 5: Verifier — AX tree change = pass
// ---------------------------------------------------------------------------

console.log("\n[TEST 5] Verifier — AX tree change after click = pass");
{
  const url = "https://example.com/app";
  // Use axEvalResult to produce distinct AX tree strings before and after click
  const beforePage = makeMockPage({
    url,
    axEvalResult: "button: Open Menu",
  });
  const preCtx = await capturePreActionContext(beforePage, "click", "#menu-button");
  // After click: AX tree changed (menu is now open) — different axEvalResult
  const afterPage = makeMockPage({
    url,
    axEvalResult: "button: Open Menu\nmenu: Navigation Menu\nmenuitem: Home",
  });
  const result = await verifyAction(afterPage, preCtx);
  assert(result.pass === true, "verification passes when AX tree changes after click");
  assert(result.checkType === "ax-changed", "checkType is ax-changed");
}

// ---------------------------------------------------------------------------
// TEST 6: Verifier — type action with matching input value = pass
// ---------------------------------------------------------------------------

console.log("\n[TEST 6] Verifier — type action with matching input value = pass");
{
  const url = "https://example.com/form";
  // The AX tree must be IDENTICAL before and after so Check 3 (ax-changed) does NOT fire.
  // Only then does Check 4 (input-value-set) run.
  const STATIC_AX = "textbox: Email\nbutton: Submit";
  // Before: empty input — AX tree is static, evalResult is empty string
  const beforePage = {
    url: () => url,
    title: async () => "Form Page",
    evaluate: async (fn: unknown, ...args: unknown[]) => {
      // AX tree extraction calls have no extra args
      if (!args || args.length === 0) return STATIC_AX;
      // Input value check: return empty string (not yet typed)
      return "";
    },
    waitForTimeout: async () => {},
  } as unknown as Page;
  const preCtx = await capturePreActionContext(beforePage, "type", "#email", "test@example.com");
  // After: AX tree is SAME (no DOM change), but input value is now set
  const afterPage = {
    url: () => url,
    title: async () => "Form Page",
    evaluate: async (fn: unknown, ...args: unknown[]) => {
      // AX tree extraction calls have no extra args
      if (!args || args.length === 0) return STATIC_AX;
      // Input value check: return the typed value
      return "test@example.com";
    },
    waitForTimeout: async () => {},
  } as unknown as Page;
  const result = await verifyAction(afterPage, preCtx);
  assert(result.pass === true, "verification passes when input value matches typed text");
  assert(result.checkType === "input-value-set", "checkType is input-value-set");
}

// ---------------------------------------------------------------------------
// TEST 7: No secret/credential leakage in P0 event payloads
// ---------------------------------------------------------------------------

console.log("\n[TEST 7] Security — P0 events do not contain secrets or base64 images");
{
  const mockPage = makeMockPage({ url: "https://example.com/dashboard" });
  const obs = await captureAXObservation(mockPage);
  const preCtx = await capturePreActionContext(mockPage, "navigate", "https://example.com/page2");
  const afterPage = makeMockPage({ url: "https://example.com/page2" });
  const verResult = await verifyAction(afterPage, preCtx);

  // Check observation payload has no base64 blobs
  const obsJson = JSON.stringify(obs);
  assert(!obsJson.includes("data:image"), "observation.captured has no base64 image data");
  assert(!obsJson.includes("sessionSecret"), "observation.captured has no sessionSecret");
  assert(!obsJson.includes("password"), "observation.captured has no password field");

  // Check verification payload has no base64 blobs
  const verJson = JSON.stringify(verResult);
  assert(!verJson.includes("data:image"), "verification.result has no base64 image data");
  assert(!verJson.includes("sessionSecret"), "verification.result has no sessionSecret");

  // AX tree must be truncated to MAX_AX_CHARS
  assert(obs.axTree.length <= 12000, "axTree is truncated to MAX_AX_CHARS (12000)");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${"=".repeat(60)}`);
console.log(`P0 Stress Test Results: ${passed} passed, ${failed} failed`);
console.log("=".repeat(60));

if (failed > 0) {
  console.error(`\n❌ ${failed} test(s) FAILED. Phase A is NOT complete.`);
  process.exit(1);
} else {
  console.log(`\n✅ All ${passed} P0 stress tests PASSED. Phase A is complete.`);
  process.exit(0);
}
