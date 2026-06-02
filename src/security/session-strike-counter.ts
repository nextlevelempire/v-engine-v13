/**
 * Standalone session strike counter.
 *
 * Tracks refusal events per session (or IP) in a rolling 2-minute window.
 * Third strike within the window disengages the session, blocks future model
 * turns before they start, and fires an operator webhook at most once.
 *
 * State is maintained in memory and checkpointed to user-scoped daemon storage
 * so the guard survives local restarts without any CRM or shared backing
 * services.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { getDaemonStateDir } from "../utils/omni-paths.js";
import { atomicWriteFile } from "../runtime/session-persistence.js";

const STRIKE_WINDOW_MS = 2 * 60_000;
const STRIKE_THRESHOLD = 3;
const DISENGAGE_TTL_MS = 24 * 60 * 60 * 1000;

type StrikeKeyParts = {
  ip?: string | null;
  sessionId?: number | string | null;
  userId?: string | null;
};

type RecordStrikeInput = StrikeKeyParts & {
  direction?: "input" | "output";
  flaggedText?: string | null;
  reason?: string | null;
  userAgent?: string | null;
};

type RecordStrikeResult = {
  strikeCount: number;
  disengaged: boolean;
  firedWebhook: boolean;
};

type GuardStateRecord = {
  disengagedUntil?: number;
  strikeEvents: number[];
  webhookFiredUntil?: number;
};

type GuardStateFile = Record<string, GuardStateRecord>;

type AdminAlertPayload = {
  direction: "input" | "output" | null;
  flaggedTextHash: string | null;
  ip: string | null;
  reason: string | null;
  sessionId: number | string | null;
  strikeCount: number;
  timestamp: string;
  userAgent: string | null;
  userId: string | null;
};

type ScopedState = {
  loaded: boolean;
  records: Map<string, GuardStateRecord>;
};

const scopedStates = new Map<string, ScopedState>();

function scopeKey(userId?: string | null): string {
  const trimmed = userId?.trim();
  return trimmed ? trimmed : "__global__";
}

function stateFileFor(userId?: string | null): { dir: string; path: string } {
  const dir = path.join(getDaemonStateDir(userId ?? undefined), "security");
  return {
    dir,
    path: path.join(dir, "strike-ledger.json"),
  };
}

function getScopedState(userId?: string | null): ScopedState {
  const key = scopeKey(userId);
  let state = scopedStates.get(key);
  if (!state) {
    state = { loaded: false, records: new Map() };
    scopedStates.set(key, state);
  }
  if (!state.loaded) {
    loadStateIfNeeded(userId, state);
  }
  return state;
}

function buildStrikeKey(parts: StrikeKeyParts): string {
  const session = parts.sessionId != null ? String(parts.sessionId) : "";
  const ip = parts.ip ?? "";
  const user = parts.userId?.trim() ?? "";
  return `strike:${user || "noUser"}:${session || "noSess"}:${ip || "noIP"}`;
}

function buildDisengageKey(parts: StrikeKeyParts): string {
  const session = parts.sessionId != null ? String(parts.sessionId) : "";
  const ip = parts.ip ?? "";
  const user = parts.userId?.trim() ?? "";
  return `disengage:${user || "noUser"}:${session || "noSess"}:${ip || "noIP"}`;
}

function buildWebhookKey(parts: StrikeKeyParts): string {
  const session = parts.sessionId != null ? String(parts.sessionId) : "";
  const ip = parts.ip ?? "";
  const user = parts.userId?.trim() ?? "";
  return `strike-webhook:${user || "noUser"}:${session || "noSess"}:${ip || "noIP"}`;
}

export async function isSessionDisengaged(parts: StrikeKeyParts): Promise<boolean> {
  const record = readRecord(buildDisengageKey(parts), parts.userId);
  if (!record.disengagedUntil) {
    return false;
  }
  if (record.disengagedUntil <= Date.now()) {
    const state = getScopedState(parts.userId);
    state.records.set(buildDisengageKey(parts), {
      ...record,
      disengagedUntil: undefined,
    });
    persistState(parts.userId);
    return false;
  }
  return true;
}

export async function recordRefusalStrike(input: RecordStrikeInput): Promise<RecordStrikeResult> {
  const strikeKey = buildStrikeKey(input);
  const disengageKey = buildDisengageKey(input);
  const webhookKey = buildWebhookKey(input);

  const strikeCount = pushStrikeEvent(strikeKey, input.userId);
  const disengaged = strikeCount >= STRIKE_THRESHOLD;
  let firedWebhook = false;

  if (disengaged) {
    markDisengaged(disengageKey, input.userId);
    if (markWebhookPending(webhookKey, input.userId)) {
      firedWebhook = await fireAdminAlert({
        direction: input.direction ?? null,
        flaggedTextHash: hashIfPresent(input.flaggedText),
        ip: input.ip ?? null,
        reason: input.reason ?? null,
        sessionId: input.sessionId ?? null,
        strikeCount,
        timestamp: new Date().toISOString(),
        userAgent: input.userAgent ?? null,
        userId: input.userId ?? null,
      });
    }
  }

  return { disengaged, firedWebhook, strikeCount };
}

export function resetStrikeStateForTests(): void {
  scopedStates.clear();
}

function pushStrikeEvent(key: string, userId?: string | null): number {
  const state = getScopedState(userId);
  const now = Date.now();
  const record = readRecord(key, userId);
  record.strikeEvents = record.strikeEvents.filter((timestamp) => now - timestamp <= STRIKE_WINDOW_MS);
  record.strikeEvents.push(now);
  state.records.set(key, record);
  persistState(userId);
  return record.strikeEvents.length;
}

function markDisengaged(key: string, userId?: string | null): void {
  const state = getScopedState(userId);
  const record = readRecord(key, userId);
  record.disengagedUntil = Date.now() + DISENGAGE_TTL_MS;
  state.records.set(key, record);
  persistState(userId);
}

function markWebhookPending(key: string, userId?: string | null): boolean {
  const state = getScopedState(userId);
  const now = Date.now();
  const record = readRecord(key, userId);
  if (record.webhookFiredUntil && record.webhookFiredUntil > now) {
    return false;
  }
  record.webhookFiredUntil = now + DISENGAGE_TTL_MS;
  state.records.set(key, record);
  persistState(userId);
  return true;
}

function readRecord(key: string, userId?: string | null): GuardStateRecord {
  pruneExpiredState(userId);
  return getScopedState(userId).records.get(key) ?? { strikeEvents: [] };
}

function pruneExpiredState(userId?: string | null): void {
  const state = getScopedState(userId);
  const now = Date.now();
  let dirty = false;
  for (const [key, record] of state.records.entries()) {
    const nextEvents = record.strikeEvents.filter((timestamp) => now - timestamp <= STRIKE_WINDOW_MS);
    const disengagedUntil = record.disengagedUntil && record.disengagedUntil > now ? record.disengagedUntil : undefined;
    const webhookFiredUntil =
      record.webhookFiredUntil && record.webhookFiredUntil > now ? record.webhookFiredUntil : undefined;

    if (
      nextEvents.length !== record.strikeEvents.length ||
      disengagedUntil !== record.disengagedUntil ||
      webhookFiredUntil !== record.webhookFiredUntil
    ) {
      dirty = true;
      if (!nextEvents.length && !disengagedUntil && !webhookFiredUntil) {
        state.records.delete(key);
      } else {
        state.records.set(key, {
          disengagedUntil,
          strikeEvents: nextEvents,
          webhookFiredUntil,
        });
      }
    }
  }

  if (dirty) {
    persistState(userId);
  }
}

function loadStateIfNeeded(userId: string | null | undefined, state: ScopedState): void {
  if (state.loaded) {
    return;
  }
  state.loaded = true;

  const { path: target } = stateFileFor(userId);
  try {
    if (!fs.existsSync(target)) {
      return;
    }
    const parsed = JSON.parse(fs.readFileSync(target, "utf8")) as GuardStateFile;
    for (const [key, record] of Object.entries(parsed)) {
      state.records.set(key, {
        disengagedUntil: typeof record.disengagedUntil === "number" ? record.disengagedUntil : undefined,
        strikeEvents: Array.isArray(record.strikeEvents)
          ? record.strikeEvents.filter((timestamp) => typeof timestamp === "number")
          : [],
        webhookFiredUntil:
          typeof record.webhookFiredUntil === "number" ? record.webhookFiredUntil : undefined,
      });
    }
    pruneExpiredState(userId);
  } catch (error) {
    console.error("[session-strike-counter] Failed to load strike state:", error);
  }
}

function persistState(userId?: string | null): void {
  const state = getScopedState(userId);
  const { dir, path: target } = stateFileFor(userId);
  ensureDir(dir);
  const payload: GuardStateFile = {};
  for (const [key, record] of state.records.entries()) {
    payload[key] = {
      disengagedUntil: record.disengagedUntil,
      strikeEvents: [...record.strikeEvents],
      webhookFiredUntil: record.webhookFiredUntil,
    };
  }
  atomicWriteFile(target, JSON.stringify(payload, null, 2), { mode: 0o600 });
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { mode: 0o700, recursive: true });
  }
}

function hashIfPresent(text: string | null | undefined): string | null {
  if (!text) {
    return null;
  }
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

async function fireAdminAlert(payload: AdminAlertPayload): Promise<boolean> {
  const url = process.env.OMNI_SECURITY_WEBHOOK_URL || "";

  const summary =
    `Standalone Omni session disengaged after ${payload.strikeCount} refusal strikes in <2min. ` +
    `session=${payload.sessionId ?? "?"} user=${payload.userId ?? "?"} ip=${payload.ip ?? "?"} ` +
    `reason=${payload.reason ?? "refusal"} hash=${payload.flaggedTextHash ?? "n/a"}`;
  console.error(`[session-strike-counter] DISENGAGE: ${summary}`);

  if (!url) {
    return false;
  }

  try {
    const response = await fetch(url, {
      body: JSON.stringify({
        level: "critical",
        source: "omni-browser-v4",
        summary,
        type: "omni.session.disengaged",
        ...payload,
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    });
    return response.ok;
  } catch (error) {
    console.error("[session-strike-counter] Webhook delivery failed:", error);
    return false;
  }
}
