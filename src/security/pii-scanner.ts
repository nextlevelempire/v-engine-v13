/**
 * pii-scanner.ts — PII detection and redaction for scratchpad entries.
 * Prevents passwords, API keys, SSNs, credit cards, and other sensitive
 * data from appearing in the cockpit mission thread or logs.
 */

const PII_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // Credentials / secrets
  { pattern: /"?password"?\s*[:=]\s*"?\S+/gi, label: "PASSWORD" },
  { pattern: /api[_-]?key\s*[:=]\s*\S+/gi, label: "API_KEY" },
  { pattern: /secret\s*[:=]\s*\S+/gi, label: "SECRET" },
  { pattern: /token\s*[:=]\s*\S+/gi, label: "TOKEN" },
  { pattern: /bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, label: "BEARER_TOKEN" },
  // Long random-looking strings (API keys, JWT segments, etc.)
  { pattern: /\b[A-Za-z0-9]{32,}\b/g, label: "KEY" },
  // Financial
  { pattern: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/g, label: "CARD" },
  { pattern: /\b\d{3,4}\b(?=\s*cvv|\s*cvc|\s*security)/gi, label: "CVV" },
  // US government IDs
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/g, label: "SSN" },
  // Email addresses (only redact in sensitive context — passwords nearby)
  // Phone numbers
  { pattern: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g, label: "PHONE" },
];

/**
 * Scan text for PII patterns and replace matches with [REDACTED:TYPE].
 * Returns the sanitized string. Fast and synchronous — safe to call on every
 * scratchpad write.
 */
export function redactPii(text: string): string {
  let result = text;
  for (const { pattern, label } of PII_PATTERNS) {
    result = result.replace(pattern, `[REDACTED:${label}]`);
  }
  return result;
}

/**
 * Returns true if the text contains any detectable PII.
 * Used for logging/alerting without modifying the text.
 */
export function containsPii(text: string): boolean {
  return PII_PATTERNS.some(({ pattern }) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}
