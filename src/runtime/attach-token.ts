import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { getSecretsDir } from "../utils/omni-paths.js";
import { atomicWriteFile } from "./session-persistence.js";

export interface OmniAttachTokenClaims {
  daemonInstanceId: string;
  exp: number;
  issuedAt: number;
  issuedByAgentId: string;
  nonce: string;
  sessionId: string;
  targetAgentId: string;
}

export interface OmniAttachTokenIssueInput {
  daemonInstanceId: string;
  issuedByAgentId: string;
  sessionId: string;
  targetAgentId: string;
  ttlMs?: number;
}

export class OmniAttachTokenService {
  private cachedKey: Buffer | null = null;
  private readonly saltPath: string;
  private warnedDevFallback = false;

  constructor(private readonly secretDir: string = getSecretsDir()) {
    ensureDir(this.secretDir);
    this.saltPath = path.join(this.secretDir, "attach-token-salt.bin");
  }

  async issueToken(
    input: OmniAttachTokenIssueInput,
  ): Promise<{ attachToken: string; claims: OmniAttachTokenClaims; expiresAt: string }> {
    const ttlMs = normalizeTtl(input.ttlMs);
    const issuedAt = Date.now();
    const claims: OmniAttachTokenClaims = {
      daemonInstanceId: input.daemonInstanceId,
      exp: issuedAt + ttlMs,
      issuedAt,
      issuedByAgentId: input.issuedByAgentId,
      nonce: crypto.randomUUID(),
      sessionId: input.sessionId,
      targetAgentId: input.targetAgentId,
    };

    const payload = base64urlEncode(JSON.stringify(claims));
    const signature = await this.sign(payload);
    return {
      attachToken: `${payload}.${signature}`,
      claims,
      expiresAt: new Date(claims.exp).toISOString(),
    };
  }

  async verifyToken(
    token: string,
    input: {
      daemonInstanceId: string;
      sessionId: string;
      targetAgentId: string;
    },
  ): Promise<OmniAttachTokenClaims> {
    const [payload, signature] = token.split(".");
    if (!payload || !signature) {
      throw new Error("Malformed attach token.");
    }

    const expectedSignature = await this.sign(payload);
    const actualBuffer = Buffer.from(signature, "base64url");
    const expectedBuffer = Buffer.from(expectedSignature, "base64url");
    if (
      actualBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(actualBuffer, expectedBuffer)
    ) {
      throw new Error("Attach token signature mismatch.");
    }

    const claims = JSON.parse(base64urlDecode(payload)) as OmniAttachTokenClaims;
    if (claims.daemonInstanceId !== input.daemonInstanceId) {
      throw new Error("Attach token was issued by a different daemon instance.");
    }
    if (claims.sessionId !== input.sessionId) {
      throw new Error("Attach token is bound to a different session.");
    }
    if (claims.targetAgentId !== input.targetAgentId) {
      throw new Error("Attach token is bound to a different agent.");
    }
    if (claims.exp <= Date.now()) {
      throw new Error("Attach token has expired.");
    }

    return claims;
  }

  private async getKey(): Promise<Buffer> {
    if (this.cachedKey) {
      return this.cachedKey;
    }

    const envSecret = process.env.OMNI_PAYLOAD_ENCRYPTION_KEY;
    const machineId = getMachineFingerprint();
    let secretMaterial = `attach-token:${machineId}`;

    if (isStrongSecret(envSecret)) {
      secretMaterial = `attach-token:${envSecret}:${machineId}`;
    } else if (process.env.NODE_ENV === "production") {
      throw new Error(
        "OMNI_PAYLOAD_ENCRYPTION_KEY must be strong (32+ chars with mixed character classes) in production.",
      );
    } else if (!this.warnedDevFallback) {
      this.warnedDevFallback = true;
      console.warn("[OMNI] Attach tokens falling back to machine-only signing in dev.");
    }

    this.cachedKey = await pbkdf2(secretMaterial, this.getSalt(), 100_000, 32);
    return this.cachedKey;
  }

  private getSalt(): Buffer {
    if (fs.existsSync(this.saltPath)) {
      return fs.readFileSync(this.saltPath);
    }

    const salt = crypto.randomBytes(32);
    atomicWriteFile(this.saltPath, salt, { mode: 0o600 });
    return salt;
  }

  private async sign(payload: string): Promise<string> {
    const key = await this.getKey();
    return crypto.createHmac("sha256", key).update(payload).digest("base64url");
  }
}

function base64urlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64urlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function normalizeTtl(value: number | undefined): number {
  const configured = Number(process.env.OMNI_ATTACH_TOKEN_TTL_MS ?? 300_000);
  const requested = typeof value === "number" && Number.isFinite(value) ? value : configured;
  return Math.max(1_000, Math.min(requested, 24 * 60 * 60 * 1_000));
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
    fs.mkdirSync(dir, { recursive: true });
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
