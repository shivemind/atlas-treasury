import { NextResponse } from "next/server";
import { type Prisma } from "@prisma/client";
import { z } from "zod";

import {
  createHandler,
  paginationSchema,
  paginationMeta,
  paginationSkip,
} from "../../../../../lib/handler";
import { emitDomainEvent } from "../../../../../lib/events";
import { prisma } from "../../../../../lib/prisma";
import { defineTransitions } from "../../../../../lib/state-machine";

type ReconPeriodStatus = "OPEN" | "IN_REVIEW" | "CLOSED";

export const reconPeriodMachine = defineTransitions<ReconPeriodStatus>({
  OPEN: ["IN_REVIEW"],
  IN_REVIEW: ["CLOSED"],
  CLOSED: [],
});

function serializeReconPeriod(p: {
  id: string;
  merchantId: string;
  name: string;
  startDate: Date;
  endDate: Date;
  status: string;
  closedAt: Date | null;
  closedBy: string | null;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: p.id,
    merchant_id: p.merchantId,
    name: p.name,
    start_date: p.startDate.toISOString(),
    end_date: p.endDate.toISOString(),
    status: p.status.toLowerCase(),
    closed_at: p.closedAt?.toISOString() ?? null,
    closed_by: p.closedBy,
    metadata: p.metadata,
    created_at: p.createdAt.toISOString(),
    updated_at: p.updatedAt.toISOString(),
  };
}

export { serializeReconPeriod };

const createPeriodSchema = z.object({
  merchant_id: z.string().min(1),
  name: z.string().min(1).max(200),
  start_date: z.string().datetime(),
  end_date: z.string().datetime(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const POST = createHandler({
  auth: "admin",
  validate: createPeriodSchema,
  handler: async (ctx) => {
    const period = await prisma.$transaction(async (tx) => {
      const created = await tx.reconPeriod.create({
        data: {
          merchantId: ctx.body.merchant_id,
          name: ctx.body.name,
          startDate: new Date(ctx.body.start_date),
          endDate: new Date(ctx.body.end_date),
          status: "OPEN",
          metadata: ctx.body.metadata as Prisma.InputJsonValue | undefined,
        },
      });

      await emitDomainEvent(tx, {
        merchantId: ctx.body.merchant_id,
        type: "recon.period.created",
        entityType: "ReconPeriod",
        entityId: created.id,
        payload: serializeReconPeriod(created) as Record<string, unknown>,
        actorType: "api_key",
        actorId: ctx.apiKey.id,
      });

      return created;
    });

    return NextResponse.json(
      { data: serializeReconPeriod(period) },
      { status: 201 },
    );
  },
});

const listQuery = paginationSchema.extend({
  merchant_id: z.string().optional(),
  status: z.string().optional(),
});

export const GET = createHandler({
  auth: "admin",
  query: listQuery,
  handler: async (ctx) => {
    const where: Prisma.ReconPeriodWhereInput = {};
    if (ctx.query.merchant_id) where.merchantId = ctx.query.merchant_id;
    if (ctx.query.status) {
      where.status = ctx.query.status.toUpperCase() as ReconPeriodStatus;
    }

    const skip = paginationSkip(ctx.query);
    const [total, periods] = await Promise.all([
      prisma.reconPeriod.count({ where }),
      prisma.reconPeriod.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: ctx.query.pageSize,
      }),
    ]);

    return NextResponse.json({
      data: periods.map(serializeReconPeriod),
      pagination: paginationMeta(ctx.query, total),
    });
  },
});
