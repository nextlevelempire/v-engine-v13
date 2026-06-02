import fs from "node:fs";
import path from "node:path";
import { atomicWriteFile } from "../runtime/session-persistence.js";
import { getVaultDir, getVaultEntryPath } from "./omni-paths.js";

export interface OmniVaultEntry {
  capturedAt: string;
  cookies: Array<Record<string, unknown>>;
  domains: string[];
  envelope?: Record<string, unknown>;
  lastUrl: string;
  service: string;
  title: string;
  userAgent: string;
}

export function saveVaultEntry(entry: OmniVaultEntry, userId?: string | null): string {
  const target = getVaultEntryPath(entry.service, userId);
  atomicWriteFile(target, JSON.stringify(entry, null, 2), { mode: 0o600 });
  return target;
}

export function loadVaultEntry(service: string, userId?: string | null): OmniVaultEntry | null {
  const target = getVaultEntryPath(service, userId);
  if (!fs.existsSync(target)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(target, "utf8")) as OmniVaultEntry;
  } catch {
    return null;
  }
}

export function listVaultEntries(userId?: string | null): OmniVaultEntry[] {
  const dir = getVaultDir(userId);
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs
    .readdirSync(dir)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, entry), "utf8")) as OmniVaultEntry;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is OmniVaultEntry => Boolean(entry));
}
