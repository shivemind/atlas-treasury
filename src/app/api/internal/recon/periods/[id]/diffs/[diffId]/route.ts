import { NextResponse } from "next/server";
import { z } from "zod";

import { createHandler } from "../../../../../../../../lib/handler";
import { NotFoundError } from "../../../../../../../../lib/errors";
import { emitDomainEvent } from "../../../../../../../../lib/events";
import { prisma } from "../../../../../../../../lib/prisma";
import { serializeReconDiff, reconDiffMachine } from "../route";

export const GET = createHandler({
  auth: "admin",
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
    return NextResponse.json({ data: serializeReconDiff(diff) });
  },
});

const updateSchema = z.object({
  status: z.string().min(1).optional(),
});

export const PATCH = createHandler({
  auth: "admin",
  validate: updateSchema,
  handler: async (ctx) => {
    const result = await prisma.$transaction(async (tx) => {
      const diff = await tx.reconDiff.findFirst({
        where: {
          id: ctx.params.diffId,
          reconPeriodId: ctx.params.id,
        },
      });
      if (!diff) {
        throw new NotFoundError("RECON_DIFF_NOT_FOUND", "Reconciliation diff not found.");
      }

      if (ctx.body.status) {
        const newStatus = ctx.body.status.toUpperCase() as "UNRESOLVED" | "EXPLAINED" | "ACCEPTED";
        reconDiffMachine.assertTransition(
          diff.status as "UNRESOLVED" | "EXPLAINED" | "ACCEPTED",
          newStatus,
        );
      }

      const updated = await tx.reconDiff.update({
        where: { id: diff.id },
        data: ctx.body.status
          ? { status: ctx.body.status.toUpperCase() as "UNRESOLVED" | "EXPLAINED" | "ACCEPTED" }
          : {},
      });

      const period = await tx.reconPeriod.findUnique({
        where: { id: ctx.params.id },
        select: { merchantId: true },
      });

      if (ctx.body.status && period) {
        await emitDomainEvent(tx, {
          merchantId: period.merchantId,
          type: `recon.diff.${ctx.body.status.toLowerCase()}`,
          entityType: "ReconDiff",
          entityId: updated.id,
          payload: serializeReconDiff(updated) as Record<string, unknown>,
          actorType: "api_key",
          actorId: ctx.apiKey.id,
        });
      }

      return updated;
    });

    return NextResponse.json({ data: serializeReconDiff(result) });
  },
});
