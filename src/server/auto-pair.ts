import { getDaemonInstanceId } from "./daemon-instance.js";

const PAIR_ENDPOINT = "/api/runtime/pair";
const MAX_RETRIES = 10;
const BASE_DELAY_MS = 2_000;
const CAPABILITIES = ["browser", "takeover-session", "takeover-idle"];

export interface AutoPairResult {
  ok: boolean;
  device?: { id: string; label: string; capabilities: string[] };
  error?: string;
}

/**
 * Read the four bootstrap env vars from the engine-bootstrap.ts contract and
 * attempt to pair this daemon instance against the control plane.
 *
 * Retries with exponential backoff (2s, 4s, 8s, 16s, 32s, 64s, 120s capped)
 * so the control plane has time to become reachable if the container starts
 * before the orchestrator is ready to accept the pair request.
 *
 * After MAX_RETRIES (~5.5 minutes worst-case) the engine exits with a fatal
 * error — the orchestrator will restart it per its restart policy.
 */
export async function autoPair(): Promise<AutoPairResult> {
  const pairingToken = process.env.OMNI_PAIRING_TOKEN?.trim();
  const controlPlaneUrl = process.env.OMNI_CONTROL_PLANE_URL?.trim();
  const deviceLabel = process.env.OMNI_DEVICE_LABEL?.trim() || "Cloud Computer";
  const daemonPort = Number(process.env.OMNI_DAEMON_PORT ?? process.env.OMNI_PORT ?? 4011);
  const publicUrl = process.env.OMNI_AGENT_PUBLIC_URL?.trim();

  // If none of the cloud env vars are set, this is a local-dev run — skip
  // auto-pair silently so the developer experience is unchanged.
  if (!pairingToken || !controlPlaneUrl || !publicUrl) {
    return { ok: false, error: "Cloud env vars not set — skipping auto-pair (local mode)" };
  }

  const daemonInstanceId = getDaemonInstanceId();
  const baseUrl = `${publicUrl.replace(/\/+$/, "")}`;
  const pairUrl = `${controlPlaneUrl.replace(/\/+$/, "")}${PAIR_ENDPOINT}`;

  const payload = {
    token: pairingToken,
    baseUrl,
    daemonInstanceId,
    label: deviceLabel,
    capabilities: CAPABILITIES,
  };

  let lastError: string | undefined;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(pairUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        const data = await response.json() as {
          device?: { id: string; label: string; capabilities: string[] };
          ok?: boolean;
        };
        console.log(
          `[auto-pair] paired as "${deviceLabel}" (${data.device?.id ?? "unknown"}) ` +
          `→ ${baseUrl}`,
        );
        return { ok: true, device: data.device };
      }

      // Non-2xx — retry unless it's a 4xx (client error won't resolve).
      if (response.status >= 400 && response.status < 500) {
        const body = await response.text().catch(() => "");
        lastError = `HTTP ${response.status}: ${body.slice(0, 200)}`;
        console.warn(`[auto-pair] client error on attempt ${attempt}: ${lastError}`);
        // Client error is unrecoverable — fail fast.
        return { ok: false, error: lastError };
      }

      lastError = `HTTP ${response.status}`;
      console.warn(`[auto-pair] attempt ${attempt}/${MAX_RETRIES} — ${lastError}, retrying...`);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      console.warn(`[auto-pair] attempt ${attempt}/${MAX_RETRIES} — ${lastError}, retrying...`);
    }

    // Exponential backoff: 2s, 4s, 8s, 16s, 32s, 64s, 120s (capped), ...
    const delay = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), 120_000);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  console.error(`[auto-pair] failed after ${MAX_RETRIES} attempts — ${lastError ?? "unknown error"}`);
  return { ok: false, error: lastError ?? "Max retries exceeded" };
}