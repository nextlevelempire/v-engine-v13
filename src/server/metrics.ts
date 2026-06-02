/**
 * Tiny in-process metrics for the V-Engine runtime.
 * Emitted in Prometheus exposition format at GET /metrics.
 *
 * Counters and gauges only — no histograms for v0.3 (the source of
 * truth for latency is per-request logs, not metrics). If/when we
 * need p50/p95/p99, add a histogram here.
 *
 * Why not pull in prom-client? It's a 200 KB dep with features we
 * don't use. A hand-rolled exposition is ~80 lines and zero deps.
 */

type Counter = { help: string; labelNames?: string[]; values: Map<string, number> };
type Gauge = { help: string; labelNames?: string[]; values: Map<string, number> };

function labelKey(labels?: Record<string, string>): string {
  if (!labels) return "";
  return Object.keys(labels).sort()
    .map((k) => `${k}="${(labels[k] ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`)
    .join(",");
}

class CounterFamily {
  readonly help: string;
  readonly labelNames: string[];
  values = new Map<string, number>();

  constructor(opts: { help: string; name: string; labelNames?: string[] }) {
    this.help = opts.help;
    this.labelNames = opts.labelNames ?? [];
  }

  inc(labels: Record<string, string> | undefined, by: number = 1): void {
    const key = labelKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + by);
  }

  reset(): void { this.values.clear(); }
}

class GaugeFamily {
  readonly help: string;
  readonly labelNames: string[];
  values = new Map<string, number>();

  constructor(opts: { help: string; name: string; labelNames?: string[] }) {
    this.help = opts.help;
    this.labelNames = opts.labelNames ?? [];
  }

  set(labels: Record<string, string> | undefined, value: number): void {
    this.values.set(labelKey(labels), value);
  }

  reset(): void { this.values.clear(); }
}

const counters = new Map<string, CounterFamily>();
const gauges = new Map<string, GaugeFamily>();

function counter(name: string, help: string, labelNames: string[] = []): CounterFamily {
  let c = counters.get(name);
  if (!c) {
    c = new CounterFamily({ help, labelNames, name });
    counters.set(name, c);
  }
  return c;
}

function gauge(name: string, help: string, labelNames: string[] = []): GaugeFamily {
  let g = gauges.get(name);
  if (!g) {
    g = new GaugeFamily({ help, labelNames, name });
    gauges.set(name, g);
  }
  return g;
}

// Define the canonical metric set for v0.3.
const httpRequestsTotal = counter(
  "omni_http_requests_total",
  "Total HTTP requests served, by route and status.",
  ["method", "path", "status"],
);
const httpRequestErrorsTotal = counter(
  "omni_http_request_errors_total",
  "Total HTTP requests that returned a non-2xx status.",
  ["method", "path", "status"],
);
const authFailuresTotal = counter(
  "omni_auth_failures_total",
  "Total runtime-grant verification failures.",
  ["reason"],
);
const sessionsActive = gauge(
  "omni_sessions_active",
  "Number of sessions currently active in the runtime.",
);
const sessionsCreatedTotal = counter(
  "omni_sessions_created_total",
  "Total sessions created since process start.",
);
const sessionsEvictedTotal = counter(
  "omni_sessions_evicted_total",
  "Total sessions evicted (parallel cap or shutdown).",
  ["reason"],
);
const bodyTooLargeTotal = counter(
  "omni_body_too_large_total",
  "Total requests rejected with 413 Payload Too Large.",
);
const timeoutsTotal = counter(
  "omni_request_timeouts_total",
  "Total requests killed by OMNI_REQUEST_TIMEOUT_MS watchdog.",
);
const rateLimitedTotal = counter(
  "omni_rate_limited_total",
  "Total requests rejected with 429 Too Many Requests.",
  ["scope"],
);

export const metrics = {
  authFailuresTotal,
  bodyTooLargeTotal,
  httpRequestErrorsTotal,
  httpRequestsTotal,
  rateLimitedTotal,
  requestTimeoutsTotal: timeoutsTotal,
  sessionsActive,
  sessionsCreatedTotal,
  sessionsEvictedTotal,
};

export function renderPrometheus(): string {
  const lines: string[] = [];
  for (const [name, c] of counters) {
    lines.push(`# HELP ${name} ${c.help}`);
    lines.push(`# TYPE ${name} counter`);
    if (c.values.size === 0) {
      lines.push(`${name} 0`);
    } else {
      for (const [key, v] of c.values) {
        lines.push(key ? `${name}{${key}} ${v}` : `${name} ${v}`);
      }
    }
  }
  for (const [name, g] of gauges) {
    lines.push(`# HELP ${name} ${g.help}`);
    lines.push(`# TYPE ${name} gauge`);
    if (g.values.size === 0) {
      lines.push(`${name} 0`);
    } else {
      for (const [key, v] of g.values) {
        lines.push(key ? `${name}{${key}} ${v}` : `${name} ${v}`);
      }
    }
  }
  return lines.join("\n") + "\n";
}

export function resetMetrics(): void {
  for (const c of counters.values()) c.reset();
  for (const g of gauges.values()) g.reset();
}
