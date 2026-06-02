/**
 * omni-checkpoint.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * P2 Session Intelligence — Mission Checkpoints + Completed-Step Memory +
 * Recovery Notes + Resume Verification
 *
 * Design rules:
 *  - Checkpoint IDs are stable and deterministic: checkpoint-{planId}-{stepId}
 *  - No raw AX tree in checkpoints — axTreeHash only.
 *  - No credentials, cookies, session secrets, or screenshot base64.
 *  - Completed-step memory stores summaries, not raw DOM.
 *  - Recovery notes are site-specific, human-readable, and safe to store.
 *  - Resume verification captures fresh observation before continuing.
 *  - Reconnect/replay must not duplicate checkpoint events (stable IDs).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { createHash } from "node:crypto";
import type { Page } from "playwright";
import { captureAXObservation } from "./omni-ax-observer.js";
import { sanitizeProtectedRuntimeText } from "../security/trade-secret-guard.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type CompletedStepSummary = {
  /** Step ID from the planner. */
  stepId: string;
  /** Human-readable intent of the step. */
  intent: string;
  /** Action type that was executed. */
  actionType: string;
  /** Target selector or URL. */
  target: string;
  /** Whether the step was verified successfully. */
  verified: boolean;
  /** Verification check type. */
  checkType: string;
  /** Proof artifact ID if captured. */
  proofArtifactId: string | null;
  /** ISO timestamp of completion. */
  completedAt: string;
};

export type RecoveryNote = {
  /** Unique note ID. */
  noteId: string;
  /** The URL pattern this note applies to. */
  urlPattern: string;
  /** Human-readable recovery note. */
  note: string;
  /** Category of the recovery note. */
  category: "auth-wall" | "captcha" | "disabled-element" | "modal-blocked" | "iframe-context" | "form-validation" | "frustration" | "general";
  /** ISO timestamp when this note was created. */
  createdAt: string;
};

export type MissionCheckpoint = {
  /** Stable deterministic ID: checkpoint-{planId}-{stepId} */
  checkpointId: string;
  /** Session ID this checkpoint belongs to. */
  sessionId: string;
  /** Plan ID. */
  planId: string;
  /** Step number (0-indexed). */
  stepNumber: number;
  /** Step ID. */
  stepId: string;
  /** Current URL at checkpoint time. */
  url: string;
  /** Page title at checkpoint time. */
  title: string;
  /** AX tree hash — never the full tree. */
  axTreeHash: string;
  /** Summary of the last verified action. */
  lastVerifiedAction: string;
  /** Compact summaries of completed steps. */
  completedSteps: CompletedStepSummary[];
  /** Summary of remaining steps (intents only, no raw data). */
  pendingStepSummary: string[];
  /** Proof/artifact IDs captured so far. */
  proofArtifactIds: string[];
  /** Recovery notes accumulated during this mission. */
  recoveryNotes: RecoveryNote[];
  /** ISO timestamp. */
  capturedAt: string;
};

export type ResumeVerificationResult = {
  /** Whether the page is in a safe state to resume. */
  safeToResume: boolean;
  /** Whether the auth/challenge blocker appears cleared. */
  blockerCleared: boolean;
  /** Current URL. */
  currentUrl: string;
  /** Current page title. */
  currentTitle: string;
  /** AX tree hash after resume. */
  axTreeHash: string;
  /** Whether an auth wall is still detected. */
  authWallStillPresent: boolean;
  /** Whether a CAPTCHA is still detected. */
  captchaStillPresent: boolean;
  /** Human-readable reason. */
  reason: string;
  /** ISO timestamp. */
  verifiedAt: string;
};

// ── In-memory store (runtime-local, not persisted to DB) ─────────────────────

/**
 * MissionMemory holds the runtime state for a single mission execution.
 * It is NOT persisted to the database — it is runtime-local only.
 * The replay bundle (persisted) is derived from this memory at mission end.
 */
export class MissionMemory {
  private completedSteps: CompletedStepSummary[] = [];
  private recoveryNotes: RecoveryNote[] = [];
  private checkpoints: MissionCheckpoint[] = [];
  private seenCheckpointIds = new Set<string>();

  /** Add a completed step summary. Stores summaries only, not raw DOM. */
  addCompletedStep(step: CompletedStepSummary): void {
    this.completedSteps.push(step);
    // Cap memory at 100 steps to prevent unbounded growth
    if (this.completedSteps.length > 100) {
      this.completedSteps = this.completedSteps.slice(-100);
    }
  }

  /** Add a recovery note. Deduplicates by note content + URL pattern. */
  addRecoveryNote(note: RecoveryNote): void {
    const key = `${note.urlPattern}:${note.note}`;
    const exists = this.recoveryNotes.some(
      (n) => `${n.urlPattern}:${n.note}` === key,
    );
    if (!exists) {
      this.recoveryNotes.push(note);
    }
  }

  /**
   * Add a checkpoint. Uses stable ID for deduplication.
   * Reconnect/replay will not duplicate checkpoint cards.
   */
  addCheckpoint(checkpoint: MissionCheckpoint): boolean {
    if (this.seenCheckpointIds.has(checkpoint.checkpointId)) {
      return false; // already seen — skip
    }
    this.seenCheckpointIds.add(checkpoint.checkpointId);
    this.checkpoints.push(checkpoint);
    return true; // newly added
  }

  getCompletedSteps(): CompletedStepSummary[] {
    return [...this.completedSteps];
  }

  getRecoveryNotes(): RecoveryNote[] {
    return [...this.recoveryNotes];
  }

  getCheckpoints(): MissionCheckpoint[] {
    return [...this.checkpoints];
  }

  getLatestCheckpoint(): MissionCheckpoint | null {
    return this.checkpoints[this.checkpoints.length - 1] ?? null;
  }

  /** Snapshot of the full memory for replay bundle construction. */
  snapshot(): {
    completedSteps: CompletedStepSummary[];
    recoveryNotes: RecoveryNote[];
    checkpoints: MissionCheckpoint[];
  } {
    return {
      completedSteps: this.getCompletedSteps(),
      recoveryNotes: this.getRecoveryNotes(),
      checkpoints: this.getCheckpoints(),
    };
  }
}

// ── Checkpoint Creation ───────────────────────────────────────────────────────

/**
 * Create a mission checkpoint after verified progress.
 *
 * The checkpoint ID is deterministic: checkpoint-{planId}-{stepId}
 * This ensures reconnect/replay cannot duplicate checkpoint cards.
 */
export async function createMissionCheckpoint(input: {
  page: Page;
  sessionId: string;
  planId: string;
  stepId: string;
  stepNumber: number;
  lastVerifiedAction: string;
  memory: MissionMemory;
  pendingStepIntents: string[];
  proofArtifactIds: string[];
}): Promise<MissionCheckpoint | null> {
  try {
    const obs = await captureAXObservation(input.page).catch(() => null);
    if (!obs) return null;

    const checkpointId = buildCheckpointId(input.planId, input.stepId);
    const capturedAt = new Date().toISOString();

    const checkpoint: MissionCheckpoint = {
      checkpointId,
      sessionId: input.sessionId,
      planId: input.planId,
      stepId: input.stepId,
      stepNumber: input.stepNumber,
      url: obs.url,
      title: obs.title,
      axTreeHash: obs.axTreeHash,
      lastVerifiedAction: sanitizeProtectedRuntimeText(input.lastVerifiedAction).slice(0, 200),
      completedSteps: input.memory.getCompletedSteps().slice(-10), // last 10 only
      pendingStepSummary: input.pendingStepIntents.slice(0, 10).map((i) =>
        sanitizeProtectedRuntimeText(i).slice(0, 100),
      ),
      proofArtifactIds: input.proofArtifactIds.slice(0, 20),
      recoveryNotes: input.memory.getRecoveryNotes().slice(0, 10),
      capturedAt,
    };

    return checkpoint;
  } catch {
    return null;
  }
}

/**
 * Build a stable, deterministic checkpoint ID.
 * checkpoint-{planId}-{stepId} — hashed to a fixed length.
 */
export function buildCheckpointId(planId: string, stepId: string): string {
  const hash = createHash("sha256")
    .update(`checkpoint:${planId}:${stepId}`)
    .digest("hex")
    .slice(0, 12);
  return `checkpoint-${hash}`;
}

// ── Recovery Notes ────────────────────────────────────────────────────────────

/**
 * Generate a recovery note based on the failure context.
 * Notes are site-specific and human-readable — safe to store.
 */
export function buildRecoveryNote(input: {
  url: string;
  failureReason: string;
  actionType: string;
  target: string;
  authWallHint: boolean;
  captchaHint: boolean;
  modalBlocked: boolean;
  iframeContext: boolean;
  formValidationError: boolean;
}): RecoveryNote {
  const urlPattern = extractUrlPattern(input.url);
  let note: string;
  let category: RecoveryNote["category"];

  if (input.authWallHint) {
    note = `Login wall detected at ${urlPattern} — human authentication required before proceeding`;
    category = "auth-wall";
  } else if (input.captchaHint) {
    note = `CAPTCHA detected at ${urlPattern} — human verification required`;
    category = "captcha";
  } else if (input.modalBlocked) {
    note = `Modal blocked background click at ${urlPattern} — dismiss modal before interacting with page`;
    category = "modal-blocked";
  } else if (input.iframeContext) {
    note = `Target was inside an iframe at ${urlPattern} — use iframe context for future interactions`;
    category = "iframe-context";
  } else if (input.formValidationError) {
    note = `Form validation rejected input at ${urlPattern} — check field requirements before retyping`;
    category = "form-validation";
  } else if (input.actionType === "click" && input.failureReason.includes("disabled")) {
    note = `Button/element disabled at ${urlPattern} — may require prior form completion or state change`;
    category = "disabled-element";
  } else {
    note = sanitizeProtectedRuntimeText(
      `${input.actionType} on "${input.target.slice(0, 60)}" failed at ${urlPattern}: ${input.failureReason.slice(0, 100)}`,
    );
    category = "general";
  }

  return {
    noteId: createHash("sha256")
      .update(`note:${urlPattern}:${note}`)
      .digest("hex")
      .slice(0, 12),
    urlPattern,
    note,
    category,
    createdAt: new Date().toISOString(),
  };
}

/** Extract a safe URL pattern (origin + path prefix, no query/fragment). */
function extractUrlPattern(url: string): string {
  try {
    const parsed = new URL(url);
    const pathParts = parsed.pathname.split("/").slice(0, 3);
    return `${parsed.hostname}${pathParts.join("/")}`;
  } catch {
    return url.slice(0, 50);
  }
}

// ── Resume Verification ───────────────────────────────────────────────────────

/**
 * Verify page state after human handoff resume.
 *
 * Rules:
 *  - Capture fresh observation — do not assume user completed the blocker.
 *  - Compare current URL/title/hash to expected resume context.
 *  - If auth wall or CAPTCHA still present, remain in handoff state.
 *  - Only declare safeToResume if blocker is cleared.
 */
export async function verifyResumeState(input: {
  page: Page;
  expectedUrl: string;
  expectedAxTreeHash: string;
  handoffReason: string;
}): Promise<ResumeVerificationResult> {
  const verifiedAt = new Date().toISOString();

  try {
    const obs = await captureAXObservation(input.page);

    const authWallStillPresent = obs.authWallHint;
    const captchaStillPresent = obs.captchaHint;
    const urlChanged = obs.url !== input.expectedUrl;
    const axChanged = obs.axTreeHash !== input.expectedAxTreeHash;

    // Blocker is cleared if: no auth wall, no CAPTCHA, and either URL or AX changed
    const blockerCleared =
      !authWallStillPresent &&
      !captchaStillPresent &&
      (urlChanged || axChanged);

    const safeToResume = blockerCleared;

    let reason: string;
    if (authWallStillPresent) {
      reason = "Auth wall still detected after resume — human must complete authentication";
    } else if (captchaStillPresent) {
      reason = "CAPTCHA still detected after resume — human must complete verification";
    } else if (!urlChanged && !axChanged) {
      reason = "Page state unchanged after resume — blocker may not be cleared";
    } else {
      reason = `Resume verified — URL ${urlChanged ? "changed" : "unchanged"}, AX tree ${axChanged ? "changed" : "unchanged"}`;
    }

    return {
      safeToResume,
      blockerCleared,
      currentUrl: obs.url,
      currentTitle: obs.title,
      axTreeHash: obs.axTreeHash,
      authWallStillPresent,
      captchaStillPresent,
      reason,
      verifiedAt,
    };
  } catch {
    return {
      safeToResume: false,
      blockerCleared: false,
      currentUrl: "",
      currentTitle: "",
      axTreeHash: "",
      authWallStillPresent: false,
      captchaStillPresent: false,
      reason: "Resume verification threw an exception — staying in handoff state",
      verifiedAt,
    };
  }
}
