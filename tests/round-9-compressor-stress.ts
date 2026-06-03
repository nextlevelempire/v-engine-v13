/**
 * ROUND 9 — Context Compressor + Memory Stress
 * Pure unit tests — no server needed.
 * Run: npx tsx tests/round-9-compressor-stress.ts
 */

import assert from "node:assert/strict";

process.env.OMNI_VAULT_KEY = "v-engine-test-vault-key-32chars-min!!";

const {
  compressConversation,
  trimAxTree,
  estimateTokens,
  isApproachingTokenLimit,
} = await import("../src/runtime/context-compressor.js");

type Msg = { role: "system" | "user" | "assistant"; content: string };

function buildMockMessages(count: number, includeSystem = true): Msg[] {
  const msgs: Msg[] = [];
  if (includeSystem) msgs.push({ role: "system", content: "You are an AI agent. Navigate websites to complete tasks." });
  const nonSystemCount = includeSystem ? count - 1 : count;
  for (let i = 0; i < nonSystemCount; i++) {
    msgs.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i}: ${i % 2 === 0 ? "What is on the page?" : '{"action":"navigate","url":"https://en.wikipedia.org/wiki/AI"}'}`,
    });
  }
  return msgs;
}

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
console.log("  ROUND 9 — CONTEXT COMPRESSOR STRESS (11 tests)");
console.log("════════════════════════════════════════════════════\n");

await test("R9-T01: 19 messages — NO compression (below threshold)", () => {
  const msgs = buildMockMessages(19);
  const result = compressConversation(msgs);
  assert.equal(result.length, msgs.length, `Expected ${msgs.length} msgs, got ${result.length}`);
});

await test("R9-T02: 20 messages — AT threshold, NOT yet compressed (threshold is >20)", () => {
  // COMPRESS_THRESHOLD = 20, condition is `<= COMPRESS_THRESHOLD` → 20 messages NOT compressed
  const msgs = buildMockMessages(20);
  const result = compressConversation(msgs);
  assert.equal(result.length, msgs.length, `20 msgs at threshold: expected unchanged (${msgs.length}), got ${result.length}`);
});

await test("R9-T03: 21 messages — compression fires", () => {
  const msgs = buildMockMessages(21);
  const result = compressConversation(msgs);
  assert.ok(result.length < msgs.length, `Expected compression at 21 msgs, got ${result.length}`);
});

await test("R9-T04: System message preserved after compression", () => {
  const msgs = buildMockMessages(25);
  const systemContent = msgs.find(m => m.role === "system")?.content ?? "";
  const result = compressConversation(msgs);
  assert.ok(
    result.some(m => m.role === "system" && m.content === systemContent),
    "System message lost in compression"
  );
});

await test("R9-T05: Last 8 non-system messages preserved verbatim after compression", () => {
  const msgs = buildMockMessages(25);
  const nonSystem = msgs.filter(m => m.role !== "system");
  const last8 = nonSystem.slice(-8);
  const result = compressConversation(msgs);
  const resultContents = new Set(result.map(m => m.content));
  for (const msg of last8) {
    assert.ok(resultContents.has(msg.content), `Recent message lost in compression: "${msg.content.slice(0, 60)}"`);
  }
});

await test("R9-T06: Compression output contains summary message", () => {
  const msgs = buildMockMessages(25);
  const result = compressConversation(msgs);
  const hasSummary = result.some(m => m.content.includes("[CONTEXT SUMMARY:") || m.content.includes("compressed"));
  assert.ok(hasSummary, "No summary message found in compressed output");
});

await test("R9-T07: trimAxTree at exactly 4000 chars — unchanged", () => {
  const ax = "A".repeat(4000);
  const result = trimAxTree(ax);
  assert.equal(result.length, ax.length, "4000-char AX tree should be unchanged");
});

await test("R9-T08: trimAxTree at 4001 chars — truncated with notice", () => {
  const ax = "A".repeat(4001);
  const result = trimAxTree(ax);
  assert.ok(result.length < ax.length, `Should trim: result length ${result.length} >= input ${ax.length}`);
  assert.ok(result.includes("[... AX tree truncated"), `Truncation notice missing in: "${result.slice(-100)}"`);
});

await test("R9-T09: High-priority interactive roles preserved in trim", () => {
  // Build AX tree: buttons + lots of static text
  const buttons = "button Click me\nbutton Submit form\nlink Learn more\ntextbox Search";
  const filler = "StaticText ".repeat(400); // ~4400 chars of low-priority content
  const axTree = buttons + "\n" + filler;
  const result = trimAxTree(axTree, 500);
  assert.ok(result.includes("button Click me"), "Button 'Click me' not preserved after trim");
  assert.ok(result.includes("button Submit form"), "Button 'Submit form' not preserved after trim");
});

await test("R9-T10: estimateTokens — rough char/4 estimate", () => {
  const text = "A".repeat(400);
  const tokens = estimateTokens(text);
  assert.ok(tokens >= 90 && tokens <= 110, `Token estimate ${tokens} outside expected range 90-110 for 400 chars`);
});

await test("R9-T11: 50-message stress — no crash, compression applied", () => {
  const msgs = buildMockMessages(50);
  const heapBefore = process.memoryUsage().heapUsed;
  const result = compressConversation(msgs);
  const heapAfter = process.memoryUsage().heapUsed;
  const deltaKB = (heapAfter - heapBefore) / 1024;
  assert.ok(result.length < msgs.length, "50 messages should be compressed");
  assert.ok(deltaKB < 50_000, `Memory growth too large: ${deltaKB.toFixed(0)} KB`);
  console.log(`    [INFO] 50 → ${result.length} messages. Heap delta: ${deltaKB.toFixed(0)} KB`);
});

console.log(`\n════════════════════════════════════════════════════`);
console.log(`  ROUND 9 SCORE: ${passed}/${passed + failed} passed`);
if (failures.length > 0) { console.error(`  FAILURES:`); failures.forEach((f) => console.error(`    ✗ ${f}`)); }
console.log(`════════════════════════════════════════════════════\n`);
if (failed > 0) process.exit(1);
