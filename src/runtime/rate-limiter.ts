export interface OmniRateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  scope?: string;
}

interface TokenBucket {
  capacity: number;
  lastRefillAt: number;
  refillPerMs: number;
  tokens: number;
}

export interface OmniRateLimiterConfig {
  agentRpm?: number;
  sessionRpm?: number;
  /** Short-window burst limit in requests-per-second (applies per agent and per session). */
  burstPerSecond?: number;
}

export class OmniRateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(private readonly config: OmniRateLimiterConfig = {}) {}

  consumeAgent(agentId: string): OmniRateLimitResult {
    const burst = this.consumeBurst(`agent-burst:${agentId}`);
    if (!burst.allowed) return { ...burst, scope: "agent-burst" };
    const minute = this.consume(`agent:${agentId}`, this.agentRpm(), 60_000);
    return { ...minute, scope: "agent" };
  }

  consumeSession(sessionId: string): OmniRateLimitResult {
    const burst = this.consumeBurst(`session-burst:${sessionId}`);
    if (!burst.allowed) return { ...burst, scope: "session-burst" };
    const minute = this.consume(`session:${sessionId}`, this.sessionRpm(), 60_000);
    return { ...minute, scope: "session" };
  }

  describeConfig(): { agentRpm: number; burstPerSecond: number; sessionRpm: number } {
    return {
      agentRpm: this.agentRpm(),
      burstPerSecond: this.burstPerSecond(),
      sessionRpm: this.sessionRpm(),
    };
  }

  private agentRpm(): number {
    return this.config.agentRpm ?? 30;
  }

  private sessionRpm(): number {
    return this.config.sessionRpm ?? 60;
  }

  private burstPerSecond(): number {
    return this.config.burstPerSecond ?? 10;
  }

  private consumeBurst(key: string): OmniRateLimitResult {
    return this.consume(key, this.burstPerSecond(), 1_000);
  }

  private consume(key: string, capacity: number, windowMs: number): OmniRateLimitResult {
    const now = Date.now();
    const safeCapacity = Math.max(capacity, 1);
    const refillPerMs = safeCapacity / windowMs;
    const bucket = this.buckets.get(key) ?? {
      capacity: safeCapacity,
      lastRefillAt: now,
      refillPerMs,
      tokens: safeCapacity,
    };

    // Config may change between calls; keep capacity in sync.
    bucket.capacity = safeCapacity;
    bucket.refillPerMs = refillPerMs;

    const elapsed = now - bucket.lastRefillAt;
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * bucket.refillPerMs);
    bucket.lastRefillAt = now;

    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket);
      return {
        allowed: false,
        remaining: 0,
        resetAt: now + Math.ceil((1 - bucket.tokens) / bucket.refillPerMs),
      };
    }

    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    return {
      allowed: true,
      remaining: Math.floor(bucket.tokens),
      resetAt: now + Math.ceil((bucket.capacity - bucket.tokens) / bucket.refillPerMs),
    };
  }
}
