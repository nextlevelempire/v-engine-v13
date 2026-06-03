/**
 * session-telemetry.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 2 Task 10: per-session console + network capture.
 *
 * Playwright's `page.on('console', ...)` and `page.on('request' | 'response',
 * ...)` events are captured into per-session ring buffers, exposed via
 * GET /api/sessions/{id}/console and /network. Buffer size is bounded by
 * OMNI_TELEMETRY_BUFFER_SIZE (default 1000, hard cap 10_000).
 *
 * The capture is wired in two places:
 *   - createSession attaches the listeners to every new page via the
 *     context's `page` event
 *   - registerOmniUiLayer (v0.1) is called per-session for UI injection;
 *     we hook the page-creation handler there
 */
import type { ConsoleMessage, Page, Request, Response as PlaywrightResponse } from "playwright";

export type CapturedConsoleEntry = {
  args: unknown[];
  location: { columnNumber: number; lineNumber: number; url: string };
  sessionId: string;
  text: string;
  timestamp: string;
  type: string;
};

export type CapturedNetworkEntry =
  | {
      kind: "request";
      method: string;
      resourceType: string;
      sessionId: string;
      timestamp: string;
      url: string;
    }
  | {
      body: { base64?: string; size: number };
      kind: "response";
      method: string;
      resourceType: string;
      sessionId: string;
      status: number;
      timestamp: string;
      url: string;
    }
  | {
      error: string;
      kind: "request_failed";
      method: string;
      resourceType: string;
      sessionId: string;
      timestamp: string;
      url: string;
    };

export type SessionTelemetry = {
  console: CapturedConsoleEntry[];
  network: CapturedNetworkEntry[];
};

const MAX_BUFFER = 10_000;
const DEFAULT_BUFFER = 1000;

function bufferSize(): number {
  const raw = Number(process.env.OMNI_TELEMETRY_BUFFER_SIZE);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_BUFFER;
  return Math.min(Math.floor(raw), MAX_BUFFER);
}

export class SessionTelemetryStore {
  private readonly buffers = new Map<string, SessionTelemetry>();
  private readonly size: number;

  constructor() {
    this.size = bufferSize();
  }

  getOrCreate(sessionId: string): SessionTelemetry {
    let buf = this.buffers.get(sessionId);
    if (!buf) {
      buf = { console: [], network: [] };
      this.buffers.set(sessionId, buf);
    }
    return buf;
  }

  get(sessionId: string): SessionTelemetry | null {
    return this.buffers.get(sessionId) ?? null;
  }

  delete(sessionId: string): void {
    this.buffers.delete(sessionId);
  }

  appendConsole(sessionId: string, entry: CapturedConsoleEntry): void {
    const buf = this.getOrCreate(sessionId);
    buf.console.unshift(entry);
    if (buf.console.length > this.size) {
      buf.console.pop();
    }
  }

  appendNetwork(sessionId: string, entry: CapturedNetworkEntry): void {
    const buf = this.getOrCreate(sessionId);
    buf.network.unshift(entry);
    if (buf.network.length > this.size) {
      buf.network.pop();
    }
  }

  sizeOf(sessionId: string): { console: number; network: number } {
    const buf = this.buffers.get(sessionId);
    return { console: buf?.console.length ?? 0, network: buf?.network.length ?? 0 };
  }
}

let globalStore: SessionTelemetryStore | null = null;

export function getTelemetryStore(): SessionTelemetryStore {
  if (!globalStore) {
    globalStore = new SessionTelemetryStore();
  }
  return globalStore;
}

export function resetTelemetryStore(): void {
  globalStore = null;
}

/**
 * Wire Playwright console + network listeners to a single page. Safe to
 * call repeatedly on the same page (subsequent calls are no-ops).
 */
export function attachTelemetryListeners(page: Page, sessionId: string): void {
  const store = getTelemetryStore();
  const flagKey = "__omni_telemetry_attached__";
  if ((page as unknown as Record<string, unknown>)[flagKey] === true) {
    return;
  }
  (page as unknown as Record<string, unknown>)[flagKey] = true;

  page.on("console", async (msg: ConsoleMessage) => {
    try {
      const args = await Promise.all(msg.args().map((arg) => arg.jsonValue().catch(() => "[unserializable]")));
      const entry: CapturedConsoleEntry = {
        args,
        location: msg.location() ?? { columnNumber: 0, lineNumber: 0, url: "" },
        sessionId,
        text: msg.text(),
        timestamp: new Date().toISOString(),
        type: msg.type(),
      };
      store.appendConsole(sessionId, entry);
    } catch {
      // best-effort
    }
  });

  page.on("request", (req: Request) => {
    try {
      store.appendNetwork(sessionId, {
        kind: "request",
        method: req.method(),
        resourceType: req.resourceType(),
        sessionId,
        timestamp: new Date().toISOString(),
        url: req.url(),
      });
    } catch {
      // best-effort
    }
  });

  page.on("response", async (res: PlaywrightResponse) => {
    try {
      const req = res.request();
      let bodySize = 0;
      try {
        const body = await res.body().catch(() => null);
        bodySize = body ? body.length : 0;
      } catch {
        bodySize = 0;
      }
      store.appendNetwork(sessionId, {
        body: { size: bodySize },
        kind: "response",
        method: req.method(),
        resourceType: req.resourceType(),
        sessionId,
        status: res.status(),
        timestamp: new Date().toISOString(),
        url: res.url(),
      });
    } catch {
      // best-effort
    }
  });

  page.on("requestfailed", (req: Request) => {
    try {
      store.appendNetwork(sessionId, {
        error: req.failure()?.errorText ?? "unknown",
        kind: "request_failed",
        method: req.method(),
        resourceType: req.resourceType(),
        sessionId,
        timestamp: new Date().toISOString(),
        url: req.url(),
      });
    } catch {
      // best-effort
    }
  });
}
