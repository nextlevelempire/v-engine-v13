import fs from "node:fs";
import path from "node:path";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { getDaemonInstanceId, getRuntimeCapabilities } from "./daemon-instance.js";
import { getOmniStandaloneService, type SessionCommand, type SessionEvent } from "./service.js";
import {
  describeRuntimeGrantForDiagnostics,
  readRuntimeGrantToken,
  verifyRuntimeGrant,
} from "./runtime-grant.js";
import {
  OmniError,
  OmniAuthRateLimitError,
  OmniPayloadTooLargeError,
} from "./omni-errors.js";
import { log } from "./log.js";
import { metrics, renderPrometheus } from "./metrics.js";
import { parseIncomingContext, type RequestContext } from "./request-context.js";

// When OMNI_DISABLE_CLIENT_ASSETS=1, the fallthrough returns 404 instead of
// serving static client assets. Used in cloud mode where there is no client.
const DISABLE_CLIENT_ASSETS = (process.env.OMNI_DISABLE_CLIENT_ASSETS ?? "") === "1";

const CLIENT_DIST_DIR = path.resolve("dist/client");
// CORS origins: defaults are empty in v0.3 because V-Engine is a
// standalone runtime — operators must set OMNI_CORS_ALLOWED_ORIGINS
// to the list of frontends that should be allowed to call this API.
// For local development, the loopback is automatically allowed when
// OMNI_ALLOW_LOOPBACK_CORS=1 (off by default to prevent accidental
// exposure).
const LOOPBACK_CORS_ENABLED = (process.env.OMNI_ALLOW_LOOPBACK_CORS ?? "") === "1";
const DEFAULT_ALLOWED_ORIGINS: string[] = LOOPBACK_CORS_ENABLED
  ? [
      "http://127.0.0.1",
      "http://127.0.0.1:4011",
      "http://localhost",
      "http://localhost:4011",
    ]
  : [];
const ALLOWED_ORIGINS = new Set([
  ...DEFAULT_ALLOWED_ORIGINS,
  ...readAllowedOriginsFromEnv(),
]);
const DEFAULT_PORT = numberFromEnv("PORT", numberFromEnv("OMNI_PORT", 4011));
const LISTEN_HOST = process.env.OMNI_LISTEN_HOST?.trim() || "127.0.0.1";
const BODY_SIZE_LIMIT = numberFromEnv("OMNI_BODY_SIZE_LIMIT", 10 * 1024 * 1024); // 10 MB
const REQUEST_TIMEOUT_MS = numberFromEnv("OMNI_REQUEST_TIMEOUT_MS", 60_000); // 60 s per request
const AUTH_FAIL_LIMIT = numberFromEnv("OMNI_AUTH_FAIL_LIMIT", 10); // 10 failures
const AUTH_FAIL_WINDOW_MS = numberFromEnv("OMNI_AUTH_FAIL_WINDOW_MS", 60_000); // 60 s window
// TLS: when both OMNI_TLS_CERT and OMNI_TLS_KEY are set, the server
// binds with HTTPS instead of HTTP. Paths to PEM files. The cert
// chain is read at boot; rotation requires a restart. K8s-friendly:
// mount the certs as a Secret volume and set the env vars to the
// in-pod paths.
const TLS_CERT_PATH = process.env.OMNI_TLS_CERT?.trim() || null;
const TLS_KEY_PATH = process.env.OMNI_TLS_KEY?.trim() || null;
const TLS_ENABLED = Boolean(TLS_CERT_PATH && TLS_KEY_PATH);
const RUNTIME_VERSION = "4.0.0";

export async function startStandaloneServer(port: number = DEFAULT_PORT) {
  const service = getOmniStandaloneService();
  const daemonInstanceId = getDaemonInstanceId();

  const requestHandler = async (request: IncomingMessage, response: ServerResponse) => {
    applyCorsHeaders(request, response);
    if ((request.method || "GET") === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    // Per-request context (P4-03): traceparent + request id. Accept
    // inbound x-omni-request-id / x-request-id / traceparent, mint
    // fresh if absent. Echoed back via response header so the client
    // can correlate.
    const ctx = parseIncomingContext(request.headers);
    response.setHeader("x-omni-request-id", ctx.requestId);
    response.setHeader("traceparent", ctx.traceparent);

    // Per-request metrics hook (P4-02). Records the final status code
    // and route label on response finish. Cheap; runs once per request.
    response.on("finish", () => {
      const status = String(response.statusCode || 0);
      const method = request.method || "GET";
      const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
      // Normalize the path to its route template (strip dynamic ids).
      const path = normalizeRoute(url.pathname);
      metrics.httpRequestsTotal.inc({ method, path, status });
      if (response.statusCode >= 400) {
        metrics.httpRequestErrorsTotal.inc({ method, path, status });
      }
    });

    const handlerDone = (async () => {
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

        // K8s-style liveness/readiness probes (P8-01). No auth required —
        // these are infrastructure endpoints, not API endpoints. /livez
        // is a process-alive check (always 200 if Node is responding).
        // /readyz returns 200 only if the runtime can serve traffic
        // (no shutdown in progress, daemon instance is initialized).
        if ((method === "GET" || method === "HEAD") && url.pathname === "/livez") {
          return writeJson(response, 200, { ok: true, status: "live" });
        }
        if ((method === "GET" || method === "HEAD") && url.pathname === "/readyz") {
          if (process.env.OMNI_SHUTTING_DOWN === "1") {
            return writeJson(response, 503, { ok: false, status: "shutting_down" });
          }
          return writeJson(response, 200, { ok: true, status: "ready" });
        }
        if ((method === "GET" || method === "HEAD") && url.pathname === "/healthz") {
          // Alias for /livez + /api/health union — kept for ops familiarity.
          return writeJson(response, 200, { ok: true, status: "live" });
        }

        // Prometheus exposition (P4-02). No auth required — this is an
        // infrastructure scrape endpoint, like the healthz probes.
        // Disable with OMNI_METRICS_DISABLED=1 if you don't want to
        // expose internal counters.
        if ((method === "GET" || method === "HEAD") && url.pathname === "/metrics") {
          if ((process.env.OMNI_METRICS_DISABLED ?? "") === "1") {
            return writeJson(response, 404, { ok: false, error: "metrics disabled" });
          }
          const body = renderPrometheus();
          response.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
          response.end(body);
          return;
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
        // Typed error path: OmniError subclasses carry httpStatus,
        // retryAfterMs, code, hint, details. The response body
        // includes all of these for client-side handling.
        if (error instanceof OmniError) {
          return writeJson(response, error.httpStatus, error.toJSON());
        }
        // Legacy / unknown error: fall back to regex-based mapping
        // so we don't regress on existing v0.1 throw-sites.
        const message = error instanceof Error ? error.message : String(error);
        const explicitStatus = (error as { httpStatus?: number })?.httpStatus;
        const statusCode = explicitStatus
          ?? (/grant|unauthorized|scope|token/i.test(message)
            ? 401
            : /budget/i.test(message)
              ? 402
              : /not\s*found|unknown\s+omni\s+session|does\s*not\s*exist/i.test(message)
                ? 404
                : /rate\s*limit|too\s*many|throttl/i.test(message)
                  ? 429
                  : /body\s*size|payload\s*too\s*large|exceeds.*limit/i.test(message)
                    ? 413
                    : 500);
        return writeJson(response, statusCode, {
          error: message,
          ok: false,
        });
      }
    })();

    // Race the handler against a hard timeout. If the handler exceeds
    // OMNI_REQUEST_TIMEOUT_MS we return 504 Gateway Timeout to the client.
    // The handler promise is NOT cancellable from here, but it will resolve
    // on its own and the response guard inside the IIFE prevents double-writes.
    let timedOut = false;
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      setTimeout(() => {
        timedOut = true;
        resolve("timeout");
      }, REQUEST_TIMEOUT_MS);
    });
    await Promise.race([handlerDone, timeoutPromise]);
    if (timedOut && !response.writableEnded) {
      log.error("request.timeout", {
        elapsedMs: REQUEST_TIMEOUT_MS,
        limitMs: REQUEST_TIMEOUT_MS,
        method: request.method,
        url: request.url,
      });
      try {
        writeJson(response, 504, {
          error: `Request exceeded OMNI_REQUEST_TIMEOUT_MS=${REQUEST_TIMEOUT_MS} ms`,
          ok: false,
        });
      } catch {
        // response already torn down
      }
    }
  };

  let server;
  if (TLS_ENABLED) {
    const cert = fs.readFileSync(TLS_CERT_PATH!);
    const key = fs.readFileSync(TLS_KEY_PATH!);
    server = createHttpsServer({ cert, key }, requestHandler);
    log.info("start.tls_enabled", { certPath: TLS_CERT_PATH });
  } else {
    server = createHttpServer(requestHandler);
  }

  await new Promise<void>((resolve) => {
    server.listen(port, LISTEN_HOST, resolve);
  });
  log.info("start.listening", {
    host: LISTEN_HOST,
    port,
    protocol: TLS_ENABLED ? "https" : "http",
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

// Sliding-window rate limiter for auth failures. Keyed by
// `${ip}:${tokenPrefix}` so a misbehaving client hitting many
// endpoints with the same bad token gets throttled, but a legitimate
// client with a real token is unaffected by a different bad-token
// caller. Memory bounded by the # of unique (ip, token) pairs seen.
const AUTH_FAIL_BUCKETS = new Map<string, { count: number; windowStart: number }>();

function recordAuthFailure(ip: string, tokenHint: string): { count: number; retryAfterMs: number } {
  const key = `${ip}:${tokenHint}`;
  const now = Date.now();
  const bucket = AUTH_FAIL_BUCKETS.get(key);
  if (!bucket || now - bucket.windowStart > AUTH_FAIL_WINDOW_MS) {
    AUTH_FAIL_BUCKETS.set(key, { count: 1, windowStart: now });
    return { count: 1, retryAfterMs: AUTH_FAIL_WINDOW_MS };
  }
  bucket.count += 1;
  return {
    count: bucket.count,
    retryAfterMs: Math.max(0, AUTH_FAIL_WINDOW_MS - (now - bucket.windowStart)),
  };
}

function checkAuthRateLimit(ip: string, tokenHint: string): { limited: boolean; retryAfterMs: number } {
  const key = `${ip}:${tokenHint}`;
  const bucket = AUTH_FAIL_BUCKETS.get(key);
  if (!bucket) return { limited: false, retryAfterMs: 0 };
  const now = Date.now();
  if (now - bucket.windowStart > AUTH_FAIL_WINDOW_MS) {
    AUTH_FAIL_BUCKETS.delete(key);
    return { limited: false, retryAfterMs: 0 };
  }
  if (bucket.count >= AUTH_FAIL_LIMIT) {
    return {
      limited: true,
      retryAfterMs: Math.max(0, AUTH_FAIL_WINDOW_MS - (now - bucket.windowStart)),
    };
  }
  return { limited: false, retryAfterMs: 0 };
}

function tokenPrefixForDiagnostics(token: string | null | undefined): string {
  if (!token || token.length < 8) return "none";
  return token.slice(0, 8);
}

function verifyRequestGrant(
  request: IncomingMessage,
  url: URL,
  daemonInstanceId: string,
  requiredScope: string,
  sessionId?: string,
) {
  const token = readRuntimeGrantToken(request, url);
  const ip = request.socket.remoteAddress || "unknown";
  const tokenHint = tokenPrefixForDiagnostics(token);

  // Pre-check: if this (ip, token) is already over the auth-fail limit,
  // reject before doing the (relatively expensive) signature check.
  const limit = checkAuthRateLimit(ip, tokenHint);
  if (limit.limited) {
    throw new OmniAuthRateLimitError(limit.retryAfterMs);
  }

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
    const result = recordAuthFailure(ip, tokenHint);
    log.warn("auth.failed", {
      ...describeRuntimeGrantForDiagnostics(token),
      currentDaemonInstanceId: daemonInstanceId,
      failCount: result.count,
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

// Collapse dynamic path segments into route templates so metrics
// don't explode with one label per session id.
function normalizeRoute(pathname: string): string {
  if (pathname.startsWith("/api/sessions/")) {
    const rest = pathname.slice("/api/sessions/".length);
    if (rest.includes("/")) {
      const [id, ...suffixParts] = rest.split("/");
      return `/api/sessions/{id}/${suffixParts.join("/")}`;
    }
    return "/api/sessions/{id}";
  }
  if (pathname.startsWith("/api/vault/")) {
    return "/api/vault/{name}";
  }
  return pathname || "/";
}

function readAllowedOriginsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  // OMNI_CORS_ALLOWED_ORIGINS is the v0.3 name. OMNI_RUNTIME_ALLOWED_ORIGINS
  // is kept as a legacy alias so existing v0.1 deployments don't break.
  const raw = env.OMNI_CORS_ALLOWED_ORIGINS ?? env.OMNI_RUNTIME_ALLOWED_ORIGINS ?? "";
  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.startsWith("http://") || origin.startsWith("https://"))
    .filter((origin) => !origin.includes("*"));
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
  let total = 0;
  for await (const chunk of request) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > BODY_SIZE_LIMIT) {
      throw new OmniPayloadTooLargeError(total, BODY_SIZE_LIMIT);
    }
    chunks.push(buf);
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
