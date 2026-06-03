/**
 * ROUND 6 — Shell Executor Safety Blind Spots
 * Pure unit tests — no server needed.
 * Run: npx tsx tests/round-6-shell-blindspots.ts
 */

import assert from "node:assert/strict";

process.env.OMNI_SHELL_ENABLED = "1";
process.env.OMNI_VAULT_KEY = "v-engine-test-vault-key-32chars-min!!";

const { runShellCommand } = await import("../src/runtime/shell-executor.js");

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
console.log("  ROUND 6 — SHELL SAFETY BLIND SPOTS (10 tests)");
console.log("════════════════════════════════════════════════════\n");

await test("R6-T01: rm -rf / is blocked", async () => {
  const r = await runShellCommand("rm -rf /");
  assert.equal(r.ok, false, "rm -rf / should return ok:false");
  assert.ok(r.error?.includes("blocked") || r.error?.includes("policy"), `Expected block message, got: "${r.error}"`);
});

await test("R6-T02: sudo whoami is blocked", async () => {
  const r = await runShellCommand("sudo whoami");
  assert.equal(r.ok, false, "sudo should be blocked");
});

await test("R6-T03: cat /etc/passwd is blocked", async () => {
  const r = await runShellCommand("cat /etc/passwd");
  assert.equal(r.ok, false, "cat /etc/passwd should be blocked");
});

await test("R6-T04: cat ~/.ssh/id_rsa is blocked", async () => {
  const r = await runShellCommand("cat ~/.ssh/id_rsa");
  assert.equal(r.ok, false, "cat ~/.ssh/id_rsa should be blocked");
});

await test("R6-T05: dd if=/dev/urandom is blocked", async () => {
  const r = await runShellCommand("dd if=/dev/urandom of=/dev/null bs=1M count=1");
  assert.equal(r.ok, false, "dd if= should be blocked");
});

await test("R6-T06: OMNI_SHELL_ENABLED=0 disables shell", async () => {
  const orig = process.env.OMNI_SHELL_ENABLED;
  process.env.OMNI_SHELL_ENABLED = "0";
  const r = await runShellCommand("echo test");
  process.env.OMNI_SHELL_ENABLED = orig;
  assert.equal(r.ok, false, "Shell should be disabled when OMNI_SHELL_ENABLED=0");
  assert.ok(r.error?.includes("disabled"), `Expected disabled message, got: "${r.error}"`);
});

await test("R6-T07: OMNI_SHELL_ENABLED unset disables shell", async () => {
  const orig = process.env.OMNI_SHELL_ENABLED;
  delete process.env.OMNI_SHELL_ENABLED;
  const r = await runShellCommand("echo test");
  process.env.OMNI_SHELL_ENABLED = orig;
  assert.equal(r.ok, false, "Shell should be disabled when env not set");
});

await test("R6-T08: Safe command returns stdout and exit code 0", async () => {
  const r = await runShellCommand("echo 'VX-Engine-Shell-Round6'", 5000);
  assert.ok(r.ok, `Shell command failed: ${r.error}`);
  assert.ok(r.stdout.includes("VX-Engine-Shell-Round6"), `Unexpected stdout: "${r.stdout}"`);
  assert.equal(r.exitCode, 0);
});

await test("R6-T09: Chained commands both execute", async () => {
  const r = await runShellCommand("echo first && echo second", 5000);
  assert.ok(r.ok, `Chained command failed: ${r.error}`);
  assert.ok(r.stdout.includes("first"), "First command output missing");
  assert.ok(r.stdout.includes("second"), "Second command output missing");
});

await test("R6-T10: Timeout enforcement — sleep 35s killed within hard cap", async () => {
  // Use 31s timeout to force the 30s hard cap to kill it
  const before = Date.now();
  const r = await runShellCommand("sleep 35", 31_000);
  const elapsed = Date.now() - before;
  // Should be killed by the 30s hard cap before 31s elapses
  assert.ok(elapsed < 32_000, `Timeout not enforced — took ${elapsed}ms`);
  assert.equal(r.ok, false, "sleep 35 should fail after timeout");
  console.log(`    [INFO] Elapsed: ${elapsed}ms (hard cap killed at ~30s)`);
});

console.log(`\n════════════════════════════════════════════════════`);
console.log(`  ROUND 6 SCORE: ${passed}/${passed + failed} passed`);
if (failures.length > 0) { console.error(`  FAILURES:`); failures.forEach((f) => console.error(`    ✗ ${f}`)); }
console.log(`════════════════════════════════════════════════════\n`);
if (failed > 0) process.exit(1);
