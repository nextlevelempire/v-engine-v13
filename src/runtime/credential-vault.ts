/**
 * credential-vault.ts — Encrypted credential store for the V-Engine.
 *
 * Stores hostname → { username, password, totpSecret? } entries encrypted
 * on disk. Separate from the session-level local-vault (which is ephemeral).
 * The AI calls vault_fill to auto-fill login forms with pre-authorized creds.
 *
 * The safety rail in local-computer.ts still blocks raw `type` commands that
 * look like password entry. vault_fill bypasses this intentionally — the user
 * pre-authorized the credential by storing it here.
 *
 * Storage: OMNI_HOME/credentials.enc (AES-256-GCM encrypted JSON)
 * Key:     OMNI_VAULT_KEY env var (min 32 chars, required in production)
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getSessionStateRootDir } from "../utils/omni-paths.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StoredCredential {
  hostname: string;
  username: string;
  password: string;
  totpSecret?: string;
  notes?: string;
  savedAt: string;
}

export type VaultFillResult =
  | { ok: true; hostname: string; username: string }
  | { ok: false; reason: "no_credential" | "vault_locked" | "page_error" | "no_page" };

// ── Encryption helpers ────────────────────────────────────────────────────────

const ALGO = "aes-256-gcm";
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;

function deriveKey(raw: string): Buffer {
  return crypto.createHash("sha256").update(raw).digest();
}

function encrypt(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

function decrypt(ciphertext: string, key: Buffer): string {
  const buf = Buffer.from(ciphertext, "base64");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(enc).toString("utf8") + decipher.final("utf8");
}

// ── Vault file I/O ────────────────────────────────────────────────────────────

function vaultPath(): string {
  return path.join(getSessionStateRootDir(), "credentials.enc");
}

function getKey(): Buffer | null {
  const raw = process.env.OMNI_VAULT_KEY?.trim() ?? "";
  if (raw.length < KEY_LEN) return null;
  return deriveKey(raw);
}

function loadVault(key: Buffer): Record<string, StoredCredential> {
  const filePath = vaultPath();
  if (!fs.existsSync(filePath)) return {};
  try {
    const ciphertext = fs.readFileSync(filePath, "utf8").trim();
    const plain = decrypt(ciphertext, key);
    return JSON.parse(plain) as Record<string, StoredCredential>;
  } catch {
    return {};
  }
}

function saveVault(vault: Record<string, StoredCredential>, key: Buffer): void {
  const dir = path.dirname(vaultPath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const plain = JSON.stringify(vault);
  fs.writeFileSync(vaultPath(), encrypt(plain, key), "utf8");
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Returns true when OMNI_VAULT_KEY is set and long enough. */
export function isVaultConfigured(): boolean {
  return (process.env.OMNI_VAULT_KEY?.trim() ?? "").length >= KEY_LEN;
}

/** Store a credential for a hostname. Creates or overwrites. */
export function storeCredential(cred: Omit<StoredCredential, "savedAt">): boolean {
  const key = getKey();
  if (!key) return false;
  const vault = loadVault(key);
  vault[cred.hostname.toLowerCase()] = { ...cred, savedAt: new Date().toISOString() };
  saveVault(vault, key);
  return true;
}

/** Retrieve stored credential for a hostname (exact or suffix match). */
export function getCredential(hostname: string): StoredCredential | null {
  const key = getKey();
  if (!key) return null;
  const vault = loadVault(key);
  const lower = hostname.toLowerCase();
  if (vault[lower]) return vault[lower];
  // Try suffix match: "mail.google.com" → "google.com"
  for (const stored of Object.keys(vault)) {
    if (lower.endsWith(stored) || stored.endsWith(lower)) return vault[stored]!;
  }
  return null;
}

/** List all stored hostnames (no passwords). */
export function listCredentials(): Array<{ hostname: string; username: string; savedAt: string }> {
  const key = getKey();
  if (!key) return [];
  const vault = loadVault(key);
  return Object.values(vault).map(({ hostname, username, savedAt }) => ({ hostname, username, savedAt }));
}

/** Delete a stored credential. */
export function deleteCredential(hostname: string): boolean {
  const key = getKey();
  if (!key) return false;
  const vault = loadVault(key);
  const lower = hostname.toLowerCase();
  if (!vault[lower]) return false;
  delete vault[lower];
  saveVault(vault, key);
  return true;
}

/**
 * Auto-fill the login form on the current page using stored credentials.
 * Detects username + password fields via AX tree / common selectors.
 * Returns ok:true with the username used, or ok:false with a reason.
 */
export async function vaultFill(
  page: import("playwright").Page,
  hostname: string,
): Promise<VaultFillResult> {
  if (!isVaultConfigured()) return { ok: false, reason: "vault_locked" };
  const cred = getCredential(hostname);
  if (!cred) return { ok: false, reason: "no_credential" };

  try {
    // Username field: try common selectors in priority order
    const usernameSelectors = [
      'input[type="email"]',
      'input[name="email"]',
      'input[name="username"]',
      'input[name="user"]',
      'input[id*="email"]',
      'input[id*="username"]',
      'input[id*="user"]',
      'input[autocomplete="username"]',
      'input[autocomplete="email"]',
    ];
    for (const sel of usernameSelectors) {
      const loc = page.locator(sel).first();
      const count = await loc.count().catch(() => 0);
      if (count > 0) {
        await loc.fill(cred.username, { timeout: 3000 });
        break;
      }
    }

    // Password field
    const passwordSelectors = [
      'input[type="password"]',
      'input[name="password"]',
      'input[autocomplete="current-password"]',
      'input[autocomplete="new-password"]',
    ];
    for (const sel of passwordSelectors) {
      const loc = page.locator(sel).first();
      const count = await loc.count().catch(() => 0);
      if (count > 0) {
        // Use page.fill directly — bypasses the keyboard-event path that
        // triggers the safety rail's text pattern detection
        await page.fill(sel, cred.password);
        break;
      }
    }

    return { ok: true, hostname, username: cred.username };
  } catch {
    return { ok: false, reason: "page_error" };
  }
}
