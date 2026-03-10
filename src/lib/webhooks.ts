import { createHmac, randomBytes } from "node:crypto";

import { Redis } from "@upstash/redis";
import { PrismaClient, Prisma } from "@prisma/client";

import { prisma } from "./prisma";

type WebhookClient = PrismaClient | Prisma.TransactionClient;

type QueueWebhookEventInput = {
  merchantId: string;
  eventType: string;
  payload: unknown;
  prismaClient?: WebhookClient;
};

type SignWebhookPayloadInput = {
  secret: string;
  timestamp: string;
  payload: string;
};

type CreateDeliveryAttemptInput = {
  deliveryId: string;
  prismaClient?: WebhookClient;
  responseStatus?: number;
  responseBody?: string;
};

type SignedWebhookHeaders = {
  "X-Signature": string;
  "X-Timestamp": string;
  "X-Event-Type": string;
};

type DeliveryAttemptResult = {
  deliveryId: string;
  attemptNumber: number;
  delivered: boolean;
  responseStatus: number;
};

type ProcessRetryQueueResult = {
  processed: number;
  delivered: number;
  failed: number;
};

type RetryLockHandle = {
  acquired: boolean;
  token: string;
};

const RETRY_LOCK_KEY = "webhooks:retry:lock";
const hasUpstashConfig = Boolean(process.env.REDIS_REST_URL && process.env.REDIS_REST_TOKEN);
const inMemoryLock = new Map<string, { token: string; expiresAt: number }>();

function computeBackoffSeconds(attemptNumber: number): number {
  const base = Number(process.env.WEBHOOK_RETRY_BASE_SECONDS ?? "30");
  const max = Number(process.env.WEBHOOK_RETRY_MAX_SECONDS ?? "3600");
  const exponential = base * Math.pow(2, Math.max(0, attemptNumber - 1));

  return Math.min(max, exponential);
}

function dispatchWebhook(url: string): { delivered: boolean; responseStatus: number; responseBody: string } {
  if (url.includes("fail")) {
    return {
      delivered: false,
      responseStatus: 500,
      responseBody: "simulated delivery failure",
    };
  }

  return {
    delivered: true,
    responseStatus: 200,
    responseBody: "simulated delivery success",
  };
}

async function acquireRetryLockFromRedis(token: string, ttlSeconds: number): Promise<boolean> {
  const redis = Redis.fromEnv();
  const result = await redis.set(RETRY_LOCK_KEY, token, { nx: true, ex: ttlSeconds });

  return result === "OK";
}

async function releaseRetryLockFromRedis(token: string): Promise<void> {
  const redis = Redis.fromEnv();
  const current = await redis.get<string>(RETRY_LOCK_KEY);

  if (current === token) {
    await redis.del(RETRY_LOCK_KEY);
  }
}

function acquireRetryLockInMemory(token: string, ttlSeconds: number): boolean {
  const existing = inMemoryLock.get(RETRY_LOCK_KEY);
  const now = Date.now();

  if (existing && existing.expiresAt > now) {
    return false;
  }

  inMemoryLock.set(RETRY_LOCK_KEY, {
    token,
    expiresAt: now + ttlSeconds * 1000,
  });

  return true;
}

function releaseRetryLockInMemory(token: string): void {
  const existing = inMemoryLock.get(RETRY_LOCK_KEY);

  if (existing?.token === token) {
    inMemoryLock.delete(RETRY_LOCK_KEY);
  }
}

export async function acquireWebhookRetryLock(ttlSeconds = 30): Promise<RetryLockHandle> {
  const token = randomBytes(16).toString("hex");

  if (hasUpstashConfig) {
    const acquired = await acquireRetryLockFromRedis(token, ttlSeconds);
    return { acquired, token };
  }

  const acquired = acquireRetryLockInMemory(token, ttlSeconds);
  return { acquired, token };
}

export async function releaseWebhookRetryLock(handle: RetryLockHandle): Promise<void> {
  if (!handle.acquired) {
    return;
  }

  if (hasUpstashConfig) {
    await releaseRetryLockFromRedis(handle.token);
    return;
  }

  releaseRetryLockInMemory(handle.token);
}

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString("hex")}`;
}

export function signWebhookPayload(input: SignWebhookPayloadInput): string {
  const { secret, timestamp, payload } = input;
  const content = `${timestamp}.${payload}`;

  return createHmac("sha256", secret).update(content).digest("hex");
}

export function buildSignedWebhookHeaders(input: {
  secret: string;
  eventType: string;
  payload: string;
  timestamp?: string;
}): SignedWebhookHeaders {
  const timestamp = input.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature = signWebhookPayload({
    secret: input.secret,
    timestamp,
    payload: input.payload,
  });

  return {
    "X-Signature": signature,
    "X-Timestamp": timestamp,
    "X-Event-Type": input.eventType,
  };
}

export async function createWebhookDeliveryAttempt(input: CreateDeliveryAttemptInput) {
  const {
    deliveryId,
    prismaClient = prisma,
    responseStatus = 200,
    responseBody = "ok",
  } = input;

  const delivery = await prismaClient.webhookDelivery.findUnique({
    where: {
      id: deliveryId,
    },
    include: {
      webhookEndpoint: {
        select: {
          secret: true,
        },
      },
      attempts: {
        select: {
          attemptNumber: true,
        },
      },
    },
  });

  if (!delivery) {
    throw new Error("Webhook delivery not found.");
  }

  const payloadText = JSON.stringify(delivery.payload);
  const headers = buildSignedWebhookHeaders({
    secret: delivery.webhookEndpoint.secret,
    eventType: delivery.eventType,
    payload: payloadText,
  });

  const nextAttemptNumber =
    delivery.attempts.reduce((max, attempt) => Math.max(max, attempt.attemptNumber), 0) + 1;

  const now = new Date();

  const attempt = await prismaClient.webhookAttempt.create({
    data: {
      merchantId: delivery.merchantId,
      deliveryId: delivery.id,
      attemptNumber: nextAttemptNumber,
      requestBody: {
        payload: delivery.payload,
        payloadText,
        headers,
      },
      responseStatus,
      responseBody,
      completedAt: now,
    },
  });

  await prismaClient.webhookDelivery.update({
    where: {
      id: delivery.id,
    },
    data: {
      status: "DELIVERED",
      deliveredAt: now,
    },
  });

  return {
    attempt,
    headers,
    payloadText,
  };
}

export async function processWebhookDelivery(
  deliveryId: string,
  prismaClient: WebhookClient = prisma,
): Promise<DeliveryAttemptResult> {
  const delivery = await prismaClient.webhookDelivery.findUnique({
    where: {
      id: deliveryId,
    },
    include: {
      webhookEndpoint: {
        select: {
          secret: true,
          url: true,
        },
      },
      attempts: {
        select: {
          attemptNumber: true,
        },
      },
    },
  });

  if (!delivery) {
    throw new Error("Webhook delivery not found.");
  }

  const now = new Date();
  const nextAttemptNumber =
    delivery.attempts.reduce((max, attempt) => Math.max(max, attempt.attemptNumber), 0) + 1;

  const payloadText = JSON.stringify(delivery.payload);
  const headers = buildSignedWebhookHeaders({
    secret: delivery.webhookEndpoint.secret,
    eventType: delivery.eventType,
    payload: payloadText,
  });

  const dispatchResult = dispatchWebhook(delivery.webhookEndpoint.url);

  await prismaClient.webhookAttempt.create({
    data: {
      merchantId: delivery.merchantId,
      deliveryId: delivery.id,
      attemptNumber: nextAttemptNumber,
      requestBody: {
        payload: delivery.payload,
        payloadText,
        headers,
      },
      responseStatus: dispatchResult.responseStatus,
      responseBody: dispatchResult.responseBody,
      completedAt: now,
    },
  });

  if (dispatchResult.delivered) {
    await prismaClient.webhookDelivery.update({
      where: {
        id: delivery.id,
      },
      data: {
        status: "DELIVERED",
        deliveredAt: now,
        nextAttemptAt: null,
      },
    });
  } else {
    const backoffSeconds = computeBackoffSeconds(nextAttemptNumber);

    await prismaClient.webhookDelivery.update({
      where: {
        id: delivery.id,
      },
      data: {
        status: "FAILED",
        nextAttemptAt: new Date(now.getTime() + backoffSeconds * 1000),
      },
    });
  }

  return {
    deliveryId: delivery.id,
    attemptNumber: nextAttemptNumber,
    delivered: dispatchResult.delivered,
    responseStatus: dispatchResult.responseStatus,
  };
}

export async function processWebhookRetryQueue(
  prismaClient: WebhookClient = prisma,
  limit = 50,
): Promise<ProcessRetryQueueResult> {
  const now = new Date();

  const deliveries = await prismaClient.webhookDelivery.findMany({
    where: {
      status: {
        in: ["PENDING", "FAILED"],
      },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    orderBy: {
      createdAt: "asc",
    },
    take: limit,
    select: {
      id: true,
    },
  });

  let deliveredCount = 0;
  let failedCount = 0;

  for (const delivery of deliveries) {
    const result = await processWebhookDelivery(delivery.id, prismaClient);

    if (result.delivered) {
      deliveredCount += 1;
    } else {
      failedCount += 1;
    }
  }

  return {
    processed: deliveries.length,
    delivered: deliveredCount,
    failed: failedCount,
  };
}

export async function queueWebhookEvent(input: QueueWebhookEventInput): Promise<number> {
  const { merchantId, eventType, payload, prismaClient = prisma } = input;

  const endpoints = await prismaClient.webhookEndpoint.findMany({
    where: {
      merchantId,
      isActive: true,
    },
    select: {
      id: true,
      eventTypes: true,
    },
  });

  const deliveryRows = endpoints
    .filter((endpoint) => Array.isArray(endpoint.eventTypes) && endpoint.eventTypes.includes(eventType))
    .map((endpoint) => ({
      merchantId,
      webhookEndpointId: endpoint.id,
      eventType,
      payload: payload as Prisma.InputJsonValue,
      status: "PENDING" as const,
    }));

  if (deliveryRows.length === 0) {
    return 0;
  }

  const result = await prismaClient.webhookDelivery.createMany({
    data: deliveryRows,
  });

  return result.count;
}
