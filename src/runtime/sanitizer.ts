/**
 * Omni Browser input sanitization.
 *
 * Node-compatible: DOMPurify needs a DOM, so we pair it with jsdom.
 * The window is created once at module load and reused.
 */

import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";

const jsdomWindow = new JSDOM("<!doctype html><html><body></body></html>").window;
// `DOMPurify` types expect a full `Window`; jsdom's window is structurally compatible.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const purify = createDOMPurify(jsdomWindow as unknown as any);

export interface SanitizerOptions {
  /** Maximum allowed input length. Default 8KB. Set 0 to disable. */
  maxLength?: number;
}

export const DEFAULT_MAX_TEXT_LENGTH = 8_192;
export const DEFAULT_MAX_SELECTOR_LENGTH = 1_024;
export const DEFAULT_MAX_URL_LENGTH = 4_096;

/** Allowed URL protocols. `file:`, `javascript:`, `data:` are explicitly rejected. */
const ALLOWED_URL_PROTOCOLS = new Set(["http:", "https:"]);

/** Blocked URL protocols regardless of what the URL constructor accepts. */
const DANGEROUS_URL_PREFIXES = [
  "javascript:",
  "vbscript:",
  "data:",
  "file:",
  "file://",
  "blob:",
  "about:",
];

/**
 * CSS selector allow-list. Permits id, class, attribute, pseudo, combinator,
 * and standard punctuation. Rejects `<`, `>` only as a combinator (allowed),
 * plus backticks, semicolons, and quotes that don't belong in a selector.
 *
 * Note: this is intentionally stricter than the CSS spec because selectors
 * used by agents should be simple and predictable.
 */
const SAFE_SELECTOR_REGEX = /^[a-zA-Z0-9\-_#.\[\]="':>~+*|^$()\s,/]+$/;

export function assertLength(input: string, max: number, label: string): void {
  if (max > 0 && input.length > max) {
    throw new SanitizationError(`${label} exceeds maximum length (${input.length}/${max})`);
  }
}

export class SanitizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SanitizationError";
  }
}

/**
 * Sanitize free-form text. Strips HTML/JS entirely (no tags or attributes
 * allowed) and enforces a length cap.
 */
export function sanitizeText(input: unknown, options: SanitizerOptions = {}): string {
  const str = typeof input === "string" ? input : String(input ?? "");
  assertLength(str, options.maxLength ?? DEFAULT_MAX_TEXT_LENGTH, "text");
  return purify.sanitize(str, {
    ALLOWED_TAGS: [],
    ALLOWED_ATTR: [],
    KEEP_CONTENT: true,
    USE_PROFILES: { html: false },
  });
}

/**
 * Validate a CSS selector. Returns the selector if it passes, throws otherwise.
 * Does NOT try to "clean" the selector — invalid selectors are rejected.
 */
export function sanitizeSelector(input: unknown, options: SanitizerOptions = {}): string {
  const str = typeof input === "string" ? input.trim() : "";
  if (!str) {
    throw new SanitizationError("Selector cannot be empty");
  }
  assertLength(str, options.maxLength ?? DEFAULT_MAX_SELECTOR_LENGTH, "selector");
  if (!SAFE_SELECTOR_REGEX.test(str)) {
    throw new SanitizationError("Selector contains disallowed characters");
  }
  // Reject obvious injection vectors even if they pass the regex.
  const lower = str.toLowerCase();
  for (const bad of ["<script", "javascript:", "onerror=", "onload=", "../"]) {
    if (lower.includes(bad)) {
      throw new SanitizationError(`Selector rejected: contains '${bad}'`);
    }
  }
  return str;
}

export interface UrlValidationResult {
  valid: boolean;
  error?: string;
  url?: string;
}

/**
 * Validate a URL. Only `http:` and `https:` are permitted. `javascript:`,
 * `data:`, `file:`, and similar pseudo-protocols are always rejected even if
 * the URL constructor would accept them.
 */
export function validateUrl(input: unknown, options: SanitizerOptions = {}): UrlValidationResult {
  if (typeof input !== "string") {
    return { valid: false, error: "URL must be a string" };
  }
  const trimmed = input.trim();
  if (!trimmed) {
    return { valid: false, error: "URL cannot be empty" };
  }
  const maxLen = options.maxLength ?? DEFAULT_MAX_URL_LENGTH;
  if (maxLen > 0 && trimmed.length > maxLen) {
    return { valid: false, error: `URL exceeds maximum length (${trimmed.length}/${maxLen})` };
  }

  const lower = trimmed.toLowerCase();
  for (const prefix of DANGEROUS_URL_PREFIXES) {
    if (lower.startsWith(prefix)) {
      return { valid: false, error: `Protocol not allowed: ${prefix}` };
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, error: "Invalid URL format" };
  }

  if (!ALLOWED_URL_PROTOCOLS.has(parsed.protocol)) {
    return { valid: false, error: `Protocol ${parsed.protocol} not allowed` };
  }

  return { valid: true, url: parsed.href };
}

/**
 * Throwing variant of `validateUrl`.
 */
export function sanitizeUrl(input: unknown, options: SanitizerOptions = {}): string {
  const result = validateUrl(input, options);
  if (!result.valid || !result.url) {
    throw new SanitizationError(result.error ?? "Invalid URL");
  }
  return result.url;
}

/**
 * Dispatcher for the older `sanitizeInput(input, context)` shape.
 */
export function sanitizeInput(
  input: string,
  context: "text" | "url" | "selector" = "text",
  options: SanitizerOptions = {},
): string {
  switch (context) {
    case "url":
      return sanitizeUrl(input, options);
    case "selector":
      return sanitizeSelector(input, options);
    case "text":
    default:
      return sanitizeText(input, options);
  }
}
