import assert from "node:assert/strict";
import path from "node:path";

process.env.OMNI_HOME = path.resolve(".omni-smoke-home");

const { buildSelfPolicingSystemAppendix } = await import("../src/security/trade-secret-guard.js");
const {
  isSessionDisengaged,
  recordRefusalStrike,
  resetStrikeStateForTests,
} = await import("../src/security/session-strike-counter.js");

resetStrikeStateForTests();

assert.ok(buildSelfPolicingSystemAppendix().length > 0);

const sessionId = "security-smoke-session";
await recordRefusalStrike({ direction: "input", flaggedText: "first", sessionId });
await recordRefusalStrike({ direction: "input", flaggedText: "second", sessionId });
const third = await recordRefusalStrike({ direction: "input", flaggedText: "third", sessionId });

assert.equal(third.disengaged, true);
assert.equal(await isSessionDisengaged({ sessionId }), true);

console.log("security smoke ok");
