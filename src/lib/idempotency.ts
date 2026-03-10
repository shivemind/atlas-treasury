import { createHash } from "node:crypto";

import { Redis } from "@upstash/redis";
import { PrismaClient } from "@prisma/client";

import { prisma } from "./prisma";

type CachedReplayRecord = {
  merchantId: string;
  route: string;
  idempotencyKey: string;
  requestHash: string;
  responseStatusCode: number;
  responseBody: string;
  responseContentType: string;
};

type IdempotencyCache = {
  get(key: string): Promise<CachedReplayRecord | null>;
  set(key: string, value: CachedReplayRecord, ttlSeconds: number): Promise<void>;
};

type IdempotentExecutionOptions = {
  request: Request;
  merchantId: string;
  route: string;
  execute: () => Promise<Response>;
  prismaClient?: PrismaClient;
  cache?: IdempotencyCache;
};

class UpstashIdempotencyCache implements IdempotencyCache {
  private readonly redis: Redis;

  constructor() {
    this.redis = Redis.fromEnv();
  }

  async get(key: string): Promise<CachedReplayRecord | null> {
    const value = await this.redis.get<CachedReplayRecord>(key);
    return value ?? null;
  }

  async set(key: string, value: CachedReplayRecord, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, value, { ex: ttlSeconds });
  }
}

class NoopIdempotencyCache implements IdempotencyCache {
  async get(): Promise<CachedReplayRecord | null> {
    return null;
  }

  async set(): Promise<void> {
    return;
  }
}

const hasUpstashConfig = Boolean(process.env.REDIS_REST_URL && process.env.REDIS_REST_TOKEN);
const defaultIdempotencyCache: IdempotencyCache = hasUpstashConfig
  ? new UpstashIdempotencyCache()
  : new NoopIdempotencyCache();

const IDEMPOTENCY_TTL_SECONDS = Number(process.env.IDEMPOTENCY_TTL_SECONDS ?? "86400");

function getIdempotencyKey(request: Request): string | null {
  const raw = request.headers.get("idempotency-key")?.trim();
  return raw ? raw : null;
}

async function buildRequestFingerprint(request: Request): Promise<string> {
  const bodyText = await request.clone().text();
  const normalized = JSON.stringify({
    method: request.method.toUpperCase(),
    body: bodyText,
  });

  return createHash("sha256").update(normalized).digest("hex");
}

function makeConflictResponse() {
  return new Response(
    JSON.stringify({
      error: {
        code: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST",
        message: "Idempotency-Key was already used with a different request payload.",
      },
    }),
    {
      status: 409,
      headers: {
        "content-type": "application/json",
      },
    },
  );
}

function makeMissingKeyResponse() {
  return new Response(
    JSON.stringify({
      error: {
        code: "IDEMPOTENCY_KEY_REQUIRED",
        message: "Idempotency-Key header is required for POST requests.",
      },
    }),
    {
      status: 400,
      headers: {
        "content-type": "application/json",
      },
    },
  );
}

function replayResponse(
  statusCode: number,
  responseBody: string,
  responseContentType: string,
): Response {
  return new Response(responseBody, {
    status: statusCode,
    headers: {
      "content-type": responseContentType,
      "x-idempotent-replayed": "true",
    },
  });
}

function cacheKey(merchantId: string, route: string, idempotencyKey: string): string {
  return `idempotency:${merchantId}:${route}:${idempotencyKey}`;
}

export async function executeWithIdempotency(options: IdempotentExecutionOptions): Promise<Response> {
  const {
    request,
    merchantId,
    route,
    execute,
    prismaClient = prisma,
    cache = defaultIdempotencyCache,
  } = options;

  if (request.method.toUpperCase() !== "POST") {
    return execute();
  }

  const idempotencyKey = getIdempotencyKey(request);
  if (!idempotencyKey) {
    return makeMissingKeyResponse();
  }

  const requestHash = await buildRequestFingerprint(request);
  const redisKey = cacheKey(merchantId, route, idempotencyKey);

  const cached = await cache.get(redisKey);
  if (cached) {
    if (cached.requestHash !== requestHash) {
      return makeConflictResponse();
    }

    return replayResponse(cached.responseStatusCode, cached.responseBody, cached.responseContentType);
  }

  const existing = await prismaClient.idempotencyRecord.findUnique({
    where: {
      merchantId_route_idempotencyKey: {
        merchantId,
        route,
        idempotencyKey,
      },
    },
  });

  if (existing) {
    if (existing.requestHash !== requestHash) {
      return makeConflictResponse();
    }

    if (existing.state === "COMPLETED" && existing.responseStatusCode && existing.responseBody) {
      const replayable: CachedReplayRecord = {
        merchantId,
        route,
        idempotencyKey,
        requestHash,
        responseStatusCode: existing.responseStatusCode,
        responseBody: existing.responseBody,
        responseContentType: existing.responseContentType ?? "application/json",
      };

      await cache.set(redisKey, replayable, IDEMPOTENCY_TTL_SECONDS);

      return replayResponse(
        replayable.responseStatusCode,
        replayable.responseBody,
        replayable.responseContentType,
      );
    }
  } else {
    await prismaClient.idempotencyRecord.create({
      data: {
        merchantId,
        route,
        idempotencyKey,
        requestHash,
        state: "PENDING",
        expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_SECONDS * 1000),
      },
    });
  }

  let response: Response;
  try {
    response = await execute();
  } catch (error) {
    await prismaClient.idempotencyRecord.delete({
      where: {
        merchantId_route_idempotencyKey: {
          merchantId,
          route,
          idempotencyKey,
        },
      },
    }).catch(() => {});
    throw error;
  }

  const responseBody = await response.clone().text();
  const responseStatusCode = response.status;
  const responseContentType = response.headers.get("content-type") ?? "application/json";

  await prismaClient.idempotencyRecord.update({
    where: {
      merchantId_route_idempotencyKey: {
        merchantId,
        route,
        idempotencyKey,
      },
    },
    data: {
      state: "COMPLETED",
      responseStatusCode,
      responseBody,
      responseContentType,
    },
  });

  await cache.set(
    redisKey,
    {
      merchantId,
      route,
      idempotencyKey,
      requestHash,
      responseStatusCode,
      responseBody,
      responseContentType,
    },
    IDEMPOTENCY_TTL_SECONDS,
  );

  return response;
}

export class InMemoryIdempotencyCache implements IdempotencyCache {
  private readonly values = new Map<string, CachedReplayRecord>();

  async get(key: string): Promise<CachedReplayRecord | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: CachedReplayRecord): Promise<void> {
    this.values.set(key, value);
  }
}
