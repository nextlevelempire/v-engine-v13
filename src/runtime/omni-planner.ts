/**
 * omni-planner.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * P0 Work Loop Orchestrator — implements the Plan → Observe → Execute → Verify
 * cycle that makes OMNI a reliable browser operator instead of a hallucination
 * machine.
 *
 * Design rules:
 *  - The planner NEVER claims completion without verification evidence.
 *  - The frustration detector hard-caps at MAX_CONSECUTIVE_FAILURES.
 *  - Auth-wall and CAPTCHA detection triggers immediate handoff — never bypass.
 *  - All event payloads are sanitized before emission.
 *  - No fake data, no mock completions, no assumed success.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import { captureAXObservation, type OmniAXObservation } from "./omni-ax-observer.js";
import {
  capturePreActionContext,
  verifyAction,
  type VerificationResult,
} from "./omni-verifier.js";
import { sanitizeProtectedRuntimeText } from "../security/trade-secret-guard.js";

// ── P0 Constants ─────────────────────────────────────────────────────────────

/** Hard cap on consecutive verification failures before triggering handoff. */
const MAX_CONSECUTIVE_FAILURES = 3;

/** Maximum steps in a single planner execution to prevent infinite loops. */
const MAX_PLAN_STEPS = 50;

// ── Types ─────────────────────────────────────────────────────────────────────

export type PlanStep = {
  /** Unique step ID. */
  id: string;
  /** Human-readable intent of this step. */
  intent: string;
  /** The action to execute. */
  action: PlannedAction;
  /** Completion criteria — what must be true for this step to be considered done. */
  completionCriteria: string;
  /** Status of this step. */
  status: "pending" | "executing" | "verified" | "failed" | "skipped";
};

export type PlannedAction =
  | { type: "navigate"; url: string }
  | { type: "click"; selector: string }
  | { type: "type"; selector: string; text: string }
  | { type: "scroll"; targetY: number }
  | { type: "wait"; ms: number }
  | { type: "handoff"; reason: string };

export type PlannerEvent =
  | { kind: "plan.created"; planId: string; steps: PlanStep[]; objective: string; capturedAt: string }
  | { kind: "observation.captured"; planId: string; stepId: string; observation: OmniAXObservation }
  | { kind: "action.executed"; planId: string; stepId: string; action: PlannedAction; success: boolean }
  | { kind: "verification.result"; planId: string; stepId: string; result: VerificationResult }
  | { kind: "handoff.requested"; planId: string; stepId: string; reason: string; handoffRequestId: string; artifactId: string | null; capturedAt: string };

export type PlannerEmitter = (event: PlannerEvent) => void;

export type PlannerExecuteInput = {
  /** The mission objective. */
  objective: string;
  /** The steps to execute. */
  steps: PlanStep[];
  /** The Playwright page to operate on. */
  page: Page;
  /** Callback to emit P0 events to the cockpit. */
  emit: PlannerEmitter;
  /** Callback to capture a proof screenshot and return an artifactId. */
  captureProof: (label: string) => Promise<string | null>;
  /** Callback to execute a click action. */
  executeClick: (selector: string) => Promise<boolean>;
  /** Callback to execute a type action. */
  executeType: (selector: string, text: string) => Promise<boolean>;
  /** Callback to execute a navigate action. */
  executeNavigate: (url: string) => Promise<boolean>;
  /** Callback to execute a scroll action. */
  executeScroll: (targetY: number) => Promise<boolean>;
  /** Callback to pause the mission for human handoff. */
  pauseForHandoff: (reason: string) => Promise<void>;
};

export type PlannerResult = {
  /** Whether the plan completed successfully. */
  success: boolean;
  /** Number of steps completed. */
  stepsCompleted: number;
  /** Number of steps failed. */
  stepsFailed: number;
  /** Whether a handoff was triggered. */
  handoffTriggered: boolean;
  /** The reason for handoff, if triggered. */
  handoffReason: string | null;
  /** The plan ID. */
  planId: string;
};

// ── Main Planner ──────────────────────────────────────────────────────────────

/**
 * Execute a plan using the Plan → Observe → Execute → Verify work loop.
 *
 * This is the core P0 engine. It replaces the previous "fire and hope" approach
 * with a disciplined loop that verifies every action before proceeding.
 */
export async function executePlan(input: PlannerExecuteInput): Promise<PlannerResult> {
  const planId = randomUUID();
  let consecutiveFailures = 0;
  let stepsCompleted = 0;
  let stepsFailed = 0;
  let handoffTriggered = false;
  let handoffReason: string | null = null;

  // Emit plan.created event so the cockpit can render pending phase cards
  // before any execution begins.
  input.emit({
    kind: "plan.created",
    planId,
    steps: input.steps.slice(0, MAX_PLAN_STEPS),
    objective: sanitizeProtectedRuntimeText(input.objective),
    capturedAt: new Date().toISOString(),
  });

  const steps = input.steps.slice(0, MAX_PLAN_STEPS);

  for (const step of steps) {
    step.status = "executing";

    // ── OBSERVE: Capture AX observation before every action ──────────────────
    let observation: OmniAXObservation;
    try {
      observation = await captureAXObservation(input.page);
    } catch {
      observation = {
        axTree: "[observation failed]",
        axTreeHash: "error",
        authWallHint: false,
        captchaHint: false,
        capturedAt: new Date().toISOString(),
        title: "",
        url: input.page.url().slice(0, 200),
      };
    }

    input.emit({
      kind: "observation.captured",
      planId,
      stepId: step.id,
      observation,
    });

    // ── AUTH WALL / CAPTCHA DETECTION ─────────────────────────────────────────
    if (observation.authWallHint || observation.captchaHint) {
      const reason = observation.captchaHint
        ? "CAPTCHA detected — human verification required before proceeding."
        : "Authentication wall detected — human login required before proceeding.";

      const artifactId = await input.captureProof(`handoff-${step.id}`).catch(() => null);
      const handoffRequestId = randomUUID();

      input.emit({
        kind: "handoff.requested",
        planId,
        stepId: step.id,
        reason: sanitizeProtectedRuntimeText(reason),
        handoffRequestId,
        artifactId,
        capturedAt: new Date().toISOString(),
      });

      step.status = "failed";
      handoffTriggered = true;
      handoffReason = reason;
      await input.pauseForHandoff(reason);
      break;
    }

    // ── EXECUTE: Run the planned action ──────────────────────────────────────
    if (step.action.type === "handoff") {
      const artifactId = await input.captureProof(`handoff-${step.id}`).catch(() => null);
      const handoffRequestId = randomUUID();
      const reason = sanitizeProtectedRuntimeText(step.action.reason);

      input.emit({
        kind: "handoff.requested",
        planId,
        stepId: step.id,
        reason,
        handoffRequestId,
        artifactId,
        capturedAt: new Date().toISOString(),
      });

      step.status = "failed";
      handoffTriggered = true;
      handoffReason = reason;
      await input.pauseForHandoff(reason);
      break;
    }

    if (step.action.type === "wait") {
      const waitMs = step.action.type === "wait" ? step.action.ms : 0;
      await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 10_000)));
      step.status = "verified";
      stepsCompleted += 1;
      consecutiveFailures = 0;
      continue;
    }

    // Capture pre-action context for verification.
    const actionType = step.action.type as "click" | "type" | "navigate" | "scroll";
    const target =
      step.action.type === "navigate"
        ? step.action.url
        : step.action.type === "scroll"
          ? String(step.action.targetY)
          : step.action.selector;

    const typedText = step.action.type === "type" ? step.action.text : undefined;
    const preContext = await capturePreActionContext(input.page, actionType, target, typedText);

    let actionSuccess = false;
    try {
      switch (step.action.type) {
        case "click":
          actionSuccess = await input.executeClick(step.action.selector);
          break;
        case "type":
          actionSuccess = await input.executeType(step.action.selector, step.action.text);
          break;
        case "navigate":
          actionSuccess = await input.executeNavigate(step.action.url);
          break;
        case "scroll":
          actionSuccess = await input.executeScroll(step.action.targetY);
          break;
      }
    } catch {
      actionSuccess = false;
    }

    input.emit({
      kind: "action.executed",
      planId,
      stepId: step.id,
      action: step.action,
      success: actionSuccess,
    });

    // ── VERIFY: Check the action had a measurable effect ─────────────────────
    const verificationResult: VerificationResult = actionSuccess
      ? await verifyAction(input.page, preContext).catch(() => ({
          pass: false,
          reason: "Verification threw an exception — treating as failure.",
          checkType: "inconclusive" as const,
          axHashBefore: preContext.axHashBefore,
          axHashAfter: "error",
          urlBefore: preContext.urlBefore,
          urlAfter: input.page.url().slice(0, 200),
          verifiedAt: new Date().toISOString(),
        }))
      : {
          pass: false,
          reason: "Action returned failure — skipping verification.",
          checkType: "inconclusive" as const,
          axHashBefore: preContext.axHashBefore,
          axHashAfter: preContext.axHashBefore,
          urlBefore: preContext.urlBefore,
          urlAfter: preContext.urlBefore,
          verifiedAt: new Date().toISOString(),
        };

    input.emit({
      kind: "verification.result",
      planId,
      stepId: step.id,
      result: verificationResult,
    });

    if (verificationResult.pass) {
      step.status = "verified";
      stepsCompleted += 1;
      consecutiveFailures = 0;
    } else {
      step.status = "failed";
      stepsFailed += 1;
      consecutiveFailures += 1;

      // ── FRUSTRATION DETECTOR: Hard cap at MAX_CONSECUTIVE_FAILURES ──────────
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        const reason = `${MAX_CONSECUTIVE_FAILURES} consecutive verification failures — pausing for human review. Last failure: ${verificationResult.reason}`;
        const artifactId = await input.captureProof(`frustration-${step.id}`).catch(() => null);
        const handoffRequestId = randomUUID();

        input.emit({
          kind: "handoff.requested",
          planId,
          stepId: step.id,
          reason: sanitizeProtectedRuntimeText(reason),
          handoffRequestId,
          artifactId,
          capturedAt: new Date().toISOString(),
        });

        handoffTriggered = true;
        handoffReason = reason;
        await input.pauseForHandoff(reason);
        break;
      }
    }
  }

  return {
    handoffReason,
    handoffTriggered,
    planId,
    stepsCompleted,
    stepsFailed,
    success: !handoffTriggered && stepsFailed === 0,
  };
}

/**
 * Build a PlanStep with a generated ID and pending status.
 * Convenience factory for callers that construct plans programmatically.
 */
export function buildPlanStep(
  intent: string,
  action: PlannedAction,
  completionCriteria: string,
): PlanStep {
  return {
    id: randomUUID(),
    intent,
    action,
    completionCriteria,
    status: "pending",
  };
}
