import { startStandaloneServer } from "./server/local-server.js";
import { autoPair } from "./server/auto-pair.js";
import { pairWithControlPlane } from "./server/pairing.js";

function resolvePort(): number {
  return Number(process.env.PORT ?? process.env.OMNI_PORT ?? 4011);
}

function resolveListenHost(): string {
  return process.env.OMNI_LISTEN_HOST?.trim() || "127.0.0.1";
}

async function runServe(): Promise<void> {
  const port = resolvePort();
  const host = resolveListenHost();
  const server = await startStandaloneServer(port);
  console.log(`[omni-browser-v4] listening on http://${host}:${port}`);

  // Auto-pair: when running in cloud mode (OMNI_PAIRING_TOKEN, OMNI_CONTROL_PLANE_URL,
  // and OMNI_AGENT_PUBLIC_URL are set), redeem the pairing token against the control
  // plane before accepting any session commands.  In local-dev mode where those vars
  // are absent, autoPair returns immediately with ok=false and a silent skip.
  const pairResult = await autoPair();
  if (!pairResult.ok && pairResult.error !== "Cloud env vars not set — skipping auto-pair (local mode)") {
    // Fatal: unrecoverable pairing failure.  The orchestrator will restart us.
    console.error("[omni-browser-v4] auto-pair failed:", pairResult.error ?? "unknown error");
    process.exitCode = 1;

    // Attempt graceful shutdown so any orphan Chrome processes are cleaned up.
    const { getOmniStandaloneService } = await import("./server/service.js");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await getOmniStandaloneService().shutdown().catch(() => undefined);
    process.exit(1);
  }

  // Graceful shutdown handler: before the orchestrator parks the container
  // (scale-to-zero), SIGTERM triggers a clean shutdown that pauses active
  // sessions, syncs final snapshots to the control plane, and flushes browser
  // cookies to the persisted profile dir (OMNI_PROFILE_DIR / Azure Files).
  // The existing start-production.sh cleanup() trap kills Xvfb after this.
  let shuttingDown = false;
  const handleShutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log("[omni-browser-v4] SIGTERM received — shutting down gracefully...");

    // Close the HTTP server first (stop accepting new connections).
    await new Promise<void>((resolve) => server.close(() => resolve()));

    // Shut down the service — pauses all sessions, syncs snapshots,
    // closes Playwright browser contexts (flushes cookies to disk).
    const { getOmniStandaloneService } = await import("./server/service.js");
    await getOmniStandaloneService().shutdown();

    console.log("[omni-browser-v4] graceful shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", handleShutdown);
  process.on("SIGINT", handleShutdown);
}

async function runPair(): Promise<void> {
  const token = process.argv[3]?.trim();
  if (!token) {
    throw new Error(
      'Usage: pair <token>\nCopy the pairing token from the OmniGPT cockpit ("Connect your computer").',
    );
  }
  const result = await pairWithControlPlane({ port: resolvePort(), token });
  console.log("[omni-browser-v4] paired with OmniGPT control plane.");
  console.log(`  device:       ${result.device?.label ?? "(this machine)"} (${result.device?.id ?? "?"})`);
  console.log(`  reachable at: ${result.baseUrl}`);
  console.log(`  capabilities: ${(result.device?.capabilities ?? result.capabilities).join(", ")}`);
  console.log(
    "\nNow run `serve` (or `npx @omnigpt/agent serve`) and your local modes will light up in the cockpit.",
  );
}

async function main(): Promise<void> {
  const command = process.argv[2] || "serve";
  switch (command) {
    case "serve":
      await runServe();
      return;
    case "pair":
      await runPair();
      return;
    default:
      throw new Error(`Unsupported command: ${command}`);
  }
}

main().catch((error) => {
  console.error("[omni-browser-v4] fatal:", error);
  process.exitCode = 1;
});