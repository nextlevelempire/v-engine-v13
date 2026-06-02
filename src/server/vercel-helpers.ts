import type { SessionEvent } from "./service.js";

export function readBody(req: any): Record<string, unknown> {
  if (req.body == null) {
    return {};
  }
  if (typeof req.body === "string") {
    return JSON.parse(req.body || "{}") as Record<string, unknown>;
  }
  return req.body as Record<string, unknown>;
}

export function writeJson(res: any, statusCode: number, payload: unknown): void {
  if (typeof res.status === "function") {
    res.status(statusCode).json(payload);
    return;
  }
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}

export function openSse(req: any, res: any, sessionId: string, unsubscribe: () => void): void {
  res.writeHead(200, {
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "content-type": "text/event-stream",
  });

  writeEvent(res, {
    data: { connected: true },
    eventId: `stream-${Date.now()}`,
    sessionId,
    timestamp: new Date().toISOString(),
    type: "stream.ready",
  });

  const heartbeat = setInterval(() => {
    res.write(": keep-alive\n\n");
  }, numberFromEnv("OMNI_SSE_HEARTBEAT_MS", 15_000));

  const close = () => {
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  };

  req.on("close", close);
  req.on("error", close);
}

export function writeEvent(res: any, event: SessionEvent): void {
  res.write(`id: ${event.eventId}\n`);
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name] ?? fallback);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}
