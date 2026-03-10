import { Redis } from "@upstash/redis";

type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
};

type RateLimitStore = {
  increment(key: string, ttlSeconds: number): Promise<number>;
};

class UpstashRateLimitStore implements RateLimitStore {
  private readonly redis: Redis;

  constructor() {
    this.redis = Redis.fromEnv();
  }

  async increment(key: string, ttlSeconds: number): Promise<number> {
    const count = await this.redis.incr(key);
    if (count === 1) {
      await this.redis.expire(key, ttlSeconds);
    }

    return count;
  }
}

class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, { count: number; expiresAt: number }>();

  async increment(key: string, ttlSeconds: number): Promise<number> {
    const now = Date.now();
    const current = this.buckets.get(key);

    if (!current || current.expiresAt <= now) {
      this.buckets.set(key, { count: 1, expiresAt: now + ttlSeconds * 1000 });
      return 1;
    }

    current.count += 1;
    this.buckets.set(key, current);
    return current.count;
  }
}

const hasUpstashConfig = Boolean(process.env.REDIS_REST_URL && process.env.REDIS_REST_TOKEN);

const store: RateLimitStore = hasUpstashConfig
  ? new UpstashRateLimitStore()
  : new MemoryRateLimitStore();

export async function checkApiKeyRateLimit(
  apiKeyId: string,
  maxRequests = Number(process.env.RATE_LIMIT_MAX_REQUESTS ?? "60"),
  windowSeconds = Number(process.env.RATE_LIMIT_WINDOW_SECONDS ?? "60"),
): Promise<RateLimitResult> {
  const currentWindow = Math.floor(Date.now() / (windowSeconds * 1000));
  const rateKey = `ratelimit:apikey:${apiKeyId}:${currentWindow}`;
  const count = await store.increment(rateKey, windowSeconds);

  const remaining = Math.max(0, maxRequests - count);
  const resetAt = (currentWindow + 1) * windowSeconds * 1000;

  return {
    allowed: count <= maxRequests,
    limit: maxRequests,
    remaining,
    resetAt,
  };
}
