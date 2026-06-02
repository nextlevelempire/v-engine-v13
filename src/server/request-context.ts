/**
 * Request ID and W3C traceparent propagation.
 *
 * For every HTTP request we generate (or accept) a request id and a
 * W3C traceparent. The traceparent format is:
 *   version-traceid-spanid-flags
 * e.g. 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
 *
 * The request id is what we return to the client via the
 * x-omni-request-id response header. It's also stamped onto every
 * log line that the request emits, so an operator can grep for a
 * single request across the runtime and see everything that happened.
 *
 * The traceparent is for distributed tracing — if the request is
 * forwarded to another service, that service can pick up the
 * traceparent and continue the trace.
 */

const TRACE_PARENT_REGEX = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  // Node 19+: crypto.getRandomValues is available globally; on 16+ we have require('node:crypto').randomBytes.
  // Using globalThis.crypto for the runtime-agnostic path.
  (globalThis.crypto as Crypto).getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface RequestContext {
  requestId: string;
  traceId: string;
  spanId: string;
  traceparent: string;
  flags: string;
}

export function parseIncomingContext(headers: NodeJS.Dict<string | string[]>): RequestContext {
  const reqIdHeader = pickHeader(headers["x-omni-request-id"]) || pickHeader(headers["x-request-id"]);
  const traceparentHeader = pickHeader(headers["traceparent"]);
  if (traceparentHeader) {
    const m = TRACE_PARENT_REGEX.exec(traceparentHeader);
    if (m) {
      const [, , traceId, spanId, flags] = m;
      // Reuse trace id, mint a fresh span id for this hop.
      const newSpan = randomHex(8);
      return {
        flags,
        requestId: reqIdHeader || randomHex(8),
        spanId: newSpan,
        traceId,
        traceparent: `00-${traceId}-${newSpan}-${flags}`,
      };
    }
  }
  // No valid traceparent — mint a fresh one.
  return mintRequestContext(reqIdHeader || undefined);
}

export function mintRequestContext(requestId?: string): RequestContext {
  const traceId = randomHex(16);
  const spanId = randomHex(8);
  const flags = "01"; // sampled
  return {
    flags,
    requestId: requestId || randomHex(8),
    spanId,
    traceId,
    traceparent: `00-${traceId}-${spanId}-${flags}`,
  };
}

function pickHeader(v: string | string[] | undefined): string | null {
  if (!v) return null;
  if (Array.isArray(v)) return v[0] || null;
  return v;
}
