/**
 * omni-replay-bundle.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * P2 Session Intelligence — Replay/Debug Bundle Creation
 *
 * Design rules:
 *  - Bundles are persisted as structured JSON artifacts via the existing
 *    ProofCapture artifact pipeline (syncArtifactRecord in service.ts).
 *  - Bundle IDs are stable and deterministic: bundle-{sessionId}-{reason-hash}
 *  - Dashboard receives artifactId only — no raw bundle blobs in events.
 *  - No raw AX tree, no screenshot base64, no session secrets, no cookies.
 *  - Deduplication: same bundleId is never written twice.
 *  - No fake replay — bundle only exists if real checkpoint/step data exists.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { MissionCheckpoint, CompletedStepSummary, RecoveryNote, MissionMemory } from "./omni-checkpoint.js";
import { sanitizeProtectedRuntimeText } from "../security/trade-secret-guard.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ReplayBundleMetadata = {
  /** Stable bundle ID: bundle-{12-char hash} */
  bundleId: string;
  /** Session ID this bundle belongs to. */
  sessionId: string;
  /** Plan ID. */
  planId: string;
  /** Reason the bundle was created. */
  reason: "mission-failed" | "handoff-requested" | "mission-complete" | "manual";
  /** Total steps completed. */
  totalStepsCompleted: number;
  /** Total checkpoints captured. */
  totalCheckpoints: number;
  /** Proof artifact IDs (no base64). */
  proofArtifactIds: string[];
  /** Recovery notes accumulated. */
  recoveryNotes: RecoveryNote[];
  /** ISO timestamp of creation. */
  createdAt: string;
  /**
   * The canonical artifact ID for this bundle.
   * This is the relative path from the session root directory:
   *   `replay-bundle-{bundleId}.json`
   * This matches the ID returned by service.ts listArtifacts() and used by
   * syncArtifactRecord — it is the real, dashboard-safe artifact identifier.
   * Internal absolute path is kept in `artifactPath` for runtime storage only.
   */
  artifactId: string;
  /** The artifact file path where the full bundle is stored (internal only, never emitted to cockpit). */
  artifactPath: string;
};

export type ReplayBundle = {
  /** Bundle metadata (safe to emit in events). */
  metadata: ReplayBundleMetadata;
  /** Compact step summaries (no raw DOM). */
  completedSteps: CompletedStepSummary[];
  /** All checkpoints in order. */
  checkpoints: MissionCheckpoint[];
  /** Recovery notes. */
  recoveryNotes: RecoveryNote[];
  /** Final URL at bundle creation time. */
  finalUrl: string;
  /** Final page title. */
  finalTitle: string;
  /** Final AX tree hash. */
  finalAxTreeHash: string;
};

// ── Deduplication Registry ────────────────────────────────────────────────────

/** Runtime-local registry of created bundle IDs — prevents duplicate writes. */
const createdBundleIds = new Set<string>();

// ── Bundle ID ─────────────────────────────────────────────────────────────────

/**
 * Build a stable, deterministic bundle ID.
 * bundle-{12-char hash of sessionId+planId+reason}
 */
export function buildBundleId(sessionId: string, planId: string, reason: string): string {
  const hash = createHash("sha256")
    .update(`bundle:${sessionId}:${planId}:${reason}`)
    .digest("hex")
    .slice(0, 12);
  return `bundle-${hash}`;
}

// ── Bundle Creation ───────────────────────────────────────────────────────────

/**
 * Create a replay/debug bundle from mission memory.
 *
 * The bundle is written as a structured JSON artifact to the session's
 * artifact directory. The dashboard receives only the artifactId (file path).
 *
 * Returns null if:
 *  - No completed steps or checkpoints exist (no real data to bundle).
 *  - This bundleId has already been created (deduplication).
 *  - The artifact write fails.
 */
export function createReplayBundle(input: {
  memory: MissionMemory;
  sessionId: string;
  planId: string;
  reason: ReplayBundleMetadata["reason"];
  finalUrl: string;
  finalTitle: string;
  finalAxTreeHash: string;
  artifactBaseDir: string;
}): ReplayBundle | null {
  const snapshot = input.memory.snapshot();

  // No fake replay — only create if real data exists
  if (snapshot.completedSteps.length === 0 && snapshot.checkpoints.length === 0) {
    return null;
  }

  const bundleId = buildBundleId(input.sessionId, input.planId, input.reason);

  // Deduplication — never write the same bundle twice
  if (createdBundleIds.has(bundleId)) {
    return null;
  }
  createdBundleIds.add(bundleId);

  const createdAt = new Date().toISOString();
  const artifactPath = join(
    input.artifactBaseDir,
    input.sessionId,
    `replay-bundle-${bundleId}.json`,
  );
  // Canonical artifact ID: relative path from session root — matches service.ts listArtifacts()
  const artifactId = `replay-bundle-${bundleId}.json`;
  const metadata: ReplayBundleMetadata = {
    bundleId,
    sessionId: input.sessionId,
    planId: input.planId,
    reason: input.reason,
    totalStepsCompleted: snapshot.completedSteps.length,
    totalCheckpoints: snapshot.checkpoints.length,
    proofArtifactIds: [
      ...new Set(
        snapshot.completedSteps
          .map((s) => s.proofArtifactId)
          .filter((id): id is string => id !== null),
      ),
    ].slice(0, 20),
    recoveryNotes: snapshot.recoveryNotes.slice(0, 10),
    createdAt,
    artifactId,
    artifactPath,
  };

  const bundle: ReplayBundle = {
    metadata,
    completedSteps: snapshot.completedSteps.map(sanitizeStep),
    checkpoints: snapshot.checkpoints.map(sanitizeCheckpoint),
    recoveryNotes: snapshot.recoveryNotes,
    finalUrl: sanitizeProtectedRuntimeText(input.finalUrl),
    finalTitle: sanitizeProtectedRuntimeText(input.finalTitle),
    finalAxTreeHash: input.finalAxTreeHash,
  };

  // Persist to artifact file
  try {
    mkdirSync(join(input.artifactBaseDir, input.sessionId), { recursive: true });
    writeFileSync(artifactPath, JSON.stringify(bundle, null, 2), "utf8");
  } catch {
    // If write fails, remove from dedup set so it can be retried
    createdBundleIds.delete(bundleId);
    return null;
  }

  return bundle;
}

// ── Sanitization Helpers ──────────────────────────────────────────────────────

/** Sanitize a completed step summary before writing to bundle. */
function sanitizeStep(step: CompletedStepSummary): CompletedStepSummary {
  return {
    ...step,
    intent: sanitizeProtectedRuntimeText(step.intent).slice(0, 200),
    target: sanitizeProtectedRuntimeText(step.target).slice(0, 200),
  };
}

/** Sanitize a checkpoint before writing to bundle. */
function sanitizeCheckpoint(cp: MissionCheckpoint): MissionCheckpoint {
  return {
    ...cp,
    lastVerifiedAction: sanitizeProtectedRuntimeText(cp.lastVerifiedAction).slice(0, 200),
    pendingStepSummary: cp.pendingStepSummary.map((s) =>
      sanitizeProtectedRuntimeText(s).slice(0, 100),
    ),
    completedSteps: cp.completedSteps.map(sanitizeStep),
  };
}

/** Clear the dedup registry (for testing only). */
export function _clearBundleRegistry_TEST_ONLY(): void {
  createdBundleIds.clear();
}
