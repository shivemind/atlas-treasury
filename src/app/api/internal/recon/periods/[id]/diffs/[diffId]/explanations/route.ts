import { NextResponse } from "next/server";
import { z } from "zod";

import {
  createHandler,
  paginationSchema,
  paginationMeta,
  paginationSkip,
} from "../../../../../../../../../lib/handler";
import { NotFoundError } from "../../../../../../../../../lib/errors";
import { emitDomainEvent } from "../../../../../../../../../lib/events";
import { prisma } from "../../../../../../../../../lib/prisma";

function serializeExplanation(e: {
  id: string;
  reconDiffId: string;
  explanation: string;
  explainedBy: string | null;
  createdAt: Date;
}) {
  return {
    id: e.id,
    recon_diff_id: e.reconDiffId,
    explanation: e.explanation,
    explained_by: e.explainedBy,
    created_at: e.createdAt.toISOString(),
  };
}

const createExplanationSchema = z.object({
  explanation: z.string().min(1).max(5000),
  explained_by: z.string().max(200).optional(),
});

export const POST = createHandler({
  auth: "admin",
  validate: createExplanationSchema,
  handler: async (ctx) => {
    const diff = await prisma.reconDiff.findFirst({
      where: {
        id: ctx.params.diffId,
        reconPeriodId: ctx.params.id,
      },
    });
    if (!diff) {
      throw new NotFoundError("RECON_DIFF_NOT_FOUND", "Reconciliation diff not found.");
    }

    const explanation = await prisma.$transaction(async (tx) => {
      const created = await tx.reconExplanation.create({
        data: {
          reconDiffId: diff.id,
          explanation: ctx.body.explanation,
          explainedBy: ctx.body.explained_by,
        },
      });

      const period = await tx.reconPeriod.findUnique({
        where: { id: ctx.params.id },
        select: { merchantId: true },
      });

      if (period) {
        await emitDomainEvent(tx, {
          merchantId: period.merchantId,
          type: "recon.explanation.created",
          entityType: "ReconExplanation",
          entityId: created.id,
          payload: serializeExplanation(created) as Record<string, unknown>,
          actorType: "api_key",
          actorId: ctx.apiKey.id,
        });
      }

      return created;
    });

    return NextResponse.json(
      { data: serializeExplanation(explanation) },
      { status: 201 },
    );
  },
});

export const GET = createHandler({
  auth: "admin",
  query: paginationSchema,
  handler: async (ctx) => {
    const diff = await prisma.reconDiff.findFirst({
      where: {
        id: ctx.params.diffId,
        reconPeriodId: ctx.params.id,
      },
    });
    if (!diff) {
      throw new NotFoundError("RECON_DIFF_NOT_FOUND", "Reconciliation diff not found.");
    }

    const skip = paginationSkip(ctx.query);
    const [total, explanations] = await Promise.all([
      prisma.reconExplanation.count({ where: { reconDiffId: diff.id } }),
      prisma.reconExplanation.findMany({
        where: { reconDiffId: diff.id },
        orderBy: { createdAt: "desc" },
        skip,
        take: ctx.query.pageSize,
      }),
    ]);

    return NextResponse.json({
      data: explanations.map(serializeExplanation),
      pagination: paginationMeta(ctx.query, total),
    });
  },
});
