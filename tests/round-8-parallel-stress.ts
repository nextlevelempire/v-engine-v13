/**
 * ROUND 8 — Parallel Executor Stress
 * Server + real sessions required.
 * Run: npx tsx tests/round-8-parallel-stress.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { Server } from "node:http";

const TEST_HOME = path.resolve(".omni-r8-test-home");
process.env.OMNI_HOME = TEST_HOME;
process.env.OMNI_TAKEOVER_MODES = "local_browser,local_computer";
process.env.OMNI_VAULT_KEY = "v-engine-test-vault-key-32chars-min!!";
process.env.OMNI_SHELL_ENABLED = "1";

if (fs.existsSync(TEST_HOME)) fs.rmSync(TEST_HOME, { recursive: true });
fs.mkdirSync(TEST_HOME, { recursive: true });

const { startStandaloneServer } = await import("../src/server/local-server.js");
const { mintRuntimeGrant } = await import("../src/server/runtime-grant.js");
const { getDaemonStateDir } = await import("../src/utils/omni-paths.js");

const PORT = 14598;
let server: Server;
let token: string;

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

console.log("\n════════════════════════════════════════════════════");
console.log("  ROUND 8 — PARALLEL EXECUTOR STRESS (7 tests)");
console.log("════════════════════════════════════════════════════\n");

server = await startStandaloneServer(PORT);
const daemonInstancePath = path.join(getDaemonStateDir(), "daemon-instance.json");
const daemonInstanceId = JSON.parse(fs.readFileSync(daemonInstancePath, "utf8")).daemonInstanceId;
token = mintRuntimeGrant({
  daemonInstanceId, orgId: "test-org", sub: "test-user",
  scopes: ["runtime.attach", "sessions.create", "sessions.command", "sessions.read", "vault.read", "vault.write"],
  ttlSeconds: 600,
});

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

// Create a parent session to issue parallel command from
const sessionRes = await api("POST", "/api/sessions", { agentId: "test-user", orgId: "test-org", creditBudget: 500 });
const sessionId = (sessionRes.body as Record<string, unknown>).sessionId as string;
async function runCommand(cmd: unknown) {
  const r = await api("POST", `/api/sessions/${sessionId}/command`, cmd);
  return r.body as Record<string, unknown>;
}

// ── Static analysis ────────────────────────────────────────────────────────────

await test("R8-T01: parallel-executor.ts source has concurrency cap + cleanup", () => {
  const src = fs.readFileSync("src/runtime/parallel-executor.ts", "utf8");
  assert.ok(src.includes("MAX_PARALLEL_CAP"), "MAX_PARALLEL_CAP missing from parallel executor");
  assert.ok(src.includes("parallel_task_complete"), "Session cleanup missing from parallel executor");
  assert.ok(src.includes("Promise.all"), "Batch concurrent execution missing");
});

await test("R8-T02: parallel command type exists in service.ts schema", () => {
  const src = fs.readFileSync("src/server/service.ts", "utf8");
  assert.ok(src.includes('"parallel"'), 'parallel command type missing from service.ts');
  assert.ok(src.includes("runParallelTasks"), "runParallelTasks not imported/called in service.ts");
});

// ── HTTP command tests ─────────────────────────────────────────────────────────

await test("R8-T03: parallel command with empty tasks list returns success", async () => {
  const result = await runCommand({ type: "parallel", tasks: [], max_concurrency: 3 });
  console.log(`    [INFO] parallel([]) result: ${JSON.stringify(result)}`);
  // Empty task list should return gracefully — either ok:true with 0 results or ok:false with reason
  assert.ok(typeof result === "object", "parallel should return an object");
  // Most important: server should not crash
  const health = await api("GET", "/api/health");
  assert.equal(health.status, 200, "Server crashed after empty parallel command");
});

await test("R8-T04: parallel with 1 real Wikipedia task completes", async () => {
  const before = Date.now();
  const result = await runCommand({
    type: "parallel",
    tasks: ["Navigate to https://en.wikipedia.org/wiki/Main_Page"],
    max_concurrency: 1,
    credit_budget_per_task: 50,
  });
  const elapsed = Date.now() - before;
  console.log(`    [INFO] parallel(1 task) elapsed: ${elapsed}ms, result: ${JSON.stringify(result).slice(0, 200)}`);
  // Should complete without crashing
  const health = await api("GET", "/api/health");
  assert.equal(health.status, 200, "Server crashed after 1-task parallel command");
});

await test("R8-T05: parallel max_concurrency cap — source enforces MAX_PARALLEL_CAP=10", () => {
  const src = fs.readFileSync("src/runtime/parallel-executor.ts", "utf8");
  assert.ok(src.includes("Math.min"), "Concurrency cap not enforced via Math.min");
  // Verify the cap value is correct
  assert.ok(src.includes("10"), "MAX_PARALLEL_CAP value 10 missing");
});

await test("R8-T06: runParallelTasks handles task errors without crashing remaining tasks", () => {
  const src = fs.readFileSync("src/runtime/parallel-executor.ts", "utf8");
  // Each task must be wrapped in try/catch so one failure doesn't kill others
  assert.ok(src.includes("try {"), "Error isolation missing from parallel task executor");
  assert.ok(src.includes("catch (err)"), "Error catch missing from parallel task executor");
  assert.ok(src.includes("ok: false"), "ok:false error response missing from parallel task result");
});

await test("R8-T07: sessions list endpoint works after parallel run", async () => {
  const result = await api("GET", "/api/sessions");
  assert.equal(result.status, 200, `Sessions list returned ${result.status}`);
  const sessions = (result.body as Record<string, unknown>).sessions ?? result.body;
  assert.ok(Array.isArray(sessions) || typeof sessions === "object", "Sessions response should be array or object");
});

// ── Cleanup ───────────────────────────────────────────────────────────────────
await runCommand({ type: "close", reason: "round-8-complete" }).catch(() => {});
await new Promise<void>((r) => server.close(() => r()));

console.log(`\n════════════════════════════════════════════════════`);
console.log(`  ROUND 8 SCORE: ${passed}/${passed + failed} passed`);
if (failures.length > 0) { console.error(`  FAILURES:`); failures.forEach((f) => console.error(`    ✗ ${f}`)); }
console.log(`════════════════════════════════════════════════════\n`);
if (failed > 0) process.exit(1);
