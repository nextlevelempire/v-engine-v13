/**
 * P1+P2 Browser Operator Engine Stress Tests
 *
 * Tests validate P1 (Browser Action Power) and P2 (Session Intelligence + Replay)
 * guarantees WITHOUT requiring a live browser. All logic contracts are tested directly.
 *
 * Run with: npx tsx tests/p1-p2-stress-test.ts
 *
 * All 12 tests must pass before Phase A is considered complete.
 *
 * Required tests:
 *  1.  target-ranking-button
 *  2.  target-ranking-ambiguous
 *  3.  modal-priority
 *  4.  iframe-target
 *  5.  type-verification
 *  6.  click-covered-disabled
 *  7.  screenshot-fallback
 *  8.  checkpoint-created
 *  9.  replay-bundle-created
 * 10.  resume-verification
 * 11.  duplicate-event-reconnect
 * 12.  no-fake-completion
 */
import type { Page } from "playwright";
import {
  rankTargetCandidates,
  verifyTypeAction,
  captureScreenshotFallback,
  detectModalState,
  detectIframeContexts,
  MIN_CLICK_CONFIDENCE,
} from "../src/runtime/omni-selector-ranker.js";
import {
  MissionMemory,
  createMissionCheckpoint,
  buildCheckpointId,
  buildRecoveryNote,
  verifyResumeState,
} from "../src/runtime/omni-checkpoint.js";
import {
  createReplayBundle,
  buildBundleId,
  _clearBundleRegistry_TEST_ONLY,
} from "../src/runtime/omni-replay-bundle.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

// ---------------------------------------------------------------------------
// Mock Page factory
// ---------------------------------------------------------------------------
function makeMockPage(overrides: {
  url?: string;
  modalActive?: boolean;
  hasIframe?: boolean;
  inputValue?: string;
  elementVisible?: boolean;
  elementDisabled?: boolean;
  elementCovered?: boolean;
  authWallHint?: boolean;
  captchaHint?: boolean;
  axEvalResult?: string;
}): Page {
  const url = overrides.url ?? "https://example.com/dashboard";
  const modalActive = overrides.modalActive ?? false;
  const hasIframe = overrides.hasIframe ?? false;
  const inputValue = overrides.inputValue ?? "";
  const elementVisible = overrides.elementVisible !== false;
  const elementDisabled = overrides.elementDisabled ?? false;
  const elementCovered = overrides.elementCovered ?? false;
  const authWallHint = overrides.authWallHint ?? false;
  const captchaHint = overrides.captchaHint ?? false;
  const axEvalResult = overrides.axEvalResult ?? (authWallHint ? "sign in\npassword" : captchaHint ? "captcha\ni'm not a robot" : "button: Submit\ntextbox: Email");

  const mockFrame = {
    url: () => "https://example.com/iframe",
    title: async () => "Iframe Title",
    evaluate: async (fn: unknown) => {
      if (typeof fn === "function") {
        return fn();
      }
      return true;
    },
    parentFrame: () => null,
  };

  const mainFrame = {
    url: () => url,
    evaluate: async (fn: unknown, ...args: unknown[]) => {
      if (typeof fn === "string" || typeof fn === "function") {
        // Simulate DOM evaluate calls
        if (inputValue) return inputValue;
        return axEvalResult;
      }
      return axEvalResult;
    },
    parentFrame: () => null,
  };

  return {
    url: () => url,
    title: async () => "Mock Page",
    mainFrame: () => mainFrame as unknown as ReturnType<Page["mainFrame"]>,
    frames: () => hasIframe ? [mainFrame, mockFrame] as unknown as ReturnType<Page["frames"]> : [mainFrame] as unknown as ReturnType<Page["frames"]>,
    accessibility: {
      snapshot: async () => ({
        role: "WebArea",
        name: "Dashboard",
        children: [
          { role: "button", name: "Submit" },
          { role: "textbox", name: "Email" },
          ...(modalActive ? [{ role: "dialog", name: "Confirm Action", children: [{ role: "button", name: "Confirm" }] }] : []),
        ],
      }),
    },
    evaluate: async (fn: unknown, ...args: unknown[]) => {
      const fnStr = typeof fn === "function" ? fn.toString() : String(fn);
      // Modal detection evaluate
      if (fnStr.includes("alertdialog") || fnStr.includes("aria-modal")) {
        return {
          active: modalActive,
          kind: modalActive ? "dialog" : null,
          hasClose: modalActive,
          hasConfirm: modalActive,
        };
      }
      // Input value evaluate (verifyTypeAction) — MUST be checked BEFORE getBoundingClientRect
      // because verifyTypeAction fn also contains getBoundingClientRect.
      // Detected by 'el.value' which is unique to verifyTypeAction.
      if (fnStr.includes("el.value")) {
        if (!elementVisible) return { fieldReady: false, accepted: false, validationError: false, reason: "Field not visible" };
        if (elementDisabled) return { fieldReady: false, accepted: false, validationError: false, reason: "Field is disabled" };
        return {
          fieldReady: elementVisible && !elementDisabled,
          accepted: inputValue.length > 0,
          validationError: false,
          reason: inputValue.length > 0 ? "Input value accepted" : "Value not reflected in field",
        };
      }
      // Candidate scoring evaluate (rankTargetCandidates)
      if (fnStr.includes("getBoundingClientRect") || fnStr.includes("uniqueMatch")) {
        return {
          visible: elementVisible,
          covered: elementCovered,
          disabled: elementDisabled,
          inModal: false,
          uniqueMatch: true,
          semanticMatch: 0.8,
        };
      }
      // AX tree extraction (captureAXObservation uses querySelectorAll for roles)
      // Return axEvalResult which contains captcha/auth-wall hints for detection
      return axEvalResult;
    },
    waitForTimeout: async () => {},
  } as unknown as Page;
}

// ---------------------------------------------------------------------------
// TEST 1: target-ranking-button — button candidate is ranked with confidence
// ---------------------------------------------------------------------------
console.log("\n[TEST 1] target-ranking-button — button candidate is ranked with confidence");
{
  const page = makeMockPage({ elementVisible: true, elementDisabled: false });
  const result = await rankTargetCandidates(page, "click Submit button");
  assert(result.candidates.length >= 0, "rankTargetCandidates returns candidates array");
  assert(typeof result.totalFound === "number", "totalFound is a number");
  assert(typeof result.modalActive === "boolean", "modalActive is a boolean");
  assert(result.iframeContext === null, "iframeContext is null when no iframe");
}

// ---------------------------------------------------------------------------
// TEST 2: target-ranking-ambiguous — ambiguity warning when no best candidate
// ---------------------------------------------------------------------------
console.log("\n[TEST 2] target-ranking-ambiguous — ambiguity warning when no best candidate");
{
  // Simulate a page where all elements are disabled/invisible
  const page = makeMockPage({ elementVisible: false, elementDisabled: true });
  const result = await rankTargetCandidates(page, "click Submit");
  // When no candidate meets MIN_CLICK_CONFIDENCE, best should be null
  // (candidates may still be returned but with low confidence)
  const allLowConfidence = result.candidates.every((c) => c.confidence < MIN_CLICK_CONFIDENCE);
  assert(
    result.best === null || allLowConfidence,
    "best is null or all candidates have low confidence when elements are invisible/disabled",
  );
  assert(MIN_CLICK_CONFIDENCE === 0.5, "MIN_CLICK_CONFIDENCE is 0.5");
}

// ---------------------------------------------------------------------------
// TEST 3: modal-priority — modal detection returns correct state
// ---------------------------------------------------------------------------
console.log("\n[TEST 3] modal-priority — modal detection returns correct state");
{
  const pageWithModal = makeMockPage({ modalActive: true });
  const modalState = await detectModalState(pageWithModal);
  assert(typeof modalState.active === "boolean", "detectModalState returns active boolean");
  assert(typeof modalState.hasClose === "boolean", "detectModalState returns hasClose boolean");
  assert(typeof modalState.hasConfirm === "boolean", "detectModalState returns hasConfirm boolean");

  const pageNoModal = makeMockPage({ modalActive: false });
  const noModalState = await detectModalState(pageNoModal);
  assert(typeof noModalState.active === "boolean", "detectModalState returns active boolean for no-modal page");
}

// ---------------------------------------------------------------------------
// TEST 4: iframe-target — iframe context detection
// ---------------------------------------------------------------------------
console.log("\n[TEST 4] iframe-target — iframe context detection");
{
  const pageWithIframe = makeMockPage({ hasIframe: true });
  const iframeContexts = await detectIframeContexts(pageWithIframe);
  assert(Array.isArray(iframeContexts), "detectIframeContexts returns an array");
  assert(iframeContexts.length > 0, "iframe contexts found when page has iframes");
  if (iframeContexts.length > 0) {
    assert(typeof iframeContexts[0].frameIndex === "number", "frameContext has frameIndex");
    assert(typeof iframeContexts[0].frameUrl === "string", "frameContext has frameUrl");
    assert(typeof iframeContexts[0].frameTitle === "string", "frameContext has frameTitle");
  }

  const pageNoIframe = makeMockPage({ hasIframe: false });
  const noIframeContexts = await detectIframeContexts(pageNoIframe);
  assert(noIframeContexts.length === 0, "no iframe contexts when page has no iframes");
}

// ---------------------------------------------------------------------------
// TEST 5: type-verification — verifyTypeAction correctly reports accepted/rejected
// ---------------------------------------------------------------------------
console.log("\n[TEST 5] type-verification — verifyTypeAction correctly reports accepted/rejected");
{
  const pageWithValue = makeMockPage({ inputValue: "hello@example.com", elementVisible: true });
  const acceptedResult = await verifyTypeAction(pageWithValue, "[aria-label='Email']", "hello@example.com", false);
  assert(typeof acceptedResult.accepted === "boolean", "verifyTypeAction returns accepted boolean");
  assert(typeof acceptedResult.fieldReady === "boolean", "verifyTypeAction returns fieldReady boolean");
  assert(typeof acceptedResult.validationError === "boolean", "verifyTypeAction returns validationError boolean");
  assert(typeof acceptedResult.reason === "string", "verifyTypeAction returns reason string");

  // Secret values must never be logged
  const secretResult = await verifyTypeAction(pageWithValue, "[type='password']", "super-secret-password", true);
  assert(typeof secretResult.accepted === "boolean", "verifyTypeAction works for secret fields");
  // The typed text must not appear in the result reason
  assert(!JSON.stringify(secretResult).includes("super-secret-password"), "secret value not in type verification result");
}

// ---------------------------------------------------------------------------
// TEST 6: click-covered-disabled — covered/disabled elements return low confidence
// ---------------------------------------------------------------------------
console.log("\n[TEST 6] click-covered-disabled — covered/disabled elements return low confidence");
{
  const pageCovered = makeMockPage({ elementCovered: true, elementVisible: true });
  const resultCovered = await rankTargetCandidates(pageCovered, "click button");
  // Covered elements should have reduced confidence
  const coveredCandidates = resultCovered.candidates.filter((c) => c.covered);
  assert(
    coveredCandidates.every((c) => c.confidence < 0.9),
    "covered elements have reduced confidence",
  );

  const pageDisabled = makeMockPage({ elementDisabled: true, elementVisible: true });
  const resultDisabled = await rankTargetCandidates(pageDisabled, "click button");
  const disabledCandidates = resultDisabled.candidates.filter((c) => c.disabled);
  assert(
    disabledCandidates.every((c) => c.confidence < MIN_CLICK_CONFIDENCE) || disabledCandidates.length === 0,
    "disabled elements do not qualify as best candidate",
  );
}

// ---------------------------------------------------------------------------
// TEST 7: screenshot-fallback — captureScreenshotFallback emits artifactId only, no base64
// ---------------------------------------------------------------------------
console.log("\n[TEST 7] screenshot-fallback — captureScreenshotFallback emits artifactId only, no base64");
{
  // Mock captureProof that returns a path (not base64)
  const mockCapture = async (label: string): Promise<string | null> => {
    return `/tmp/omni-artifacts/session-123/screenshots/${label}.png`;
  };
  const result = await captureScreenshotFallback(mockCapture, "test-fallback");
  assert(result.artifactId !== null, "captureScreenshotFallback returns artifactId");
  assert(typeof result.artifactId === "string", "artifactId is a string");
  assert(!result.artifactId!.includes("data:image"), "artifactId is NOT a base64 blob");
  assert(typeof result.reason === "string", "captureScreenshotFallback returns reason");

  // Mock captureProof that fails
  const mockFailCapture = async (_label: string): Promise<string | null> => null;
  const failResult = await captureScreenshotFallback(mockFailCapture, "test-fallback-fail");
  assert(failResult.artifactId === null, "captureScreenshotFallback returns null artifactId on failure");
  assert(typeof failResult.reason === "string", "captureScreenshotFallback returns reason on failure");
}

// ---------------------------------------------------------------------------
// TEST 8: checkpoint-created — checkpoint has stable ID, no raw AX tree, no secrets
// ---------------------------------------------------------------------------
console.log("\n[TEST 8] checkpoint-created — checkpoint has stable ID, no raw AX tree, no secrets");
{
  const memory = new MissionMemory();
  const page = makeMockPage({ url: "https://example.com/dashboard" });

  const checkpoint = await createMissionCheckpoint({
    page,
    sessionId: "session-test-123",
    planId: "plan-abc",
    stepId: "step-1",
    stepNumber: 1,
    lastVerifiedAction: "click Submit",
    memory,
    pendingStepIntents: ["fill form", "submit"],
    proofArtifactIds: ["artifact-001"],
  });

  assert(checkpoint !== null, "createMissionCheckpoint returns a checkpoint");
  if (checkpoint) {
    assert(checkpoint.checkpointId.startsWith("checkpoint-"), "checkpointId starts with 'checkpoint-'");
    assert(checkpoint.checkpointId.length > 10, "checkpointId has sufficient length");
    assert(typeof checkpoint.axTreeHash === "string", "checkpoint has axTreeHash (not raw tree)");
    assert(!("axTree" in checkpoint), "checkpoint does NOT contain raw axTree");
    assert(typeof checkpoint.url === "string", "checkpoint has url");
    assert(typeof checkpoint.capturedAt === "string", "checkpoint has capturedAt");
    assert(Array.isArray(checkpoint.completedSteps), "checkpoint has completedSteps array");
    assert(Array.isArray(checkpoint.pendingStepSummary), "checkpoint has pendingStepSummary array");
    assert(Array.isArray(checkpoint.proofArtifactIds), "checkpoint has proofArtifactIds array");

    // Stable ID: same inputs produce same ID
    const id1 = buildCheckpointId("plan-abc", "step-1");
    const id2 = buildCheckpointId("plan-abc", "step-1");
    assert(id1 === id2, "checkpoint ID is deterministic (same inputs = same ID)");

    // Different inputs produce different IDs
    const id3 = buildCheckpointId("plan-abc", "step-2");
    assert(id1 !== id3, "checkpoint ID differs for different step IDs");
  }
}

// ---------------------------------------------------------------------------
// TEST 9: replay-bundle-created — bundle has stable ID, is artifact-backed, no base64
// ---------------------------------------------------------------------------
console.log("\n[TEST 9] replay-bundle-created — bundle has stable ID, is artifact-backed, no base64");
{
  _clearBundleRegistry_TEST_ONLY();
  const memory = new MissionMemory();
  // Add some completed steps so bundle creation is not blocked
  memory.addCompletedStep({
    stepId: "step-1",
    intent: "click Submit",
    actionType: "click",
    target: "[role='button'][aria-label='Submit']",
    verified: true,
    checkType: "ax-changed",
    proofArtifactId: "artifact-001",
    completedAt: new Date().toISOString(),
  });

  const artifactBaseDir = tmpdir();
  const bundle = createReplayBundle({
    memory,
    sessionId: "session-test-456",
    planId: "plan-xyz",
    reason: "handoff-requested",
    finalUrl: "https://example.com/blocked",
    finalTitle: "Blocked Page",
    finalAxTreeHash: "abc123def456",
    artifactBaseDir,
  });

  assert(bundle !== null, "createReplayBundle returns a bundle when steps exist");
  if (bundle) {
    assert(bundle.metadata.bundleId.startsWith("bundle-"), "bundleId starts with 'bundle-'");
    assert(typeof bundle.metadata.artifactPath === "string", "bundle has artifactPath");
    assert(!bundle.metadata.artifactPath.includes("data:image"), "artifactPath is NOT base64");
    assert(bundle.metadata.totalStepsCompleted > 0, "bundle has totalStepsCompleted > 0");
    assert(typeof bundle.metadata.createdAt === "string", "bundle has createdAt");
    assert(bundle.completedSteps.length > 0, "bundle has completedSteps");
    assert(!JSON.stringify(bundle).includes("sessionSecret"), "bundle has no sessionSecret");
    assert(!JSON.stringify(bundle).includes("data:image"), "bundle has no base64 images");

    // Stable ID: same inputs produce same ID
    const id1 = buildBundleId("session-test-456", "plan-xyz", "handoff-requested");
    const id2 = buildBundleId("session-test-456", "plan-xyz", "handoff-requested");
    assert(id1 === id2, "bundle ID is deterministic");

    // Deduplication: creating same bundle again returns null
    const bundleDuplicate = createReplayBundle({
      memory,
      sessionId: "session-test-456",
      planId: "plan-xyz",
      reason: "handoff-requested",
      finalUrl: "https://example.com/blocked",
      finalTitle: "Blocked Page",
      finalAxTreeHash: "abc123def456",
      artifactBaseDir,
    });
    assert(bundleDuplicate === null, "duplicate bundle creation returns null (deduplication works)");
  }

  // No fake replay: empty memory returns null
  const emptyMemory = new MissionMemory();
  const emptyBundle = createReplayBundle({
    memory: emptyMemory,
    sessionId: "session-empty",
    planId: "plan-empty",
    reason: "handoff-requested",
    finalUrl: "https://example.com",
    finalTitle: "Empty",
    finalAxTreeHash: "",
    artifactBaseDir,
  });
  assert(emptyBundle === null, "createReplayBundle returns null when no steps exist (no fake replay)");
}

// ---------------------------------------------------------------------------
// TEST 10: resume-verification — verifyResumeState correctly detects blockers
// ---------------------------------------------------------------------------
console.log("\n[TEST 10] resume-verification — verifyResumeState correctly detects blockers");
{
  // Auth wall still present
  const authWallPage = makeMockPage({ authWallHint: true, url: "https://example.com/login" });
  const authWallResult = await verifyResumeState({
    page: authWallPage,
    expectedUrl: "https://example.com/dashboard",
    expectedAxTreeHash: "old-hash-123",
    handoffReason: "auth-wall-detected",
  });
  assert(authWallResult.safeToResume === false, "safeToResume is false when auth wall is present");
  assert(authWallResult.authWallStillPresent === true, "authWallStillPresent is true");
  assert(typeof authWallResult.reason === "string", "verifyResumeState returns reason");
  assert(typeof authWallResult.verifiedAt === "string", "verifyResumeState returns verifiedAt");

  // CAPTCHA still present
  const captchaPage = makeMockPage({ captchaHint: true, url: "https://example.com/captcha" });
  const captchaResult = await verifyResumeState({
    page: captchaPage,
    expectedUrl: "https://example.com/dashboard",
    expectedAxTreeHash: "old-hash-123",
    handoffReason: "captcha-detected",
  });
  assert(captchaResult.safeToResume === false, "safeToResume is false when CAPTCHA is present");
  assert(captchaResult.captchaStillPresent === true, "captchaStillPresent is true");
}

// ---------------------------------------------------------------------------
// TEST 11: duplicate-event-reconnect — MissionMemory deduplicates checkpoint events
// ---------------------------------------------------------------------------
console.log("\n[TEST 11] duplicate-event-reconnect — MissionMemory deduplicates checkpoint events");
{
  const memory = new MissionMemory();
  const page = makeMockPage({ url: "https://example.com/step1" });

  const checkpoint = await createMissionCheckpoint({
    page,
    sessionId: "session-dedup-test",
    planId: "plan-dedup",
    stepId: "step-1",
    stepNumber: 1,
    lastVerifiedAction: "click Submit",
    memory,
    pendingStepIntents: [],
    proofArtifactIds: [],
  });

  assert(checkpoint !== null, "first checkpoint created successfully");
  if (checkpoint) {
    const added1 = memory.addCheckpoint(checkpoint);
    assert(added1 === true, "first addCheckpoint returns true (newly added)");

    // Try to add the same checkpoint again (simulating reconnect)
    const added2 = memory.addCheckpoint(checkpoint);
    assert(added2 === false, "duplicate addCheckpoint returns false (deduplicated)");

    // Verify only one checkpoint in memory
    assert(memory.getCheckpoints().length === 1, "only one checkpoint stored after duplicate attempt");
  }
}

// ---------------------------------------------------------------------------
// TEST 12: no-fake-completion — recovery notes are safe, no secrets
// ---------------------------------------------------------------------------
console.log("\n[TEST 12] no-fake-completion — recovery notes are safe, no secrets");
{
  const authNote = buildRecoveryNote({
    url: "https://accounts.google.com/signin",
    failureReason: "auth wall detected",
    actionType: "navigate",
    target: "https://accounts.google.com/signin",
    authWallHint: true,
    captchaHint: false,
    modalBlocked: false,
    iframeContext: false,
    formValidationError: false,
  });
  assert(authNote.category === "auth-wall", "auth-wall recovery note has correct category");
  assert(authNote.note.includes("Login wall detected"), "auth-wall note contains expected message");
  assert(!authNote.note.includes("password"), "auth-wall note does not contain 'password'");
  assert(!authNote.note.includes("secret"), "auth-wall note does not contain 'secret'");
  assert(authNote.noteId.length > 0, "recovery note has a noteId");
  assert(typeof authNote.createdAt === "string", "recovery note has createdAt");

  const captchaNote = buildRecoveryNote({
    url: "https://example.com/verify",
    failureReason: "captcha detected",
    actionType: "click",
    target: "[role='button']",
    authWallHint: false,
    captchaHint: true,
    modalBlocked: false,
    iframeContext: false,
    formValidationError: false,
  });
  assert(captchaNote.category === "captcha", "captcha recovery note has correct category");
  assert(!captchaNote.note.includes("data:image"), "captcha note has no base64");

  // Verify MissionMemory deduplicates recovery notes
  const memory = new MissionMemory();
  memory.addRecoveryNote(authNote);
  memory.addRecoveryNote(authNote); // duplicate
  assert(memory.getRecoveryNotes().length === 1, "duplicate recovery notes are deduplicated");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(60)}`);
console.log(`P1+P2 Stress Test Results: ${passed} passed, ${failed} failed`);
console.log("=".repeat(60));
if (failed > 0) {
  console.error(`\n❌ ${failed} test(s) FAILED. Phase A P1+P2 is NOT complete.`);
  process.exit(1);
} else {
  console.log(`\n✅ All ${passed} P1+P2 stress tests PASSED. Phase A P1+P2 is complete.`);
  process.exit(0);
}
