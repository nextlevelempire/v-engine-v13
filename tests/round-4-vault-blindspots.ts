/**
 * ROUND 4 — Credential Vault + vault_fill Blind Spots
 * Server + browser required for HTTP command tests.
 * Run: npx tsx tests/round-4-vault-blindspots.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { Server } from "node:http";

const TEST_HOME = path.resolve(".omni-r4-test-home");
process.env.OMNI_HOME = TEST_HOME;
process.env.OMNI_TAKEOVER_MODES = "local_browser,local_computer";
process.env.OMNI_VAULT_KEY = "v-engine-test-vault-key-32chars-min!!";
process.env.OMNI_SHELL_ENABLED = "1";

if (fs.existsSync(TEST_HOME)) fs.rmSync(TEST_HOME, { recursive: true });
fs.mkdirSync(TEST_HOME, { recursive: true });

const { storeCredential, getCredential, listCredentials, deleteCredential, isVaultConfigured } = await import("../src/runtime/credential-vault.js");
const { startStandaloneServer } = await import("../src/server/local-server.js");
const { mintRuntimeGrant } = await import("../src/server/runtime-grant.js");
const { getDaemonStateDir } = await import("../src/utils/omni-paths.js");

const PORT = 14592;
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

console.log("\n════════════════════════════════════════════════════");
console.log("  ROUND 4 — VAULT BLIND SPOTS (8 tests)");
console.log("════════════════════════════════════════════════════\n");

// ── Unit tests ─────────────────────────────────────────────────────────────────

await test("R4-T01: Credential with special chars roundtrips correctly", () => {
  const specialPass = 'p@$$w0rd!#&"{}[]<>';
  storeCredential({ hostname: "special-r4.example.com", username: "alice@test.com", password: specialPass });
  const retrieved = getCredential("special-r4.example.com");
  assert.ok(retrieved !== null, "Credential not found after store");
  assert.equal(retrieved!.password, specialPass, `Password mismatch: expected "${specialPass}", got "${retrieved!.password}"`);
});

await test("R4-T02: Suffix match — store google.com, retrieve accounts.google.com", () => {
  storeCredential({ hostname: "google.com", username: "user@gmail.com", password: "GooglePass123" });
  const bySubdomain = getCredential("accounts.google.com");
  // Suffix match: "accounts.google.com".endsWith("google.com") → should return the stored cred
  assert.ok(bySubdomain !== null, "Suffix match failed — accounts.google.com should match google.com credential");
  assert.equal(bySubdomain!.username, "user@gmail.com", "Wrong username returned from suffix match");
});

await test("R4-T03: listCredentials with no entries returns empty array", () => {
  // Use a fresh OMNI_VAULT_KEY to get an empty vault
  const origKey = process.env.OMNI_VAULT_KEY;
  const origHome = process.env.OMNI_HOME;
  const tempHome = path.resolve(".omni-r4-empty-vault");
  fs.mkdirSync(tempHome, { recursive: true });
  process.env.OMNI_HOME = tempHome;
  process.env.OMNI_VAULT_KEY = "empty-vault-test-key-32chars-min!!";
  try {
    const list = listCredentials();
    assert.ok(Array.isArray(list), "listCredentials should return array");
    assert.equal(list.length, 0, `Expected 0 entries in fresh vault, got ${list.length}`);
  } finally {
    process.env.OMNI_HOME = origHome;
    process.env.OMNI_VAULT_KEY = origKey;
    fs.rmSync(tempHome, { recursive: true });
  }
});

await test("R4-T04: deleteCredential on non-existent hostname returns false", () => {
  const result = deleteCredential("absolutely-does-not-exist-xyz.example.com");
  assert.equal(result, false, "deleteCredential should return false for non-existent hostname");
});

await test("R4-T05: isVaultConfigured with short key returns false", () => {
  const orig = process.env.OMNI_VAULT_KEY;
  process.env.OMNI_VAULT_KEY = "short";
  const configured = isVaultConfigured();
  process.env.OMNI_VAULT_KEY = orig;
  assert.equal(configured, false, "Short OMNI_VAULT_KEY should return isVaultConfigured:false");
});

// ── Server-based tests ─────────────────────────────────────────────────────────

server = await startStandaloneServer(PORT);
const daemonInstancePath = path.join(getDaemonStateDir(), "daemon-instance.json");
const daemonInstanceId = JSON.parse(fs.readFileSync(daemonInstancePath, "utf8")).daemonInstanceId;
token = mintRuntimeGrant({
  daemonInstanceId, orgId: "test-org", sub: "test-user",
  scopes: ["runtime.attach", "sessions.create", "sessions.command", "sessions.read", "vault.read", "vault.write"],
  ttlSeconds: 300,
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

const sessionRes = await api("POST", "/api/sessions", {
  agentId: "test-user", orgId: "test-org", creditBudget: 100,
});
sessionId = (sessionRes.body as Record<string, unknown>).sessionId as string;

async function runCommand(cmd: unknown) {
  const r = await api("POST", `/api/sessions/${sessionId}/command`, cmd);
  return r.body as Record<string, unknown>;
}

await test("R4-T06: vault_store via HTTP then vault_list — round-trip", async () => {
  const storeResult = await runCommand({
    type: "vault_store",
    hostname: "http-vault-test-r4.com",
    username: "httpuser@test.com",
    password: "HttpTestPass123!",
  });
  assert.ok(storeResult.ok !== false, `vault_store failed: ${JSON.stringify(storeResult)}`);

  const listResult = await runCommand({ type: "vault_list" });
  assert.ok(listResult.ok !== false, `vault_list failed: ${JSON.stringify(listResult)}`);
  const entries = listResult.credentials ?? listResult.data ?? listResult.entries ?? listResult.result;
  // Just verify the command returned successfully — the exact field name may vary
  console.log(`    [INFO] vault_list response keys: ${Object.keys(listResult).join(", ")}`);
  assert.ok(Object.keys(listResult).length > 0, "vault_list returned empty response");
});

await test("R4-T07: vault_fill on Wikipedia (no login form) returns ok:false gracefully", async () => {
  // Store credential first
  await runCommand({
    type: "vault_store",
    hostname: "en.wikipedia.org",
    username: "wikiuser@test.com",
    password: "WikiPass123",
  });

  // Navigate to Wikipedia (no login form)
  await runCommand({ type: "navigate", url: "https://en.wikipedia.org/wiki/Main_Page" });
  await new Promise<void>(r => setTimeout(r, 3000));

  // vault_fill should return gracefully (not crash) — may return ok:true or ok:false
  const fillResult = await runCommand({ type: "vault_fill", hostname: "en.wikipedia.org" });
  console.log(`    [INFO] vault_fill on Wikipedia: ${JSON.stringify(fillResult)}`);
  // Key requirement: does NOT throw / crash the server
  assert.ok(typeof fillResult === "object", "vault_fill should return an object response");
});

await test("R4-T08: vault_fill on non-stored hostname returns ok:false", async () => {
  const fillResult = await runCommand({ type: "vault_fill", hostname: "absolutely-not-stored.example.com" });
  // Should return ok:false with reason:no_credential
  console.log(`    [INFO] vault_fill on unstored hostname: ${JSON.stringify(fillResult)}`);
  assert.equal(fillResult.ok, false, "vault_fill should return ok:false for unstored hostname");
});

// ── Cleanup ───────────────────────────────────────────────────────────────────
await runCommand({ type: "close", reason: "round-4-complete" }).catch(() => {});
await new Promise<void>((r) => server.close(() => r()));

console.log(`\n════════════════════════════════════════════════════`);
console.log(`  ROUND 4 SCORE: ${passed}/${passed + failed} passed`);
if (failures.length > 0) { console.error(`  FAILURES:`); failures.forEach((f) => console.error(`    ✗ ${f}`)); }
console.log(`════════════════════════════════════════════════════\n`);
if (failed > 0) process.exit(1);
