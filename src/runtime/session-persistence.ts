import fs from "node:fs";
import path from "node:path";
import { getSessionStateRootDir } from "../utils/omni-paths.js";
import type { OmniPayloadCrypto } from "./payload-crypto.js";

export interface OmniDaemonInfo {
  pid: number;
  port: number;
  startedAt: string;
  version: string;
}

export interface OmniSessionManifest {
  agentId: string;
  badgeVisible?: boolean;
  bridgePort: number | null;
  continuityMode?: string;
  controlPanelVisible?: boolean;
  createdAt: string;
  currentUrl: string | null;
  headless: boolean;
  heartbeatAt?: string | null;
  lastActiveAt: string;
  launchStrategy: string;
  pendingCommands: number;
  persistent?: boolean;
  runtimeProvider?: string;
  scratchpadActiveTab?: OmniScratchpadTab;
  sessionId: string;
  status: "active" | "disposed" | "paused" | "recoverable";
  taskObjective?: string | null;
  userDataDir: string;
  warmStatePath: string | null;
  operatorSessionId?: number | null;
}

export type OmniScratchpadTab = "live" | "task";

export type OmniTaskChecklistStatus = "active" | "blocked" | "completed" | "pending";

export interface OmniTaskChecklistItem {
  detail?: string;
  id: string;
  label: string;
  status: OmniTaskChecklistStatus;
}

export interface OmniTaskTimelineEntry {
  detail: string;
  id: string;
  label: string;
  status: "active" | "blocked" | "completed" | "error" | "recovery" | "success";
  timestamp: string;
}

export interface OmniTaskBriefSnapshot {
  generatedAt: string;
  headline: string;
  proofArtifactCount: number;
  summaryLines: string[];
}

export interface OmniRuntimeProfileSnapshot {
  continuityMode: string;
  heartbeatAt: string | null;
  persistent: boolean;
  provider: string;
  operatorSessionId: number | null;
}

export interface OmniTaskBoardSnapshot {
  activeTab: OmniScratchpadTab;
  brief: OmniTaskBriefSnapshot | null;
  checklist: OmniTaskChecklistItem[];
  objective: string | null;
  timeline: OmniTaskTimelineEntry[];
}

export interface OmniWarmResumeState {
  agentId: string;
  badgeVisible?: boolean;
  capturedAt: string;
  controlPanelVisible?: boolean;
  currentUrl: string | null;
  domSnapshotPath: string | null;
  humanControl: boolean;
  missionLog: Array<Record<string, unknown>>;
  pendingHumanMessages: string[];
  pendingCommands: Array<Record<string, unknown>>;
  paused: boolean;
  proofArtifacts: string[];
  runtimeProfile?: OmniRuntimeProfileSnapshot;
  scratchpadActiveTab?: OmniScratchpadTab;
  scratchpadWindowState?: "closed" | "fullscreen" | "minimized" | "open";
  scratchpadEntries: Array<{ text: string; timestamp: string; type: "ai" | "human" }>;
  sessionId: string;
  storageState: Record<string, unknown>;
  taskBoard?: OmniTaskBoardSnapshot;
  operatorSessionId?: number | null;
}

export class OmniSessionPersistence {
  private readonly daemonInfoPath: string;
  private readonly sessionsDir: string;

  constructor(private readonly baseDir: string = getSessionStateRootDir()) {
    ensureDir(this.baseDir);
    this.sessionsDir = path.join(this.baseDir, "live");
    this.daemonInfoPath = path.join(this.baseDir, "daemon.json");
    ensureDir(this.sessionsDir);
  }

  clearDaemonInfo(): void {
    if (fs.existsSync(this.daemonInfoPath)) {
      fs.unlinkSync(this.daemonInfoPath);
    }
  }

  getDaemonInfo(): OmniDaemonInfo | null {
    return readJsonFile<OmniDaemonInfo>(this.daemonInfoPath);
  }

  getSessionDir(sessionId: string): string {
    const dir = path.join(this.sessionsDir, sanitizeSegment(sessionId));
    ensureDir(dir);
    return dir;
  }

  getWarmStatePath(sessionId: string): string {
    return path.join(this.getSessionDir(sessionId), "state.enc.json");
  }

  listManifests(): OmniSessionManifest[] {
    if (!fs.existsSync(this.sessionsDir)) {
      return [];
    }

    return fs
      .readdirSync(this.sessionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) =>
        readJsonFile<OmniSessionManifest>(path.join(this.sessionsDir, entry.name, "manifest.json")),
      )
      .filter((entry): entry is OmniSessionManifest => Boolean(entry))
      .sort((a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt));
  }

  loadManifest(sessionId: string): OmniSessionManifest | null {
    return readJsonFile<OmniSessionManifest>(path.join(this.getSessionDir(sessionId), "manifest.json"));
  }

  async loadWarmState(
    sessionId: string,
    payloadCrypto?: OmniPayloadCrypto,
  ): Promise<OmniWarmResumeState | null> {
    const target = this.getWarmStatePath(sessionId);
    const parsed = readJsonFile<{
      encrypted?: Record<string, unknown>;
      payload?: OmniWarmResumeState;
    }>(target);
    if (!parsed) {
      return null;
    }
    if (parsed.payload) {
      return parsed.payload;
    }
    if (parsed.encrypted && payloadCrypto) {
      return payloadCrypto.decryptPayload<OmniWarmResumeState>(parsed.encrypted as any);
    }
    return null;
  }

  removeSession(sessionId: string): void {
    const dir = this.getSessionDir(sessionId);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  }

  saveDaemonInfo(input: OmniDaemonInfo): string {
    ensureDir(this.baseDir);
    atomicWriteFile(this.daemonInfoPath, JSON.stringify(input, null, 2));
    return this.daemonInfoPath;
  }

  saveDomSnapshot(sessionId: string, html: string): string {
    const target = path.join(this.getSessionDir(sessionId), "dom-snapshot.html");
    atomicWriteFile(target, html);
    return target;
  }

  saveManifest(input: OmniSessionManifest): string {
    const target = path.join(this.getSessionDir(input.sessionId), "manifest.json");
    atomicWriteFile(target, JSON.stringify(input, null, 2));
    return target;
  }

  async saveWarmState(input: OmniWarmResumeState, payloadCrypto?: OmniPayloadCrypto): Promise<string> {
    const target = this.getWarmStatePath(input.sessionId);
    if (payloadCrypto) {
      const encrypted = await payloadCrypto.encryptPayload(input);
      atomicWriteFile(target, JSON.stringify({ encrypted }, null, 2));
      return target;
    }

    atomicWriteFile(target, JSON.stringify({ payload: input }, null, 2));
    return target;
  }
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { mode: 0o700, recursive: true });
  }
}

function readJsonFile<T>(target: string): T | null {
  try {
    if (!fs.existsSync(target)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(target, "utf8")) as T;
  } catch {
    return null;
  }
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

export function atomicWriteFile(
  target: string,
  content: string | Buffer,
  options: { mode?: number } = {},
): void {
  const tempPath = `${target}.${process.pid}.${Date.now()}.tmp`;
  const mode = options.mode ?? 0o600;
  fs.writeFileSync(tempPath, content, { mode });
  fs.renameSync(tempPath, target);
}
