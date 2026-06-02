/**
 * Takeover configuration — which local-takeover capabilities THIS machine offers,
 * and the public base URL the OmniGPT control plane uses to reach this daemon.
 *
 * This is the v4 (engine) side of the "real local takeover" contract. The picker
 * in omni-browser-app shows three modes (cloud / local_browser / local_computer);
 * a machine becomes eligible for a local mode only once its daemon advertises the
 * matching takeover capability on /api/health AND has paired as a RuntimeDevice.
 *
 * Persistence is a small JSON file in the daemon state dir — no DB, no schema.
 * Credential safety: nothing here ever stores user passwords; it only records
 * device identity, the enabled takeover capabilities, and the pairing baseUrl.
 */
import fs from "node:fs";
import path from "node:path";
import { getDaemonStateDir } from "../utils/omni-paths.js";
import { atomicWriteFile } from "../runtime/session-persistence.js";

export const TAKEOVER_CAPABILITIES = [
  "takeover:local_browser",
  "takeover:local_computer",
] as const;

export type TakeoverCapability = (typeof TAKEOVER_CAPABILITIES)[number];

export type TakeoverConfig = {
  /** Public URL the control plane can reach (tunnel or LAN). Set at pair time. */
  baseUrl: string | null;
  /** Takeover capabilities this machine offers. */
  enabledCapabilities: TakeoverCapability[];
  /** Friendly device label shown in the cockpit device list. */
  label: string | null;
  /** Last successful pairing timestamp (ISO), informational. */
  pairedAt: string | null;
};

const CONFIG_PATH = path.join(getDaemonStateDir(), "takeover.json");

function isTakeoverCapability(value: unknown): value is TakeoverCapability {
  return (
    typeof value === "string" &&
    (TAKEOVER_CAPABILITIES as readonly string[]).includes(value)
  );
}

/**
 * Capabilities enabled by env override (OMNI_TAKEOVER_MODES="local_browser,local_computer"),
 * or null when unset. Lets operators force a machine's offered modes without editing JSON.
 */
function envEnabledCapabilities(): TakeoverCapability[] | null {
  const raw = process.env.OMNI_TAKEOVER_MODES?.trim();
  if (!raw) {
    return null;
  }
  const mapped = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .map((entry) => (entry.startsWith("takeover:") ? entry : `takeover:${entry}`))
    .filter(isTakeoverCapability);
  return Array.from(new Set(mapped));
}

/** Capabilities the machine can offer by default when nothing is configured. */
function defaultEnabledCapabilities(): TakeoverCapability[] {
  // local_browser only needs Chrome + Playwright (always present in this daemon).
  // local_computer needs OS screen/input control, opted in explicitly to avoid
  // advertising desktop control the user did not intend.
  const caps: TakeoverCapability[] = ["takeover:local_browser"];
  if (process.env.OMNI_ENABLE_LOCAL_COMPUTER === "1") {
    caps.push("takeover:local_computer");
  }
  return caps;
}

export function loadTakeoverConfig(): TakeoverConfig {
  let stored: Partial<TakeoverConfig> = {};
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      stored = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as Partial<TakeoverConfig>;
    }
  } catch {
    stored = {};
  }

  const envCaps = envEnabledCapabilities();
  const storedCaps = Array.isArray(stored.enabledCapabilities)
    ? stored.enabledCapabilities.filter(isTakeoverCapability)
    : [];

  const enabledCapabilities =
    envCaps ?? (storedCaps.length > 0 ? storedCaps : defaultEnabledCapabilities());

  return {
    baseUrl: typeof stored.baseUrl === "string" && stored.baseUrl.trim() ? stored.baseUrl : null,
    enabledCapabilities: Array.from(new Set(enabledCapabilities)),
    label: typeof stored.label === "string" && stored.label.trim() ? stored.label : null,
    pairedAt: typeof stored.pairedAt === "string" && stored.pairedAt.trim() ? stored.pairedAt : null,
  };
}

export function saveTakeoverConfig(config: TakeoverConfig): void {
  atomicWriteFile(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

/** The takeover capabilities advertised on /api/health for this machine. */
export function getEnabledTakeoverCapabilities(): TakeoverCapability[] {
  return loadTakeoverConfig().enabledCapabilities;
}
