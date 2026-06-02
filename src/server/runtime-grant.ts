import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";

export interface OmniRuntimeGrantClaims {
  creditBudget?: number;
  daemonInstanceId: string;
  exp: number;
  iat: number;
  iss: string;
  orgId: string;
  policyVersion: string;
  scopes: string[];
  sessionId?: string;
  sub: string;
}

const DEFAULT_SECRET = "omni-dashboard-dev-secret-change-me";

function secret(): string {
  const configured = process.env.OMNI_DASHBOARD_JWT_SECRET?.trim();

  if (configured) {
    return configured;
  }

  if (process.env.NODE_ENV === "production" || process.env.RAILWAY_ENVIRONMENT === "production") {
    throw new Error("OMNI_DASHBOARD_JWT_SECRET is required for runtime grant verification.");
  }

  return DEFAULT_SECRET;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function parseBase64url(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

function sign(value: string): string {
  return base64url(crypto.createHmac("sha256", secret()).update(value).digest());
}

export function readRuntimeGrantToken(request: IncomingMessage, url?: URL): string {
  const authorization = request.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (authorization) {
    return authorization;
  }
  const queryToken = url?.searchParams.get("token");
  if (queryToken) {
    return queryToken;
  }
  throw new Error("Missing Omni runtime grant.");
}

export function verifyRuntimeGrant(
  token: string,
  input: {
    daemonInstanceId: string;
    requiredScope?: string;
    sessionId?: string;
  },
): OmniRuntimeGrantClaims {
  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature) {
    throw new Error("Malformed Omni runtime grant.");
  }

  const expected = sign(`${header}.${payload}`);
  const actualBuffer = parseBase64url(signature);
  const expectedBuffer = parseBase64url(expected);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    throw new Error("Invalid Omni runtime grant signature.");
  }

  const claims = JSON.parse(parseBase64url(payload).toString("utf8")) as OmniRuntimeGrantClaims;
  if (claims.exp <= Math.floor(Date.now() / 1000)) {
    throw new Error("Omni runtime grant expired.");
  }
  if (claims.daemonInstanceId !== input.daemonInstanceId) {
    throw new Error("Grant daemon mismatch.");
  }
  if (input.sessionId && claims.sessionId && claims.sessionId !== input.sessionId) {
    throw new Error("Grant session mismatch.");
  }
  if (input.requiredScope && !claims.scopes.includes(input.requiredScope)) {
    throw new Error(`Grant missing scope: ${input.requiredScope}`);
  }
  return claims;
}

export function describeRuntimeGrantForDiagnostics(token: string): {
  hasToken: boolean;
  segments: number;
  iss?: string;
  daemonInstanceId?: string;
  orgId?: string;
  sessionId?: string;
  scopes?: string[];
  sub?: string;
  exp?: number;
  iat?: number;
} {
  const segments = token.split(".");
  const [, payload] = segments;

  if (!payload) {
    return { hasToken: Boolean(token), segments: segments.length };
  }

  try {
    const claims = JSON.parse(parseBase64url(payload).toString("utf8")) as OmniRuntimeGrantClaims;
    return {
      daemonInstanceId: claims.daemonInstanceId,
      exp: claims.exp,
      hasToken: true,
      iat: claims.iat,
      iss: claims.iss,
      orgId: claims.orgId,
      scopes: claims.scopes,
      segments: segments.length,
      sessionId: claims.sessionId,
      sub: claims.sub,
    };
  } catch {
    return { hasToken: true, segments: segments.length };
  }
}
