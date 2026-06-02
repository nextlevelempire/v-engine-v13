/**
 * Typed error classes for the V-Engine runtime.
 * Replaces the regex-based status code mapping in local-server.ts
 * with a stable contract: every error has .code, .statusCode, .hint,
 * and (for 429) .retryAfterMs.
 *
 * Usage:
 *   throw new OmniAuthError("grant scope mismatch", { requiredScope: "sessions.create" });
 *   throw new OmniNotFoundError("session", sessionId);
 *   throw new OmniRateLimitError("auth fails exceeded limit", { retryAfterMs: 30_000 });
 *
 * The error mapper in local-server.ts recognizes these classes and
 * reads their httpStatus / retryAfterMs fields directly — no regex
 * matching of error messages.
 */

export type OmniErrorCode =
  | "auth.missing"
  | "auth.invalid"
  | "auth.expired"
  | "auth.scope"
  | "auth.daemon_mismatch"
  | "auth.rate_limited"
  | "budget.exceeded"
  | "not_found"
  | "rate_limited"
  | "payload.too_large"
  | "request.timeout"
  | "validation"
  | "internal";

export class OmniError extends Error {
  readonly code: OmniErrorCode;
  readonly httpStatus: number;
  readonly hint?: string;
  readonly retryAfterMs?: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: OmniErrorCode,
    message: string,
    opts: {
      httpStatus: number;
      hint?: string;
      retryAfterMs?: number;
      details?: Record<string, unknown>;
    },
  ) {
    super(message);
    this.name = "OmniError";
    this.code = code;
    this.httpStatus = opts.httpStatus;
    this.hint = opts.hint;
    this.retryAfterMs = opts.retryAfterMs;
    this.details = opts.details;
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      details: this.details,
      error: this.message,
      hint: this.hint,
      ok: false,
      retryAfterMs: this.retryAfterMs,
    };
  }
}

export class OmniAuthError extends OmniError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("auth.invalid", message, { details, httpStatus: 401, hint: "Provide a valid runtime grant in the Authorization header." });
    this.name = "OmniAuthError";
  }
}

export class OmniAuthScopeError extends OmniError {
  constructor(requiredScope: string) {
    super("auth.scope", `Grant missing required scope: ${requiredScope}`, {
      details: { requiredScope },
      hint: "Issue a new grant with the required scope.",
      httpStatus: 401,
    });
    this.name = "OmniAuthScopeError";
  }
}

export class OmniAuthDaemonMismatchError extends OmniError {
  constructor(tokenDaemonId: string, currentDaemonId: string) {
    super("auth.daemon_mismatch", "Grant was issued for a different daemon instance", {
      details: { currentDaemonId, tokenDaemonId },
      hint: "Re-attach to the current daemon or restart the runtime to mint a new grant.",
      httpStatus: 401,
    });
    this.name = "OmniAuthDaemonMismatchError";
  }
}

export class OmniAuthRateLimitError extends OmniError {
  constructor(retryAfterMs: number) {
    super("auth.rate_limited", "Auth failure rate limit exceeded", {
      hint: "Wait and try again. If the problem persists, rotate the JWT secret.",
      httpStatus: 429,
      retryAfterMs,
    });
    this.name = "OmniAuthRateLimitError";
  }
}

export class OmniBudgetError extends OmniError {
  constructor(consumed: number, limit: number) {
    super("budget.exceeded", "Credit budget exceeded", {
      details: { consumed, limit },
      hint: "Top up the budget or end the session.",
      httpStatus: 402,
    });
    this.name = "OmniBudgetError";
  }
}

export class OmniNotFoundError extends OmniError {
  constructor(resource: string, id: string) {
    super("not_found", `${resource} not found: ${id}`, {
      details: { id, resource },
      hint: `Verify the ${resource} id is correct and you have access to it.`,
      httpStatus: 404,
    });
    this.name = "OmniNotFoundError";
  }
}

export class OmniRateLimitError extends OmniError {
  constructor(retryAfterMs: number, scope: string = "global") {
    super("rate_limited", `Rate limit exceeded (${scope})`, {
      details: { scope },
      hint: "Wait and retry.",
      httpStatus: 429,
      retryAfterMs,
    });
    this.name = "OmniRateLimitError";
  }
}

export class OmniPayloadTooLargeError extends OmniError {
  constructor(actual: number, limit: number) {
    super("payload.too_large", `Request body exceeds OMNI_BODY_SIZE_LIMIT=${limit} bytes (got ${actual})`, {
      details: { actual, limit },
      hint: "Reduce the request body size or raise OMNI_BODY_SIZE_LIMIT.",
      httpStatus: 413,
    });
    this.name = "OmniPayloadTooLargeError";
  }
}

export class OmniRequestTimeoutError extends OmniError {
  constructor(elapsedMs: number, limitMs: number) {
    super("request.timeout", `Request exceeded OMNI_REQUEST_TIMEOUT_MS=${limitMs} ms (took ${elapsedMs} ms)`, {
      details: { elapsedMs, limitMs },
      hint: "Optimize the request or raise OMNI_REQUEST_TIMEOUT_MS.",
      httpStatus: 504,
    });
    this.name = "OmniRequestTimeoutError";
  }
}

export class OmniValidationError extends OmniError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("validation", message, {
      details,
      hint: "Check the request payload against the API contract in V-ENGINE.md.",
      httpStatus: 400,
    });
    this.name = "OmniValidationError";
  }
}
