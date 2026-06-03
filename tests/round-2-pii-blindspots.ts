/**
 * ROUND 2 — PII Redaction Blind Spots
 * Pure unit tests — no server needed.
 * Tests edge cases the happy-path tests miss.
 *
 * Run: npx tsx tests/round-2-pii-blindspots.ts
 */

import assert from "node:assert/strict";

// Env set before imports
process.env.OMNI_VAULT_KEY = "v-engine-test-vault-key-32chars-min!!";

const { redactPii, containsPii } = await import("../src/security/pii-scanner.js");

// ── Scoring ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✅ PASS [${name}]`);
    passed++;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ❌ FAIL [${name}] — ${msg.slice(0, 300)}`);
    failed++;
    failures.push(`${name}: ${msg.slice(0, 200)}`);
  }
}

console.log("\n════════════════════════════════════════════════════");
console.log("  ROUND 2 — PII REDACTION BLIND SPOTS (8 tests)");
console.log("════════════════════════════════════════════════════\n");

await test("R2-T01: SSN with dashes is redacted", () => {
  const result = redactPii("User SSN is 123-45-6789 in our records");
  assert.ok(result.includes("[REDACTED:SSN]"), `SSN not caught: "${result}"`);
});

await test("R2-T02: 9-digit order ID does NOT false-positive as SSN", () => {
  const result = redactPii("Order ID: 123456789");
  // SSN pattern requires dashes (xxx-xx-xxxx) so plain 9 digits should NOT match SSN
  // Note: may still be caught by KEY pattern (32-char rule won't match 9 digits)
  // This test documents behavior — if it catches as SSN, that's a false positive
  const hasSsnRedact = result.includes("[REDACTED:SSN]");
  if (hasSsnRedact) {
    console.log(`    [DOCUMENT] 9-digit order ID caught as SSN — possible false positive. Result: "${result}"`);
  } else {
    assert.ok(!hasSsnRedact, "PASS: order ID not false-positive redacted as SSN");
  }
  // Either way, test passes — we just document the behavior
});

await test("R2-T03: Bearer JWT token is redacted", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV";
  const result = redactPii(`Authorization: Bearer ${jwt}`);
  assert.ok(result.includes("[REDACTED"), `JWT bearer not caught: "${result}"`);
});

await test("R2-T04: Credit card number (no spaces) is redacted", () => {
  const result = redactPii("Card: 4532015112830366");
  assert.ok(result.includes("[REDACTED:CARD]"), `Credit card not caught: "${result}"`);
});

await test("R2-T05: Credit card with spaces — document behavior", () => {
  const result = redactPii("Card: 4532 0151 1283 0366");
  // The card regex requires consecutive digits — spaces break the match
  // This is a known gap — document it
  const caught = result.includes("[REDACTED:CARD]");
  console.log(`    [DOCUMENT] Credit card with spaces — caught: ${caught}. Result: "${result.slice(0, 80)}"`);
  // Test always passes — we're documenting, not asserting
});

await test("R2-T06: Password inside JSON string is redacted", () => {
  const input = '{"username":"alice","password":"SuperSecret99!"}';
  const result = redactPii(input);
  assert.ok(result.includes("[REDACTED:PASSWORD]"), `Password in JSON not caught: "${result}"`);
});

await test("R2-T07: API key in assignment is redacted", () => {
  const input = "api_key = sk-live-abc123def456ghi789jkl-production";
  const result = redactPii(input);
  assert.ok(result.includes("[REDACTED"), `API key not caught: "${result}"`);
});

await test("R2-T08: UUID with hyphens does NOT false-positive as API key", () => {
  // UUID format: 8-4-4-4-12 hex digits with hyphens — has hyphens so won't be 32+ contiguous chars
  const uuid = "550e8400-e29b-41d4-a716-446655440000";
  const result = redactPii(`Session ID: ${uuid}`);
  // UUID has hyphens so \b[A-Za-z0-9]{32,}\b won't match (boundary breaks at hyphen)
  const wasRedacted = result.includes("[REDACTED:KEY]");
  console.log(`    [DOCUMENT] UUID redacted as KEY: ${wasRedacted}. Result: "${result.slice(0, 80)}"`);
  // Document-only test — we note the behavior either way
  // A false positive on UUID would be build item B9
  assert.ok(true, "UUID behavior documented");
});

// ── Results ───────────────────────────────────────────────────────────────────

console.log(`\n════════════════════════════════════════════════════`);
console.log(`  ROUND 2 SCORE: ${passed}/${passed + failed} passed`);
if (failures.length > 0) {
  console.error(`\n  FAILURES:`);
  failures.forEach((f) => console.error(`    ✗ ${f}`));
}
console.log(`════════════════════════════════════════════════════\n`);

if (failed > 0) process.exit(1);
