import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";

const TEST_SECRET = "qa-062-runtime-grant-secret";
const TEST_INGEST_SECRET = "qa-062-runtime-ingest-secret";
const CANONICAL_WWW = "https://www.omnibrowser.online";
const CANONICAL_APEX = "https://omnibrowser.online";
const DIAGNOSTIC_ORIGIN = "https://diagnostic.omnibrowser.online";
const REJECTED_ORIGIN = "https://evil.example";
const PORT = 4317;

let assertions = 0;
let proofPassed = false;

process.env.NODE_ENV = "test";
process.env.OMNI_DASHBOARD_JWT_SECRET = TEST_SECRET;
process.env.OMNI_RUNTIME_ALLOWED_ORIGINS = `${DIAGNOSTIC_ORIGIN},*,http://bad.example`;
process.env.OMNI_HOME = path.join(os.tmpdir(), `omni-v5-bridge-proof-${process.pid}`);

function ok(value: unknown, message: string): void {
  assert.ok(value, message);
  assertions += 1;
}

function equal<T>(actual: T, expected: T, message: string): void {
  assert.equal(actual, expected, message);
  assertions += 1;
}

function absent(value: unknown, message: string): void {
  assert.equal(value, null, message);
  assertions += 1;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(value: string): string {
  return base64url(crypto.createHmac("sha256", TEST_SECRET).update(value).digest());
}

function runtimeGrant(input: {
  daemonInstanceId: string;
  scopes: string[];
  sessionId?: string;
}): string {
  const iat = Math.floor(Date.now() / 1000);
  const payload = {
    creditBudget: 10,
    daemonInstanceId: input.daemonInstanceId,
    exp: iat + 300,
    iat,
    iss: "omni-browser-app",
    orgId: "org_bridge_proof",
    policyVersion: "qa-062",
    scopes: input.scopes,
    sessionId: input.sessionId,
    sub: "user_bridge_proof",
  };
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  return `${header}.${body}.${sign(`${header}.${body}`)}`;
}

function tamperGrant(token: string): string {
  return `${token.slice(0, -1)}${token.endsWith("x") ? "y" : "x"}`;
}

async function preflight(baseUrl: string, pathName: string, origin: string): Promise<Response> {
  return fetch(new URL(pathName, baseUrl), {
    headers: {
      "access-control-request-headers": "authorization,content-type,x-omni-runtime-token,x-omni-ingest-secret",
      "access-control-request-method": "POST",
      origin,
    },
    method: "OPTIONS",
  });
}

function assertApprovedCors(response: Response, origin: string, label: string): void {
  equal(response.headers.get("access-control-allow-origin"), origin, `${label}: approved origin echoed exactly.`);
  equal(response.headers.get("access-control-allow-credentials"), "true", `${label}: credentials enabled for approved origin.`);
  equal(response.headers.get("access-control-allow-methods"), "GET,POST,OPTIONS", `${label}: methods preserved.`);
  ok(
    response.headers.get("access-control-allow-headers")?.includes("Authorization"),
    `${label}: authorization header preserved.`,
  );
  ok(
    response.headers.get("access-control-allow-headers")?.includes("x-omni-ingest-secret"),
    `${label}: ingest secret header preserved.`,
  );
  equal(response.headers.get("vary"), "Origin", `${label}: vary origin preserved.`);
}

function assertRejectedCors(response: Response, label: string): void {
  absent(response.headers.get("access-control-allow-origin"), `${label}: rejected origin has no allow-origin.`);
  absent(response.headers.get("access-control-allow-credentials"), `${label}: rejected origin has no credentials.`);
  equal(response.headers.get("access-control-allow-methods"), "GET,POST,OPTIONS", `${label}: methods preserved for preflight.`);
  equal(response.headers.get("vary"), "Origin", `${label}: vary origin preserved for rejected origin.`);
}

async function startMockDashboardIngest(): Promise<{
  close: () => Promise<void>;
  records: Array<{ secret: string; status: number }>;
  url: string;
}> {
  const records: Array<{ secret: string; status: number }> = [];
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    if (request.url !== "/api/runtime/ingest" || request.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    for await (const _ of request) {
      // Drain request body before responding.
    }
    const secret = String(request.headers["x-omni-ingest-secret"] ?? "");
    const status = secret === TEST_INGEST_SECRET ? 202 : 401;
    records.push({ secret, status });
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(status === 202 ? { ok: true } : { error: "Unauthorized." }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    close: async () => {
      server.closeIdleConnections();
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
    records,
    url: `http://127.0.0.1:${address.port}`,
  };
}

const mockDashboard = await startMockDashboardIngest();
process.env.OMNI_CONTROL_PLANE_URL = mockDashboard.url;
process.env.OMNI_INGEST_SECRET = TEST_INGEST_SECRET;

const [{ startStandaloneServer }, { syncRuntimeSessionSnapshot }] = await Promise.all([
  import("../src/server/local-server.js"),
  import("../src/server/control-plane-sync.js"),
]);

const server = await startStandaloneServer(PORT);
const baseUrl = `http://127.0.0.1:${PORT}`;

try {
  const health = (await (await fetch(new URL("/api/health", baseUrl))).json()) as {
    daemonInstanceId?: string;
    ok?: boolean;
  };
  equal(health.ok, true, "Runtime health returns ok.");
  ok(health.daemonInstanceId, "Runtime health exposes daemon instance ID.");

  const wwwPreflight = await preflight(baseUrl, "/api/runtime/attach", CANONICAL_WWW);
  equal(wwwPreflight.status, 204, "www attach preflight succeeds.");
  assertApprovedCors(wwwPreflight, CANONICAL_WWW, "www attach preflight");

  const apexPreflight = await preflight(baseUrl, "/api/runtime/attach", CANONICAL_APEX);
  equal(apexPreflight.status, 204, "apex attach preflight succeeds.");
  assertApprovedCors(apexPreflight, CANONICAL_APEX, "apex attach preflight");

  const diagnosticPreflight = await preflight(baseUrl, "/api/runtime/attach", DIAGNOSTIC_ORIGIN);
  equal(diagnosticPreflight.status, 204, "env diagnostic origin preflight succeeds.");
  assertApprovedCors(diagnosticPreflight, DIAGNOSTIC_ORIGIN, "env diagnostic preflight");

  const rejectedPreflight = await preflight(baseUrl, "/api/runtime/attach", REJECTED_ORIGIN);
  equal(rejectedPreflight.status, 204, "rejected origin preflight still completes.");
  assertRejectedCors(rejectedPreflight, "rejected attach preflight");

  const attachToken = runtimeGrant({
    daemonInstanceId: health.daemonInstanceId!,
    scopes: ["runtime.attach"],
  });
  const attach = await fetch(new URL("/api/runtime/attach", baseUrl), {
    body: "{}",
    headers: {
      authorization: `Bearer ${attachToken}`,
      "content-type": "application/json",
      origin: CANONICAL_WWW,
    },
    method: "POST",
  });
  equal(attach.status, 200, "Valid dashboard-issued runtime grant attaches.");
  assertApprovedCors(attach, CANONICAL_WWW, "valid attach");

  const invalidAttach = await fetch(new URL("/api/runtime/attach", baseUrl), {
    body: "{}",
    headers: {
      authorization: `Bearer ${tamperGrant(attachToken)}`,
      "content-type": "application/json",
      origin: CANONICAL_WWW,
    },
    method: "POST",
  });
  equal(invalidAttach.status, 401, "Invalid runtime grant is rejected.");
  assertApprovedCors(invalidAttach, CANONICAL_WWW, "invalid attach");

  const sessionId = "bridge-proof-session";
  const sessionToken = runtimeGrant({
    daemonInstanceId: health.daemonInstanceId!,
    scopes: ["sessions.create", "sessions.command"],
    sessionId,
  });
  const createSession = await fetch(new URL("/api/sessions", baseUrl), {
    body: JSON.stringify({
      creditBudget: 10,
      objective: null,
      orgId: "org_bridge_proof",
      policyVersion: "qa-062",
      sessionId,
      userId: "user_bridge_proof",
    }),
    headers: {
      authorization: `Bearer ${sessionToken}`,
      "content-type": "application/json",
      origin: CANONICAL_WWW,
    },
    method: "POST",
  });
  equal(createSession.status, 201, "Runtime session is created for SSE and command proof.");
  assertApprovedCors(createSession, CANONICAL_WWW, "create session");

  const commandPreflight = await preflight(baseUrl, `/api/sessions/${sessionId}/command`, CANONICAL_WWW);
  equal(commandPreflight.status, 204, "command preflight succeeds.");
  assertApprovedCors(commandPreflight, CANONICAL_WWW, "command preflight");

  const command = await fetch(new URL(`/api/sessions/${sessionId}/command`, baseUrl), {
    body: JSON.stringify({ type: "status" }),
    headers: {
      authorization: `Bearer ${sessionToken}`,
      "content-type": "application/json",
      origin: CANONICAL_WWW,
    },
    method: "POST",
  });
  equal(command.status, 200, "Runtime command POST succeeds with valid grant.");
  assertApprovedCors(command, CANONICAL_WWW, "command POST");

  const sse = await fetch(new URL(`/api/sessions/${sessionId}/events?token=${sessionToken}`, baseUrl), {
    headers: { origin: CANONICAL_WWW },
  });
  equal(sse.status, 200, "SSE stream opens with valid grant.");
  equal(sse.headers.get("content-type"), "text/event-stream", "SSE content type is preserved.");
  assertApprovedCors(sse, CANONICAL_WWW, "SSE stream");
  await sse.body?.cancel();

  await syncRuntimeSessionSnapshot({
    authWall: false,
    currentUrl: "https://www.omnibrowser.online",
    orgId: "org_bridge_proof",
    runtimeSessionId: sessionId,
    sessionId,
    status: "running",
    userId: "user_bridge_proof",
  });
  equal(mockDashboard.records.at(-1)?.status, 202, "Runtime ingest with configured secret succeeds.");
  equal(mockDashboard.records.at(-1)?.secret, TEST_INGEST_SECRET, "Runtime ingest sends the configured secret.");

  const wrongSecret = await fetch(new URL("/api/runtime/ingest", mockDashboard.url), {
    body: JSON.stringify({ kind: "session.snapshot", payload: { sessionId } }),
    headers: {
      "content-type": "application/json",
      "x-omni-ingest-secret": "wrong-secret",
    },
    method: "POST",
  });
  equal(wrongSecret.status, 401, "Wrong ingest secret is rejected.");

  const missingSecret = await fetch(new URL("/api/runtime/ingest", mockDashboard.url), {
    body: JSON.stringify({ kind: "session.snapshot", payload: { sessionId } }),
    headers: {
      "content-type": "application/json",
    },
    method: "POST",
  });
  equal(missingSecret.status, 401, "Missing ingest secret is rejected.");

  console.log(`QA-062/QA-063 V5 bridge proof: PASS (${assertions} assertions)`);
  proofPassed = true;
} finally {
  server.closeIdleConnections();
  server.closeAllConnections();
  server.close();
  await once(server, "close");
  await mockDashboard.close();
  if (proofPassed) {
    process.exit(0);
  }
}
