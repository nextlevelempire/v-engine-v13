const EMAIL_RE = /\b([A-Z0-9._%+-]{1,64})@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi;
const PHONE_RE = /\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?){2}\d{4}\b/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._-]+\b/gi;
const AUTH_HEADER_RE = /\bAuthorization\s*:\s*[^\s,;]+(?:\s+[^\s,;]+)?/gi;
const COOKIE_HEADER_RE = /\b(?:Set-Cookie|Cookie)\s*:\s*[^;\n]+(?:;[^\n]*)*/gi;
const SENSITIVE_ASSIGNMENT_RE = /\b(session(?:_token|_id)?|access_token|refresh_token|id_token|api[_-]?key|token|cookie)\b(\s*[:=]\s*)([^\s,;]+)/gi;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+\b/g;
const LONG_HEX_RE = /\b[a-f0-9]{24,}\b/gi;
const LONG_OPAQUE_ID_RE = /\b(?=[A-Za-z0-9_-]{32,}\b)(?=.*\d)(?=.*[A-Za-z])[A-Za-z0-9_-]+\b/g;
const URL_RE = /\bhttps?:\/\/[^\s)]+/gi;

function maskEmail(_match: string, local: string, domain: string) {
  const prefix = local.slice(0, Math.min(local.length, 2));
  return `${prefix || "*"}***@${domain}`;
}

function sanitizeUrl(rawUrl: string) {
  try {
    const parsed = new URL(rawUrl);
    const hasPathDetails =
      parsed.pathname !== "/" || Boolean(parsed.search) || Boolean(parsed.hash);
    return hasPathDetails ? `${parsed.origin}/[redacted]` : parsed.origin;
  } catch {
    return "[redacted-url]";
  }
}

export function redactVisibleText(value: string): string {
  return value
    .replace(BEARER_RE, "Bearer [redacted]")
    .replace(AUTH_HEADER_RE, "Authorization: [redacted]")
    .replace(COOKIE_HEADER_RE, (header) => {
      const [name] = header.split(":");
      return `${name}: [redacted]`;
    })
    .replace(SENSITIVE_ASSIGNMENT_RE, (_match, key: string, separator: string) => `${key}${separator}[redacted]`)
    .replace(URL_RE, sanitizeUrl)
    .replace(EMAIL_RE, maskEmail)
    .replace(PHONE_RE, "[redacted-phone]")
    .replace(JWT_RE, "[redacted-token]")
    .replace(UUID_RE, "[redacted-id]")
    .replace(LONG_HEX_RE, "[redacted-id]")
    .replace(LONG_OPAQUE_ID_RE, "[redacted-id]");
}

export function redactValue<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value === "string") {
    return redactVisibleText(value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, seen)) as T;
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  if (value instanceof Date) {
    return value;
  }

  if (seen.has(value as object)) {
    return value;
  }

  seen.add(value as object);

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    output[key] = redactValue(entry, seen);
  }

  return output as T;
}

export function redactForProduction<T>(value: T): T {
  return process.env.NODE_ENV === "production" ? redactValue(value) : value;
}
