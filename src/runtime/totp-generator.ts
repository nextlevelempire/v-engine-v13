/**
 * totp-generator.ts — RFC 6238 TOTP code generation.
 *
 * Pure math — no external deps. Given a base32 TOTP seed (stored in
 * credential-vault.ts), generates the current 6-digit OTP code.
 * The AI calls vault_fill_totp to auto-type the current code into the
 * focused 2FA input field.
 */

import crypto from "node:crypto";

// ── Base32 decoder ────────────────────────────────────────────────────────────

const BASE32_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input: string): Buffer {
  const str = input.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const char of str) {
    const idx = BASE32_CHARS.indexOf(char);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

// ── HOTP (counter-based) ──────────────────────────────────────────────────────

function hotp(secret: Buffer, counter: bigint, digits = 6): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(counter);
  const hmac = crypto.createHmac("sha1", secret).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return String(code % 10 ** digits).padStart(digits, "0");
}

// ── TOTP (time-based) ─────────────────────────────────────────────────────────

/**
 * Generate the current TOTP code for a base32 secret.
 * @param secret  Base32-encoded TOTP seed (e.g. from Google Authenticator QR code)
 * @param digits  Code length (default 6)
 * @param period  Step period in seconds (default 30)
 */
export function generateTotp(secret: string, digits = 6, period = 30): string {
  const key = base32Decode(secret);
  const counter = BigInt(Math.floor(Date.now() / 1000 / period));
  return hotp(key, counter, digits);
}

/**
 * Returns seconds until the current TOTP code expires.
 * Useful for deciding whether to wait for the next window before submitting.
 */
export function totpSecondsRemaining(period = 30): number {
  return period - (Math.floor(Date.now() / 1000) % period);
}

/**
 * Fill the active 2FA field on the page with the current TOTP code.
 * Waits for a fresh code window (> 3s remaining) to avoid race conditions.
 */
export async function fillTotp(
  page: import("playwright").Page,
  totpSecret: string,
): Promise<{ ok: boolean; code?: string; reason?: string }> {
  // If the current window expires in < 3s, wait for the next one
  const remaining = totpSecondsRemaining();
  if (remaining < 3) {
    await new Promise<void>((r) => setTimeout(r, (remaining + 1) * 1000));
  }

  const code = generateTotp(totpSecret);

  // Try common 2FA input selectors
  const otpSelectors = [
    'input[type="number"][maxlength="6"]',
    'input[name*="otp"]',
    'input[name*="totp"]',
    'input[name*="code"]',
    'input[name*="token"]',
    'input[autocomplete="one-time-code"]',
    'input[inputmode="numeric"]',
  ];

  for (const sel of otpSelectors) {
    const loc = page.locator(sel).first();
    const count = await loc.count().catch(() => 0);
    if (count > 0) {
      await page.fill(sel, code);
      return { ok: true, code };
    }
  }

  // Fallback: type into whatever is focused
  try {
    await page.keyboard.type(code, { delay: 80 });
    return { ok: true, code };
  } catch {
    return { ok: false, reason: "no_otp_field_found" };
  }
}
