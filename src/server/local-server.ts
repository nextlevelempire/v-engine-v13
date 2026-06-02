import fs from "node:fs";
import path from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { getDaemonInstanceId, getRuntimeCapabilities } from "./daemon-instance.js";
import { getOmniStandaloneService, type SessionCommand, type SessionEvent } from "./service.js";
import {
  describeRuntimeGrantForDiagnostics,
  readRuntimeGrantToken,
  verifyRuntimeGrant,
} from "./runtime-grant.js";

// When OMNI_DISABLE_CLIENT_ASSETS=1, the fallthrough returns 404 instead of
// serving static client assets. Used in cloud mode where there is no client.
const DISABLE_CLIENT_ASSETS = (process.env.OMNI_DISABLE_CLIENT_ASSETS ?? "") === "1";

const CLIENT_DIST_DIR = path.resolve("dist/client");
const DEFAULT_ALLOWED_ORIGINS = [
  "https://omnibrowser.online",
  "https://www.omnibrowser.online",
];
const ALLOWED_ORIGINS = new Set([
  ...DEFAULT_ALLOWED_ORIGINS,
  ...readAllowedOriginsFromEnv(),
]);
const DEFAULT_PORT = numberFromEnv("PORT", numberFromEnv("OMNI_PORT", 4011));
const LISTEN_HOST = process.env.OMNI_LISTEN_HOST?.trim() || "127.0.0.1";
const RUNTIME_VERSION = "4.0.0";

export async function startStandaloneServer(port: number = DEFAULT_PORT) {
  const service = getOmniStandaloneService();
  const daemonInstanceId = getDaemonInstanceId();

  const server = createServer(async (request, response) => {
    applyCorsHeaders(request, response);
    if ((request.method || "GET") === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    try {
      const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
      const method = request.method || "GET";

      if ((method === "GET" || method === "HEAD") && url.pathname === "/api/health") {
        // Scope-free grant validation: verify the token is structurally valid
        // (signature, expiry, daemon match) but do NOT require a specific scope.
        // The control plane's pingRuntimeHealth calls health as a preflight
        // before issuing any session-scoped grant — requiring a scope here
        // would create a bootstrapping deadlock.
        verifyRequestGrant(request, url, daemonInstanceId, "");
        return writeJson(response, 200, buildHealthPayload(port, daemonInstanceId));
      }

      if (method === "POST" && url.pathname === "/api/runtime/attach") {
        const claims = verifyRequestGrant(request, url, daemonInstanceId, "runtime.attach");
        return writeJson(response, 200, {
          attached: true,
          claims,
          daemonInstanceId,
        });
      }

      if (method === "GET" && url.pathname === "/api/sessions") {
        const claims = verifyRequestGrant(request, url, daemonInstanceId, "sessions.create");
        return writeJson(response, 200, {
          sessions: service.listSessions({ orgId: claims.orgId, userId: claims.sub }),
        });
      }

      if (method === "POST" && url.pathname === "/api/sessions") {
        const claims = verifyRequestGrant(request, url, daemonInstanceId, "sessions.create");
        const payload = (await readJsonBody(request)) as {
          creditBudget?: number;
          objective?: string | null;
          operatorSessionId?: number | null;
          orgId?: string | null;
          persistent?: boolean;
          policyVersion?: string | null;
          sessionId?: string;
          userId?: string | null;
        };
        if (payload.orgId && payload.orgId !== claims.orgId) {
          throw new Error("Grant org mismatch.");
        }
        if (payload.userId && payload.userId !== claims.sub) {
          throw new Error("Grant user mismatch.");
        }
        const session = await service.createSession({
          agentId: claims.sub,
          creditBudget: payload.creditBudget ?? claims.creditBudget ?? 0,
          objective: payload.objective,
          operatorSessionId: payload.operatorSessionId ?? null,
          orgId: claims.orgId,
          persistent: payload.persistent === true,
          policyVersion: payload.policyVersion ?? claims.policyVersion,
          sessionId: payload.sessionId ?? claims.sessionId,
          userId: claims.sub,
        });
        return writeJson(response, 201, session);
      }

      if (method === "GET" && url.pathname === "/api/vault") {
        const claims = verifyRequestGrant(request, url, daemonInstanceId, "vault.read");
        return writeJson(response, 200, { entries: service.listVaultEntries(claims.sub) });
      }

      const vaultGetMatch = url.pathname.match(/^\/api\/vault\/([^/]+)$/);
      if (method === "GET" && vaultGetMatch) {
        const claims = verifyRequestGrant(request, url, daemonInstanceId, "vault.read");
        const serviceName = decodeURIComponent(vaultGetMatch[1] || "");
        return writeJson(response, 200, { entry: service.getVaultEntry(serviceName, claims.sub) });
      }

      const vaultSaveMatch = url.pathname.match(/^\/api\/vault\/([^/]+)\/save$/);
      if (method === "POST" && vaultSaveMatch) {
        const claims = verifyRequestGrant(request, url, daemonInstanceId, "vault.write");
        const serviceName = decodeURIComponent(vaultSaveMatch[1] || "");
        const payload = (await readJsonBody(request)) as Record<string, unknown>;
        const entry = service.saveVaultPayload(serviceName, claims.sub, payload as any, claims.orgId);
        return writeJson(response, 200, entry);
      }

      const vaultLoadMatch = url.pathname.match(/^\/api\/vault\/([^/]+)\/load$/);
      if (method === "POST" && vaultLoadMatch) {
        const claims = verifyRequestGrant(request, url, daemonInstanceId, "vault.read");
        const serviceName = decodeURIComponent(vaultLoadMatch[1] || "");
        const entry = service.loadVaultPayload(serviceName, claims.sub);
        return writeJson(response, 200, entry ?? {});
      }

      const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (method === "GET" && sessionMatch) {
        const sessionId = decodeURIComponent(sessionMatch[1] || "");
        verifyRequestGrant(request, url, daemonInstanceId, "sessions.command", sessionId);
        const status = await service.getSessionStatus(sessionId);
        return writeJson(response, 200, status);
      }

      const commandMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/command$/);
      if (method === "POST" && commandMatch) {
        const sessionId = decodeURIComponent(commandMatch[1] || "");
        const claims = verifyRequestGrant(request, url, daemonInstanceId, "sessions.command", sessionId);
        const command = (await readJsonBody(request)) as SessionCommand & { agentId?: string };
        const result = await service.executeCommand(sessionId, command, {
          agentId: claims.sub,
          ip: request.socket.remoteAddress,
          orgId: claims.orgId,
          userAgent: request.headers["user-agent"] || null,
          userId: claims.sub,
        });
        return writeJson(response, 200, result);
      }

      const screenshotMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/screenshot$/);
      if (method === "POST" && screenshotMatch) {
        const sessionId = decodeURIComponent(screenshotMatch[1] || "");
        const claims = verifyRequestGrant(request, url, daemonInstanceId, "sessions.command", sessionId);
        const payload = (await readJsonBody(request)) as { label?: string };
        const result = await service.executeCommand(
          sessionId,
          {
            label: payload.label,
            type: "screenshot",
          },
          {
            agentId: claims.sub,
            ip: request.socket.remoteAddress,
            orgId: claims.orgId,
            userAgent: request.headers["user-agent"] || null,
            userId: claims.sub,
          },
        );
        return writeJson(response, 200, result);
      }

      const artifactsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/artifacts$/);
      if (method === "GET" && artifactsMatch) {
        const sessionId = decodeURIComponent(artifactsMatch[1] || "");
        const claims = verifyRequestGrant(request, url, daemonInstanceId, "artifacts.read", sessionId);
        return writeJson(response, 200, { artifacts: service.listArtifacts(sessionId, claims.sub) });
      }

      const artifactMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/artifacts\/([^/]+)$/);
      if (method === "GET" && artifactMatch) {
        const sessionId = decodeURIComponent(artifactMatch[1] || "");
        const claims = verifyRequestGrant(request, url, daemonInstanceId, "artifacts.read", sessionId);
        const artifactId = decodeURIComponent(artifactMatch[2] || "");
        const artifact = service.getArtifact(sessionId, artifactId, claims.sub);
        if (!artifact) {
          return writeJson(response, 404, { error: "Artifact not found", ok: false });
        }
        const targetPath = typeof artifact.path === "string" ? artifact.path : null;
        if (targetPath && fs.existsSync(targetPath)) {
          response.writeHead(200, {
            "content-type": contentTypeFor(targetPath),
          });
          response.end(fs.readFileSync(targetPath));
          return;
        }
        return writeJson(response, 200, artifact);
      }

      const eventsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/events$/);
      if (method === "GET" && eventsMatch) {
        const sessionId = decodeURIComponent(eventsMatch[1] || "");
        verifyRequestGrant(request, url, daemonInstanceId, "sessions.command", sessionId);
        return openEventStream(
          response,
          sessionId,
          service.subscribe(sessionId, (event) => {
            writeEvent(response, event);
          }),
        );
      }

      if (!DISABLE_CLIENT_ASSETS && !url.pathname.startsWith("/api/")) {
        return serveClientAsset(url.pathname, response);
      }

      return writeJson(response, 404, { error: "Not found", ok: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusCode = /grant|unauthorized|scope|token/i.test(message)
        ? 401
        : /budget/i.test(message)
          ? 402
          : 500;
      return writeJson(response, statusCode, {
        error: message,
        ok: false,
      });
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(port, LISTEN_HOST, resolve);
  });

  return server;
}

function buildHealthPayload(port: number, daemonInstanceId: string) {
  return {
    capabilities: getRuntimeCapabilities(),
    daemonInstanceId,
    launchMode: "external-browser",
    ok: true,
    port,
    runtime: "standalone-runtime",
    runtimeVersion: RUNTIME_VERSION,
    transport: "http+sse",
  };
}

function verifyRequestGrant(
  request: IncomingMessage,
  url: URL,
  daemonInstanceId: string,
  requiredScope: string,
  sessionId?: string,
) {
  const token = readRuntimeGrantToken(request, url);

  try {
    const opts: {
      daemonInstanceId: string;
      requiredScope?: string;
      sessionId?: string;
    } = { daemonInstanceId, sessionId };
    // Empty string = scope-free validation (health preflight).
    if (requiredScope) {
      opts.requiredScope = requiredScope;
    }
    return verifyRuntimeGrant(token, opts);
  } catch (error) {
    console.warn("[runtime.grant] verification failed", {
      ...describeRuntimeGrantForDiagnostics(token),
      currentDaemonInstanceId: daemonInstanceId,
      message: error instanceof Error ? error.message : String(error),
      requiredScope,
      sessionId,
    });
    throw error;
  }
}

function openEventStream(response: ServerResponse, sessionId: string, unsubscribe: () => void): void {
  response.writeHead(200, {
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "content-type": "text/event-stream",
  });

  writeEvent(response, {
    data: { connected: true },
    eventId: `stream-${Date.now()}`,
    sessionId,
    timestamp: new Date().toISOString(),
    type: "stream.ready",
  });

  const heartbeat = setInterval(() => {
    response.write(": keep-alive\n\n");
  }, numberFromEnv("OMNI_SSE_HEARTBEAT_MS", 15_000));

  const close = () => {
    clearInterval(heartbeat);
    unsubscribe();
    response.end();
  };

  response.on("close", close);
  response.on("error", close);
}

function writeEvent(response: ServerResponse, event: SessionEvent): void {
  response.write(`id: ${event.eventId}\n`);
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function applyCorsHeaders(request: IncomingMessage, response: ServerResponse): void {
  const requestOrigin = request.headers.origin;
  if (typeof requestOrigin === "string" && ALLOWED_ORIGINS.has(requestOrigin)) {
    response.setHeader("access-control-allow-origin", requestOrigin);
    response.setHeader("access-control-allow-credentials", "true");
  }
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader(
    "access-control-allow-headers",
    "Content-Type,Authorization,Accept,x-omni-runtime-token,x-omni-ingest-secret",
  );
  response.setHeader("vary", "Origin");
}

function readAllowedOriginsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.OMNI_RUNTIME_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.startsWith("https://") && !origin.includes("*"));
}

async function serveClientAsset(pathname: string, response: ServerResponse): Promise<void> {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const target = path.join(CLIENT_DIST_DIR, requested);
  if (target.startsWith(CLIENT_DIST_DIR) && fs.existsSync(target) && fs.statSync(target).isFile()) {
    response.writeHead(200, { "content-type": contentTypeFor(target) });
    response.end(fs.readFileSync(target));
    return;
  }

  const fallback = path.join(CLIENT_DIST_DIR, "index.html");
  if (fs.existsSync(fallback)) {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(fs.readFileSync(fallback));
    return;
  }

  writeJson(response, 404, { error: "Not found", ok: false });
}

function contentTypeFor(target: string): string {
  const ext = path.extname(target).toLowerCase();
  switch (ext) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".webp":
      return "image/webp";
    case ".webm":
      return "video/webm";
    default:
      return "text/plain; charset=utf-8";
  }
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  response.writeHead(statusCode, {
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
  });
  if (response.req?.method === "HEAD") {
    response.end();
    return;
  }
  response.end(body);
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name] ?? fallback);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}
