/**
 * Webhook delivery subsystem (P4-06).
 *
 * Minimal v0.3 implementation: env-var configured (no API for CRUD).
 * Operators set OMNI_WEBHOOK_URL and OMNI_WEBHOOK_SECRET to receive
 * fire-and-forget POSTs on key session events.
 *
 * Delivery is best-effort with bounded retries. A failure is logged
 * and counted in metrics but does not block the runtime.
 *
 * Out of scope for v0.3 (deferred to v0.4+):
 * - Per-event subscription filters
 * - Webhook CRUD endpoints
 * - Delivery dashboard
 * - Multi-webhook fan-out
 */

import crypto from "node:crypto";
import { log } from "./log.js";
import { metrics } from "./metrics.js";

const WEBHOOK_URL = process.env.OMNI_WEBHOOK_URL?.trim() || null;
const WEBHOOK_SECRET = process.env.OMNI_WEBHOOK_SECRET?.trim() || null;
const WEBHOOK_ENABLED = Boolean(WEBHOOK_URL && WEBHOOK_SECRET);
const WEBHOOK_TIMEOUT_MS = Number(process.env.OMNI_WEBHOOK_TIMEOUT_MS) || 5_000;
const WEBHOOK_MAX_RETRIES = Number(process.env.OMNI_WEBHOOK_MAX_RETRIES) || 3;
const WEBHOOK_RETRY_BASE_MS = Number(process.env.OMNI_WEBHOOK_RETRY_BASE_MS) || 500;

export type WebhookEventType =
  | "session.created"
  | "session.closed"
  | "command.completed"
  | "command.failed"
  | "session.evicted";

export interface WebhookEvent {
  eventId: string;
  type: WebhookEventType;
  sessionId: string;
  orgId: string | null;
  userId: string | null;
  data: Record<string, unknown>;
  ts: string;
}

function signPayload(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

function mintEventId(): string {
  return crypto.randomBytes(8).toString("hex");
}

async function deliverOnce(event: WebhookEvent, signature: string): Promise<{ ok: boolean; status: number; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const res = await fetch(WEBHOOK_URL!, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "omni-v-engine/0.3",
        "x-omni-event": event.type,
        "x-omni-event-id": event.eventId,
        "x-omni-signature": `sha256=${signature}`,
        "x-omni-timestamp": event.ts,
      },
      body: JSON.stringify(event),
      signal: controller.signal,
    });
    const text = await res.text().catch(() => "");
    return { body: text.slice(0, 500), ok: res.ok, status: res.status };
  } catch (err) {
    return { body: String(err).slice(0, 500), ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

async function deliverWithRetry(event: WebhookEvent): Promise<void> {
  if (!WEBHOOK_ENABLED) return;
  const body = JSON.stringify(event);
  const signature = signPayload(body, WEBHOOK_SECRET!);
  let lastResult: { ok: boolean; status: number; body: string } | null = null;
  for (let attempt = 0; attempt <= WEBHOOK_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = WEBHOOK_RETRY_BASE_MS * Math.pow(2, attempt - 1);
      await new Promise((r) => setTimeout(r, delay));
      log.warn("webhook.retry", { attempt, eventId: event.eventId, type: event.type });
    }
    const result = await deliverOnce(event, signature);
    lastResult = result;
    if (result.ok) {
      log.info("webhook.delivered", { eventId: event.eventId, status: result.status, type: event.type });
      return;
    }
    log.warn("webhook.failed", {
      attempt,
      eventId: event.eventId,
      status: result.status,
      type: event.type,
    });
  }
  log.error("webhook.exhausted", {
    eventId: event.eventId,
    finalStatus: lastResult?.status ?? 0,
    type: event.type,
  });
  metrics.rateLimitedTotal.inc({ scope: "webhook_exhausted" });
}

/**
 * Emit a webhook event. Fire-and-forget; does not block the caller.
 */
export function emitWebhookEvent(
  type: WebhookEventType,
  sessionId: string,
  orgId: string | null,
  userId: string | null,
  data: Record<string, unknown>,
): void {
  if (!WEBHOOK_ENABLED) return;
  const event: WebhookEvent = {
    data,
    eventId: mintEventId(),
    orgId,
    sessionId,
    ts: new Date().toISOString(),
    type,
    userId,
  };
  // Detach from caller: don't await, don't propagate errors.
  void deliverWithRetry(event).catch((err) => {
    log.error("webhook.unhandled", { error: String(err), eventId: event.eventId });
  });
}

export function isWebhookEnabled(): boolean {
  return WEBHOOK_ENABLED;
}

export const webhookConfig = {
  enabled: WEBHOOK_ENABLED,
  maxRetries: WEBHOOK_MAX_RETRIES,
  retryBaseMs: WEBHOOK_RETRY_BASE_MS,
  timeoutMs: WEBHOOK_TIMEOUT_MS,
  url: WEBHOOK_URL,
};
