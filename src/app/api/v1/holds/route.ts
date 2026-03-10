import { NextResponse } from "next/server";
import { type Prisma } from "@prisma/client";
import { z } from "zod";

import {
  createHandler,
  paginationSchema,
  paginationMeta,
  paginationSkip,
} from "../../../../lib/handler";
import { emitDomainEvent } from "../../../../lib/events";
import { prisma } from "../../../../lib/prisma";
import { defineTransitions } from "../../../../lib/state-machine";

type HoldStatus = "ACTIVE" | "RELEASED" | "EXPIRED" | "CAPTURED";

export const holdMachine = defineTransitions<HoldStatus>({
  ACTIVE: ["RELEASED", "EXPIRED", "CAPTURED"],
  RELEASED: [],
  EXPIRED: [],
  CAPTURED: [],
});

function serializeHold(h: {
  id: string;
  merchantId: string;
  amount: number;
  currency: string;
  status: string;
  reason: string | null;
  entityType: string | null;
  entityId: string | null;
  releasedAt: Date | null;
  expiresAt: Date | null;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: h.id,
    merchant_id: h.merchantId,
    amount: h.amount,
    currency: h.currency,
    status: h.status.toLowerCase(),
    reason: h.reason,
    entity_type: h.entityType,
    entity_id: h.entityId,
    released_at: h.releasedAt?.toISOString() ?? null,
    expires_at: h.expiresAt?.toISOString() ?? null,
    metadata: h.metadata,
    created_at: h.createdAt.toISOString(),
    updated_at: h.updatedAt.toISOString(),
  };
}

export { serializeHold };

const createHoldSchema = z.object({
  amount: z.number().int().positive(),
  currency: z
    .string()
    .length(3)
    .transform((v) => v.toUpperCase()),
  reason: z.string().max(500).optional(),
  entity_type: z.string().max(100).optional(),
  entity_id: z.string().max(200).optional(),
  expires_at: z.string().datetime().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const POST = createHandler({
  auth: "merchant",
  idempotent: true,
  validate: createHoldSchema,
  handler: async (ctx) => {
    const hold = await prisma.$transaction(async (tx) => {
      const created = await tx.hold.create({
        data: {
          merchantId: ctx.merchantId,
          amount: ctx.body.amount,
          currency: ctx.body.currency,
          status: "ACTIVE",
          reason: ctx.body.reason,
          entityType: ctx.body.entity_type,
          entityId: ctx.body.entity_id,
          expiresAt: ctx.body.expires_at ? new Date(ctx.body.expires_at) : undefined,
          metadata: ctx.body.metadata as Prisma.InputJsonValue | undefined,
        },
      });

      await emitDomainEvent(tx, {
        merchantId: ctx.merchantId,
        type: "hold.created",
        entityType: "Hold",
        entityId: created.id,
        payload: serializeHold(created) as Record<string, unknown>,
        actorType: "api_key",
        actorId: ctx.apiKey.id,
      });

      return created;
    });

    return NextResponse.json(
      { hold: serializeHold(hold) },
      { status: 201 },
    );
  },
});

const listQuery = paginationSchema.extend({
  status: z.string().optional(),
});

export const GET = createHandler({
  auth: "merchant",
  query: listQuery,
  handler: async (ctx) => {
    const where: Prisma.HoldWhereInput = {
      merchantId: ctx.merchantId,
    };
    if (ctx.query.status) {
      where.status = ctx.query.status.toUpperCase() as HoldStatus;
    }

    const skip = paginationSkip(ctx.query);
    const [total, holds] = await Promise.all([
      prisma.hold.count({ where }),
      prisma.hold.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: ctx.query.pageSize,
      }),
    ]);

    return NextResponse.json({
      data: holds.map(serializeHold),
      pagination: paginationMeta(ctx.query, total),
    });
  },
});
