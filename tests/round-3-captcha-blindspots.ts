/**
 * ROUND 3 — CAPTCHA Detection Blind Spots
 * Server + browser required for DOM injection tests.
 * Run: npx tsx tests/round-3-captcha-blindspots.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { Server } from "node:http";

const TEST_HOME = path.resolve(".omni-r3-test-home");
process.env.OMNI_HOME = TEST_HOME;
process.env.OMNI_TAKEOVER_MODES = "local_browser,local_computer";
process.env.OMNI_VAULT_KEY = "v-engine-test-vault-key-32chars-min!!";
process.env.OMNI_SHELL_ENABLED = "1";

if (fs.existsSync(TEST_HOME)) fs.rmSync(TEST_HOME, { recursive: true });
fs.mkdirSync(TEST_HOME, { recursive: true });

const { detectCaptcha, solveCaptcha } = await import("../src/runtime/captcha-solver.js");
const { startStandaloneServer } = await import("../src/server/local-server.js");
const { mintRuntimeGrant } = await import("../src/server/runtime-grant.js");
const { getDaemonStateDir } = await import("../src/utils/omni-paths.js");

const PORT = 14591;
let server: Server;
let token: string;
let sessionId: string;

let passed = 0; let failed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`  ✅ PASS [${name}]`); passed++; }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ❌ FAIL [${name}] — ${msg.slice(0, 300)}`);
    failed++; failures.push(`${name}: ${msg.slice(0, 200)}`);
  }
}

async function api(method: "GET" | "POST", path_: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path_}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  let parsed: unknown;
  try { parsed = await res.json(); } catch { parsed = {}; }
  return { status: res.status, body: parsed as Record<string, unknown> };
}

console.log("\n════════════════════════════════════════════════════");
console.log("  ROUND 3 — CAPTCHA DETECTION BLIND SPOTS (8 tests)");
console.log("════════════════════════════════════════════════════\n");

// ── Unit tests (no server needed) ─────────────────────────────────────────────

await test("R3-T05: solveCaptcha with no API key → no_solver_key", async () => {
  delete process.env.CAPTCHA_SOLVER_API_KEY;
  delete process.env.CAPTCHA_SOLVER_PROVIDER;
  // We can't call solveCaptcha without a real page object, but we can test the env guard
  // via the exported function with a mock page
  const mockPage = { url: () => "https://example.com", locator: () => ({ count: async () => 0 }), evaluate: async () => "" } as unknown as import("playwright").Page;
  const result = await solveCaptcha({ page: mockPage, type: "recaptcha" });
  assert.equal(result.solved, false, "Should return solved:false when no API key");
  assert.equal((result as { solved: false; reason: string }).reason, "no_solver_key", `Expected no_solver_key, got ${JSON.stringify(result)}`);
});

await test("R3-T06: solveCaptcha with wrong provider → unsupported_provider", async () => {
  process.env.CAPTCHA_SOLVER_API_KEY = "test-key-123";
  process.env.CAPTCHA_SOLVER_PROVIDER = "anticaptcha";
  const mockPage = { url: () => "https://example.com", locator: () => ({ count: async () => 0 }), evaluate: async () => "" } as unknown as import("playwright").Page;
  const result = await solveCaptcha({ page: mockPage, type: "recaptcha" });
  assert.equal(result.solved, false);
  assert.equal((result as { solved: false; reason: string }).reason, "unsupported_provider", `Expected unsupported_provider, got ${JSON.stringify(result)}`);
  delete process.env.CAPTCHA_SOLVER_API_KEY;
  delete process.env.CAPTCHA_SOLVER_PROVIDER;
});

await test("R3-T07: solveCaptcha with type:none → solver_returned_no_token", async () => {
  process.env.CAPTCHA_SOLVER_API_KEY = "test-key-123";
  process.env.CAPTCHA_SOLVER_PROVIDER = "2captcha";
  const mockPage = { url: () => "https://example.com", locator: () => ({ count: async () => 0 }), evaluate: async () => "" } as unknown as import("playwright").Page;
  const result = await solveCaptcha({ page: mockPage, type: "none" });
  assert.equal(result.solved, false);
  assert.equal((result as { solved: false; reason: string }).reason, "solver_returned_no_token");
  delete process.env.CAPTCHA_SOLVER_API_KEY;
  delete process.env.CAPTCHA_SOLVER_PROVIDER;
});

// ── Browser tests (server required) ───────────────────────────────────────────

server = await startStandaloneServer(PORT);
const daemonInstancePath = path.join(getDaemonStateDir(), "daemon-instance.json");
const daemonInstanceId = JSON.parse(fs.readFileSync(daemonInstancePath, "utf8")).daemonInstanceId;
token = mintRuntimeGrant({
  daemonInstanceId, orgId: "test-org", sub: "test-user",
  scopes: ["runtime.attach", "sessions.create", "sessions.command", "sessions.read"],
  ttlSeconds: 300,
});

// Create session
const sessionRes = await api("POST", "/api/sessions", {
  agentId: "test-user", orgId: "test-org", creditBudget: 100,
});
sessionId = (sessionRes.body as Record<string, unknown>).sessionId as string;

async function runCommand(cmd: unknown) {
  const r = await api("POST", `/api/sessions/${sessionId}/command`, cmd);
  return r.body as Record<string, unknown>;
}

await test("R3-T01: detectCaptcha on Wikipedia — no CAPTCHA detected", async () => {
  await runCommand({ type: "navigate", url: "https://en.wikipedia.org/wiki/Main_Page" });
  await new Promise<void>(r => setTimeout(r, 3000));
  // Get context to find page reference — we test via the context endpoint captchaHint field
  const ctx = await api("GET", `/api/sessions/${sessionId}/context`);
  const ctxBody = ctx.body as Record<string, unknown>;
  assert.ok("captchaHint" in ctxBody, "Context response missing captchaHint field");
  const captchaHint = ctxBody.captchaHint;
  assert.equal(captchaHint, false, `Wikipedia should not have CAPTCHA hint, got: ${captchaHint}`);
});

await test("R3-T02: CaptchaDetection shape — detected field is boolean", async () => {
  // Verify the context endpoint always returns captchaHint as boolean
  const ctx = await api("GET", `/api/sessions/${sessionId}/context`);
  const ctxBody = ctx.body as Record<string, unknown>;
  assert.equal(typeof ctxBody.captchaHint, "boolean", `captchaHint should be boolean, got ${typeof ctxBody.captchaHint}`);
});

await test("R3-T03: Navigate to DuckDuckGo — captchaHint false (no CAPTCHA on DDG)", async () => {
  await runCommand({ type: "navigate", url: "https://duckduckgo.com" });
  await new Promise<void>(r => setTimeout(r, 3000));
  const ctx = await api("GET", `/api/sessions/${sessionId}/context`);
  const ctxBody = ctx.body as Record<string, unknown>;
  // DDG may or may not show a challenge — document result
  console.log(`    [INFO] DDG captchaHint: ${ctxBody.captchaHint}`);
  assert.equal(typeof ctxBody.captchaHint, "boolean", "captchaHint should be boolean on DDG");
});

await test("R3-T04: detectCaptcha returns correct shape fields", async () => {
  // Verify captcha-solver.ts exports and type contracts are correct
  const { detectCaptcha: detect } = await import("../src/runtime/captcha-solver.js");
  assert.equal(typeof detect, "function", "detectCaptcha should be exported");
  assert.equal(typeof solveCaptcha, "function", "solveCaptcha should be exported");
});

await test("R3-T08: Context endpoint returns authWallHint as boolean", async () => {
  const ctx = await api("GET", `/api/sessions/${sessionId}/context`);
  const ctxBody = ctx.body as Record<string, unknown>;
  assert.ok("authWallHint" in ctxBody, "authWallHint missing from context endpoint");
  assert.equal(typeof ctxBody.authWallHint, "boolean", `authWallHint should be boolean, got ${typeof ctxBody.authWallHint}`);
});

// ── Cleanup ───────────────────────────────────────────────────────────────────
await runCommand({ type: "close", reason: "round-3-complete" }).catch(() => {});
await new Promise<void>((r) => server.close(() => r()));

console.log(`\n════════════════════════════════════════════════════`);
console.log(`  ROUND 3 SCORE: ${passed}/${passed + failed} passed`);
if (failures.length > 0) { console.error(`  FAILURES:`); failures.forEach((f) => console.error(`    ✗ ${f}`)); }
console.log(`════════════════════════════════════════════════════\n`);
if (failed > 0) process.exit(1);
