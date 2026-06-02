import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { getSecretsDir } from "../utils/omni-paths.js";
import { atomicWriteFile } from "./session-persistence.js";

export interface OmniEncryptedPayload {
  algorithm: "aes-256-gcm";
  ciphertext: string;
  iv: string;
  keyVersion: string;
  salt: string;
  tag: string;
}

export interface OmniPayloadProtectionStatus {
  envKeyValid: boolean;
  keyVersion: string;
  machineBound: true;
  mode: "env+machine" | "machine-only";
}

export class OmniPayloadCrypto {
  private cachedKey: Buffer | null = null;
  private readonly saltPath: string;
  private warnedDevFallback = false;

  constructor(private readonly secretDir: string = getSecretsDir()) {
    ensureDir(this.secretDir);
    this.saltPath = path.join(this.secretDir, "payload-salt.bin");
  }

  async decryptPayload<T>(input: OmniEncryptedPayload): Promise<T> {
    const key = await this.getKey();
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(input.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(input.tag, "base64"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(input.ciphertext, "base64")),
      decipher.final(),
    ]);
    return JSON.parse(decrypted.toString("utf8")) as T;
  }

  async encryptPayload(value: unknown): Promise<OmniEncryptedPayload> {
    const key = await this.getKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);

    return {
      algorithm: "aes-256-gcm",
      ciphertext: encrypted.toString("base64"),
      iv: iv.toString("base64"),
      keyVersion: process.env.OMNI_PAYLOAD_ENCRYPTION_KEY_VERSION ?? "v1",
      salt: this.getSalt().toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    };
  }

  isSensitiveCommand(type: string, payload: Record<string, unknown>): boolean {
    if (payload.sensitive === true) {
      return true;
    }

    return (
      type === "type" ||
      type === "run_task" ||
      type === "resume_session" ||
      type === "human_message" ||
      type === "scratchpad_append" ||
      type === "export_state" ||
      Boolean(payload.text || payload.cookies || payload.storageState || payload.humanMessage)
    );
  }

  describeProtection(): OmniPayloadProtectionStatus {
    const envSecret = process.env.OMNI_PAYLOAD_ENCRYPTION_KEY;
    const envKeyValid = isStrongSecret(envSecret);
    return {
      envKeyValid,
      keyVersion: process.env.OMNI_PAYLOAD_ENCRYPTION_KEY_VERSION ?? "v1",
      machineBound: true,
      mode: envKeyValid ? "env+machine" : "machine-only",
    };
  }

  private async getKey(): Promise<Buffer> {
    if (this.cachedKey) {
      return this.cachedKey;
    }

    const envSecret = process.env.OMNI_PAYLOAD_ENCRYPTION_KEY;
    const machineId = getMachineFingerprint();

    let secretMaterial = machineId;
    if (isStrongSecret(envSecret)) {
      secretMaterial = `${envSecret}${machineId}`;
    } else if (process.env.NODE_ENV === "production") {
      throw new Error(
        "OMNI_PAYLOAD_ENCRYPTION_KEY must be strong (32+ chars with mixed character classes) in production.",
      );
    } else if (!this.warnedDevFallback) {
      this.warnedDevFallback = true;
      console.warn("[OMNI] OMNI_PAYLOAD_ENCRYPTION_KEY missing or weak in dev. Falling back to machine-only key.");
    }

    this.cachedKey = await pbkdf2(secretMaterial, this.getSalt(), 100_000, 32);
    return this.cachedKey;
  }

  private getSalt(): Buffer {
    if (fs.existsSync(this.saltPath)) {
      const existing = fs.readFileSync(this.saltPath);
      const asText = existing.toString("utf8").trim();
      if (/^[A-Za-z0-9+/=]+$/.test(asText) && asText.length >= 44) {
        try {
          return Buffer.from(asText, "base64");
        } catch {
          return existing;
        }
      }
      return existing;
    }

    const salt = crypto.randomBytes(32);
    atomicWriteFile(this.saltPath, salt.toString("base64"), { mode: 0o600 });
    return salt;
  }
}

function isStrongSecret(value: string | undefined): value is string {
  if (!value || value.length < 32) {
    return false;
  }

  const classes = [
    /[a-z]/.test(value),
    /[A-Z]/.test(value),
    /\d/.test(value),
    /[^A-Za-z0-9]/.test(value),
  ].filter(Boolean).length;

  return classes >= 3 && new Set(value).size >= 12;
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { mode: 0o700, recursive: true });
  }
}

function getMachineFingerprint(): string {
  const candidates = [
    readMacPlatformUuid(),
    readLinuxMachineId(),
    readWindowsMachineGuid(),
    `${os.hostname()}:${os.platform()}:${os.arch()}:${os.userInfo().username}`,
  ].filter(Boolean) as string[];

  return crypto.createHash("sha256").update(candidates.join("|")).digest("hex");
}

function readLinuxMachineId(): string | null {
  for (const target of ["/etc/machine-id"]) {
    if (fs.existsSync(target)) {
      return fs.readFileSync(target, "utf8").trim();
    }
  }
  return null;
}

function readMacPlatformUuid(): string | null {
  if (process.platform !== "darwin") {
    return null;
  }

  try {
    const output = execSync("ioreg -rd1 -c IOPlatformExpertDevice", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const match = output.match(/"IOPlatformUUID" = "([^"]+)"/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function readWindowsMachineGuid(): string | null {
  if (process.platform !== "win32") {
    return null;
  }

  try {
    const output = execSync("reg query HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const match = output.match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/);
    return match?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

function pbkdf2(value: string, salt: Buffer, iterations: number, keyLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(value, salt, iterations, keyLength, "sha512", (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey);
    });
  });
}
