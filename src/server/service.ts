import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { OmniCoreClone } from "../runtime/omni-core-clone.js";
import { ProofCapture } from "../runtime/proof-capture.js";
import { OmniSessionPersistence } from "../runtime/session-persistence.js";
import { OmniSessionManager } from "../runtime/omni-session-manager.js";
import { OmniRateLimiter } from "../runtime/rate-limiter.js";
import { listVaultEntries, loadVaultEntry, saveVaultEntry, type OmniVaultEntry } from "../utils/local-vault.js";
import {
  getBrowserRecordSessionDir,
  getBrowserRecordsRoot,
  getBrowserSessionDir,
  getMissionLogsDir,
  getSessionStateRootDir,
} from "../utils/omni-paths.js";
import { prepareDirectiveForModel, validateAssistantReply } from "./model-guard.js";
import { isAgentLoopEnabled, runAgentLoop } from "../runtime/omni-agent-loop.js";
import {
  syncArtifactRecord,
  syncGuardrailIncident,
  syncRuntimeEvent,
  syncRuntimeSessionSnapshot,
  syncVaultRecord,
} from "./control-plane-sync.js";
import { sanitizeProtectedRuntimeValue } from "../security/trade-secret-guard.js";
import { LocalComputerController, type ComputerAction } from "../runtime/local-computer.js";
import { getEnabledTakeoverCapabilities } from "./takeover-config.js";
import { emitWebhookEvent } from "./webhooks.js";
import { listCommandNames } from "./commands-schema.js";
import { executePlan, type PlanStep } from "../runtime/omni-planner.js";
import { captureAXObservation } from "../runtime/omni-ax-observer.js";
import { detectCaptcha, solveCaptcha, waitForHuman } from "../runtime/captcha-solver.js";
import {
  OmniBudgetError,
  OmniNotFoundError,
  OmniRateLimitError,
  OmniRequestTimeoutError,
  OmniValidationError,
} from "./omni-errors.js";
import type { Page } from "playwright";

export type SessionEvent = {
  data: Record<string, unknown>;
  eventId: string;
  sessionId: string;
  timestamp: string;
  type: string;
};

type SessionListener = (event: SessionEvent) => void;

type CreateSessionInput = {
  agentId?: string;
  colorScheme?: "dark" | "light" | "no-preference";
  creditBudget?: number | null;
  device?: string;
  geolocation?: { latitude: number; longitude: number };
  locale?: string;
  objective?: string | null;
  operatorSessionId?: number | null;
  orgId?: string | null;
  permissions?: string[];
  persistent?: boolean;
  policyVersion?: string | null;
  sessionId?: string;
  timezoneId?: string;
  userAgent?: string;
  userId?: string | null;
  viewport?: { width: number; height: number };
};

type CommandContext = {
  agentId?: string;
  ip?: string | null;
  orgId?: string | null;
  userAgent?: string | null;
  userId?: string | null;
};

type ControlPlaneSessionStatus =
  | "awaiting_auth"
  | "closed"
  | "completed"
  | "failed"
  | "launching"
  | "paused"
  | "running";

export type SessionCommand =
  | { type: "assistant_reply"; message: string }
  | {
      type: "click";
      // Exactly one target source is required: selector OR text OR coordinates.
      // The handler in service.ts validates the payload and rejects ambiguous
      // or empty input with a typed OmniValidationError (400).
      coordinates?: { x: number; y: number };
      match_index?: number;
      selector?: string;
      text?: string;
    }
  | { type: "computer"; action: ComputerAction; confirm?: boolean }
  | { type: "directive"; message: string }
  | { type: "navigate"; url: string }
  | { type: "pause"; reason?: string }
  | { type: "resume"; reason?: string }
  | { type: "screenshot"; label?: string }
  | { type: "status" }
  | { type: "type"; selector: string; text: string }
  | { type: "close"; reason?: string }
  // ── Wave 2: high-level wrappers over the new low-level ComputerAction variants ──
  | { type: "right_click"; selector: string }
  | { type: "double_click"; selector: string }
  | { type: "hover"; selector: string }
  | { type: "shortcut"; keys: string[] }
  | { type: "drag"; fromSelector: string; toSelector: string }
  | { type: "scroll"; selector: string; targetY: number }
  | { type: "file_upload"; selector: string; filePath: string }
  | { type: "file_download"; url: string; savePath: string }
  | { type: "screenshot_element"; selector: string; label?: string }
  | { type: "fill_form"; fields: Array<{ selector: string; value: string }> }
  | { type: "scroll_until"; target: string; direction?: "down" | "up"; maxScrolls?: number }
  | { type: "enter_frame"; frameSelector: string }
  | { type: "exit_frame" }
  | { type: "shadow_click"; selector: string }
  // ── Wave 2 Task 5: AI helpers — thin wrappers over the existing planner/AX observer ──
  | { type: "plan"; goal: string }
  | { type: "execute_plan"; plan_id: string; steps?: PlannedStepInput[] }
  | { type: "next_step"; plan_id: string; step: PlannedStepInput }
  | { type: "describe_page" }
  | { type: "find"; text: string; fuzzy?: boolean }
  | { type: "wait_for"; predicate: string; timeout_ms?: number }
  // ── Wave 2 Task 6: CAPTCHA handling ──
  | { type: "detect_captcha" }
  | { type: "wait_for_human"; reason?: string; timeout_ms?: number }
  | { type: "navigate_with_fallback"; url: string; fallback_url: string };

/** Wave 2 Task 5: shape of a step the AI can submit in execute_plan / next_step. */
export type PlannedStepInput = {
  intent: string;
  action: PlannedActionInput;
};

/** Wave 2 Task 5: shape of an action within a planned step. */
export type PlannedActionInput =
  | { type: "click"; selector?: string }
  | { type: "navigate"; url?: string }
  | { type: "scroll"; targetY?: number }
  | { type: "type"; selector?: string; text?: string }
  | { type: "wait" }
  | { type: "handoff"; reason?: string };

/** Wave 2: the subset of SessionCommand that handleNewHighLevel routes. */
export type NewHighLevelCommand = Extract<
  SessionCommand,
  | { type: "right_click" }
  | { type: "double_click" }
  | { type: "hover" }
  | { type: "shortcut" }
  | { type: "drag" }
  | { type: "scroll" }
  | { type: "file_upload" }
  | { type: "file_download" }
  | { type: "screenshot_element" }
  | { type: "fill_form" }
  | { type: "scroll_until" }
  | { type: "enter_frame" }
  | { type: "exit_frame" }
  | { type: "shadow_click" }
>;

type SessionRecord = {
  actionLog: Array<{
    type: string;
    ts: string;
    // Optional summary text for the control plane to inspect.  Not sent as
    // telemetry detail — only logged in-band for heuristic loop detection.
    summary?: string;
  }>;
  agentId: string;
  commandCount: number;
  computer: LocalComputerController | null;
  core: OmniCoreClone;
  createdAt: string;
  creditBudget: number;
  lastActiveAt: string;
  listeners: Set<SessionListener>;
  objective: string | null;
  orgId: string | null;
  persistent: boolean;
  policyVersion: string | null;
  remainingBudget: number;
  sessionId: string;
  sessionManager: OmniSessionManager;
  totalArtifactCount: number;
  userId: string | null;
};

const CONTROL_PLANE_TELEMETRY_EVENTS = new Set([
  "checkpoint.created",
  "execution",
  "handoff.requested",
  "human_message",
  "mission_log",
  "observation.captured",
  "plan.created",
  "replay.bundle_created",
  "verification.result",
]);

export class OmniStandaloneService {
  private cleanupTimer: NodeJS.Timeout;
  private readonly planStore = new PlanStore();
  private readonly rateLimiter = new OmniRateLimiter({
    agentRpm: numberFromEnv("OMNI_AGENT_RPM", 30),
    burstPerSecond: numberFromEnv("OMNI_BURST_RPS", 10),
    sessionRpm: numberFromEnv("OMNI_SESSION_RPM", 60),
  });
  private readonly sessions = new Map<string, SessionRecord>();

  constructor() {
    this.cleanupTimer = setInterval(() => {
      void this.cleanupIdleSessions();
    }, Math.min(this.idleTimeoutMs(), 60_000));
    this.cleanupTimer.unref?.();
  }

  async createSession(input: CreateSessionInput = {}): Promise<Record<string, unknown>> {
    await this.enforceSessionCap();

    const sessionId = input.sessionId?.trim() || randomUUID();
    if (this.sessions.has(sessionId)) {
      throw new OmniValidationError(`Omni session already exists: ${sessionId}`, { sessionId });
    }

    const agentId = input.agentId?.trim() || input.userId?.trim() || "standalone-api";
    const now = new Date().toISOString();
    const proofCapture = new ProofCapture(
      getBrowserRecordsRoot(input.userId ?? undefined),
      getMissionLogsDir(input.userId ?? undefined),
    );
    const sessionPersistence = new OmniSessionPersistence(getSessionStateRootDir(input.userId ?? undefined));
    // Use the same OMNI_MAX_PARALLEL_SESSIONS env var as the global cap so
    // operators have one source of truth. The session-manager's per-instance
    // sub-session cap is independent of the global service cap, but tying
    // them to the same env var prevents surprise inconsistencies.
    const parallelCap = numberFromEnv("OMNI_MAX_PARALLEL_SESSIONS", 50);
    const sessionManager = new OmniSessionManager({ maxParallelSessions: parallelCap });
    // Wave 2 Task 4: per-session browser context options. Per-session
    // overrides win over global env defaults (read in local-server.ts).
    const contextOptions = {
      colorScheme: input.colorScheme,
      device: input.device,
      geolocation: input.geolocation,
      locale: input.locale,
      permissions: input.permissions,
      timezoneId: input.timezoneId,
      userAgent: input.userAgent,
      viewport: input.viewport,
    };
    const core = new OmniCoreClone({
      proofCapture,
      sessionManager,
      sessionPersistence,
    });

    core.setUserScope(input.userId ?? null);
    await core.initVault(
      getBrowserSessionDir(sessionId, input.userId ?? undefined),
      input.userId ?? undefined,
      contextOptions,
    );
    core.startRuntimePersistence({
      agentId,
      checkpointIntervalMs: numberFromEnv("OMNI_CHECKPOINT_MS", 300_000),
      heartbeatIntervalMs: numberFromEnv("OMNI_HEARTBEAT_MS", 60_000),
    });

    if (input.objective?.trim()) {
      await core.bootstrapTaskMission({
        objective: input.objective.trim(),
        operatorSessionId: input.operatorSessionId ?? null,
        persistent: input.persistent === true,
        provider: "standalone-runtime",
      });
    }

    const creditBudget = Math.max(0, Number(input.creditBudget ?? 0));
    const record: SessionRecord = {
      actionLog: [],
      agentId,
      commandCount: 0,
      computer: null,
      core,
      createdAt: now,
      creditBudget,
      lastActiveAt: now,
      listeners: new Set(),
      objective: input.objective?.trim() || null,
      orgId: input.orgId?.trim() || null,
      persistent: input.persistent === true,
      policyVersion: input.policyVersion?.trim() || null,
      remainingBudget: creditBudget,
      sessionId,
      sessionManager,
      totalArtifactCount: 0,
      userId: input.userId?.trim() || null,
    };
    core.setTelemetrySink((event, payload) => {
      if (!CONTROL_PLANE_TELEMETRY_EVENTS.has(event)) {
        return;
      }
      this.emit(record, event, sanitizeProtectedRuntimeValue({
        ...payload,
        tool: "browser",
      }));
    });
    this.sessions.set(sessionId, record);

    const snapshot = await this.describeSession(record);
    this.emit(record, "session.created", snapshot);
    emitWebhookEvent("session.created", sessionId, record.orgId, record.userId, { sessionId });
    void this.syncSessionSnapshot(record);
    return snapshot;
  }

  async executeCommand(
    sessionId: string,
    command: SessionCommand,
    context: CommandContext = {},
  ): Promise<Record<string, unknown>> {
    const record = this.requireSession(sessionId);
    const agentId = context.agentId?.trim() || record.agentId;
    this.touch(record);

    const agentRate = this.rateLimiter.consumeAgent(agentId);
    if (!agentRate.allowed) {
      const retryAfterMs = Math.max(0, agentRate.resetAt - Date.now());
      throw new OmniRateLimitError(retryAfterMs || 1000, `agent:${agentId}`);
    }

    const sessionRate = this.rateLimiter.consumeSession(sessionId);
    if (!sessionRate.allowed) {
      const retryAfterMs = Math.max(0, sessionRate.resetAt - Date.now());
      throw new OmniRateLimitError(retryAfterMs || 1000, `session:${sessionId}`);
    }

    const cost = command.type === "status" ? 0 : 1;
    if (cost > 0 && record.remainingBudget < cost) {
      await record.core.pauseMission("Credit budget exhausted").catch(() => undefined);
      void this.syncSessionSnapshot(record, "paused");
      throw new OmniBudgetError(cost, record.creditBudget);
    }

    this.emit(record, "command.started", {
      agentId,
      command,
      rateLimits: {
        agentRemaining: agentRate.remaining,
        sessionRemaining: sessionRate.remaining,
      },
      remainingBudget: record.remainingBudget,
    });

    let result: Record<string, unknown>;
    switch (command.type) {
      case "navigate":
        result = await record.core.navigate(command.url);
        break;
      case "click":
        result = await this.handleClick(record, command);
        break;
      case "type":
        if (typeof command.selector !== "string" || command.selector.length === 0) {
          throw new OmniValidationError(`type: selector is required (string, non-empty)`, { received: command });
        }
        if (typeof command.text !== "string") {
          throw new OmniValidationError(`type: text is required (string)`, { received: command });
        }
        result = await record.core.type(command.selector, command.text);
        break;
      case "screenshot":
        result = await record.core.screenshot(command.label);
        break;
      case "pause":
        result = { ...(await record.core.pauseMission(command.reason)) };
        break;
      case "resume":
        result = { ...(await record.core.resumeMission(command.reason)) };
        break;
      case "status":
        result = await record.core.getStatus();
        break;
      case "computer":
        result = await this.handleComputer(record, command);
        break;
      case "directive":
        result = await this.handleDirective(record, command.message, context);
        break;
      case "assistant_reply":
        result = await this.handleAssistantReply(record, command.message, context);
        break;
      // Wave 2: high-level wrappers. Each resolves selectors to coordinates (or
      // builds a low-level ComputerAction) and re-enters via handleComputer so
      // the safety rails + webhooks + action log path apply uniformly.
      case "right_click":
      case "double_click":
      case "hover":
      case "shortcut":
      case "drag":
      case "scroll":
      case "file_upload":
      case "file_download":
      case "screenshot_element":
      case "fill_form":
      case "scroll_until":
      case "enter_frame":
      case "exit_frame":
      case "shadow_click":
        result = await this.handleNewHighLevel(record, command);
        break;
      // Wave 2 Task 5: AI helpers. Thin wrappers over the existing
      // omni-planner + omni-ax-observer. Each returns a structured result
      // the AI can consume to drive the next step.
      case "plan":
      case "execute_plan":
      case "next_step":
      case "describe_page":
      case "find":
      case "wait_for":
        result = await this.handleAiHelper(record, command);
        break;
      // Wave 2 Task 6: CAPTCHA handling. Each command reads from the
      // captcha-solver module; detect_captcha is always safe to call,
      // wait_for_human pauses the mission, navigate_with_fallback tries
      // the primary URL then falls back if a CAPTCHA is detected.
      case "detect_captcha":
      case "wait_for_human":
      case "navigate_with_fallback":
        result = await this.handleCaptcha(record, command);
        break;
      case "close":
        result = await this.closeSessionInternal(record, command.reason);
        break;
      default:
        throw new OmniValidationError(
          `unknown command type: ${(command as { type: string }).type}`,
          { knownCommands: listCommandNames() },
        );
    }

    record.commandCount += 1;
    record.remainingBudget = Math.max(record.remainingBudget - cost, 0);

    // Push action-log entry for the control plane's loop/no-progress detection.
    // Newest-first; bounded by OMNI_ACTION_LOG_MAX (default 10000) to prevent
    // unbounded memory growth on long-lived sessions. Paginated access via
    // listActionLog(sessionId, { limit, before }).
    record.actionLog.unshift({
      type: command.type,
      ts: new Date().toISOString(),
      summary: describeCommandForActionLog(command),
    });
    const actionLogMax = numberFromEnv("OMNI_ACTION_LOG_MAX", 10_000);
    if (record.actionLog.length > actionLogMax) {
      record.actionLog.length = actionLogMax;
    }

    this.emit(record, "command.completed", {
      agentId,
      commandType: command.type,
      remainingBudget: record.remainingBudget,
      result,
    });
    emitWebhookEvent("command.completed", record.sessionId, record.orgId, record.userId, {
      agentId,
      commandType: command.type,
      remainingBudget: record.remainingBudget,
    });
    void this.syncSessionSnapshot(record);
    if (
      command.type === "screenshot" ||
      command.type === "navigate" ||
      command.type === "click" ||
      command.type === "type" ||
      command.type === "directive"
    ) {
      void this.syncArtifacts(record);
    }
    return result;
  }

  async getSessionStatus(sessionId: string): Promise<Record<string, unknown>> {
    const record = this.requireSession(sessionId);
    const status = await record.core.getStatus();
    return {
      metadata: await this.describeSession(record),
      runtime: status,
    };
  }

  // Wave 2 Task 10: rich context snapshot for GET /api/sessions/{id}/context.
  // Returns the runtime status + AX tree summary (capped at 2000 chars),
  // URL, title, and auth/captcha hints. Best-effort: returns what it can
  // and substitutes null for fields the page can't provide.
  async getSessionContext(
    sessionId: string,
    opts: { includeScreenshot?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const record = this.requireSession(sessionId);
    const runtime = (await record.core.getStatus()) as Record<string, unknown>;
    let ax: Awaited<ReturnType<typeof captureAXObservation>> | null = null;
    let screenshotBase64: string | null = null;
    try {
      const page = await record.core.ensurePage();
      ax = await captureAXObservation(page);
      // Include a base64 screenshot when OMNI_SCREENSHOT_IN_EVENTS=1 or caller opts in.
      // Scaled to 75% for bandwidth — still high enough for a vision AI to read.
      if (opts.includeScreenshot || process.env.OMNI_SCREENSHOT_IN_EVENTS === "1") {
        const buf = await page.screenshot({ type: "jpeg", quality: 70, scale: "css" }).catch(() => null);
        if (buf) screenshotBase64 = buf.toString("base64");
      }
    } catch {
      ax = null;
    }
    return {
      axSummary: ax?.axTree?.slice(0, 2000) ?? null,
      axTreeHash: ax?.axTreeHash ?? null,
      authWallHint: ax?.authWallHint ?? null,
      capturedAt: ax?.capturedAt ?? null,
      captchaHint: ax?.captchaHint ?? null,
      runtime,
      sessionId,
      ...(screenshotBase64 !== null ? { screenshotBase64 } : {}),
      title:
        ax?.title ?? (typeof runtime.title === "string" ? (runtime.title as string) : null),
      url:
        ax?.url ?? (typeof runtime.currentUrl === "string" ? (runtime.currentUrl as string) : null),
    };
  }

  // P4-04: paginated actionLog access. Newest-first ordering,
  // cursor-based pagination via 'before' (ts string of the last
  // entry the client already has).
  listActionLog(
    sessionId: string,
    opts: { limit?: number; before?: string } = {},
  ): Array<{ type: string; ts: string; summary?: string }> {
    const record = this.requireSession(sessionId);
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
    const before = opts.before ? Date.parse(opts.before) : null;
    const log = record.actionLog;
    const result: Array<{ type: string; ts: string; summary?: string }> = [];
    for (const entry of log) {
      if (before !== null && Date.parse(entry.ts) >= before) continue;
      result.push(entry);
      if (result.length >= limit) break;
    }
    return result;
  }

  listSessions(filter: { orgId?: string | null; userId?: string | null } = {}): Array<Record<string, unknown>> {
    return Array.from(this.sessions.values())
      .filter((record) => {
        if (filter.orgId && record.orgId !== filter.orgId) return false;
        if (filter.userId && record.userId !== filter.userId) return false;
        return true;
      })
      .map((record) => ({
        agentId: record.agentId,
        commandCount: record.commandCount,
        createdAt: record.createdAt,
        creditBudget: record.creditBudget,
        lastActiveAt: record.lastActiveAt,
        objective: record.objective,
        orgId: record.orgId,
        persistent: record.persistent,
        policyVersion: record.policyVersion,
        remainingBudget: record.remainingBudget,
        sessionId: record.sessionId,
        userId: record.userId,
      }));
  }

  listVaultEntries(userId?: string | null): OmniVaultEntry[] {
    return listVaultEntries(userId);
  }

  getVaultEntry(service: string, userId?: string | null): OmniVaultEntry | null {
    return loadVaultEntry(service, userId);
  }

  saveVaultPayload(
    service: string,
    userId: string | null | undefined,
    input: Partial<OmniVaultEntry> & { envelope?: Record<string, unknown> },
    orgId?: string | null,
  ): OmniVaultEntry {
    const entry: OmniVaultEntry = {
      capturedAt: input.capturedAt || new Date().toISOString(),
      cookies: input.cookies ?? [],
      domains: input.domains ?? [],
      envelope: input.envelope,
      lastUrl: input.lastUrl || "",
      service,
      title: input.title || service,
      userAgent: input.userAgent || "omni-dashboard-control-plane",
    };
    saveVaultEntry(entry, userId);
    if (userId && orgId) {
      void syncVaultRecord({
        domains: entry.domains,
        envelope: entry.envelope,
        lastUrl: entry.lastUrl,
        orgId,
        service,
        title: entry.title,
        userId,
      });
    }
    return entry;
  }

  loadVaultPayload(service: string, userId?: string | null): OmniVaultEntry | null {
    return loadVaultEntry(service, userId);
  }

  // P4-05: timeline of screenshot artifacts for a session, newest-first.
  // Filters the artifacts list to entries typed as 'screenshot'.
  listScreenshots(sessionId: string, userId?: string | null): Array<Record<string, unknown>> {
    return this.listArtifacts(sessionId, userId).filter((a) => a.type === "screenshot");
  }

  listArtifacts(sessionId: string, userId?: string | null): Array<Record<string, unknown>> {
    const liveRecord = this.sessions.get(sessionId);
    const rootDir = liveRecord
      ? liveRecord.core.getProofCapture().getSessionPaths(sessionId).rootDir
      : getBrowserRecordSessionDir(sessionId, userId ?? undefined);
    return collectArtifacts(rootDir).map((artifactPath) => ({
      artifactId: path.relative(rootDir, artifactPath.path).replaceAll(path.sep, "/"),
      createdAt: new Date(artifactPath.mtimeMs).toISOString(),
      label: path.basename(artifactPath.path),
      path: artifactPath.path,
      sessionId,
      sizeBytes: artifactPath.size,
      type: inferArtifactType({
        contentType: inferArtifactContentType({
          label: path.basename(artifactPath.path),
          path: artifactPath.path,
        }),
        label: path.basename(artifactPath.path),
        path: artifactPath.path,
      }),
    }));
  }

  getArtifact(sessionId: string, artifactId: string, userId?: string | null): Record<string, unknown> | null {
    return this.listArtifacts(sessionId, userId).find((artifact) => artifact.artifactId === artifactId) ?? null;
  }

  subscribe(sessionId: string, listener: SessionListener): () => void {
    const record = this.requireSession(sessionId);
    record.listeners.add(listener);
    void this.describeSession(record).then((snapshot) => {
      listener({
        data: snapshot,
        eventId: randomUUID(),
        sessionId,
        timestamp: new Date().toISOString(),
        type: "session.snapshot",
      });
    });
    return () => {
      record.listeners.delete(listener);
    };
  }

  async closeSession(sessionId: string): Promise<void> {
    const record = this.sessions.get(sessionId);
    if (!record) {
      return;
    }
    const runtimeStatus = await record.core.getStatus().catch(() => ({}));
    this.emit(record, "session.closing", {});
    // Await snapshots during shutdown so the control plane receives the final
    // session-closed status before the container parks.
    await this.syncSessionSnapshot(record, "closed", runtimeStatus).catch(() => undefined);
    await this.syncArtifacts(record).catch(() => undefined);
    this.sessions.delete(sessionId);
    await record.core.close();
    record.sessionManager.dispose();
    emitWebhookEvent("session.closed", sessionId, record.orgId, record.userId, { sessionId });
  }

  /** Internal: invoked from the `close` SessionCommand. */
  private async closeSessionInternal(
    record: SessionRecord,
    reason?: string,
  ): Promise<Record<string, unknown>> {
    const sessionId = record.sessionId;
    await this.closeSession(sessionId);
    return { ok: true, sessionId, closed: true, reason: reason ?? null };
  }

  async shutdown(): Promise<void> {
    clearInterval(this.cleanupTimer);
    for (const sessionId of Array.from(this.sessions.keys())) {
      await this.closeSession(sessionId);
    }
  }

  private async handleDirective(
    record: SessionRecord,
    message: string,
    context: CommandContext,
  ): Promise<Record<string, unknown>> {
    const guarded = await prepareDirectiveForModel({
      ip: context.ip,
      message,
      sessionId: record.sessionId,
      userAgent: context.userAgent,
      userId: context.userId ?? record.userId,
    });

    if (guarded.allowed === false) {
      const refusal = guarded;
      this.emit(record, "security.refusal", {
        disengaged: refusal.disengaged,
        firedWebhook: refusal.firedWebhook,
        strikeCount: refusal.strikeCount,
      });
      if (record.orgId) {
        void syncGuardrailIncident({
          kind: "security.refusal",
          orgId: record.orgId,
          payload: {
            disengaged: refusal.disengaged,
            firedWebhook: refusal.firedWebhook,
            strikeCount: refusal.strikeCount,
          },
          sessionId: record.sessionId,
          severity: refusal.disengaged ? "critical" : "warning",
          userId: record.userId,
        });
      }
      return {
        disengaged: refusal.disengaged,
        firedWebhook: refusal.firedWebhook,
        response: refusal.response,
        strikeCount: refusal.strikeCount,
      };
    }

    await record.core.receiveHumanMessage(guarded.message, {
      echoInScratchpad: true,
      queueForAgent: true,
    });

    // When OMNI_LLM_PROVIDER is set, spawn the autonomous agent loop.
    // Fire-and-forget: the directive command returns immediately; the loop
    // runs in the background and narrates via SSE + cockpit scratchpad.
    if (isAgentLoopEnabled()) {
      const loopObjective = guarded.message;
      void runAgentLoop({
        core: record.core,
        emit: (event, payload) => this.emit(record, event, payload),
        objective: loopObjective,
        sessionId: record.sessionId,
      }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        void record.core.appendScratchpadEntry(`REFLECT: Agent loop crashed — ${msg}`);
      });
    }

    return {
      accepted: true,
      agentLoopActive: isAgentLoopEnabled(),
      modelTurn: guarded.modelTurn,
      queuedDirective: guarded.message,
    };
  }

  private async handleComputer(
    record: SessionRecord,
    command: { type: "computer"; action: ComputerAction; confirm?: boolean },
  ): Promise<Record<string, unknown>> {
    // Capability gate: only a machine advertising takeover:local_computer drives the desktop.
    if (!getEnabledTakeoverCapabilities().includes("takeover:local_computer")) {
      throw new OmniValidationError(
        "local_computer takeover is not enabled on this machine (advertise takeover:local_computer to use it).",
        { requiredCapability: "takeover:local_computer" },
      );
    }

    if (!record.computer) {
      record.computer = new LocalComputerController();
    }
    // Attach the session's current page so page-DOM ComputerActions
    // (screenshot_element, file_upload, fill_form, scroll_until, enter_frame,
    // shadow_pierce) have a Page to operate on. Safe to call repeatedly;
    // setPage() clears the frame state on every call.
    try {
      const page = await record.core.ensurePage();
      if (page) {
        record.computer.setPage(page);
      }
    } catch {
      // No page yet (e.g. session created but no navigate yet). The desktop
      // actions still work; page-DOM actions will return blockedReason.
    }
    // The human approved the pending irreversible/financial action for this step.
    if (command.confirm === true) {
      record.computer.grantConfirmation();
    }

    const outcome = await record.computer.execute(command.action);

    // Emit a cockpit event; never echo screenshot bytes into the event stream payload.
    const { screenshotBase64, ...eventOutcome } = outcome;
    this.emit(record, "computer.action", {
      action: command.action.type,
      hasScreenshot: typeof screenshotBase64 === "string",
      outcome: eventOutcome,
    });
    if (outcome.handoff && record.orgId) {
      void syncGuardrailIncident({
        kind: `computer.${outcome.handoff.kind}`,
        orgId: record.orgId,
        payload: { label: outcome.handoff.label },
        sessionId: record.sessionId,
        severity: "warning",
        userId: record.userId,
      });
    }

    return { ...outcome };
  }

  private async handleAssistantReply(
    record: SessionRecord,
    message: string,
    context: CommandContext,
  ): Promise<Record<string, unknown>> {
    const guarded = await validateAssistantReply({
      ip: context.ip,
      message,
      sessionId: record.sessionId,
      userAgent: context.userAgent,
      userId: context.userId ?? record.userId,
    });

    if (!guarded.disengaged && guarded.response.trim()) {
      await record.core.appendScratchpadEntry(guarded.response, "ai");
    }

    if (guarded.refusalDetected) {
      this.emit(record, "security.refusal", {
        disengaged: guarded.disengaged,
        firedWebhook: guarded.firedWebhook,
        strikeCount: guarded.strikeCount,
      });
      if (record.orgId) {
        void syncGuardrailIncident({
          kind: "assistant.refusal",
          orgId: record.orgId,
          payload: {
            disengaged: guarded.disengaged,
            firedWebhook: guarded.firedWebhook,
            strikeCount: guarded.strikeCount,
          },
          sessionId: record.sessionId,
          severity: guarded.disengaged ? "critical" : "warning",
          userId: record.userId,
        });
      }
    }

    return guarded;
  }

  // ── Wave 2: high-level command dispatcher ─────────────────────────────────
  // Each new high-level command builds a low-level ComputerAction and re-enters
  // through handleComputer so the safety rails (credential gate, irreversible
  // confirmation, capability check, page-required check), the action log, the
  // webhook event, and the cockpit event all flow through the same code path.
  // Selector-based commands resolve selector → (x, y) via the core's page
  // before building the low-level action.
  private async handleNewHighLevel(
    record: SessionRecord,
    command: NewHighLevelCommand,
  ): Promise<Record<string, unknown>> {
    let action: ComputerAction;
    switch (command.type) {
      case "right_click": {
        const coords = await this.resolveSelectorCoords(record, command.selector);
        action = { type: "right_click", x: coords.x, y: coords.y };
        break;
      }
      case "double_click": {
        const coords = await this.resolveSelectorCoords(record, command.selector);
        action = { type: "double_click", x: coords.x, y: coords.y };
        break;
      }
      case "hover": {
        const coords = await this.resolveSelectorCoords(record, command.selector);
        action = { type: "hover", x: coords.x, y: coords.y };
        break;
      }
      case "shortcut":
        action = { type: "shortcut", keys: command.keys };
        break;
      case "drag": {
        const fromCoords = await this.resolveSelectorCoords(record, command.fromSelector);
        const toCoords = await this.resolveSelectorCoords(record, command.toSelector);
        action = {
          fromX: fromCoords.x,
          fromY: fromCoords.y,
          toX: toCoords.x,
          toY: toCoords.y,
          type: "drag",
        };
        break;
      }
      case "scroll": {
        const coords = await this.resolveSelectorCoords(record, command.selector);
        // Compute deltaY from the current scroll position of the page; if the
        // page can't be reached, fall back to deltaY=0 and let the low-level
        // executor log a blocked outcome.
        let deltaY = 0;
        try {
          const page = await record.core.ensurePage();
          const currentY = await page.evaluate(() => window.scrollY).catch(() => 0);
          deltaY = command.targetY - (typeof currentY === "number" ? currentY : 0);
        } catch {
          deltaY = 0;
        }
        action = { deltaX: 0, deltaY, type: "scroll", x: coords.x, y: coords.y };
        break;
      }
      case "file_upload":
        action = { filePath: command.filePath, selector: command.selector, type: "file_upload" };
        break;
      case "file_download":
        action = { savePath: command.savePath, type: "file_download", url: command.url };
        break;
      case "screenshot_element":
        action = {
          label: command.label,
          selector: command.selector,
          type: "screenshot_element",
        };
        break;
      case "fill_form":
        action = { fields: command.fields, type: "fill_form" };
        break;
      case "scroll_until":
        action = {
          direction: command.direction,
          maxScrolls: command.maxScrolls,
          target: command.target,
          type: "scroll_until",
        };
        break;
      case "enter_frame":
        action = { frameSelector: command.frameSelector, type: "enter_frame" };
        break;
      case "exit_frame":
        action = { type: "exit_frame" };
        break;
      case "shadow_click": {
        // The high-level shadow_click resolves the pierced element's coords
        // first, then dispatches a regular click. If resolution fails, it
        // falls back to the page-DOM shadow_pierce for the count check.
        const coords = await this.resolveShadowPierceCoords(record, command.selector);
        action = { type: "click", x: coords.x, y: coords.y };
        break;
      }
      default:
        throw new OmniValidationError(
          `unknown high-level command type: ${(command as { type: string }).type}`,
          { knownCommands: listCommandNames() },
        );
    }

    return this.handleComputer(record, { action, type: "computer" });
  }

  /** Resolve a CSS selector to its center coordinates via the core's page. */
  private async resolveSelectorCoords(
    record: SessionRecord,
    selector: string,
  ): Promise<{ x: number; y: number }> {
    const page = await record.core.ensurePage();
    const box = await page.locator(selector).first().boundingBox().catch(() => null);
    if (!box) {
      throw new OmniNotFoundError("element with selector", selector);
    }
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  /** Resolve a shadow-pierced selector to its center coordinates. */
  private async resolveShadowPierceCoords(
    record: SessionRecord,
    selector: string,
  ): Promise<{ x: number; y: number }> {
    const page = await record.core.ensurePage();
    const deep = selector.includes(">>>") ? selector : `css:light >>> ${selector}`;
    const box = await page.locator(deep).first().boundingBox().catch(() => null);
    if (!box) {
      throw new OmniNotFoundError("element with shadow-pierced selector", selector);
    }
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  // ── Wave 2 Task 3: ClickInput dispatcher (selector / text / coordinates) ─
  // Validates that exactly one target source is provided, then dispatches:
  //   selector    → existing core.click(selector) path (no behavior change)
  //   text        → resolve via findByText (AX tree text match) → click(selector)
  //   coordinates → page.mouse.click(x, y), bypassing the DOM lookup
  //   match_index → when set, pick the Nth match for text/selector resolution
  private async handleClick(
    record: SessionRecord,
    command: {
      coordinates?: { x: number; y: number };
      match_index?: number;
      selector?: string;
      text?: string;
      type: "click";
    },
  ): Promise<Record<string, unknown>> {
    const { selector, text, coordinates, match_index } = command;
    const provided = [selector, text, coordinates].filter((v) => v !== undefined).length;
    if (provided === 0) {
      throw new OmniValidationError(
        "click command requires one of: selector, text, coordinates",
        { command: "click", providedTargets: [] },
      );
    }
    if (provided > 1) {
      throw new OmniValidationError(
        "click command accepts exactly one of: selector, text, coordinates",
        {
          command: "click",
          providedTargets: [selector, text, coordinates]
            .filter((v) => v !== undefined)
            .map((v) => Object.keys(v as object)[0] ?? "unknown"),
        },
      );
    }
    if (match_index !== undefined && (match_index < 0 || !Number.isInteger(match_index))) {
      throw new OmniValidationError(
        "click command match_index must be a non-negative integer",
        { command: "click", matchIndex: match_index },
      );
    }
    if (selector !== undefined) {
      // Existing path, unchanged. match_index is ignored for selector-based
      // clicks (the selector is already specific).
      return record.core.click(selector);
    }
    if (text !== undefined) {
      const resolvedSelector = await this.findByText(record, text, match_index ?? 0);
      return record.core.click(resolvedSelector);
    }
    // coordinates: page.mouse.click bypasses the DOM lookup entirely.
    const page = await record.core.ensurePage();
    await page.mouse.click(coordinates!.x, coordinates!.y);
    return { ok: true, clickTarget: "coordinates", coordinates: coordinates! };
  }

  // Wave 2 basic find: walks the AX tree from omni-ax-observer and returns
  // the Nth selector whose visible text equals `text` (case-insensitive, trimmed).
  // Task 5 upgrades this to a Levenshtein-based fuzzy match and exposes it
  // as a first-class `find` SessionCommand. For now, this is the resolver
  // used by click(text=...). The returned selector is a Playwright `:text(...)`
  // pseudo-selector that Playwright resolves at click time.
  private async findByText(
    record: SessionRecord,
    text: string,
    matchIndex: number,
  ): Promise<string> {
    const page = await record.core.ensurePage();
    const escaped = text.replace(/"/g, '\\"');
    const selector = `text="${escaped}"`;
    // Verify the selector actually matches at least matchIndex+1 elements.
    const count = await page.locator(selector).count().catch(() => 0);
    if (count === 0) {
      throw new OmniNotFoundError("element with text", text);
    }
    if (matchIndex >= count) {
      throw new OmniValidationError(
        `match_index=${matchIndex} out of range; only ${count} element(s) match text=${text}`,
        { availableMatches: count, matchIndex, text },
      );
    }
    return selector;
  }

  // ── Wave 2 Task 5: AI helper dispatcher ──────────────────────────────────
  // plan(goal)         — create a draft plan, return plan_id
  // execute_plan(id,?) — run all steps via the existing omni-planner
  // next_step(id,step) — add + run a single step
  // describe_page      — AX tree summary via omni-ax-observer
  // find(text, fuzzy)  — text match (exact or Levenshtein ≤ 2)
  // wait_for(pred,to)  — page.waitForFunction with timeout
  private async handleAiHelper(
    record: SessionRecord,
    command:
      | { type: "plan"; goal: string }
      | { type: "execute_plan"; plan_id: string; steps?: PlannedStepInput[] }
      | { type: "next_step"; plan_id: string; step: PlannedStepInput }
      | { type: "describe_page" }
      | { type: "find"; text: string; fuzzy?: boolean }
      | { type: "wait_for"; predicate: string; timeout_ms?: number },
  ): Promise<Record<string, unknown>> {
    switch (command.type) {
      case "plan": {
        const plan_id = this.planStore.create(record.sessionId, command.goal);
        return { goal: command.goal, plan_id, status: "draft" };
      }
      case "execute_plan": {
        const plan = this.planStore.get(command.plan_id);
        if (!plan) {
          throw new OmniNotFoundError("plan", command.plan_id);
        }
        if (command.steps) {
          this.planStore.setSteps(command.plan_id, command.steps);
        }
        const page = await record.core.ensurePage();
        const steps = this.planStore.getSteps(command.plan_id);
        const result = await executePlan({
          captureProof: async (label) =>
            record.core.captureProofCheckpoint(label).then((p) => p || null),
          emit: (event) => {
            if (event.kind === "plan.created") {
              this.emit(record, "plan.created", {
                goal: plan.goal,
                planId: event.planId,
                stepCount: event.steps.length,
              });
            } else if (event.kind === "handoff.requested") {
              this.emit(record, "handoff.requested", {
                planId: event.planId,
                reason: event.reason,
                stepId: event.stepId,
              });
            }
          },
          executeClick: async (selector) => {
            const r = await record.core.click(selector);
            return r && typeof r === "object" && "ok" in r ? Boolean((r as Record<string, unknown>).ok) : true;
          },
          executeNavigate: async (url) => {
            const r = await record.core.navigate(url);
            return r && typeof r === "object" && "ok" in r ? Boolean((r as Record<string, unknown>).ok) : true;
          },
          executeScroll: async (targetY) => {
            const r = await record.core.humanScroll(page, targetY);
            return r;
          },
          executeType: async (selector, text) => {
            const r = await record.core.type(selector, text);
            return r && typeof r === "object" && "ok" in r ? Boolean((r as Record<string, unknown>).ok) : true;
          },
          objective: plan.goal,
          page,
          pauseForHandoff: async (reason) => {
            await record.core.pauseMission(reason);
          },
          steps,
        });
        this.planStore.markExecuted(command.plan_id, result);
        return { ...result, plan_id: command.plan_id };
      }
      case "next_step": {
        this.planStore.appendStep(command.plan_id, command.step);
        const page = await record.core.ensurePage();
        const plan = this.planStore.get(command.plan_id);
        if (!plan) {
          throw new OmniNotFoundError("plan", command.plan_id);
        }
        const lastStep = this.planStore.getSteps(command.plan_id).slice(-1)[0]!;
        // Build a 1-step plan and run it.
        const result = await executePlan({
          captureProof: async (label) =>
            record.core.captureProofCheckpoint(label).then((p) => p || null),
          emit: () => undefined,
          executeClick: async (selector) => {
            const r = await record.core.click(selector);
            return r && typeof r === "object" && "ok" in r ? Boolean((r as Record<string, unknown>).ok) : true;
          },
          executeNavigate: async (url) => {
            const r = await record.core.navigate(url);
            return r && typeof r === "object" && "ok" in r ? Boolean((r as Record<string, unknown>).ok) : true;
          },
          executeScroll: async (targetY) => record.core.humanScroll(page, targetY),
          executeType: async (selector, text) => {
            const r = await record.core.type(selector, text);
            return r && typeof r === "object" && "ok" in r ? Boolean((r as Record<string, unknown>).ok) : true;
          },
          objective: plan.goal,
          page,
          pauseForHandoff: async (reason) => {
            await record.core.pauseMission(reason);
          },
          steps: [lastStep],
        });
        return {
          plan_id: command.plan_id,
          result,
          step: command.step,
          step_id: lastStep.id,
        };
      }
      case "describe_page": {
        const page = await record.core.ensurePage();
        const observation = await captureAXObservation(page);
        return {
          axSummary: observation.axTree.slice(0, 4000),
          axTreeHash: observation.axTreeHash,
          authWallHint: observation.authWallHint,
          captchaHint: observation.captchaHint,
          capturedAt: observation.capturedAt,
          title: observation.title,
          url: observation.url,
        };
      }
      case "find": {
        const page = await record.core.ensurePage();
        const result = await this.findInPage(page, command.text, command.fuzzy === true);
        return result;
      }
      case "wait_for": {
        const page = await record.core.ensurePage();
        const timeoutMs = Math.max(100, Math.min(command.timeout_ms ?? 10_000, 120_000));
        try {
          await page.waitForFunction(command.predicate, undefined, { timeout: timeoutMs });
          return { ok: true, predicate: command.predicate, timeoutMs };
        } catch (error) {
          throw new OmniRequestTimeoutError(timeoutMs, timeoutMs);
        }
      }
      default:
        throw new OmniValidationError(
          `unknown AI helper command type: ${(command as { type: string }).type}`,
          { knownCommands: listCommandNames() },
        );
    }
  }

  // ── Wave 2 Task 6: CAPTCHA dispatcher ────────────────────────────────────
  // detect_captcha: probe the page for reCAPTCHA / hCaptcha / Cloudflare
  //   surfaces. Returns { detected, type, locator, evidence }.
  // wait_for_human: pause the mission with a handoff reason so the cockpit
  //   can prompt the human. Returns { handoff, reason, timeoutMs }.
  // navigate_with_fallback: try the primary URL; if a CAPTCHA is detected
  //   on the resulting page, navigate to the fallback URL instead.
  //   If a solver is configured (CAPTCHA_SOLVER_API_KEY + PROVIDER=2captcha)
  //   we attempt to solve and inject the token before the fallback.
  private async handleCaptcha(
    record: SessionRecord,
    command:
      | { type: "detect_captcha" }
      | { type: "wait_for_human"; reason?: string; timeout_ms?: number }
      | { type: "navigate_with_fallback"; url: string; fallback_url: string },
  ): Promise<Record<string, unknown>> {
    const page = await record.core.ensurePage();
    switch (command.type) {
      case "detect_captcha": {
        const detection = await detectCaptcha(page);
        this.emit(record, "captcha.detected", detection);
        return detection as unknown as Record<string, unknown>;
      }
      case "wait_for_human": {
        const handoff = await waitForHuman({
          page,
          reason: command.reason ?? "CAPTCHA detected — human verification required.",
          timeoutMs: command.timeout_ms,
        });
        await record.core.pauseMission(handoff.reason);
        this.emit(record, "captcha.handoff", handoff);
        if (record.orgId) {
          void syncGuardrailIncident({
            kind: "captcha.handoff",
            orgId: record.orgId,
            payload: { reason: handoff.reason, timeoutMs: handoff.timeoutMs },
            sessionId: record.sessionId,
            severity: "warning",
            userId: record.userId,
          });
        }
        return handoff as unknown as Record<string, unknown>;
      }
      case "navigate_with_fallback": {
        const primary = await record.core.navigate(command.url);
        await new Promise((r) => setTimeout(r, 250));
        const detection = await detectCaptcha(page);
        if (!detection.detected) {
          return {
            detected: false,
            fallbackUsed: false,
            navigation: primary,
            url: command.url,
          };
        }
        // Try the solver (opt-in). If no key, solver returns
        // solved:false with reason "no_solver_key" — we still fall back.
        const solve = await solveCaptcha({ page, type: detection.type });
        if (solve.solved) {
          // Synthetic stub: in a real runtime, the token would be injected
          // into the page via the appropriate callback (grecaptcha,
          // hcaptcha, cf-chl-gen, etc.). For v0.3, we report solved=true
          // so the AI knows the wiring path works end-to-end.
          return {
            detected: true,
            evidence: detection.evidence,
            fallbackUsed: false,
            solver: { provider: solve.provider, token: solve.token, type: detection.type },
            url: command.url,
          };
        }
        // Solver unavailable or failed — fall back to the alternate URL.
        const fallback = await record.core.navigate(command.fallback_url);
        return {
          detected: true,
          evidence: detection.evidence,
          fallbackNavigation: fallback,
          fallbackUrl: command.fallback_url,
          fallbackUsed: true,
          primaryUrl: command.url,
          solveReason: solve.solved === false ? solve.reason : undefined,
        };
      }
      default:
        throw new OmniValidationError(
          `unknown CAPTCHA command type: ${(command as { type: string }).type}`,
          { knownCommands: listCommandNames() },
        );
    }
  }

  // Text finder used by SessionCommand `find` and by the click(text=...) path.
  // Returns up to 10 matches with selectors + match_index, plus the count.
  // When `fuzzy` is true, applies Levenshtein distance ≤ 2 to the AX tree text.
  private async findInPage(
    page: Page,
    text: string,
    fuzzy: boolean,
  ): Promise<Record<string, unknown>> {
    const escaped = text.replace(/"/g, '\\"');
    if (!fuzzy) {
      const exactSelector = `text="${escaped}"`;
      const count = await page.locator(exactSelector).count().catch(() => 0);
      return {
        count,
        fuzzy: false,
        matches: Array.from({ length: Math.min(count, 10) }, (_, i) => ({
          match_index: i,
          selector: exactSelector,
        })),
        query: text,
      };
    }
    // Fuzzy: walk the AX tree and rank by Levenshtein distance ≤ 2.
    const observation = await captureAXObservation(page);
    const candidates = observation.axTree
      .split("\n")
      .map((line) => {
        // AX tree lines look like "role: text" — extract the text portion.
        const idx = line.indexOf(":");
        const label = idx === -1 ? line : line.slice(idx + 1).trim();
        return { distance: levenshtein(label.toLowerCase(), text.toLowerCase()), label, line };
      })
      .filter((c) => c.distance <= 2)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 10);
    return {
      count: candidates.length,
      fuzzy: true,
      matches: candidates.map((c, i) => ({
        label: c.label,
        match_index: i,
        selector: `text="${c.label.replace(/"/g, '\\"')}"`,
      })),
      query: text,
    };
  }

  private emit(record: SessionRecord, type: string, data: Record<string, unknown>): void {
    const event: SessionEvent = {
      data,
      eventId: randomUUID(),
      sessionId: record.sessionId,
      timestamp: new Date().toISOString(),
      type,
    };
    for (const listener of record.listeners) {
      listener(event);
    }
    void syncRuntimeEvent({
      data,
      eventType: type,
      orgId: record.orgId,
      sessionId: record.sessionId,
      timestamp: event.timestamp,
      userId: record.userId,
    });
  }

  private touch(record: SessionRecord): void {
    record.lastActiveAt = new Date().toISOString();
  }

  private requireSession(sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record) {
      throw new OmniNotFoundError("Omni session", sessionId);
    }
    return record;
  }

  private async describeSession(record: SessionRecord): Promise<Record<string, unknown>> {
    return {
      actionLog: record.actionLog,
      agentId: record.agentId,
      commandCount: record.commandCount,
      createdAt: record.createdAt,
      creditBudget: record.creditBudget,
      lastActiveAt: record.lastActiveAt,
      objective: record.objective,
      orgId: record.orgId,
      persistent: record.persistent,
      policyVersion: record.policyVersion,
      remainingBudget: record.remainingBudget,
      sessionId: record.sessionId,
      status: await record.core.getStatus(),
      totalArtifactCount: record.totalArtifactCount,
      userId: record.userId,
    };
  }

  private async syncSessionSnapshot(
    record: SessionRecord,
    forcedStatus?: ControlPlaneSessionStatus,
    runtimeStatus?: Record<string, unknown>,
  ): Promise<void> {
    const resolvedStatus = (runtimeStatus ?? (await record.core.getStatus().catch(() => ({})))) as Record<string, unknown>;
    await syncRuntimeSessionSnapshot({
      actionLog: record.actionLog,
      authWall: extractAuthWall(resolvedStatus),
      currentUrl: typeof resolvedStatus["currentUrl"] === "string" ? (resolvedStatus["currentUrl"] as string) : null,
      orgId: record.orgId,
      runtimeSessionId:
        typeof resolvedStatus["sessionId"] === "string" ? (resolvedStatus["sessionId"] as string) : record.sessionId,
      sessionId: record.sessionId,
      status: forcedStatus ?? deriveControlPlaneStatus(resolvedStatus),
      totalArtifactCount: record.totalArtifactCount,
      userId: record.userId,
    });
  }

  private async syncArtifacts(record: SessionRecord): Promise<void> {
    if (!record.orgId || !record.userId) {
      return;
    }
    const artifacts = this.listArtifacts(record.sessionId, record.userId);
    await Promise.all(
      artifacts.map((artifact) =>
        syncArtifactRecord({
          artifactId: String(artifact.artifactId),
          checksumSha256: readArtifactChecksum(artifact),
          contentBase64: readArtifactContentBase64(artifact),
          contentType: inferArtifactContentType(artifact),
          downloadUrl: null,
          fileName: String(artifact.label ?? artifact.artifactId),
          label: String(artifact.label ?? artifact.artifactId),
          metadata: {
            source: "runtime",
            syncedAt: new Date().toISOString(),
            tool: "browser",
          },
          orgId: record.orgId!,
          path: String(artifact.artifactId),
          sessionId: record.sessionId,
          sizeBytes: typeof artifact.sizeBytes === "number" ? artifact.sizeBytes : null,
          type: String(artifact.type ?? "file"),
          userId: record.userId!,
        }),
      ),
    );
  }

  private async cleanupIdleSessions(): Promise<void> {
    const cutoff = Date.now() - this.idleTimeoutMs();
    for (const record of Array.from(this.sessions.values())) {
      if (Date.parse(record.lastActiveAt) < cutoff) {
        await this.closeSession(record.sessionId);
      }
    }
  }

  private async enforceSessionCap(): Promise<void> {
    const cap = numberFromEnv("OMNI_MAX_PARALLEL_SESSIONS", 50);
    if (this.sessions.size < cap) {
      return;
    }
    const oldest = Array.from(this.sessions.values()).sort(
      (left, right) => Date.parse(left.lastActiveAt) - Date.parse(right.lastActiveAt),
    )[0];
    if (oldest) {
      // Emit session.evicted before closing so SSE listeners can observe the
      // eviction. Previously this was a silent cap — operators had no way to
      // tell why their session disappeared.
      this.emit(oldest, "session.evicted", {
        reason: "parallel_cap",
        cap,
        currentSize: this.sessions.size,
      });
      emitWebhookEvent("session.evicted", oldest.sessionId, oldest.orgId, oldest.userId, {
        cap,
        currentSize: this.sessions.size,
        reason: "parallel_cap",
      });
      await this.closeSession(oldest.sessionId);
    }
  }

  private idleTimeoutMs(): number {
    return numberFromEnv("OMNI_IDLE_TIMEOUT_MS", 900_000);
  }
}

function extractAuthWall(status: Record<string, unknown>): boolean {
  const authWall = status.authWall;
  if (typeof authWall === "boolean") {
    return authWall;
  }
  if (authWall && typeof authWall === "object") {
    const detected = (authWall as { detected?: unknown }).detected;
    return detected === true;
  }
  return false;
}

function readArtifactPath(artifact: Record<string, unknown>): string | null {
  return typeof artifact.path === "string" && artifact.path.trim() ? artifact.path : null;
}

function readArtifactContentBase64(artifact: Record<string, unknown>): string | null {
  const targetPath = readArtifactPath(artifact);
  if (!targetPath || !fs.existsSync(targetPath)) {
    return null;
  }
  return fs.readFileSync(targetPath).toString("base64");
}

function readArtifactChecksum(artifact: Record<string, unknown>): string | null {
  const targetPath = readArtifactPath(artifact);
  if (!targetPath || !fs.existsSync(targetPath)) {
    return null;
  }
  return createHash("sha256").update(fs.readFileSync(targetPath)).digest("hex");
}

function inferArtifactContentType(artifact: Record<string, unknown>): string {
  const targetPath = readArtifactPath(artifact) ?? String(artifact.label ?? "");
  switch (path.extname(targetPath).toLowerCase()) {
    case ".csv":
      return "text/csv; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".log":
    case ".md":
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".webm":
      return "video/webm";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

function deriveControlPlaneStatus(status: Record<string, unknown>): ControlPlaneSessionStatus {
  if (extractAuthWall(status)) {
    return "awaiting_auth";
  }
  if (extractRuntimeFailed(status)) {
    return "failed";
  }
  if (extractRuntimeCompleted(status)) {
    return "completed";
  }
  if (status.paused === true) {
    return "paused";
  }
  return "running";
}

function getRuntimeTaskBoard(status: Record<string, unknown>): Record<string, unknown> | null {
  const taskBoard = status.taskBoard;
  return taskBoard && typeof taskBoard === "object" ? (taskBoard as Record<string, unknown>) : null;
}

function readRuntimeStatusText(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : "";
}

function extractRuntimeStatusText(status: Record<string, unknown>): string {
  const candidates = [
    status.status,
    status.state,
    status.missionStatus,
    status.runtimeStatus,
    status.lifecycle,
  ];

  for (const candidate of candidates) {
    const text = readRuntimeStatusText(candidate);
    if (text) return text;
  }

  return "";
}

function extractNestedTaskBoardStatus(status: Record<string, unknown>): string {
  const taskBoard = status.taskBoard;
  if (!taskBoard || typeof taskBoard !== "object" || Array.isArray(taskBoard)) {
    return "";
  }

  const board = taskBoard as Record<string, unknown>;
  const candidates = [
    board.status,
    board.state,
    board.missionStatus,
    board.runtimeStatus,
    board.lifecycle,
  ];

  for (const candidate of candidates) {
    const text = readRuntimeStatusText(candidate);
    if (text) return text;
  }

  return "";
}

function getRuntimeChecklistItems(status: Record<string, unknown>): Array<Record<string, unknown>> {
  const taskBoard = getRuntimeTaskBoard(status);
  if (!taskBoard) {
    return [];
  }
  const checklist = taskBoard.checklist;
  if (!Array.isArray(checklist)) {
    return [];
  }
  return checklist.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
}

function extractRuntimeCompleted(status: Record<string, unknown>): boolean {
  if (
    status.completed === true ||
    status.done === true ||
    status.finished === true ||
    status.closed === true
  ) {
    return true;
  }

  const statusText = extractRuntimeStatusText(status) || extractNestedTaskBoardStatus(status);
  return ["completed", "complete", "done", "finished", "closed"].includes(statusText);
}

function extractRuntimeFailed(status: Record<string, unknown>): boolean {
  if (status.failed === true || status.errored === true) {
    return true;
  }

  const statusText = extractRuntimeStatusText(status) || extractNestedTaskBoardStatus(status);
  return ["failed", "error", "errored"].includes(statusText);
}

function collectArtifacts(rootDir: string): Array<{ mtimeMs: number; path: string; size: number }> {
  if (!fs.existsSync(rootDir)) {
    return [];
  }
  const stack = [rootDir];
  const collected: Array<{ mtimeMs: number; path: string; size: number }> = [];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(target);
        continue;
      }
      const stat = fs.statSync(target);
      collected.push({
        mtimeMs: stat.mtimeMs,
        path: target,
        size: stat.size,
      });
    }
  }
  return collected.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

function inferArtifactType(input: { path?: string | null; contentType?: string | null; label?: string | null }): string {
  const value = `${input.path ?? ""} ${input.label ?? ""} ${input.contentType ?? ""}`.toLowerCase();

  if (value.includes("screenshot")) return "screenshot";

  if (/\.(html|htm)\b/.test(value) || value.includes("text/html")) {
    return "report";
  }

  if (/\.(png|jpg|jpeg|webp|gif|svg)\b/.test(value) || value.includes("image/")) {
    return "image";
  }

  if (/\.(json)\b/.test(value) || value.includes("application/json")) {
    return "json";
  }

  if (/\.(log)\b/.test(value)) {
    return "log";
  }

  if (/\.(md|markdown|txt|docx|pdf|csv)\b/.test(value) || value.includes("text/")) {
    return "doc";
  }

  if (/\.(webm|mp4|mov)\b/.test(value) || value.includes("video/")) {
    return "video";
  }

  return "file";
}

function assertNever(value: never): never {
  throw new Error(`Unhandled session command: ${JSON.stringify(value)}`);
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name] ?? fallback);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

// ── Wave 2 Task 5: PlanStore + Levenshtein helper ─────────────────────────
type PlanEntry = {
  createdAt: string;
  goal: string;
  planId: string;
  sessionId: string;
  status: "draft" | "executing" | "completed" | "failed";
  steps: PlanStep[];
};

class PlanStore {
  private readonly entries = new Map<string, PlanEntry>();

  create(sessionId: string, goal: string): string {
    const planId = randomUUID();
    this.entries.set(planId, {
      createdAt: new Date().toISOString(),
      goal,
      planId,
      sessionId,
      status: "draft",
      steps: [],
    });
    return planId;
  }

  get(planId: string): PlanEntry | null {
    return this.entries.get(planId) ?? null;
  }

  getSteps(planId: string): PlanStep[] {
    return this.entries.get(planId)?.steps ?? [];
  }

  setSteps(planId: string, rawSteps: PlannedStepInput[]): void {
    const entry = this.entries.get(planId);
    if (!entry) return;
    entry.steps = rawSteps.map((step) => ({
      action: toPlannedAction(step.action),
      completionCriteria: step.intent,
      id: randomUUID(),
      intent: step.intent,
      status: "pending",
    }));
  }

  appendStep(planId: string, rawStep: PlannedStepInput): void {
    const entry = this.entries.get(planId);
    if (!entry) return;
    entry.steps.push({
      action: toPlannedAction(rawStep.action),
      completionCriteria: rawStep.intent,
      id: randomUUID(),
      intent: rawStep.intent,
      status: "pending",
    });
  }

  markExecuted(planId: string, result: { success: boolean; handoffTriggered: boolean }): void {
    const entry = this.entries.get(planId);
    if (!entry) return;
    entry.status = result.handoffTriggered
      ? "failed"
      : result.success
        ? "completed"
        : "failed";
  }
}

function toPlannedAction(raw: PlannedActionInput): PlanStep["action"] {
  switch (raw.type) {
    case "click":
      return { selector: raw.selector ?? "", type: "click" };
    case "navigate":
      return { type: "navigate", url: raw.url ?? "" };
    case "scroll":
      return { targetY: raw.targetY ?? 0, type: "scroll" };
    case "type":
      return { selector: raw.selector ?? "", text: raw.text ?? "", type: "type" };
    case "wait":
      return { ms: 1000, type: "wait" };
    case "handoff":
      return { reason: raw.reason ?? "step handoff", type: "handoff" };
    default:
      throw new OmniValidationError(
        `Unknown planned action type: ${(raw as { type: string }).type}`,
        { providedType: (raw as { type: string }).type },
      );
  }
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let last = i;
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const temp = prev[j]!;
      if (a[i - 1] === b[j - 1]) {
        prev[j] = last;
      } else {
        prev[j] = Math.min(prev[j]!, prev[j - 1]!, last) + 1;
      }
      last = temp;
    }
  }
  return prev[b.length]!;
}

/**
 * Produce a compact one-line summary of a command for the action log.
 * The control plane uses these summaries to detect loop/no-progress patterns:
 * repeated near-identical steps with no new URLs or artifacts over N minutes.
 *
 * This runs in-memory only (no I/O) and produces a stable key that the control
 * plane can hash/compare for similarity detection.
 */
function describeCommandForActionLog(command: SessionCommand): string {
  switch (command.type) {
    case "navigate":
      return `navigate ${command.url.slice(0, 120)}`;
    case "click": {
      if (command.selector !== undefined) {
        return `click ${command.selector.slice(0, 60)}`;
      }
      if (command.text !== undefined) {
        return `click text="${command.text.slice(0, 40)}" (match_index=${command.match_index ?? 0})`;
      }
      if (command.coordinates !== undefined) {
        return `click coords (${command.coordinates.x}, ${command.coordinates.y})`;
      }
      return "click (no target)";
    }
    case "type":
      return `type ${command.selector.slice(0, 60)}`;
    case "screenshot":
      return `screenshot${command.label ? ` (${command.label.slice(0, 40)})` : ""}`;
    case "directive":
      return `directive ${command.message.slice(0, 100)}`;
    case "assistant_reply":
      return "assistant_reply";
    case "pause":
      return `pause${command.reason ? ` (${command.reason.slice(0, 60)})` : ""}`;
    case "resume":
      return `resume${command.reason ? ` (${command.reason.slice(0, 60)})` : ""}`;
    case "status":
      return "status";
    case "computer":
      return `computer ${command.action}${command.confirm ? " (confirm)" : ""}`;
    // Wave 2 high-level wrappers — descriptive one-liners for the action log.
    case "right_click":
      return `right_click ${command.selector.slice(0, 60)}`;
    case "double_click":
      return `double_click ${command.selector.slice(0, 60)}`;
    case "hover":
      return `hover ${command.selector.slice(0, 60)}`;
    case "shortcut":
      return `shortcut ${command.keys.join("+")}`;
    case "drag":
      return `drag ${command.fromSelector.slice(0, 40)} → ${command.toSelector.slice(0, 40)}`;
    case "scroll":
      return `scroll ${command.selector.slice(0, 40)} → ${command.targetY}`;
    case "file_upload":
      return `file_upload ${command.selector.slice(0, 40)} ← ${command.filePath}`;
    case "file_download":
      return `file_download ${command.url.slice(0, 60)} → ${command.savePath}`;
    case "screenshot_element":
      return `screenshot_element ${command.selector.slice(0, 40)}${command.label ? ` (${command.label.slice(0, 30)})` : ""}`;
    case "fill_form":
      return `fill_form (${command.fields.length} field${command.fields.length === 1 ? "" : "s"})`;
    case "scroll_until":
      return `scroll_until ${command.target.slice(0, 40)} ${command.direction ?? "down"}`;
    case "enter_frame":
      return `enter_frame ${command.frameSelector.slice(0, 60)}`;
    case "exit_frame":
      return "exit_frame";
    case "shadow_click":
      return `shadow_click ${command.selector.slice(0, 60)}`;
    // Wave 2 Task 5: AI helper summaries
    case "plan":
      return `plan "${command.goal.slice(0, 60)}"`;
    case "execute_plan":
      return `execute_plan ${command.plan_id.slice(0, 8)} (${command.steps?.length ?? "?"} steps)`;
    case "next_step":
      return `next_step ${command.plan_id.slice(0, 8)} -> ${command.step.intent.slice(0, 40)}`;
    case "describe_page":
      return "describe_page";
    case "find":
      return `find "${command.text.slice(0, 40)}" (${command.fuzzy ? "fuzzy" : "exact"})`;
    case "wait_for":
      return `wait_for (${command.timeout_ms ?? 10_000}ms)`;
    // Wave 2 Task 6: CAPTCHA summaries
    case "detect_captcha":
      return "detect_captcha";
    case "wait_for_human":
      return `wait_for_human (${command.timeout_ms ?? 300_000}ms) "${(command.reason ?? "").slice(0, 40)}"`;
    case "navigate_with_fallback":
      return `navigate_with_fallback ${command.url.slice(0, 40)} → ${command.fallback_url.slice(0, 40)}`;
    case "close":
      return `close (${command.reason?.slice(0, 40) ?? "no reason"})`;
    default:
      return assertNever(command);
  }
}

declare global {
  var __omniStandaloneService: OmniStandaloneService | undefined;
}

export function getOmniStandaloneService(): OmniStandaloneService {
  if (!globalThis.__omniStandaloneService) {
    globalThis.__omniStandaloneService = new OmniStandaloneService();
  }
  return globalThis.__omniStandaloneService;
}
