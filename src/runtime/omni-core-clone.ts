import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  extractSemanticPage,
  humanClick,
  humanClickPixel,
  humanDelay,
  humanDrag,
  humanMoveMouse,
  humanPressCombo,
  humanScroll,
  humanType,
  waitForNavigation,
  type OmniTelemetryEmitter,
} from "./human-rhythm.js";
import { OmniSessionManager, type OmniSession } from "./omni-session-manager.js";
import { ProofCapture } from "./proof-capture.js";
import {
  createScratchpadExportBundle as buildScratchpadExportBundle,
  processScratchpadFiles as runScratchpadFileProcessing,
  transcribeScratchpadAudio as runScratchpadAudioTranscription,
  type OmniScratchpadFileInput,
  type OmniScratchpadFileResult,
} from "./omni-scratchpad-runtime.js";
import {
  sanitizeSelector,
  sanitizeText,
  validateUrl,
  SanitizationError,
} from "./sanitizer.js";
import {
  atomicWriteFile,
  OmniSessionPersistence,
  type OmniRuntimeProfileSnapshot,
  type OmniScratchpadTab,
  type OmniTaskBoardSnapshot,
  type OmniTaskBriefSnapshot,
  type OmniTaskChecklistItem,
  type OmniTaskTimelineEntry,
  type OmniWarmResumeState,
} from "./session-persistence.js";
import { OmniPayloadCrypto } from "./payload-crypto.js";
import { forceInjectOmniUi } from "./omni-ui-layer.js";
import type { Browser, BrowserContext, Page, Response as PlaywrightResponse } from "playwright";
import { sanitizeProtectedRuntimeText, sanitizeProtectedRuntimeValue } from "../security/trade-secret-guard.js";
import { captureAXObservation } from "./omni-ax-observer.js";
import { capturePreActionContext, verifyAction } from "./omni-verifier.js";
import { loadVaultEntry, saveVaultEntry } from "../utils/local-vault.js";
import { getBrowserSessionDir, getMissionLogsDir, getBrowserRecordsRoot } from "../utils/omni-paths.js";
import {
  rankTargetCandidates,
  verifyTypeAction,
  captureScreenshotFallback,
  MIN_CLICK_CONFIDENCE,
} from "./omni-selector-ranker.js";
import {
  MissionMemory,
  createMissionCheckpoint,
  buildRecoveryNote,
  verifyResumeState,
} from "./omni-checkpoint.js";
import { createReplayBundle } from "./omni-replay-bundle.js";

export interface MissionLogEntry {
  action: string;
  detail: string;
  status: "error" | "recovery" | "success";
  timestamp: string;
}

export interface OmniNavigateOutcome {
  errors: string[];
  finalUrl: string;
  httpStatus: number | null;
  success: boolean;
}

export interface OmniAuthWallSignal {
  confidence: "high" | "low" | "medium";
  detected: boolean;
  hints: string[];
  url: string;
}

interface OmniHudDiagnostics {
  activePageAttr: string | null;
  badgePresent: boolean;
  controlClusterPresent: boolean;
  hasShadowRoot: boolean;
  hostPresent: boolean;
  keyboardShellPresent: boolean;
  mandatorySurfacesPresent: boolean;
  mousePresent: boolean;
  nleInjectUiDefined: boolean;
  scratchpadPresent: boolean;
}

interface OmniControlState {
  badgeVisible: boolean;
  controlPanelVisible: boolean;
  executing: boolean;
  humanControl: boolean;
  paused: boolean;
  pendingHumanMessages: number;
  runtimeProfile: OmniRuntimeProfileSnapshot;
  scratchpadActiveTab: OmniScratchpadTab;
  scratchpadWindowState: ScratchpadWindowState;
  sessionId: string | null;
  sessionSecret: string | null;
  taskBoard: OmniTaskBoardSnapshot;
}

interface ScratchpadEntry {
  text: string;
  timestamp: string;
  type: "ai" | "human";
}

type ScratchpadWindowState = "closed" | "fullscreen" | "minimized" | "open";

type TaskProgressSignal =
  | "browser_launch"
  | "mission_end"
  | "mission_start"
  | "proof_ready"
  | "surface_ready";

type TelemetrySink = (event: string, payload: Record<string, unknown>) => void;

export class OmniCoreClone {
  browser: Browser | null = null;
  context: BrowserContext | null = null;
  currentPage: Page | null = null;
  private activeUserId: string | null = null;
  headless = false;

  private consecutiveFailures = 0;
  private handoffRequestCounter = 0;
  private currentSession: OmniSession | null = null;
  private errorScreenshotCounter = 0;
  private executionDepth = 0;
  private humanMessageHandlers: Array<(message: string) => void> = [];
  private humanMessageQueue: string[] = [];
  private isHumanActive = false;
  private isPaused = false;
  private sessionSecret = "";
  private maxConsecutiveFailures = 3;
  private memoryCleanupInterval: ReturnType<typeof setInterval> | null = null;
  private missionLog: MissionLogEntry[] = [];
  private missionLogPath = "";
  private pausedPromiseResolve: ((context: { url: string }) => void) | null = null;
  private readonly proofCapture: ProofCapture;
  private badgeVisible = true;
  private controlPanelVisible = true;
  private runtimeProfile: OmniRuntimeProfileSnapshot = {
    continuityMode: "warm-state",
    heartbeatAt: null,
    persistent: false,
    provider: "standalone-runtime",
    operatorSessionId: null,
  };
  private scratchpadActiveTab: OmniScratchpadTab = "live";
  private scratchpadWindowState: ScratchpadWindowState = "open";
  private scratchpadHistory: ScratchpadEntry[] = [];
  private taskBoard: OmniTaskBoardSnapshot = {
    activeTab: "live",
    brief: null,
    checklist: [],
    objective: null,
    timeline: [],
  };
  private readonly sessionManager: OmniSessionManager;
  private readonly payloadCrypto = new OmniPayloadCrypto();
  private readonly sessionPersistence: OmniSessionPersistence;
  private telemetrySink: TelemetrySink | null = null;
  private watchdogInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private checkpointInterval: ReturnType<typeof setInterval> | null = null;
  private persistenceAgentId: string | null = null;
  private checkpointInFlight = false;
  private lastCheckpointAt: string | null = null;
  // P1+P2: Mission memory — runtime-local, not persisted to DB
  private missionMemory = new MissionMemory();
  // P1+P2: Current plan ID for stable checkpoint/bundle IDs
  private currentPlanId = "";
  // P1+P2: Current step counter for checkpoint IDs
  private currentStepNumber = 0;
  // P1+P2: Accumulated proof artifact IDs for this mission
  private missionProofArtifactIds: string[] = [];

  constructor(input: {
    proofCapture?: ProofCapture;
    sessionManager?: OmniSessionManager;
    sessionPersistence?: OmniSessionPersistence;
  } = {}) {
    this.proofCapture = input.proofCapture ?? new ProofCapture();
    this.sessionManager = input.sessionManager ?? new OmniSessionManager();
    this.sessionPersistence = input.sessionPersistence ?? new OmniSessionPersistence();
  }

  setTelemetrySink(sink: TelemetrySink | null): void {
    this.telemetrySink = sink;
  }

  getProofCapture(): ProofCapture {
    return this.proofCapture;
  }

  getActiveSessionId(): string | null {
    return this.currentSession?.sessionId ?? null;
  }

  setUserScope(userId?: string | null): void {
    this.activeUserId = userId?.trim() || null;
  }

  async ensureSession(): Promise<string> {
    if (!this.context || !this.currentSession) {
      const sessionId = `omni-clone-${Date.now()}`;
      const userDataDir = getBrowserSessionDir(sessionId, this.activeUserId ?? undefined);
      await this.initVault(userDataDir, this.activeUserId);
    }
    return this.currentSession!.sessionId;
  }

  async initVault(userDataDir: string, userId?: string | null): Promise<BrowserContext> {
    this.headless = false;
    this.activeUserId = userId?.trim() || this.inferUserScopeFromVaultDir(userDataDir);

    const sessionId = path.basename(path.resolve(userDataDir)) || `omni-clone-${Date.now()}`;
    // Per-session random authorization secret for nle_takeover (in-memory only, never persisted).
    this.sessionSecret = randomBytes(32).toString("hex");
    this.currentSession = await this.sessionManager.createSession({
      sessionId,
      userDataDir,
      userId: this.activeUserId,
    });
    this.browser = this.currentSession.browser;
    this.context = this.currentSession.context;
    this.currentPage = this.currentSession.currentPage;

    await this.registerControlCallbacks();
    this.logAction(
      "BROWSER_LAUNCH",
      "success",
      `Chrome launched with ${this.currentSession.launchStrategy} and isolated session ${this.currentSession.sessionId}`,
    );

    await this.restoreFromCheckpoint(sessionId);
    this.startRuntimePersistence({ agentId: this.persistenceAgentId ?? sessionId });

    return this.context;
  }

  async openPage(): Promise<Page> {
    await this.ensureSession();
    this.currentPage = await this.sessionManager.openPage(this.currentSession!.sessionId);
    // UI injected via addInitScript in registerOmniUiLayer (authoritative path)
    this.sessionManager.markActive(this.currentSession!.sessionId, this.currentPage);
    await this.replayScratchpadHistory(this.currentPage);
    await this.syncControlState();
    return this.currentPage;
  }

  async injectSetOfMark(page: Page): Promise<Record<number, unknown>> {
    return page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll('button, a, input, [role="button"]'));
      const mapping: Record<number, unknown> = {};

      elements.forEach((el, index) => {
        const id = index + 1;
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.left >= 0) {
          mapping[id] = {
            tag: el.tagName,
            text:
              (el as HTMLElement).innerText?.trim().substring(0, 30) ||
              (el as HTMLInputElement).value ||
              (el as HTMLInputElement).placeholder ||
              "",
            x: rect.x,
            y: rect.y,
          };
        }
      });

      return mapping;
    });
  }

  async mapSoM(page: Page): Promise<Array<{ index: number; text: string; x: number; y: number }>> {
    const allElements: Array<{ index: number; text: string; x: number; y: number }> = [];
    let globalIndex = 0;

    for (const frame of page.frames()) {
      try {
        let frameOffsetX = 0;
        let frameOffsetY = 0;

        if (frame.parentFrame()) {
          const frameElement = await frame.frameElement();
          const box = await frameElement.boundingBox();
          if (box) {
            frameOffsetX = box.x;
            frameOffsetY = box.y;
          }
        }

        const frameElements = await frame.evaluate((startIndex: number) => {
          (window as any).nle_somActive = true;
          return typeof (window as any).mapSoM === "function" ? (window as any).mapSoM(startIndex) : [];
        }, globalIndex);

        for (const element of frameElements as Array<{ index: number; text: string; x: number; y: number }>) {
          element.x += frameOffsetX;
          element.y += frameOffsetY;
          allElements.push(element);
        }
        globalIndex += frameElements.length;
      } catch {
        // Ignore cross-origin frame evaluation failures.
      }
    }

    return allElements;
  }

  async clickSoM(page: Page, index: number): Promise<boolean> {
    this.assertAutomationControlBoundary("SoM click");
    return this.withExecutionPulse("som-click", async () => {
      try {
        const elements = await this.mapSoM(page);
        const target = elements.find((element) => element.index === index);
        if (!target) {
          throw new Error(`SoM ${index} not found`);
        }
        await page.mouse.move(target.x, target.y, { steps: 5 });
        await page.mouse.click(target.x, target.y, { delay: Math.random() * 100 + 50 });
        return true;
      } catch (error) {
        await this.writeScratchpad(page, `❌ Action failed (clickSoM): ${toMessage(error)}`);
        return false;
      }
    });
  }

  async writeScratchpad(page: Page, text: string, type: "ai" | "human" = "ai"): Promise<void> {
    const safeText = sanitizeProtectedRuntimeText(text);
    this.rememberScratchpadEntry(safeText, type);
    await this.renderScratchpadEntry(page, safeText, type);
    this.telemetrySink?.("scratchpad", { text: safeText, type });
  }

  async appendScratchpadEntry(text: string, type: "ai" | "human" = "ai"): Promise<void> {
    const safeText = sanitizeProtectedRuntimeText(text);
    if (this.currentPage && !this.currentPage.isClosed()) {
      await this.writeScratchpad(this.currentPage, safeText, type);
      return;
    }

    this.rememberScratchpadEntry(safeText, type);
    this.telemetrySink?.("scratchpad", { text: safeText, type });
  }

  async humanType(page: Page, selector: string, text: string): Promise<boolean> {
    const result = await this.retryWithBackoff(async () => {
      await humanType(page, selector, text, this.emitTelemetry);
      return true;
    }, 3, `humanType(${selector})`);
    return result ?? false;
  }

  async humanClick(page: Page, selector: string): Promise<boolean> {
    const result = await this.retryWithBackoff(async () => {
      await humanClick(page, selector, this.emitTelemetry);
      return true;
    }, 3, `humanClick(${selector})`);
    return result ?? false;
  }

  async humanMoveMouse(page: Page, x: number, y: number): Promise<boolean> {
    try {
      await humanMoveMouse(page, x, y, this.emitTelemetry);
      return true;
    } catch (error) {
      await this.writeScratchpad(page, `❌ Action failed (Move): ${toMessage(error)}`);
      return false;
    }
  }

  async humanClickPixel(page: Page, x: number, y: number): Promise<boolean> {
    try {
      await humanClickPixel(page, x, y, this.emitTelemetry);
      return true;
    } catch (error) {
      await this.writeScratchpad(page, `❌ Action failed (Pixel Click): ${toMessage(error)}`);
      return false;
    }
  }

  async humanDrag(page: Page, fromX: number, fromY: number, toX: number, toY: number): Promise<boolean> {
    try {
      await humanDrag(page, fromX, fromY, toX, toY, this.emitTelemetry);
      return true;
    } catch (error) {
      await this.writeScratchpad(page, `❌ Action failed (Drag): ${toMessage(error)}`);
      return false;
    }
  }

  async humanScroll(page: Page, targetY: number): Promise<boolean> {
    this.assertAutomationControlBoundary("scroll");
    return this.withExecutionPulse("scroll", async () => {
      try {
        await humanScroll(page, targetY, this.emitTelemetry);
        return true;
      } catch (error) {
        await this.writeScratchpad(page, `❌ Action failed (Scroll): ${toMessage(error)}`);
        return false;
      }
    });
  }

  async humanPressCombo(page: Page, keys: string[]): Promise<boolean> {
    try {
      await humanPressCombo(page, keys, this.emitTelemetry);
      return true;
    } catch (error) {
      await this.writeScratchpad(page, `❌ Action failed (Combo): ${toMessage(error)}`);
      return false;
    }
  }

  async analyzeScreen(page: Page): Promise<string> {
    return this.withExecutionPulse("screen-analysis", async () => {
      try {
        await this.writeScratchpad(page, "👁️ Engaging Pure Pixel Vision Fallback...");
        const buffer = await page.screenshot({ quality: 80, type: "jpeg" });
        await this.writeScratchpad(page, "📸 Screen captured. Ready for Vision Model analysis.");
        return `data:image/jpeg;base64,${buffer.toString("base64")}`;
      } catch (error) {
        await this.writeScratchpad(page, `❌ Vision capture failed: ${toMessage(error)}`);
        return "";
      }
    });
  }

  async getActiveTab(): Promise<Page | null> {
    if (!this.context) return null;

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const pages = this.context.pages().filter((page) => !page.isClosed());
      if (pages.length === 0) return null;
      const sessionPage = this.currentSession?.currentPage;
      if (sessionPage && !sessionPage.isClosed() && sessionPage !== this.currentPage) {
        this.markCurrentPage(sessionPage);
        return this.currentPage;
      }
      if (this.currentPage && !this.currentPage.isClosed()) {
        return this.currentPage;
      }

      const candidate = pages[pages.length - 1];
      if (candidate && !candidate.isClosed()) {
        this.markCurrentPage(candidate);
        return this.currentPage;
      }

      await sleep(500);
    }

    return null;
  }

  async extractCookies(page: Page): Promise<Array<Record<string, unknown>>> {
    const cookies = await page.context().cookies();
    return cookies.map((cookie) => ({
      domain: cookie.domain,
      expires: cookie.expires,
      httpOnly: cookie.httpOnly,
      name: cookie.name,
      path: cookie.path || "/",
      sameSite: cookie.sameSite || "Lax",
      secure: cookie.secure,
      value: cookie.value,
    }));
  }

  async injectCookies(
    page: Page,
    cookies: Array<Record<string, unknown>>,
    service: string,
  ): Promise<boolean> {
    try {
      await this.writeScratchpad(page, `🔐 INJECTING VAULT SESSION: ${service}`);
      const domains = new Set<string>();
      for (const cookie of cookies) {
        const domain = typeof cookie.domain === "string" ? cookie.domain : undefined;
        if (domain) {
          domains.add(domain);
        }
        await page.context().addCookies([
          {
            domain,
            expires: typeof cookie.expires === "number" ? cookie.expires : -1,
            httpOnly: Boolean(cookie.httpOnly),
            name: String(cookie.name),
            path: typeof cookie.path === "string" ? cookie.path : "/",
            sameSite:
              cookie.sameSite === "Strict" || cookie.sameSite === "None" ? cookie.sameSite : "Lax",
            secure: cookie.secure !== false,
            value: String(cookie.value),
          },
        ]);
      }
      await this.writeScratchpad(
        page,
        `✅ VAULT INJECTION COMPLETE: ${cookies.length} cookies for ${domains.size} domains`,
      );
      return true;
    } catch (error) {
      await this.writeScratchpad(page, `❌ VAULT INJECTION FAILED: ${String(error)}`);
      return false;
    }
  }

  async saveCookiesToVault(
    page: Page,
    service: string,
  ): Promise<{ message: string; success: boolean; vaultId?: number }> {
    try {
      await this.writeScratchpad(page, `🔐 CAPTURING SESSION: ${service}`);
      const cookies = await this.extractCookies(page);
      if (cookies.length === 0) {
        return { message: "No cookies found in current session", success: false };
      }

      const domains = Array.from(
        new Set(
          cookies
            .map((cookie) => cookie.domain)
            .filter((domain): domain is string => typeof domain === "string" && domain.length > 0),
        ),
      );
      const savedPath = saveVaultEntry({
        capturedAt: new Date().toISOString(),
        cookies,
        domains,
        lastUrl: page.url(),
        service,
        title: await page.title(),
        userAgent: await page.evaluate(() => navigator.userAgent),
      }, this.activeUserId ?? undefined);
      await this.writeScratchpad(page, `✅ SESSION SECURED: ${service} stored locally`);
      return {
        message: `Vault entry stored at ${savedPath}`,
        success: true,
      };
    } catch (error) {
      await this.writeScratchpad(page, `❌ VAULT ERROR: ${String(error)}`);
      return { message: String(error), success: false };
    }
  }

  async loadCookiesFromVault(page: Page, service: string): Promise<boolean> {
    try {
      await this.writeScratchpad(page, `🔐 RETRIEVING VAULT SESSION: ${service}`);
      const entry = loadVaultEntry(service, this.activeUserId ?? undefined);
      if (entry?.cookies?.length) {
        await this.injectCookies(page, entry.cookies, service);
        return true;
      }
      const message = "Vault entry not found";
      await this.writeScratchpad(page, `❌ VAULT RETRIEVE FAILED: ${message}`);
      return false;
    } catch (error) {
      await this.writeScratchpad(page, `❌ VAULT ERROR: ${String(error)}`);
      return false;
    }
  }

  startMissionLogger(missionId: string): void {
    const logDir = getMissionLogsDir(this.activeUserId ?? undefined);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { mode: 0o700, recursive: true });
    }

    this.missionLogPath = path.join(logDir, `${missionId}-${Date.now()}.json`);
    this.missionLog = [];
    this.logAction("MISSION_START", "success", `Mission ${missionId} initialized`);
  }

  getMissionLog(): MissionLogEntry[] {
    return [...this.missionLog];
  }

  async bootstrapTaskMission(input: {
    checklist?: string[];
    continuityMode?: string;
    objective: string;
    persistent?: boolean;
    provider?: string;
    operatorSessionId?: number | null;
  }): Promise<void> {
    const objective = input.objective.trim();
    if (!objective) {
      return;
    }

    const checklistLabels =
      Array.isArray(input.checklist) && input.checklist.length > 0
        ? input.checklist
        : deriveTaskChecklist(objective);

    this.taskBoard = {
      activeTab: this.scratchpadActiveTab,
      brief: null,
      checklist: checklistLabels.map((label, index) => ({
        id: `task-step-${index + 1}`,
        label,
        status: index === 0 ? "active" : "pending",
      })),
      objective,
      timeline: [
        {
          detail: objective,
          id: `timeline-${Date.now()}-mission-received`,
          label: "Mission received",
          status: "success",
          timestamp: new Date().toISOString(),
        },
      ],
    };
    this.runtimeProfile = {
      continuityMode: input.continuityMode ?? this.runtimeProfile.continuityMode,
      heartbeatAt: this.runtimeProfile.heartbeatAt,
      persistent: input.persistent === true,
      provider: "standalone-runtime",
      operatorSessionId:
        typeof input.operatorSessionId === "number" ? input.operatorSessionId : this.runtimeProfile.operatorSessionId,
    };
    this.refreshTaskBrief();
    await this.syncControlState();
  }

  async configureRuntimeProfile(
    input: Partial<OmniRuntimeProfileSnapshot>,
  ): Promise<void> {
    this.runtimeProfile = {
      continuityMode: input.continuityMode ?? this.runtimeProfile.continuityMode,
      heartbeatAt:
        input.heartbeatAt === null || typeof input.heartbeatAt === "string"
          ? input.heartbeatAt
          : this.runtimeProfile.heartbeatAt,
      persistent:
        typeof input.persistent === "boolean" ? input.persistent : this.runtimeProfile.persistent,
      provider: "standalone-runtime",
      operatorSessionId:
        typeof input.operatorSessionId === "number" || input.operatorSessionId === null
          ? input.operatorSessionId
          : this.runtimeProfile.operatorSessionId,
    };
    await this.syncControlState();
  }

  async noteHeartbeat(timestamp: string = new Date().toISOString()): Promise<void> {
    this.runtimeProfile = {
      ...this.runtimeProfile,
      heartbeatAt: timestamp,
    };
    await this.syncControlState();
  }

  async setHudPreferences(input: {
    badgeVisible?: boolean;
    controlPanelVisible?: boolean;
  }): Promise<OmniControlState> {
    if (typeof input.badgeVisible === "boolean") {
      this.badgeVisible = input.badgeVisible;
    }
    if (typeof input.controlPanelVisible === "boolean") {
      this.controlPanelVisible = input.controlPanelVisible;
    }
    await this.syncControlState();
    void this.persistHudPreferences();
    return this.getControlState();
  }

  private async persistHudPreferences(): Promise<void> {
    const sessionId = this.currentSession?.sessionId;
    if (!sessionId) return;
    try {
      const dir = this.sessionPersistence.getSessionDir(sessionId);
      const target = path.join(dir, "hud-prefs.json");
      atomicWriteFile(
        target,
        JSON.stringify(
          {
            badgeVisible: this.badgeVisible,
            controlPanelVisible: this.controlPanelVisible,
            updatedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
    } catch {
      // best-effort persistence
    }
  }

  private loadHudPreferences(sessionId: string): void {
    try {
      const dir = this.sessionPersistence.getSessionDir(sessionId);
      const target = path.join(dir, "hud-prefs.json");
      if (!fs.existsSync(target)) return;
      const parsed = JSON.parse(fs.readFileSync(target, "utf8")) as {
        badgeVisible?: boolean;
        controlPanelVisible?: boolean;
      };
      if (typeof parsed.badgeVisible === "boolean") this.badgeVisible = parsed.badgeVisible;
      if (typeof parsed.controlPanelVisible === "boolean")
        this.controlPanelVisible = parsed.controlPanelVisible;
    } catch {
      // best-effort load
    }
  }

  startRuntimePersistence(input: {
    agentId?: string;
    checkpointIntervalMs?: number;
    heartbeatIntervalMs?: number;
  } = {}): void {
    this.persistenceAgentId = input.agentId ?? this.persistenceAgentId ?? this.currentSession?.sessionId ?? "omni-agent";
    const heartbeatMs = Math.max(15_000, input.heartbeatIntervalMs ?? 60_000);
    const checkpointMs = Math.max(60_000, input.checkpointIntervalMs ?? 300_000);

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    this.heartbeatInterval = setInterval(() => {
      void this.noteHeartbeat().catch(() => undefined);
    }, heartbeatMs);
    this.heartbeatInterval.unref?.();

    if (this.checkpointInterval) {
      clearInterval(this.checkpointInterval);
    }
    this.checkpointInterval = setInterval(() => {
      void this.persistCheckpoint("scheduled").catch(() => undefined);
    }, checkpointMs);
    this.checkpointInterval.unref?.();

    void this.noteHeartbeat().catch(() => undefined);
  }

  stopRuntimePersistence(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.checkpointInterval) {
      clearInterval(this.checkpointInterval);
      this.checkpointInterval = null;
    }
  }

  async persistCheckpoint(reason: string = "manual"): Promise<string | null> {
    if (this.checkpointInFlight) return null;
    if (!this.currentSession || !this.currentPage || this.currentPage.isClosed()) return null;
    this.checkpointInFlight = true;
    try {
      const warmState = await this.captureWarmState({
        agentId: this.persistenceAgentId ?? this.currentSession.sessionId,
        pendingCommands: [],
        proofArtifacts: [],
        reason,
      });
      const saved = await this.sessionPersistence.saveWarmState(warmState, this.payloadCrypto);
      this.lastCheckpointAt = warmState.capturedAt;
      this.logAction("CHECKPOINT", "success", `${reason} → ${saved}`);
      // P2: Create mission checkpoint and emit checkpoint.created event
      const sessionId = this.currentSession.sessionId;
      const stepId = `step-${this.currentStepNumber}`;
      const checkpoint = await createMissionCheckpoint({
        page: this.currentPage,
        sessionId,
        planId: this.currentPlanId || sessionId,
        stepId,
        stepNumber: this.currentStepNumber,
        lastVerifiedAction: reason,
        memory: this.missionMemory,
        pendingStepIntents: [],
        proofArtifactIds: this.missionProofArtifactIds,
      }).catch(() => null);
      if (checkpoint) {
        const isNew = this.missionMemory.addCheckpoint(checkpoint);
        if (isNew) {
          this.p1p2EmitEvent("checkpoint.created", {
            checkpointId: checkpoint.checkpointId,
            planId: checkpoint.planId,
            stepId: checkpoint.stepId,
            stepNumber: checkpoint.stepNumber,
            url: checkpoint.url,
            title: checkpoint.title,
            axTreeHash: checkpoint.axTreeHash,
            lastVerifiedAction: checkpoint.lastVerifiedAction,
            completedStepCount: checkpoint.completedSteps.length,
            proofArtifactCount: checkpoint.proofArtifactIds.length,
            capturedAt: checkpoint.capturedAt,
          });
        }
      }
      return saved;
    } catch (error) {
      this.logAction("CHECKPOINT_FAILED", "error", toMessage(error));
      return null;
    } finally {
      this.checkpointInFlight = false;
    }
  }

  private async restoreFromCheckpoint(sessionId: string): Promise<void> {
    this.loadHudPreferences(sessionId);
    try {
      const warm = await this.sessionPersistence.loadWarmState(sessionId, this.payloadCrypto);
      if (!warm) return;

      if (typeof warm.badgeVisible === "boolean") this.badgeVisible = warm.badgeVisible;
      if (typeof warm.controlPanelVisible === "boolean")
        this.controlPanelVisible = warm.controlPanelVisible;
      if (warm.scratchpadActiveTab) this.scratchpadActiveTab = warm.scratchpadActiveTab;
      if (warm.scratchpadWindowState) this.scratchpadWindowState = warm.scratchpadWindowState;
      if (Array.isArray(warm.scratchpadEntries) && warm.scratchpadEntries.length > 0) {
        this.scratchpadHistory = warm.scratchpadEntries.map((entry) => ({
          text: entry.text,
          timestamp: entry.timestamp,
          type: entry.type,
        }));
      }
      if (warm.taskBoard) {
        this.taskBoard = {
          activeTab: warm.taskBoard.activeTab ?? this.scratchpadActiveTab,
          brief: warm.taskBoard.brief ?? null,
          checklist: Array.isArray(warm.taskBoard.checklist)
            ? warm.taskBoard.checklist.map((item) => ({ ...item }))
            : [],
          objective: warm.taskBoard.objective ?? null,
          timeline: Array.isArray(warm.taskBoard.timeline)
            ? warm.taskBoard.timeline.map((entry) => ({ ...entry }))
            : [],
        };
      }
      if (warm.runtimeProfile) {
        this.runtimeProfile = { ...warm.runtimeProfile };
      }
      if (Array.isArray(warm.pendingHumanMessages) && warm.pendingHumanMessages.length > 0) {
        this.humanMessageQueue = [...warm.pendingHumanMessages];
      }
      if (Array.isArray(warm.missionLog) && warm.missionLog.length > 0) {
        this.missionLog = warm.missionLog as unknown as MissionLogEntry[];
      }
      this.persistenceAgentId = warm.agentId ?? this.persistenceAgentId;
      this.logAction("CHECKPOINT_RESTORED", "recovery", `Resumed session ${sessionId} from warm state`);
    } catch (error) {
      this.logAction("CHECKPOINT_RESTORE_FAILED", "error", toMessage(error));
    }
  }

  async setScratchpadTab(tab: string): Promise<OmniControlState> {
    const nextTab: OmniScratchpadTab = tab === "task" ? "task" : "live";
    this.scratchpadActiveTab = nextTab;
    this.taskBoard = {
      ...this.taskBoard,
      activeTab: nextTab,
    };
    await this.syncControlState();
    return this.getControlState();
  }

  async captureWarmState(input: {
    agentId: string;
    pendingCommands: Array<Record<string, unknown>>;
    proofArtifacts: string[];
    reason: string;
  }): Promise<OmniWarmResumeState> {
    const sessionId = await this.ensureSession();
    const page = await this.requirePage();
    const storageState = {
      cookies: [],
      origins: [],
    };
    const domSnapshotPath = this.proofCapture.writeTextLog(
      sessionId,
      `${input.reason}-dom-snapshot`,
      sanitizeProtectedRuntimeText(await page.content().catch(() => "<html></html>")),
    );

    return {
      agentId: input.agentId,
      badgeVisible: this.badgeVisible,
      capturedAt: new Date().toISOString(),
      controlPanelVisible: this.controlPanelVisible,
      currentUrl: sanitizeProtectedRuntimeText(page.url()),
      domSnapshotPath,
      humanControl: this.isHumanActive,
      missionLog: sanitizeProtectedRuntimeValue(
        this.getMissionLog().slice(-200),
      ) as unknown as Array<Record<string, unknown>>,
      pendingHumanMessages: [...this.humanMessageQueue],
      paused: this.isPaused,
      pendingCommands: sanitizeProtectedRuntimeValue([...input.pendingCommands]),
      proofArtifacts: [...input.proofArtifacts],
      runtimeProfile: { ...this.runtimeProfile },
      scratchpadActiveTab: this.scratchpadActiveTab,
      scratchpadWindowState: this.scratchpadWindowState,
      scratchpadEntries: sanitizeProtectedRuntimeValue([...this.scratchpadHistory]),
      sessionId,
      storageState: storageState as unknown as Record<string, unknown>,
      taskBoard: sanitizeProtectedRuntimeValue({
        ...this.taskBoard,
        checklist: this.taskBoard.checklist.map((item) => ({ ...item })),
        timeline: this.taskBoard.timeline.map((entry) => ({ ...entry })),
      }),
      operatorSessionId: this.runtimeProfile.operatorSessionId,
    };
  }

  async ensurePage(): Promise<Page> {
    return this.requirePage();
  }

  async captureErrorScreenshot(page: Page, context: string): Promise<string | null> {
    try {
      this.errorScreenshotCounter += 1;
      const sessionId = await this.ensureSession();
      const screenshotPath = await this.proofCapture.captureScreenshot(
        page,
        sessionId,
        `error-${this.errorScreenshotCounter}-${context}`,
      );
      this.logAction("ERROR_SCREENSHOT", "success", `${context} → ${screenshotPath}`);
      return screenshotPath;
    } catch {
      return null;
    }
  }

  async captureProofCheckpoint(label: string): Promise<string> {
    this.assertAutomationControlBoundary("proof capture");
    return this.withExecutionPulse("proof-capture", async () => {
      const sessionId = await this.ensureSession();
      const page = await this.requirePage();
      const screenshotPath = await this.proofCapture.captureScreenshot(page, sessionId, label, { fullPage: true });
      this.proofCapture.writeJsonReport(sessionId, `${label}-mission-log`, this.missionLog);
      return screenshotPath;
    });
  }

  async retryWithBackoff<T>(
    fn: () => Promise<T>,
    maxRetries: number = 3,
    context: string = "unknown",
  ): Promise<T | null> {
    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      try {
        const result = await fn();
        this.consecutiveFailures = 0;
        if (attempt > 1) {
          this.logAction("RETRY_SUCCESS", "recovery", `${context} succeeded on attempt ${attempt}`);
        }
        return result;
      } catch (error) {
        this.consecutiveFailures += 1;
        this.logAction(
          "RETRY_FAILED",
          "error",
          `${context} attempt ${attempt}/${maxRetries}: ${toMessage(error)}`,
        );

        if (attempt === maxRetries && this.currentPage) {
          await this.captureErrorScreenshot(this.currentPage, context);
        }

        if (attempt < maxRetries && this.consecutiveFailures >= this.maxConsecutiveFailures) {
          this.logAction(
            "AUTO_PAUSE",
            "error",
            `${this.maxConsecutiveFailures} consecutive failures — pausing for human review`,
          );
          return null;
        }

        if (attempt < maxRetries) {
          await sleep(Math.min(1000 * 2 ** (attempt - 1), 5000));
        }
      }
    }

    return null;
  }

  async smartWait(page: Page, selector: string, timeoutMs: number = 10_000): Promise<boolean> {
    try {
      await page.waitForSelector(selector, { state: "attached", timeout: timeoutMs });
      return true;
    } catch {
      return false;
    }
  }

  async navigateResilient(page: Page, url: string): Promise<OmniNavigateOutcome> {
    const strategies: Array<{ timeout: number; waitUntil: "domcontentloaded" | "networkidle" | "load" }> = [
      { timeout: 15_000, waitUntil: "domcontentloaded" },
      { timeout: 20_000, waitUntil: "networkidle" },
      { timeout: 30_000, waitUntil: "load" },
    ];
    const errors: string[] = [];
    let lastHttpStatus: number | null = null;

    for (let index = 0; index < strategies.length; index += 1) {
      const strategy = strategies[index]!;
      try {
        const response: PlaywrightResponse | null = await page.goto(url, {
          timeout: strategy.timeout,
          waitUntil: strategy.waitUntil,
        });

        // Check for Chrome error pages (net::ERR_*, interstitials, etc.)
        const finalUrl = page.url();
        if (finalUrl.startsWith("chrome-error://") || finalUrl.startsWith("chrome://network-error")) {
          const message = `Chrome error page reached: ${finalUrl}`;
          errors.push(`Strategy ${index + 1} (${strategy.waitUntil}): ${message}`);
          this.logAction("NAVIGATE_FAILED", "error", message);
          continue;
        }

        if (response) {
          lastHttpStatus = response.status();
          if (!response.ok()) {
            const message = `HTTP ${response.status()} ${response.statusText()}`;
            errors.push(`Strategy ${index + 1} (${strategy.waitUntil}): ${message}`);
            this.logAction("NAVIGATE_FAILED", "error", message);
            continue;
          }
        }

        this.consecutiveFailures = 0;
        this.markCurrentPage(page);
        await this.replayScratchpadHistory(page);
        await this.syncControlState();
        this.logAction("NAVIGATE", "success", `Strategy ${index + 1}: ${strategy.waitUntil} → ${finalUrl}`);
        return { success: true, errors: [], httpStatus: lastHttpStatus, finalUrl };
      } catch (error) {
        const message = toMessage(error);
        errors.push(`Strategy ${index + 1} (${strategy.waitUntil}): ${message}`);
        this.logAction("NAVIGATE_FAILED", "error", `Strategy ${index + 1} (${strategy.waitUntil}): ${message}`);
      }
    }

    this.consecutiveFailures += 1;
    await this.captureErrorScreenshot(page, `Navigation failed: ${url}`);
    return {
      success: false,
      errors,
      httpStatus: lastHttpStatus,
      finalUrl: page.url(),
    };
  }

  async waitForNavigation(page: Page): Promise<void> {
    await waitForNavigation(page, undefined, this.emitTelemetry);
  }

  async checkTabHealth(page: Page): Promise<boolean> {
    try {
      await page.evaluate(() => document.readyState);
      return true;
    } catch {
      this.logAction("TAB_HEALTH_CHECK", "error", "Tab is unresponsive — attempting recovery");
      return false;
    }
  }

  async recoverTab(page: Page): Promise<Page | null> {
    try {
      this.logAction("TAB_RECOVERY", "recovery", "Attempting to recover unresponsive tab");
      const url = page.url();
      await page.close().catch(() => {});
      const newPage = await this.openPage();
      await newPage.goto(url, { timeout: 15_000, waitUntil: "domcontentloaded" }).catch(() => {});
      await forceInjectOmniUi(newPage);
      await this.replayScratchpadHistory(newPage);
      await this.syncControlState();
      this.markCurrentPage(newPage);
      this.logAction("TAB_RECOVERY", "recovery", `Tab recovered at ${url}`);
      return newPage;
    } catch (error) {
      this.logAction("TAB_RECOVERY_FAILED", "error", toMessage(error));
      return null;
    }
  }

  startWatchdog(checkIntervalMs: number = 30_000): void {
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
    }
    this.watchdogInterval = setInterval(() => {
      void this.runWatchdogCheck();
    }, checkIntervalMs);
    this.watchdogInterval.unref?.();
  }

  startMemoryCleanup(cleanupIntervalMs: number = 60_000): void {
    if (this.memoryCleanupInterval) {
      clearInterval(this.memoryCleanupInterval);
    }

    this.memoryCleanupInterval = setInterval(() => {
      void this.runMemoryCleanup();
    }, cleanupIntervalMs);
    this.memoryCleanupInterval.unref?.();
  }

  async smartFillForm(page: Page, fields: Record<string, string>): Promise<boolean> {
    try {
      for (const [selector, value] of Object.entries(fields)) {
        const found = await this.smartWait(page, selector, 5000);
        if (!found) {
          this.logAction("SMART_FILL", "error", `Field not found: ${selector}`);
          continue;
        }
        await this.humanType(page, selector, value);
        this.logAction("SMART_FILL", "success", `Filled ${selector} with ${value.slice(0, 20)}...`);
      }
      return true;
    } catch (error) {
      this.logAction("SMART_FILL_FAILED", "error", toMessage(error));
      return false;
    }
  }

  async startSoMAutoRefresh(page: Page, refreshIntervalMs: number = 1000): Promise<void> {
    await page.evaluate((interval) => {
      if ((window as any)._somRefreshInterval) {
        clearInterval((window as any)._somRefreshInterval);
      }
      (window as any)._somRefreshInterval = setInterval(() => {
        if ((window as any).nle_somActive && typeof (window as any).mapSoM === "function") {
          (window as any).mapSoM();
        }
      }, interval);
    }, refreshIntervalMs);
  }

  async stopSoMAutoRefresh(page: Page): Promise<void> {
    await page.evaluate(() => {
      if ((window as any)._somRefreshInterval) {
        clearInterval((window as any)._somRefreshInterval);
        (window as any)._somRefreshInterval = null;
      }
    });
  }

  async extractSemanticPage(page: Page): Promise<string> {
    return extractSemanticPage(page, "markdown", this.emitTelemetry);
  }

  async restoreWarmState(state: OmniWarmResumeState): Promise<void> {
    await this.ensureSession();
    const page = await this.requirePage();
    const storageState = state.storageState as {
      cookies?: Array<Record<string, unknown>>;
      origins?: Array<{ localStorage?: Array<{ name: string; value: string }>; origin: string }>;
    };

    if (this.context && Array.isArray(storageState.cookies) && storageState.cookies.length > 0) {
      await this.context.addCookies(
        storageState.cookies.map((cookie) => ({
          domain: String(cookie.domain ?? ""),
          expires: typeof cookie.expires === "number" ? cookie.expires : -1,
          httpOnly: Boolean(cookie.httpOnly),
          name: String(cookie.name ?? ""),
          path: typeof cookie.path === "string" ? cookie.path : "/",
          sameSite:
            cookie.sameSite === "Strict" || cookie.sameSite === "None" ? cookie.sameSite : "Lax",
          secure: cookie.secure !== false,
          value: String(cookie.value ?? ""),
        })),
      );
    }

    if (state.currentUrl) {
      await this.navigateResilient(page, state.currentUrl);
      const targetOrigin = new URL(state.currentUrl).origin;
      const originState = storageState.origins?.find((origin) => origin.origin === targetOrigin);
      if (originState?.localStorage?.length) {
        await page.evaluate((entries) => {
          for (const entry of entries) {
            window.localStorage.setItem(entry.name, entry.value);
          }
        }, originState.localStorage);
        await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      }
    }

    this.missionLog = (state.missionLog as unknown as MissionLogEntry[]) ?? [];
    this.humanMessageQueue = [...(state.pendingHumanMessages ?? [])];
    this.isPaused = state.paused;
    this.isHumanActive = state.humanControl;
    this.badgeVisible = state.badgeVisible !== false;
    this.controlPanelVisible = state.controlPanelVisible !== false;
    this.runtimeProfile = {
      continuityMode: state.runtimeProfile?.continuityMode ?? this.runtimeProfile.continuityMode,
      heartbeatAt:
        state.runtimeProfile?.heartbeatAt === undefined
          ? this.runtimeProfile.heartbeatAt
          : state.runtimeProfile.heartbeatAt,
      persistent: state.runtimeProfile?.persistent === true,
      provider: "standalone-runtime",
      operatorSessionId:
        typeof state.runtimeProfile?.operatorSessionId === "number" || state.runtimeProfile?.operatorSessionId === null
          ? state.runtimeProfile.operatorSessionId
          : this.runtimeProfile.operatorSessionId,
    };
    this.scratchpadActiveTab = state.scratchpadActiveTab === "task" ? "task" : "live";
    this.scratchpadWindowState =
      state.scratchpadWindowState === "closed" ||
      state.scratchpadWindowState === "fullscreen" ||
      state.scratchpadWindowState === "minimized"
        ? state.scratchpadWindowState
        : "open";
    this.scratchpadHistory = [...(state.scratchpadEntries ?? [])];
    this.taskBoard = {
      activeTab: this.scratchpadActiveTab,
      brief: state.taskBoard?.brief ?? null,
      checklist: [...(state.taskBoard?.checklist ?? [])],
      objective: state.taskBoard?.objective ?? null,
      timeline: [...(state.taskBoard?.timeline ?? [])],
    };
    await this.replayScratchpadHistory(page);
    await this.syncControlState();
  }

  async surrenderControl(page: Page, reason: string): Promise<{ url: string }> {
    await this.takeover(reason, page);
    return new Promise<{ url: string }>((resolve) => {
      this.pausedPromiseResolve = resolve;
    });
  }

  async checkPause(): Promise<void> {
    while (this.isPaused) {
      await sleep(100);
    }
  }

  getPendingHumanMessages(): string[] {
    const messages = [...this.humanMessageQueue];
    this.humanMessageQueue = [];
    void this.syncControlState();
    return messages;
  }

  acknowledgeHumanMessage(message?: string): void {
    if (typeof message === "string" && message.length > 0) {
      const matchingIndex = this.humanMessageQueue.indexOf(message);
      if (matchingIndex >= 0) {
        this.humanMessageQueue.splice(matchingIndex, 1);
      } else {
        this.humanMessageQueue.shift();
      }
    } else {
      this.humanMessageQueue.shift();
    }
    void this.syncControlState();
  }

  togglePause(): boolean {
    this.isPaused = !this.isPaused;
    if (!this.isPaused && !this.isHumanActive && this.pausedPromiseResolve) {
      this.pausedPromiseResolve({ url: this.currentPage?.url() || "" });
      this.pausedPromiseResolve = null;
    }
    void this.syncControlState();
    return this.isPaused;
  }

  isPausedState(): boolean {
    return this.isPaused;
  }

  isHumanInControl(): boolean {
    return this.isHumanActive;
  }

  resumeAI(): void {
    this.isPaused = false;
    this.isHumanActive = false;
    if (this.pausedPromiseResolve) {
      this.pausedPromiseResolve({ url: this.currentPage?.url() || "" });
      this.pausedPromiseResolve = null;
    }
    void this.syncControlState();
  }

  onHumanMessage(handler: (message: string) => void): void {
    this.humanMessageHandlers.push(handler);
  }

  sendHumanMessage(message: string, options: { queueForAgent?: boolean } = {}): void {
    const safeMessage = sanitizeProtectedRuntimeText(message);
    const shouldQueue = options.queueForAgent !== false;
    if (shouldQueue) {
      this.humanMessageQueue.push(safeMessage);
    }
    for (const handler of this.humanMessageHandlers) {
      handler(safeMessage);
    }
    this.telemetrySink?.("human_message", { message: safeMessage, queued: shouldQueue });
    void this.syncControlState();
  }

  async receiveHumanMessage(
    message: string,
    options: { echoInScratchpad?: boolean; queueForAgent?: boolean } = {},
  ): Promise<void> {
    const rawNormalized = message.trim();
    if (!rawNormalized) {
      return;
    }
    const normalized = sanitizeProtectedRuntimeText(rawNormalized);

    if (options.echoInScratchpad) {
      await this.appendScratchpadEntry(normalized, "human");
    }

    if (!this.taskBoard.objective) {
      await this.bootstrapTaskMission({ objective: normalized });
      if (!this.missionLogPath) {
        this.startMissionLogger(`scratchpad-${Date.now()}`);
      }
    } else {
      this.recordTaskTimeline("human_directive", normalized, "success");
      await this.syncControlState();
    }

    this.sendHumanMessage(normalized, { queueForAgent: options.queueForAgent });

    if (this.humanMessageHandlers.length === 0) {
      await this.handleHumanMessageLocally(normalized);
    }

    await this.syncControlState();
  }

  private async handleHumanMessageLocally(message: string): Promise<void> {
    const navigationTarget = extractNavigationTarget(message);

    if (navigationTarget) {
      try {
        await this.navigate(navigationTarget);
      } catch (error) {
        await this.appendScratchpadEntry(`REFLECT: Navigation failed - ${toMessage(error)}.`);
      }
      this.acknowledgeHumanMessage(message);
      this.refreshTaskBrief();
      await this.syncControlState();
      return;
    }

    await this.appendScratchpadEntry(`THINK: Reviewing directive "${message}".`);
    await this.appendScratchpadEntry(
      "EXECUTE: Captured directive to the task board. Planner, Progress, and Brief tabs now reflect this mission.",
    );
    await this.appendScratchpadEntry(
      "REFLECT: Directive logged. Tell me the next step or ask me to navigate, research, or capture proof.",
    );
    this.acknowledgeHumanMessage(message);
    this.refreshTaskBrief();
    await this.syncControlState();
  }

  async signalSovereignHandoff(page: Page, reason: string): Promise<string> {
    const result = await this.surrenderControl(page, reason);
    return result.url || page.url();
  }

  async waitForResume(page: Page): Promise<string> {
    while (this.isPaused || this.isHumanActive) {
      await sleep(500);
    }
    return page.url();
  }

  async awaitAutomationClearance(): Promise<void> {
    while (this.isPaused || this.isHumanActive) {
      await sleep(200);
    }
  }

  async takeover(reason: string = "Manual takeover engaged", page?: Page): Promise<OmniControlState> {
    this.isPaused = true;
    this.isHumanActive = true;
    await (page ? this.writeScratchpad(page, `👤 HUMAN CONTROL: ${reason}`) : this.appendScratchpadEntry(`👤 HUMAN CONTROL: ${reason}`));
    await this.syncControlState();
    return this.getControlState();
  }

  async pauseMission(reason?: string): Promise<OmniControlState> {
    if (!this.isPaused) {
      this.isPaused = true;
      if (reason) {
        await this.appendScratchpadEntry(`⏸ ${reason}`);
      }
    }
    await this.syncControlState();
    return this.getControlState();
  }

  async resumeMission(reason?: string): Promise<OmniControlState> {
    // P2: Verify page state before resuming — do not blindly continue after handoff
    const latestCheckpoint = this.missionMemory.getLatestCheckpoint();
    if (this.currentPage && !this.currentPage.isClosed() && latestCheckpoint) {
      const resumeVerification = await verifyResumeState({
        page: this.currentPage,
        expectedUrl: latestCheckpoint.url,
        expectedAxTreeHash: latestCheckpoint.axTreeHash,
        handoffReason: reason ?? "manual-resume",
      }).catch(() => null);
      if (resumeVerification) {
        // Embed resume verification result into handoff.requested event for cockpit display
        this.p0EmitEvent("handoff.requested", {
          reason: "resume-verification",
          safeToResume: resumeVerification.safeToResume,
          blockerCleared: resumeVerification.blockerCleared,
          currentUrl: resumeVerification.currentUrl,
          axTreeHash: resumeVerification.axTreeHash,
          authWallStillPresent: resumeVerification.authWallStillPresent,
          captchaStillPresent: resumeVerification.captchaStillPresent,
          resumeVerificationReason: resumeVerification.reason,
          verifiedAt: resumeVerification.verifiedAt,
        });
        if (!resumeVerification.safeToResume) {
          this.logAction(
            "RESUME_BLOCKED",
            "recovery",
            `Resume verification failed: ${resumeVerification.reason}`,
          );
          // Do NOT resume if blocker is still present
          return this.getControlState();
        }
      }
    }
    this.resumeAI();
    if (reason) {
      await this.appendScratchpadEntry(`▶ ${reason}`);
    }
    return this.getControlState();
  }

  async navigate(url: string): Promise<Record<string, unknown>> {
    this.assertAutomationControlBoundary("navigate");
    // URL validation BEFORE we open a page — rejects javascript:, file://, etc.
    const validation = validateUrl(url);
    if (!validation.valid || !validation.url) {
      this.logAction(
        "NAVIGATE_REJECTED",
        "error",
        `URL rejected: ${validation.error ?? "invalid"} → ${String(url).slice(0, 200)}`,
      );
      return {
        errors: [validation.error ?? "Invalid URL"],
        finalUrl: null,
        httpStatus: null,
        success: false,
        url,
      };
    }

    const validatedUrl = validation.url;
    return this.withExecutionPulse("navigate", async () => {
      const page = await this.requirePage();
      // P0: Capture pre-action context for verification
      const preCtx = await capturePreActionContext(page, "navigate", validatedUrl);
      const outcome = await this.navigateResilient(page, validatedUrl);
      // P0: Emit observation.captured after navigation
      const axObs = await captureAXObservation(page).catch(() => null);
      if (axObs) {
        this.p0EmitEvent("observation.captured", {
          axTreeHash: axObs.axTreeHash,
          authWallHint: axObs.authWallHint,
          captchaHint: axObs.captchaHint,
          title: axObs.title,
          url: axObs.url,
        });
      }
      // P0: Verify the navigation had an effect
      const verification = await verifyAction(page, preCtx);
      this.p0EmitEvent("verification.result", {
        actionType: "navigate",
        axHashAfter: verification.axHashAfter,
        axHashBefore: verification.axHashBefore,
        checkType: verification.checkType,
        pass: verification.pass,
        reason: verification.reason,
        target: validatedUrl,
        urlAfter: verification.urlAfter,
        urlBefore: verification.urlBefore,
      });
      if (!verification.pass) {
        this.consecutiveFailures += 1;
        if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
          await this.triggerFrustrationHandoff("navigate", validatedUrl, verification.reason);
        }
      } else {
        this.consecutiveFailures = 0;
      }
      const authWall = outcome.success ? await this.detectAuthWall(page) : null;
      let proofCaptured = false;
      if (outcome.success) {
        try {
          await this.captureProofCheckpoint("navigation-proof");
          proofCaptured = true;
        } catch (error) {
          this.logAction("PROOF_CAPTURE", "error", toMessage(error));
        }
      }
      return {
        authWall,
        errors: outcome.errors,
        finalUrl: outcome.finalUrl,
        httpStatus: outcome.httpStatus,
        proofCaptured,
        success: outcome.success,
        url: validatedUrl,
        verification: { checkType: verification.checkType, pass: verification.pass },
      };
    });
  }

  async click(selector: string): Promise<Record<string, unknown>> {
    this.assertAutomationControlBoundary("click");
    let safeSelector: string;
    try {
      safeSelector = sanitizeSelector(selector);
    } catch (error) {
      const message = error instanceof SanitizationError ? error.message : toMessage(error);
      this.logAction("CLICK_REJECTED", "error", `${message} → ${String(selector).slice(0, 200)}`);
      return { errors: [message], selector, success: false };
    }
    return this.withExecutionPulse("click", async () => {
      const page = await this.requirePage();
      // P1: Rank target candidates before clicking
      const ranking = await rankTargetCandidates(page, safeSelector, safeSelector).catch(
        () => null,
      );
      // P1: Screenshot fallback if no candidate meets confidence threshold
      let screenshotFallbackArtifactId: string | null = null;
      if (ranking && !ranking.best) {
        const fallback = await captureScreenshotFallback(
          (label) => this.captureProofCheckpoint(label).catch(() => null),
          `click-low-confidence-${safeSelector.slice(0, 30)}`,
        );
        screenshotFallbackArtifactId = fallback.artifactId;
        if (fallback.artifactId) this.missionProofArtifactIds.push(fallback.artifactId);
        this.logAction("CLICK_LOW_CONFIDENCE", "recovery", fallback.reason);
      }
      // P0: Capture pre-action context for verification
      const preCtx = await capturePreActionContext(page, "click", safeSelector);
      const success = await this.humanClick(page, safeSelector);
      // P0: Verify the click had an effect
      const verification = await verifyAction(page, preCtx);
      // P0 + P1: Emit verification.result with embedded P1 metadata
      this.p0EmitEvent("verification.result", {
        actionType: "click",
        axHashAfter: verification.axHashAfter,
        axHashBefore: verification.axHashBefore,
        checkType: verification.checkType,
        pass: verification.pass,
        reason: verification.reason,
        target: safeSelector,
        urlAfter: verification.urlAfter,
        urlBefore: verification.urlBefore,
        // P1 metadata embedded in existing event payload
        p1: ranking ? {
          candidatesFound: ranking.totalFound,
          topCandidateConfidence: ranking.best?.confidence ?? null,
          topCandidateLocator: ranking.best?.locator ?? null,
          modalActive: ranking.modalActive,
          iframeContext: ranking.iframeContext,
          screenshotFallbackArtifactId,
          ambiguityWarning: ranking.totalFound > 1 && !ranking.best,
        } : null,
      });
      if (!verification.pass) {
        this.consecutiveFailures += 1;
        if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
          await this.triggerFrustrationHandoff("click", safeSelector, verification.reason);
        }
      } else {
        this.consecutiveFailures = 0;
        // P2: Record completed step in mission memory
        this.currentStepNumber += 1;
        this.missionMemory.addCompletedStep({
          stepId: `step-${this.currentStepNumber}`,
          intent: `click: ${safeSelector.slice(0, 100)}`,
          actionType: "click",
          target: safeSelector,
          verified: true,
          checkType: verification.checkType,
          proofArtifactId: screenshotFallbackArtifactId,
          completedAt: new Date().toISOString(),
        });
      }
      return {
        selector: safeSelector,
        success,
        verification: { checkType: verification.checkType, pass: verification.pass },
        p1: ranking ? { candidatesFound: ranking.totalFound, confidence: ranking.best?.confidence ?? null } : null,
      };
    });
  }

  async type(selector: string, text: string): Promise<Record<string, unknown>> {
    this.assertAutomationControlBoundary("type");
    let safeSelector: string;
    let safeText: string;
    try {
      safeSelector = sanitizeSelector(selector);
    } catch (error) {
      const message = error instanceof SanitizationError ? error.message : toMessage(error);
      this.logAction("TYPE_REJECTED", "error", `selector: ${message}`);
      return { errors: [message], selector, success: false, textLength: 0 };
    }
    try {
      safeText = sanitizeText(text);
    } catch (error) {
      const message = error instanceof SanitizationError ? error.message : toMessage(error);
      this.logAction("TYPE_REJECTED", "error", `text: ${message}`);
      return { errors: [message], selector: safeSelector, success: false, textLength: 0 };
    }
    return this.withExecutionPulse("type", async () => {
      const page = await this.requirePage();
      // P0: Capture pre-action context for verification
      const preCtx = await capturePreActionContext(page, "type", safeSelector, safeText);
      const success = await this.humanType(page, safeSelector, safeText);
      // P1: Verify type action was accepted (never logs secret values)
      const isSecret = safeSelector.toLowerCase().includes("password") ||
        safeSelector.toLowerCase().includes("secret") ||
        safeSelector.toLowerCase().includes("token");
      const typeVerification = await verifyTypeAction(page, safeSelector, safeText, isSecret).catch(
        () => null,
      );
      // P0: Verify the type had an effect
      const verification = await verifyAction(page, preCtx);
      this.p0EmitEvent("verification.result", {
        actionType: "type",
        axHashAfter: verification.axHashAfter,
        axHashBefore: verification.axHashBefore,
        checkType: verification.checkType,
        pass: verification.pass,
        reason: verification.reason,
        target: safeSelector,
        urlAfter: verification.urlAfter,
        urlBefore: verification.urlBefore,
        // P1 type verification metadata embedded in existing event payload
        p1: typeVerification ? {
          typeAccepted: typeVerification.accepted,
          fieldReady: typeVerification.fieldReady,
          validationError: typeVerification.validationError,
          typeVerificationReason: typeVerification.reason,
        } : null,
      });
      if (!verification.pass) {
        this.consecutiveFailures += 1;
        if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
          await this.triggerFrustrationHandoff("type", safeSelector, verification.reason);
        }
      } else {
        this.consecutiveFailures = 0;
        // P2: Record completed step in mission memory
        this.currentStepNumber += 1;
        this.missionMemory.addCompletedStep({
          stepId: `step-${this.currentStepNumber}`,
          intent: `type into: ${safeSelector.slice(0, 100)}`,
          actionType: "type",
          target: safeSelector,
          verified: true,
          checkType: verification.checkType,
          proofArtifactId: null,
          completedAt: new Date().toISOString(),
        });
      }
      return {
        selector: safeSelector,
        success,
        textLength: safeText.length,
        verification: { checkType: verification.checkType, pass: verification.pass },
        p1: typeVerification ? { typeAccepted: typeVerification.accepted, validationError: typeVerification.validationError } : null,
      };
    });
  }

  async exportScratchpadBundle(): Promise<Record<string, unknown>> {
    const sessionId = await this.ensureSession();
    return this.withExecutionPulse("scratchpad-export", async () => {
      const bundle = await buildScratchpadExportBundle({
        missionLog: this.missionLog,
        proofCapture: this.proofCapture,
        scratchpadEntries: this.scratchpadHistory,
        sessionId,
      });
      return bundle as unknown as Record<string, unknown>;
    });
  }

  async processScratchpadFiles(input: OmniScratchpadFileInput[]): Promise<OmniScratchpadFileResult[]> {
    const sessionId = await this.ensureSession();
    return this.withExecutionPulse("scratchpad-file-parse", async () => {
      const results = await runScratchpadFileProcessing(sessionId, input);
      for (const result of results) {
        if (result.status === "ready") {
          const lines = [result.summary];
          if (result.previewText) {
            lines.push(result.previewText);
          }
          await this.appendScratchpadEntry(`📎 ${lines.join("\n\n")}`);
        } else {
          await this.appendScratchpadEntry(
            `📎 Failed to parse ${result.name}: ${result.error ?? "unknown error"}`,
          );
        }
      }
      return results;
    });
  }

  async setScratchpadWindowState(state: string): Promise<OmniControlState> {
    const nextState: ScratchpadWindowState =
      state === "closed" || state === "fullscreen" || state === "minimized" ? state : "open";
    this.scratchpadWindowState = nextState;
    await this.syncControlState();
    return this.getControlState();
  }

  async transcribeScratchpadAudio(input: {
    base64: string;
    mimeType?: string | null;
    name?: string | null;
  }): Promise<Record<string, unknown>> {
    const sessionId = await this.ensureSession();
    return this.withExecutionPulse("scratchpad-audio", async () => {
      const result = await runScratchpadAudioTranscription({
        base64: input.base64,
        mimeType: input.mimeType,
        name: input.name,
        sessionId,
      });
      return result as unknown as Record<string, unknown>;
    });
  }

  /**
   * Heuristic detector for authentication walls. Returns `detected: true` when
   * the current page looks like a login / re-auth gate so the daemon can trigger
   * an auth recovery playbook.
   */
  async detectAuthWall(page?: Page): Promise<OmniAuthWallSignal> {
    const target = page ?? this.currentPage;
    if (!target) {
      return { confidence: "low", detected: false, hints: ["no-page"], url: "" };
    }

    const url = target.url();
    const hints: string[] = [];

    // URL-based heuristics (cheap, run first)
    const lowerUrl = url.toLowerCase();
    const urlPatterns = ["/login", "/signin", "/sign-in", "/auth", "/oauth", "accounts.google", "login.microsoftonline"];
    for (const pattern of urlPatterns) {
      if (lowerUrl.includes(pattern)) {
        hints.push(`url:${pattern}`);
      }
    }

    // DOM-based heuristics
    try {
      const domHints = await target.evaluate(() => {
        const out: string[] = [];
        const hasPwd = !!document.querySelector('input[type="password"]');
        if (hasPwd) out.push("dom:password-field");

        const forms = Array.from(document.querySelectorAll("form"));
        for (const form of forms) {
          const action = (form.getAttribute("action") ?? "").toLowerCase();
          if (action.includes("login") || action.includes("auth")) {
            out.push("dom:auth-form");
            break;
          }
        }

        const title = (document.title ?? "").toLowerCase();
        if (title.includes("sign in") || title.includes("log in") || title.includes("login")) {
          out.push(`dom:title=${title.slice(0, 64)}`);
        }

        const body = (document.body?.innerText ?? "").toLowerCase();
        if (
          body.includes("session expired") ||
          body.includes("please sign in") ||
          body.includes("please log in")
        ) {
          out.push("dom:expired-copy");
        }

        return out;
      });
      hints.push(...domHints);
    } catch {
      // page may have been closed or is on chrome-error://
    }

    const detected = hints.length > 0;
    const strong = hints.some(
      (h) => h === "dom:password-field" || h === "dom:auth-form" || h === "dom:expired-copy",
    );
    const signal = {
      confidence: (strong ? "high" : detected ? "medium" : "low") as "high" | "medium" | "low",
      detected,
      hints,
      url,
    };
    // P0: Auth-wall handoff — emit handoff.requested on high-confidence auth walls
    if (signal.detected && signal.confidence === "high") {
      this.handoffRequestCounter += 1;
      const handoffRequestId = `handoff-${this.getActiveSessionId() ?? "unknown"}-${this.handoffRequestCounter}`;
      this.p0EmitEvent("handoff.requested", {
        confidence: signal.confidence,
        handoffRequestId,
        hints: signal.hints,
        reason: "auth-wall-detected",
        url: signal.url,
      });
    }
    return signal;
  }

  async screenshot(label: string = "bridge-capture"): Promise<Record<string, unknown>> {
    this.assertAutomationControlBoundary("screenshot");
    const pathToImage = await this.captureProofCheckpoint(label);
    return { path: pathToImage };
  }

  async getStatus(): Promise<Record<string, unknown>> {
    const authWall = await this.detectAuthWall();
    const hudDiagnostics = await this.inspectHudDiagnostics();
    return {
      authWall,
      badgeVisible: this.badgeVisible,
      controlPanelVisible: this.controlPanelVisible,
      currentUrl: this.currentPage?.url() ?? null,
      executing: this.executionDepth > 0,
      humanControl: this.isHumanActive,
      hudDiagnostics,
      missionLogEntries: this.missionLog.length,
      pendingHumanMessages: this.humanMessageQueue.length,
      paused: this.isPaused,
      runtimeProfile: this.runtimeProfile,
      scratchpadActiveTab: this.scratchpadActiveTab,
      scratchpadWindowState: this.scratchpadWindowState,
      scratchpadEntries: this.scratchpadHistory.length,
      sessionId: this.getActiveSessionId(),
      taskBoard: this.taskBoard,
    };
  }

  async close(): Promise<void> {
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
    }
    if (this.memoryCleanupInterval) {
      clearInterval(this.memoryCleanupInterval);
    }
    this.stopRuntimePersistence();
    try {
      await this.persistCheckpoint("shutdown");
    } catch {
      // best-effort
    }

    this.logAction(
      "MISSION_END",
      "success",
      `Total actions: ${this.missionLog.length}, Errors: ${this.missionLog.filter((entry) => entry.status === "error").length}`,
    );

    if (this.currentSession) {
      await this.sessionManager.closeSession(this.currentSession.sessionId);
      this.sessionManager.dispose();
      this.currentSession = null;
    }

    this.browser = null;
    this.context = null;
    this.currentPage = null;
  }

  private inferUserScopeFromVaultDir(userDataDir: string): string | null {
    const resolved = path.resolve(userDataDir);
    const parent = path.basename(path.dirname(resolved));
    return parent && parent !== "browser-sessions" ? parent : null;
  }

  private async registerControlCallbacks(): Promise<void> {
    if (!this.context) return;

    await safeExpose(this.context, "nle_onControlAction", async () => undefined);
    // GUARDRAIL: AI cannot auto-takeover. User MUST explicitly click "Take Over" or "Resume Mission".
    // Never call nle_takeover() automatically on blur/focus/state-change.
    // Per-session secret guards against cross-origin JS that could call window.nle_takeover()
    // without being able to read the in-page controlState. Residual risk: same-origin XSS.
    await safeExpose(
      this.context,
      "nle_takeover",
      async (_sessionIdArg?: string, providedSecret?: string) => {
        if (!providedSecret || providedSecret !== this.sessionSecret) {
          throw new Error(
            "Human control is active for session. Explicit 'Resume Mission' or 'Take Over' required.",
          );
        }
        await this.takeover("Manual takeover engaged");
      },
    );
    await safeExpose(this.context, "nle_resume", async () => {
      await this.resumeMission();
    });
    await safeExpose(this.context, "nle_togglePause", async () => {
      const paused = this.togglePause();
      return paused;
    });
    await safeExpose(this.context, "nle_humanMessage", async (message: string) => {
      await this.receiveHumanMessage(message);
    });
    await safeExpose(this.context, "nle_exportLogs", async () => {
      return this.exportScratchpadBundle();
    });
    await safeExpose(this.context, "nle_setScratchpadWindowState", async (state: string) => {
      return this.setScratchpadWindowState(state);
    });
    await safeExpose(this.context, "nle_setScratchpadTab", async (tab: string) => {
      return this.setScratchpadTab(tab);
    });
    await safeExpose(
      this.context,
      "nle_setHudPreferences",
      async (input?: { badgeVisible?: boolean; controlPanelVisible?: boolean }) => {
        return this.setHudPreferences(input ?? {});
      },
    );
    await safeExpose(this.context, "nle_processScratchpadFiles", async (files: OmniScratchpadFileInput[]) => {
      return this.processScratchpadFiles(Array.isArray(files) ? files : []);
    });
    await safeExpose(
      this.context,
      "nle_transcribeScratchpadAudio",
      async (base64: string, mimeType?: string | null, name?: string | null) => {
        return this.transcribeScratchpadAudio({ base64, mimeType, name });
      },
    );
  }

  private async runWatchdogCheck(): Promise<void> {
    if (!this.currentPage || this.isPaused) return;
    const healthy = await this.checkTabHealth(this.currentPage);
    if (!healthy) {
      await this.writeScratchpad(this.currentPage, "⚠️ Tab health check failed — attempting auto-recovery...");
      const recovered = await this.recoverTab(this.currentPage);
      if (recovered) {
        this.markCurrentPage(recovered);
        await this.writeScratchpad(recovered, "✅ Tab recovered — continuing mission");
      }
    }
  }

  private async runMemoryCleanup(): Promise<void> {
    if (!this.currentPage) return;
    try {
      const before = await this.currentPage.evaluate(() => {
        const mem = (performance as any).memory;
        return mem ? mem.usedJSHeapSize : 0;
      });
      await this.currentPage.evaluate(() => {
        try {
          const shadowRoot = (window as any).nle_shadowRoot as ShadowRoot | undefined;
          shadowRoot?.querySelectorAll(".som-badge").forEach((el) => el.remove());
        } catch {
          // Ignore transient shadow root access failures.
        }
      });
      const after = await this.currentPage.evaluate(() => {
        const mem = (performance as any).memory;
        return mem ? mem.usedJSHeapSize : 0;
      });
      const freed = before - after;
      if (freed > 0) {
        this.logAction("MEMORY_CLEANUP", "success", `Freed ${Math.round(freed / 1024)}KB`);
      }
    } catch {
      // Ignore closed pages.
    }
  }

  private async requirePage(): Promise<Page> {
    await this.ensureSession();
    const activeTab = await this.getActiveTab();
    if (activeTab && !activeTab.isClosed()) {
      return activeTab;
    }
    this.currentPage = await this.openPage();
    return this.currentPage;
  }

  private markCurrentPage(page: Page): void {
    this.currentPage = page;
    if (this.currentSession) {
      this.sessionManager.markActive(this.currentSession.sessionId, page);
    }
  }

  private logAction(
    action: string,
    status: "error" | "recovery" | "success",
    detail: string,
  ): void {
    const entry: MissionLogEntry = {
      action,
      detail: sanitizeProtectedRuntimeText(detail),
      status,
      timestamp: new Date().toISOString(),
    };
    this.missionLog.push(entry);
    this.missionLog = this.missionLog.slice(-200);
    if (this.missionLogPath) {
      atomicWriteFile(this.missionLogPath, JSON.stringify(this.missionLog, null, 2));
    }
    this.recordTaskTimeline(action, detail, status);
    this.updateTaskProgressFromAction(action, status, detail);
    this.telemetrySink?.("mission_log", entry as unknown as Record<string, unknown>);
  }

  private recordTaskTimeline(
    action: string,
    detail: string,
    status: MissionLogEntry["status"],
  ): void {
    if (!this.taskBoard.objective) {
      return;
    }

    const nextEntry: OmniTaskTimelineEntry = {
      detail,
      id: `timeline-${Date.now()}-${action.toLowerCase()}`,
      label: action.replaceAll("_", " ").trim(),
      status,
      timestamp: new Date().toISOString(),
    };

    this.taskBoard = {
      ...this.taskBoard,
      timeline: [...this.taskBoard.timeline, nextEntry].slice(-80),
    };
  }

  private updateTaskProgressFromAction(
    action: string,
    status: MissionLogEntry["status"],
    detail: string,
  ): void {
    if (!this.taskBoard.objective || this.taskBoard.checklist.length === 0) {
      return;
    }

    if (status === "error") {
      this.flagActiveTask("blocked", detail);
      this.refreshTaskBrief();
      return;
    }

    if (action === "MISSION_START") {
      this.advanceTaskProgress("mission_start", detail);
    } else if (action === "BROWSER_LAUNCH") {
      this.advanceTaskProgress("browser_launch", detail);
    } else if (action === "NAVIGATE") {
      this.advanceTaskProgress("surface_ready", detail);
    } else if (action === "MISSION_END") {
      this.advanceTaskProgress("mission_end", detail);
    } else if (action === "ERROR_SCREENSHOT" || action.includes("PROOF")) {
      this.advanceTaskProgress("proof_ready", detail);
    }

    if (status === "recovery") {
      this.flagActiveTask("active", detail);
    }

    this.refreshTaskBrief();
  }

  private advanceTaskProgress(signal: TaskProgressSignal, detail: string): void {
    const checklist = this.taskBoard.checklist.map((item) => ({ ...item }));
    const activeIndex = checklist.findIndex((item) => item.status === "active");

    const promoteIndex = (index: number) => {
      if (index < 0 || index >= checklist.length) {
        return;
      }
      checklist[index] = {
        ...checklist[index],
        detail,
        status: "completed",
      };
      const nextIndex = checklist.findIndex((item, candidateIndex) => candidateIndex > index && item.status === "pending");
      if (nextIndex >= 0) {
        checklist[nextIndex] = {
          ...checklist[nextIndex],
          status: "active",
        };
      }
    };

    switch (signal) {
      case "mission_start":
        promoteIndex(activeIndex >= 0 ? activeIndex : 0);
        break;
      case "browser_launch":
        promoteIndex(findChecklistIndex(checklist, ["launch", "runtime", "browser"]));
        break;
      case "surface_ready":
        promoteIndex(findChecklistIndex(checklist, ["open", "visit", "surface", "navigate"]));
        break;
      case "proof_ready":
        promoteIndex(findChecklistIndex(checklist, ["verify", "proof", "confirm"]));
        break;
      case "mission_end":
        for (let index = 0; index < checklist.length; index += 1) {
          if (checklist[index]?.status === "pending" || checklist[index]?.status === "active") {
            checklist[index] = {
              ...checklist[index]!,
              detail,
              status: "completed",
            };
          }
        }
        break;
    }

    this.taskBoard = {
      ...this.taskBoard,
      checklist,
    };
  }

  private flagActiveTask(status: "active" | "blocked", detail: string): void {
    const checklist = this.taskBoard.checklist.map((item) => ({ ...item }));
    const activeIndex = checklist.findIndex((item) => item.status === "active");
    if (activeIndex >= 0) {
      checklist[activeIndex] = {
        ...checklist[activeIndex],
        detail,
        status,
      };
    }
    this.taskBoard = {
      ...this.taskBoard,
      checklist,
    };
  }

  private refreshTaskBrief(): void {
    if (!this.taskBoard.objective) {
      return;
    }

    const completed = this.taskBoard.checklist.filter((item) => item.status === "completed").length;
    const blocked = this.taskBoard.checklist.filter((item) => item.status === "blocked").length;
    const headline =
      completed === this.taskBoard.checklist.length && this.taskBoard.checklist.length > 0
        ? "Mission verified and ready for review"
        : blocked > 0
          ? "Mission needs intervention"
          : "Mission is actively progressing";

    const summaryLines = [
      `Objective: ${this.taskBoard.objective}`,
      `Checklist: ${completed}/${this.taskBoard.checklist.length} steps completed`,
      blocked > 0 ? `Blocked steps: ${blocked}` : "Blocked steps: 0",
      `Proof artifacts tracked: ${this.missionLog.filter((entry) => entry.action.includes("PROOF") || entry.action.includes("SCREENSHOT")).length}`,
    ];

    this.taskBoard = {
      ...this.taskBoard,
      brief: {
        generatedAt: new Date().toISOString(),
        headline,
        proofArtifactCount: this.missionLog.filter(
          (entry) => entry.action.includes("PROOF") || entry.action.includes("SCREENSHOT"),
        ).length,
        summaryLines,
      },
    };
  }

  /**
   * P0 Frustration Detector — called when consecutiveFailures >= maxConsecutiveFailures.
   * Pauses the mission and emits handoff.requested so the cockpit can surface the issue.
   * NEVER closes the session. NEVER auto-resumes. Human must explicitly resume.
   */
  private async triggerFrustrationHandoff(
    actionType: string,
    target: string,
    reason: string,
  ): Promise<void> {
    this.consecutiveFailures = 0; // reset so we don't spam handoffs
    this.handoffRequestCounter += 1;
    const handoffRequestId = `handoff-${this.getActiveSessionId() ?? "unknown"}-${this.handoffRequestCounter}`;
    // Pause the mission so the AI stops retrying
    await this.pauseMission(`Frustration threshold reached: ${reason}`).catch(() => undefined);
    // P2: Add recovery note to mission memory
    const currentUrl = this.currentPage?.url() ?? "";
    const recoveryNote = buildRecoveryNote({
      url: currentUrl,
      failureReason: reason,
      actionType,
      target,
      authWallHint: false,
      captchaHint: false,
      modalBlocked: reason.toLowerCase().includes("modal") || reason.toLowerCase().includes("dialog"),
      iframeContext: false,
      formValidationError: reason.toLowerCase().includes("validation"),
    });
    this.missionMemory.addRecoveryNote(recoveryNote);
    // P2: Create replay bundle on handoff
    const sessionId = this.getActiveSessionId() ?? "unknown";
    const planId = this.currentPlanId || sessionId;
    const axTreeHash = this.missionMemory.getLatestCheckpoint()?.axTreeHash ?? "";
    const bundle = createReplayBundle({
      memory: this.missionMemory,
      sessionId,
      planId,
      reason: "handoff-requested",
      finalUrl: currentUrl,
      finalTitle: "",
      finalAxTreeHash: axTreeHash,
      artifactBaseDir: getBrowserRecordsRoot(this.activeUserId),
    });
    this.p0EmitEvent("handoff.requested", {
      actionType,
      consecutiveFailuresAtTrigger: this.maxConsecutiveFailures,
      handoffRequestId,
      reason: "frustration-threshold-reached",
      target,
      verificationFailureReason: reason,
      // P2 metadata embedded in existing handoff event.
      // Contract: replayBundleArtifactId is the canonical artifact ID (relative path
      // from session root, e.g. "replay-bundle-{bundleId}.json").
      // This matches service.ts listArtifacts() and is what the dashboard gates replay UI on.
      // artifactPath is kept internal only and NEVER emitted to the cockpit.
      replayBundleArtifactId: bundle?.metadata.artifactId ?? null,
      completedStepCount: this.missionMemory.getCompletedSteps().length,
      recoveryCategory: recoveryNote.category,
    });
    if (bundle) {
      this.p1p2EmitEvent("replay.bundle_created", {
        bundleId: bundle.metadata.bundleId,
        // Contract: artifactId is the canonical artifact ID (relative path from session root).
        // artifactPath is kept internal only and NEVER emitted to the cockpit.
        artifactId: bundle.metadata.artifactId,
        planId: bundle.metadata.planId,
        completedStepCount: bundle.metadata.totalStepsCompleted,
        triggerReason: bundle.metadata.reason,
        createdAt: bundle.metadata.createdAt,
      });
    }
    this.logAction(
      "FRUSTRATION_HANDOFF",
      "recovery",
      `Handoff requested after ${this.maxConsecutiveFailures} consecutive failures on ${actionType}:${target}`,
    );
  }

  private readonly emitTelemetry: OmniTelemetryEmitter = (event, data) => {
    this.telemetrySink?.(event, data);
  };

  /**
   * P0 Browser Operator Engine — emit one of the four approved runtime events.
   * These flow through telemetrySink → service.ts emit() → SSE → cockpit.
   * NEVER include: base64 images, session secrets, credential values, or raw DOM.
   */
  private p0EmitEvent(
    type: "plan.created" | "observation.captured" | "verification.result" | "handoff.requested",
    data: Record<string, unknown>,
  ): void {
    this.telemetrySink?.(type, {
      ...data,
      sessionId: this.getActiveSessionId(),
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * P1+P2 — emit one of the two approved new events.
   * Only checkpoint.created and replay.bundle_created are permitted.
   * NEVER include: base64 images, session secrets, credential values, or raw DOM.
   */
  private p1p2EmitEvent(
    type: "checkpoint.created" | "replay.bundle_created",
    data: Record<string, unknown>,
  ): void {
    this.telemetrySink?.(type, {
      ...data,
      sessionId: this.getActiveSessionId(),
      timestamp: new Date().toISOString(),
    });
  }

  private describeExecutionLabel(eventLabel: string): string {
    return eventLabel.replace(/[-_]+/g, " ").trim() || "omni action";
  }

  private async inspectHudDiagnostics(): Promise<OmniHudDiagnostics> {
    if (!this.currentPage || this.currentPage.isClosed()) {
      return {
        activePageAttr: null,
        badgePresent: false,
        controlClusterPresent: false,
        hasShadowRoot: false,
        hostPresent: false,
        keyboardShellPresent: false,
        mandatorySurfacesPresent: false,
        mousePresent: false,
        nleInjectUiDefined: false,
        scratchpadPresent: false,
      };
    }

    return this.currentPage
      .evaluate(() => {
        const host = document.getElementById("nle-visual-biometrics");
        const shadow = (window as unknown as { nle_shadowRoot?: ShadowRoot }).nle_shadowRoot ?? null;
        const diagnostics = {
          activePageAttr: host?.getAttribute("data-omni-page-active") ?? null,
          badgePresent: !!shadow?.querySelector("#nle-badge"),
          controlClusterPresent: !!shadow?.querySelector("#nle-control-cluster"),
          hasShadowRoot: shadow !== null,
          hostPresent: host !== null,
          keyboardShellPresent: !!shadow?.querySelector("#nle-keyboard-shell"),
          mousePresent: !!shadow?.querySelector("#nle-magic-mouse"),
          nleInjectUiDefined:
            typeof (window as unknown as { nle_injectUI?: unknown }).nle_injectUI === "function",
          scratchpadPresent: !!shadow?.querySelector("#nle-scratchpad"),
        };

        return {
          ...diagnostics,
          mandatorySurfacesPresent:
            diagnostics.hostPresent &&
            diagnostics.hasShadowRoot &&
            diagnostics.nleInjectUiDefined &&
            diagnostics.badgePresent &&
            diagnostics.scratchpadPresent &&
            diagnostics.controlClusterPresent &&
            diagnostics.keyboardShellPresent &&
            diagnostics.mousePresent,
        };
      })
      .catch(() => ({
        activePageAttr: null,
        badgePresent: false,
        controlClusterPresent: false,
        hasShadowRoot: false,
        hostPresent: false,
        keyboardShellPresent: false,
        mandatorySurfacesPresent: false,
        mousePresent: false,
        nleInjectUiDefined: false,
        scratchpadPresent: false,
      }));
  }

  private getControlState(): OmniControlState {
    return {
      badgeVisible: this.badgeVisible,
      controlPanelVisible: this.controlPanelVisible,
      executing: this.executionDepth > 0,
      humanControl: this.isHumanActive,
      paused: this.isPaused,
      pendingHumanMessages: this.humanMessageQueue.length,
      runtimeProfile: { ...this.runtimeProfile },
      scratchpadActiveTab: this.scratchpadActiveTab,
      scratchpadWindowState: this.scratchpadWindowState,
      sessionId: this.getActiveSessionId(),
      sessionSecret: this.sessionSecret || null,
      taskBoard: {
        ...this.taskBoard,
        checklist: this.taskBoard.checklist.map((item) => ({ ...item })),
        timeline: this.taskBoard.timeline.map((entry) => ({ ...entry })),
      },
    };
  }

  private rememberScratchpadEntry(text: string, type: "ai" | "human"): void {
    this.scratchpadHistory.push({
      text: sanitizeProtectedRuntimeText(text),
      timestamp: new Date().toISOString(),
      type,
    });
    if (this.scratchpadHistory.length > 200) {
      this.scratchpadHistory.splice(0, this.scratchpadHistory.length - 200);
    }
  }

  private async renderScratchpadEntry(page: Page, text: string, type: "ai" | "human"): Promise<void> {
    await page
      .evaluate(
        ([message, messageType]) => {
          if (typeof (window as any).writeToScratchpad === "function") {
            (window as any).writeToScratchpad(message, messageType);
          }
        },
        [text, type] as const,
      )
      .catch(() => {});
  }

  private async replayScratchpadHistory(page: Page): Promise<void> {
    const recentEntries = this.scratchpadHistory.slice(-60);
    for (const entry of recentEntries) {
      await this.renderScratchpadEntry(page, entry.text, entry.type);
    }
  }

  private async syncControlState(): Promise<void> {
    const state = this.getControlState();
    // Never emit the per-session takeover secret to telemetry. It must remain
    // in-memory on the Node side + the live browser page only. Anything that
    // persists telemetry (audit log, remote sink, local file) would otherwise
    // recover the secret and bypass the cross-origin takeover guard.
    const { sessionSecret: _omitSecret, ...telemetrySafeState } = state;
    this.telemetrySink?.(
      "control_state",
      telemetrySafeState as unknown as Record<string, unknown>,
    );
    if (!this.currentPage || this.currentPage.isClosed()) {
      return;
    }

    await this.currentPage
      .evaluate((payload) => {
        (window as any).nle_controlState = payload;
        (window as any).nle_setControlState?.(payload);
      }, state)
      .catch(() => {});
  }

  private async withExecutionPulse<T>(eventLabel: string, fn: () => Promise<T>): Promise<T> {
    this.executionDepth += 1;
    const topLevelExecution = this.executionDepth === 1;
    const executionLabel = this.describeExecutionLabel(eventLabel);
    this.telemetrySink?.("execution", { active: true, label: eventLabel });
    if (topLevelExecution) {
      await this.appendScratchpadEntry(`THINK: Preparing ${executionLabel}.`);
      await this.appendScratchpadEntry(`EXECUTE: Running ${executionLabel}.`);
    }
    await this.syncControlState();
    try {
      const result = await fn();
      if (topLevelExecution) {
        await this.appendScratchpadEntry(`REFLECT: ${executionLabel} complete.`);
      }
      return result;
    } catch (error) {
      if (topLevelExecution) {
        await this.appendScratchpadEntry(`REFLECT: ${executionLabel} failed - ${toMessage(error)}.`);
      }
      throw error;
    } finally {
      this.executionDepth = Math.max(0, this.executionDepth - 1);
      this.telemetrySink?.("execution", { active: this.executionDepth > 0, label: eventLabel });
      await this.syncControlState();
    }
  }

  private assertAutomationControlBoundary(_action: string): void {
    if (!this.isPaused && !this.isHumanActive) {
      return;
    }

    throw new Error(
      "Human control is active for session. Explicit 'Resume Mission' or 'Take Over' required.",
    );
  }
}

async function safeExpose(
  context: BrowserContext,
  name: string,
  callback: (...args: any[]) => unknown,
): Promise<void> {
  try {
    await context.exposeFunction(name, callback);
  } catch {
    // Ignore duplicate exposeFunction registration during re-init.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deriveTaskChecklist(objective: string): string[] {
  const fragments = objective
    .split(/\b(?:then|and then|after that|next|finally)\b|[.;]+/gi)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part.length > 0);

  const normalized = fragments
    .map((fragment) => fragment.replace(/^(please|help me|can you|could you)\s+/i, "").trim())
    .filter((fragment) => fragment.length > 0)
    .slice(0, 3);

  const checklist = normalized.length > 0 ? normalized : [`Work through: ${objective.trim()}`];
  checklist.push("Verify outcome and capture proof");
  checklist.push("Prepare executive brief");
  return checklist.slice(0, 5);
}

function findChecklistIndex(
  checklist: OmniTaskChecklistItem[],
  patterns: string[],
): number {
  const matchedIndex = checklist.findIndex((item) =>
    patterns.some((pattern) => item.label.toLowerCase().includes(pattern)),
  );

  if (matchedIndex >= 0) {
    return matchedIndex;
  }

  return checklist.findIndex((item) => item.status === "active" || item.status === "pending");
}

function toMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message.split("\n")[0] || error.message;
  }
  return String(error);
}

function extractNavigationTarget(message: string): string | null {
  const explicit = message.match(/\b(?:go to|navigate to|open|visit|browse to)\s+([^\s]+)/i);
  if (explicit) {
    const target = explicit[1]?.trim().replace(/[),.;!?"']+$/g, "");
    if (target) {
      return normalizeNavigationUrl(target);
    }
  }
  const bareUrl = message.match(/\bhttps?:\/\/[^\s]+/i);
  if (bareUrl) {
    return bareUrl[0].replace(/[),.;!?"']+$/g, "");
  }
  const domain = message.match(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/i);
  if (domain && /\.[a-z]{2,}$/i.test(domain[1])) {
    return normalizeNavigationUrl(domain[1]);
  }
  return null;
}

function normalizeNavigationUrl(raw: string): string {
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}
