/**
 * Unit test for request-context: traceparent + request id (P4-03).
 */
import assert from "node:assert/strict";
import { mintRequestContext, parseIncomingContext } from "../src/server/request-context.js";

// Mint fresh context
const c = mintRequestContext();
assert.match(c.requestId, /^[0-9a-f]{16}$/, "requestId is 16 hex chars");
assert.match(c.traceId, /^[0-9a-f]{32}$/, "traceId is 32 hex chars");
assert.match(c.spanId, /^[0-9a-f]{16}$/, "spanId is 16 hex chars");
assert.equal(c.flags, "01");
assert.equal(c.traceparent, `00-${c.traceId}-${c.spanId}-01`);

// Mint with supplied requestId
const c2 = mintRequestContext("my-req-123");
assert.equal(c2.requestId, "my-req-123");

// Parse inbound: accept existing traceparent
const inbound = parseIncomingContext({
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
});
assert.equal(inbound.traceId, "4bf92f3577b34da6a3ce929d0e0e4736", "traceId is preserved across hops");
assert.notEqual(inbound.spanId, "00f067aa0ba902b7", "spanId is fresh per hop");
assert.equal(inbound.flags, "01");
assert.equal(inbound.traceparent, `00-${inbound.traceId}-${inbound.spanId}-01`);

// Parse inbound: x-omni-request-id wins
const inbound2 = parseIncomingContext({
  "x-omni-request-id": "client-supplied-id",
});
assert.equal(inbound2.requestId, "client-supplied-id");

// Parse inbound: x-request-id fallback
const inbound3 = parseIncomingContext({
  "x-request-id": "client-req-fallback",
});
assert.equal(inbound3.requestId, "client-req-fallback");

// Parse inbound: garbage traceparent → mint fresh
const inbound4 = parseIncomingContext({
  traceparent: "garbage",
});
assert.match(inbound4.traceId, /^[0-9a-f]{32}$/, "garbage traceparent is replaced");

// Two mints produce different ids
const a = mintRequestContext();
const b = mintRequestContext();
assert.notEqual(a.requestId, b.requestId);
assert.notEqual(a.traceId, b.traceId);

console.log("request-context unit test ok");
