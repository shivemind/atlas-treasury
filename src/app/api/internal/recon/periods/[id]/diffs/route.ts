import { NextResponse } from "next/server";
import { type Prisma } from "@prisma/client";
import { z } from "zod";

import {
  createHandler,
  paginationSchema,
  paginationMeta,
  paginationSkip,
} from "../../../../../../../lib/handler";
import { NotFoundError } from "../../../../../../../lib/errors";
import { emitDomainEvent } from "../../../../../../../lib/events";
import { prisma } from "../../../../../../../lib/prisma";
import { defineTransitions } from "../../../../../../../lib/state-machine";

type ReconDiffStatus = "UNRESOLVED" | "EXPLAINED" | "ACCEPTED";

export const reconDiffMachine = defineTransitions<ReconDiffStatus>({
  UNRESOLVED: ["EXPLAINED", "ACCEPTED"],
  EXPLAINED: [],
  ACCEPTED: [],
});

function serializeReconDiff(d: {
  id: string;
  reconPeriodId: string;
  entityType: string;
  entityId: string;
  expectedAmount: number;
  actualAmount: number;
  difference: number;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: d.id,
    recon_period_id: d.reconPeriodId,
    entity_type: d.entityType,
    entity_id: d.entityId,
    expected_amount: d.expectedAmount,
    actual_amount: d.actualAmount,
    difference: d.difference,
    status: d.status.toLowerCase(),
    created_at: d.createdAt.toISOString(),
    updated_at: d.updatedAt.toISOString(),
  };
}

export { serializeReconDiff };

const createDiffSchema = z.object({
  entity_type: z.string().min(1).max(100),
  entity_id: z.string().min(1).max(200),
  expected_amount: z.number().int(),
  actual_amount: z.number().int(),
});

export const POST = createHandler({
  auth: "admin",
  validate: createDiffSchema,
  handler: async (ctx) => {
    const period = await prisma.reconPeriod.findUnique({
      where: { id: ctx.params.id },
    });
    if (!period) {
      throw new NotFoundError("RECON_PERIOD_NOT_FOUND", "Reconciliation period not found.");
    }

    const diff = await prisma.$transaction(async (tx) => {
      const created = await tx.reconDiff.create({
        data: {
          reconPeriodId: period.id,
          entityType: ctx.body.entity_type,
          entityId: ctx.body.entity_id,
          expectedAmount: ctx.body.expected_amount,
          actualAmount: ctx.body.actual_amount,
          difference: ctx.body.expected_amount - ctx.body.actual_amount,
          status: "UNRESOLVED",
        },
      });

      await emitDomainEvent(tx, {
        merchantId: period.merchantId,
        type: "recon.diff.created",
        entityType: "ReconDiff",
        entityId: created.id,
        payload: serializeReconDiff(created) as Record<string, unknown>,
        actorType: "api_key",
        actorId: ctx.apiKey.id,
      });

      return created;
    });

    return NextResponse.json(
      { data: serializeReconDiff(diff) },
      { status: 201 },
    );
  },
});

const listQuery = paginationSchema.extend({
  status: z.string().optional(),
  entity_type: z.string().optional(),
});

export const GET = createHandler({
  auth: "admin",
  query: listQuery,
  handler: async (ctx) => {
    const period = await prisma.reconPeriod.findUnique({
      where: { id: ctx.params.id },
    });
    if (!period) {
      throw new NotFoundError("RECON_PERIOD_NOT_FOUND", "Reconciliation period not found.");
    }

    const where: Prisma.ReconDiffWhereInput = {
      reconPeriodId: period.id,
    };
    if (ctx.query.status) {
      where.status = ctx.query.status.toUpperCase() as ReconDiffStatus;
    }
    if (ctx.query.entity_type) where.entityType = ctx.query.entity_type;

    const skip = paginationSkip(ctx.query);
    const [total, diffs] = await Promise.all([
      prisma.reconDiff.count({ where }),
      prisma.reconDiff.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: ctx.query.pageSize,
      }),
    ]);

    return NextResponse.json({
      data: diffs.map(serializeReconDiff),
      pagination: paginationMeta(ctx.query, total),
    });
  },
});
