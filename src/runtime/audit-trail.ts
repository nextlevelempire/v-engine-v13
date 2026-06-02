import fs from "node:fs";
import path from "node:path";
import { atomicWriteFile } from "./session-persistence.js";
import { sanitizeProtectedRuntimeValue } from "../security/trade-secret-guard.js";
import { getAuditDir } from "../utils/omni-paths.js";

export interface OmniAuditEntry {
  agentId: string;
  commandId: string;
  durationMs?: number;
  encryptedPayload?: unknown;
  error?: string | null;
  metadata?: Record<string, unknown>;
  outcome: "error" | "success";
  payload?: Record<string, unknown> | null;
  rateLimitScope?: "agent" | "session" | null;
  sessionId: string | null;
  sensitive: boolean;
  timestamp: string;
  type: string;
}

export class OmniAuditTrail {
  constructor(private readonly baseDir: string = getAuditDir()) {
    ensureDir(this.baseDir);
  }

  append(entry: OmniAuditEntry): string {
    const target = this.getSessionLogPath(entry.sessionId);
    const sanitized = sanitizeProtectedRuntimeValue(entry);
    fs.appendFileSync(target, `${JSON.stringify(sanitized)}\n`, { mode: 0o600 });
    return target;
  }

  exportAll(targetDir: string): {
    csvPath: string;
    entries: OmniAuditEntry[];
    jsonPath: string;
  } {
    return this.writeExport(this.readAllEntries(), "all-sessions", targetDir);
  }

  exportSession(sessionId: string | null, targetDir: string): {
    csvPath: string;
    entries: OmniAuditEntry[];
    jsonPath: string;
  } {
    const entries = this.readSessionEntries(sessionId);
    return this.writeExport(entries, sanitizeSegment(sessionId ?? "unassigned"), targetDir);
  }

  readSessionEntries(sessionId: string | null): OmniAuditEntry[] {
    const target = this.getSessionLogPath(sessionId);
    if (!fs.existsSync(target)) {
      return [];
    }

    return fs
      .readFileSync(target, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as OmniAuditEntry);
  }

  private readAllEntries(): OmniAuditEntry[] {
    if (!fs.existsSync(this.baseDir)) {
      return [];
    }

    return fs
      .readdirSync(this.baseDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ndjson"))
      .flatMap((entry) =>
        fs
          .readFileSync(path.join(this.baseDir, entry.name), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as OmniAuditEntry),
      )
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  }

  private writeExport(
    entries: OmniAuditEntry[],
    safeId: string,
    targetDir: string,
  ): {
    csvPath: string;
    entries: OmniAuditEntry[];
    jsonPath: string;
  } {
    ensureDir(targetDir);
    const jsonPath = path.join(targetDir, `${safeId}-audit.json`);
    const csvPath = path.join(targetDir, `${safeId}-audit.csv`);
    const sanitizedEntries = entries.map((entry) => sanitizeProtectedRuntimeValue(entry));

    atomicWriteFile(jsonPath, JSON.stringify(sanitizedEntries, null, 2), { mode: 0o600 });
    atomicWriteFile(csvPath, toCsv(sanitizedEntries), { mode: 0o600 });

    return { csvPath, entries: sanitizedEntries, jsonPath };
  }

  private getSessionLogPath(sessionId: string | null): string {
    return path.join(this.baseDir, `${sanitizeSegment(sessionId ?? "unassigned")}.ndjson`);
  }
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function escapeCsv(value: unknown): string {
  if (value == null) {
    return "";
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function toCsv(entries: OmniAuditEntry[]): string {
  const header = [
    "timestamp",
    "type",
    "outcome",
    "agentId",
    "sessionId",
    "commandId",
    "sensitive",
    "durationMs",
    "error",
    "rateLimitScope",
    "payload",
    "encryptedPayload",
    "metadata",
  ];

  const rows = entries.map((entry) =>
    [
      entry.timestamp,
      entry.type,
      entry.outcome,
      entry.agentId,
      entry.sessionId,
      entry.commandId,
      entry.sensitive,
      entry.durationMs ?? "",
      entry.error ?? "",
      entry.rateLimitScope ?? "",
      entry.payload ?? "",
      entry.encryptedPayload ?? "",
      entry.metadata ?? "",
    ]
      .map(escapeCsv)
      .join(","),
  );

  return [header.join(","), ...rows].join("\n");
}
