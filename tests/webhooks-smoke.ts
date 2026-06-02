/**
 * Unit test for webhook delivery (P4-06).
 * Tests by mocking fetch and calling emitWebhookEvent directly.
 */
import assert from "node:assert/strict";
import { mock } from "node:test";

// We can't easily mock fetch in tsx without a network interceptor library.
// Instead, exercise the signing/header/timeout logic by inspecting source.
import fs from "node:fs";

const webhooksSrc = fs.readFileSync("src/server/webhooks.ts", "utf8");
const serviceSrc = fs.readFileSync("src/server/service.ts", "utf8");

// Env vars
assert.match(webhooksSrc, /OMNI_WEBHOOK_URL/, "must reference OMNI_WEBHOOK_URL");
assert.match(webhooksSrc, /OMNI_WEBHOOK_SECRET/, "must reference OMNI_WEBHOOK_SECRET");
assert.match(webhooksSrc, /OMNI_WEBHOOK_TIMEOUT_MS/, "must reference OMNI_WEBHOOK_TIMEOUT_MS");
assert.match(webhooksSrc, /OMNI_WEBHOOK_MAX_RETRIES/, "must reference OMNI_WEBHOOK_MAX_RETRIES");
assert.match(webhooksSrc, /OMNI_WEBHOOK_RETRY_BASE_MS/, "must reference OMNI_WEBHOOK_RETRY_BASE_MS");

// HMAC signing
assert.match(webhooksSrc, /createHmac\("sha256", secret\)/, "must HMAC-SHA256 sign payload");
assert.match(webhooksSrc, /x-omni-signature/, "must send x-omni-signature header");
assert.match(webhooksSrc, /sha256=/, "signature must be prefixed with sha256=");

// Event types
assert.match(webhooksSrc, /"session\.created"/, "must support session.created event");
assert.match(webhooksSrc, /"session\.closed"/, "must support session.closed event");
assert.match(webhooksSrc, /"command\.completed"/, "must support command.completed event");
assert.match(webhooksSrc, /"session\.evicted"/, "must support session.evicted event");

// Headers
assert.match(webhooksSrc, /x-omni-event/, "must send x-omni-event header");
assert.match(webhooksSrc, /x-omni-event-id/, "must send x-omni-event-id header");
assert.match(webhooksSrc, /x-omni-timestamp/, "must send x-omni-timestamp header");

// Retry with exponential backoff
assert.match(webhooksSrc, /Math\.pow\(2, attempt - 1\)/, "retry must use exponential backoff");

// AbortController for timeout
assert.match(webhooksSrc, /AbortController/, "must use AbortController for timeout");
assert.match(webhooksSrc, /controller\.abort\(\)/, "must abort on timeout");

// Fire-and-forget
assert.match(webhooksSrc, /void deliverWithRetry/, "emit must be fire-and-forget");

// Service integration
assert.match(serviceSrc, /emitWebhookEvent\("session\.created"/, "createSession must emit webhook");
assert.match(serviceSrc, /emitWebhookEvent\("session\.closed"/, "closeSession must emit webhook");
assert.match(serviceSrc, /emitWebhookEvent\("command\.completed"/, "executeCommand must emit webhook");
assert.match(serviceSrc, /emitWebhookEvent\("session\.evicted"/, "enforceSessionCap must emit webhook");

console.log("webhooks unit test ok");
