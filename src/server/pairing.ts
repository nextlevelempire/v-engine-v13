/**
 * Device pairing — redeem a one-time pairing token from the OmniGPT cockpit so
 * THIS machine registers as the user's RuntimeDevice and lights up its chosen
 * local-takeover mode(s).
 *
 * Flow: the user picks "My browser" / "My computer" in the cockpit (V5TakeoverPicker),
 * the app mints a signed pairing token (runtime.pairLocalAgent) and shows a command
 * like `npx @omnigpt/agent pair <token>`. The user runs it; this module POSTs the
 * token + this daemon's identity/capabilities to the control plane's
 * POST /api/runtime/pair endpoint, which verifies the signature and upserts the
 * RuntimeDevice. From then on the control plane routes that user's local-takeover
 * missions here over the same grant/attach/session HTTP contract.
 *
 * Credential safety (hard rule): pairing transmits NO passwords — only the signed
 * token, the reachable baseUrl, a stable daemonInstanceId, and advertised capabilities.
 */
import os from "node:os";
import { getDaemonInstanceId, getRuntimeCapabilities } from "./daemon-instance.js";
import { loadTakeoverConfig, saveTakeoverConfig, type TakeoverCapability } from "./takeover-config.js";

export type PairResult = {
  device: { capabilities?: string[]; id?: string; label?: string } | null;
  baseUrl: string;
  capabilities: string[];
};

function controlPlaneUrl(): string {
  const raw = process.env.OMNI_CONTROL_PLANE_URL?.trim();
  if (!raw) {
    throw new Error(
      "OMNI_CONTROL_PLANE_URL is not set. Point it at your OmniGPT control plane (e.g. https://tryomnigpt.com) before pairing.",
    );
  }
  return raw;
}

/**
 * The URL the control plane uses to reach this daemon. A serverless control plane
 * cannot reach the user's localhost, so a public tunnel/LAN URL is required for
 * real takeover. We accept it from config (set on a prior pair) or env, and only
 * fall back to a localhost URL when explicitly allowed (dev / same-host control plane).
 */
function resolveBaseUrl(port: number): string {
  const fromEnv = process.env.OMNI_AGENT_PUBLIC_URL?.trim();
  if (fromEnv) {
    return fromEnv.replace(/\/+$/, "");
  }
  const fromConfig = loadTakeoverConfig().baseUrl;
  if (fromConfig) {
    return fromConfig.replace(/\/+$/, "");
  }
  if (process.env.OMNI_ALLOW_LOCALHOST_BASEURL === "1") {
    return `http://127.0.0.1:${port}`;
  }
  throw new Error(
    "No reachable base URL for this machine. Set OMNI_AGENT_PUBLIC_URL to a URL the control plane can reach " +
      "(a tunnel like ngrok/cloudflared, or a LAN URL). For a same-host dev control plane, set OMNI_ALLOW_LOCALHOST_BASEURL=1.",
  );
}

function defaultLabel(): string {
  const host = os.hostname?.() || "My Computer";
  return host.trim() || "My Computer";
}

/** Advertised takeover capabilities (subset of getRuntimeCapabilities). */
function advertisedTakeoverCapabilities(): TakeoverCapability[] {
  return getRuntimeCapabilities().filter(
    (cap): cap is TakeoverCapability => cap.startsWith("takeover:"),
  );
}

export async function pairWithControlPlane(input: {
  token: string;
  port: number;
  label?: string;
}): Promise<PairResult> {
  const token = input.token?.trim();
  if (!token) {
    throw new Error("Missing pairing token. Copy it from the OmniGPT cockpit and run: pair <token>");
  }

  const baseUrl = resolveBaseUrl(input.port);
  const daemonInstanceId = getDaemonInstanceId();
  const capabilities = getRuntimeCapabilities();
  const takeover = advertisedTakeoverCapabilities();
  if (takeover.length === 0) {
    throw new Error(
      "This machine advertises no local-takeover capability. Enable at least one mode " +
        '(OMNI_TAKEOVER_MODES="local_browser" or OMNI_ENABLE_LOCAL_COMPUTER=1) before pairing.',
    );
  }

  const label = input.label?.trim() || loadTakeoverConfig().label || defaultLabel();
  const target = new URL("/api/runtime/pair", controlPlaneUrl());

  const response = await fetch(target, {
    body: JSON.stringify({ baseUrl, capabilities, daemonInstanceId, label, token }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

  const text = await response.text().catch(() => "");
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    parsed = {};
  }

  if (!response.ok) {
    const message =
      (typeof parsed.error === "string" && parsed.error) ||
      `Pairing failed (${response.status}). ${text}`.trim();
    throw new Error(message);
  }

  // Persist successful pairing so future serves reuse the same baseUrl/label.
  const config = loadTakeoverConfig();
  saveTakeoverConfig({
    ...config,
    baseUrl,
    label,
    pairedAt: new Date().toISOString(),
  });

  const device =
    parsed.device && typeof parsed.device === "object"
      ? (parsed.device as PairResult["device"])
      : null;

  return { baseUrl, capabilities, device };
}
