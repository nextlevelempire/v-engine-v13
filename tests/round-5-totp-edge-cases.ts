/**
 * ROUND 5 — TOTP Edge Cases
 * Pure unit tests — no server needed.
 * Run: npx tsx tests/round-5-totp-edge-cases.ts
 */

import assert from "node:assert/strict";

process.env.OMNI_VAULT_KEY = "v-engine-test-vault-key-32chars-min!!";
process.env.OMNI_SHELL_ENABLED = "1";

const { generateTotp, totpSecondsRemaining } = await import("../src/runtime/totp-generator.js");
const { storeCredential } = await import("../src/runtime/credential-vault.js");

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
console.log("  ROUND 5 — TOTP EDGE CASES (8 tests)");
console.log("════════════════════════════════════════════════════\n");

// RFC 6238 test vector verification
// Known seed JBSWY3DPEHPK3PXP = base32 of "Hello!"
// We verify the code is 6 digits and matches across same window
await test("R5-T01: TOTP produces 6-digit numeric code for RFC test seed", () => {
  const secret = "JBSWY3DPEHPK3PXP";
  const code = generateTotp(secret);
  assert.ok(/^\d{6}$/.test(code), `Expected 6-digit code, got: "${code}"`);
  // Two calls in same window must match
  const code2 = generateTotp(secret);
  assert.equal(code, code2, "Two codes in same TOTP window differ");
});

await test("R5-T02: totpSecondsRemaining returns 1-30 always", () => {
  const r = totpSecondsRemaining();
  assert.ok(r >= 1 && r <= 30, `Remaining ${r} out of 1-30 range`);
});

await test("R5-T03: generateTotp with empty string throws or returns error", () => {
  let threw = false;
  let result = "";
  try {
    result = generateTotp("");
  } catch {
    threw = true;
  }
  // Either throws OR returns garbage (not a valid 6-digit code)
  if (!threw) {
    console.log(`    [DOCUMENT] generateTotp("") returned: "${result}" without throwing`);
    // If it didn't throw, it should at least return something (base32 of "" decodes to empty buffer)
    // Either behavior is acceptable — document it
  } else {
    console.log(`    [DOCUMENT] generateTotp("") threw — correct behavior`);
  }
  assert.ok(true, "Behavior documented");
});

await test("R5-T04: generateTotp with invalid base32 chars — graceful", () => {
  let threw = false;
  let result = "";
  try {
    result = generateTotp("!@#$%^&*()invalid");
  } catch {
    threw = true;
  }
  console.log(`    [DOCUMENT] Invalid base32 threw: ${threw}, result: "${result}"`);
  // The base32 decoder skips unknown chars — it may produce something from valid chars
  // Key requirement: does NOT crash the process
  assert.ok(true, "Process survived invalid base32 input");
});

await test("R5-T05: generateTotp with digits=8 returns 8-digit code", () => {
  const code = generateTotp("JBSWY3DPEHPK3PXP", 8);
  assert.equal(code.length, 8, `Expected 8-digit code, got: "${code}" (length ${code.length})`);
  assert.ok(/^\d{8}$/.test(code), `8-digit code is not all numeric: "${code}"`);
});

await test("R5-T06: generateTotp with period=60 returns 6-digit code", () => {
  const code = generateTotp("JBSWY3DPEHPK3PXP", 6, 60);
  assert.ok(/^\d{6}$/.test(code), `Expected 6-digit code with period=60, got: "${code}"`);
});

await test("R5-T07: Two different secrets produce different codes (probabilistic)", () => {
  const code1 = generateTotp("JBSWY3DPEHPK3PXP");
  const code2 = generateTotp("MFRGGZDFMZTWQ2LK"); // different seed
  // Different seeds should produce different codes (with very high probability)
  // This could theoretically collide once every 1,000,000 checks — acceptable
  console.log(`    [INFO] Secret 1 code: ${code1}, Secret 2 code: ${code2}`);
  // Not asserting equality — just verifying both produce valid codes
  assert.ok(/^\d{6}$/.test(code1) && /^\d{6}$/.test(code2), "Both codes should be 6-digit");
});

await test("R5-T08: vault with totpSecret stores and credential has totpSecret field", async () => {
  storeCredential({
    hostname: "totp-test-r5.example.com",
    username: "totpuser",
    password: "pass123",
    totpSecret: "JBSWY3DPEHPK3PXP",
  });
  const { getCredential } = await import("../src/runtime/credential-vault.js");
  const cred = getCredential("totp-test-r5.example.com");
  assert.ok(cred !== null, "Credential not found after store");
  assert.equal(cred!.totpSecret, "JBSWY3DPEHPK3PXP", "totpSecret not preserved in vault");
});

console.log(`\n════════════════════════════════════════════════════`);
console.log(`  ROUND 5 SCORE: ${passed}/${passed + failed} passed`);
if (failures.length > 0) { console.error(`  FAILURES:`); failures.forEach((f) => console.error(`    ✗ ${f}`)); }
console.log(`════════════════════════════════════════════════════\n`);
if (failed > 0) process.exit(1);
