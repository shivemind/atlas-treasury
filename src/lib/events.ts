import { Prisma, PrismaClient } from "@prisma/client";

import { prisma } from "./prisma";
import { queueWebhookEvent } from "./webhooks";

type EventClient = PrismaClient | Prisma.TransactionClient;

export interface DomainEventInput {
  merchantId: string;
  type: string;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
  actorType?: string;
  actorId?: string;
}

export async function emitDomainEvent(
  client: EventClient,
  input: DomainEventInput,
): Promise<string> {
  const {
    merchantId,
    type,
    entityType,
    entityId,
    payload,
    actorType,
    actorId,
  } = input;

  const event = await client.event.create({
    data: {
      merchantId,
      type,
      entityType,
      entityId,
      payload: payload as Prisma.InputJsonValue,
      actorType,
      actorId,
    },
  });

  if (actorType && actorId) {
    await client.auditLog.create({
      data: {
        merchantId,
        action: type,
        actorType,
        actorId,
        entityType,
        entityId,
        metadata: payload as Prisma.InputJsonValue,
      },
    });
  }

  await queueWebhookEvent({
    merchantId,
    eventType: type,
    payload: { type, data: payload },
    prismaClient: client,
  });

  return event.id;
}

export async function emitEvent(input: DomainEventInput): Promise<string> {
  return prisma.$transaction((tx) => emitDomainEvent(tx, input));
}
