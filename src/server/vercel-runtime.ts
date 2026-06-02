import { getDaemonInstanceId, getRuntimeCapabilities } from "./daemon-instance.js";
import { readRuntimeGrantToken, verifyRuntimeGrant } from "./runtime-grant.js";

const RUNTIME_VERSION = "4.0.0";

export function buildHealthPayload() {
  return {
    capabilities: getRuntimeCapabilities(),
    daemonInstanceId: getDaemonInstanceId(),
    launchMode: "external-browser",
    ok: true,
    runtime: "standalone-runtime",
    runtimeVersion: RUNTIME_VERSION,
    transport: "http+sse",
  };
}

export function buildRequestUrl(req: any): URL {
  return new URL(req.url || "/", `http://${req.headers?.host || "127.0.0.1"}`);
}

export function requireGrant(req: any, requiredScope: string, sessionId?: string) {
  const daemonInstanceId = getDaemonInstanceId();
  const url = buildRequestUrl(req);
  const token = readRuntimeGrantToken(req as any, url);
  const claims = verifyRuntimeGrant(token, {
    daemonInstanceId,
    requiredScope,
    sessionId,
  });
  return { claims, daemonInstanceId, url };
}

export function readRemoteAddress(req: any): string | null {
  const forwarded = req.headers?.["x-forwarded-for"];
  if (Array.isArray(forwarded)) {
    return forwarded[0] ?? null;
  }
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0]?.trim() ?? null;
  }
  return req.socket?.remoteAddress ?? null;
}
