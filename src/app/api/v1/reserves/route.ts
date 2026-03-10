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

type ReserveStatus = "ACTIVE" | "RELEASED" | "FORFEITED";

export const reserveMachine = defineTransitions<ReserveStatus>({
  ACTIVE: ["RELEASED", "FORFEITED"],
  RELEASED: [],
  FORFEITED: [],
});

function serializeReserve(r: {
  id: string;
  merchantId: string;
  amount: number;
  currency: string;
  status: string;
  reason: string | null;
  releasedAt: Date | null;
  expiresAt: Date | null;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: r.id,
    merchant_id: r.merchantId,
    amount: r.amount,
    currency: r.currency,
    status: r.status.toLowerCase(),
    reason: r.reason,
    released_at: r.releasedAt?.toISOString() ?? null,
    expires_at: r.expiresAt?.toISOString() ?? null,
    metadata: r.metadata,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}

export { serializeReserve };

const createReserveSchema = z.object({
  amount: z.number().int().positive(),
  currency: z
    .string()
    .length(3)
    .transform((v) => v.toUpperCase()),
  reason: z.string().max(500).optional(),
  expires_at: z.string().datetime().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const POST = createHandler({
  auth: "merchant",
  idempotent: true,
  validate: createReserveSchema,
  handler: async (ctx) => {
    const reserve = await prisma.$transaction(async (tx) => {
      const created = await tx.reserve.create({
        data: {
          merchantId: ctx.merchantId,
          amount: ctx.body.amount,
          currency: ctx.body.currency,
          status: "ACTIVE",
          reason: ctx.body.reason,
          expiresAt: ctx.body.expires_at ? new Date(ctx.body.expires_at) : undefined,
          metadata: ctx.body.metadata as Prisma.InputJsonValue | undefined,
        },
      });

      await emitDomainEvent(tx, {
        merchantId: ctx.merchantId,
        type: "reserve.created",
        entityType: "Reserve",
        entityId: created.id,
        payload: serializeReserve(created) as Record<string, unknown>,
        actorType: "api_key",
        actorId: ctx.apiKey.id,
      });

      return created;
    });

    return NextResponse.json(
      { reserve: serializeReserve(reserve) },
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
    const where: Prisma.ReserveWhereInput = {
      merchantId: ctx.merchantId,
    };
    if (ctx.query.status) {
      where.status = ctx.query.status.toUpperCase() as ReserveStatus;
    }

    const skip = paginationSkip(ctx.query);
    const [total, reserves] = await Promise.all([
      prisma.reserve.count({ where }),
      prisma.reserve.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: ctx.query.pageSize,
      }),
    ]);

    return NextResponse.json({
      data: reserves.map(serializeReserve),
      pagination: paginationMeta(ctx.query, total),
    });
  },
});
