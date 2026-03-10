import { NextResponse } from "next/server";
import { type Prisma } from "@prisma/client";
import { z } from "zod";

import { createHandler } from "../../../../../../lib/handler";
import { NotFoundError } from "../../../../../../lib/errors";
import { emitDomainEvent } from "../../../../../../lib/events";
import { prisma } from "../../../../../../lib/prisma";
import { serializeReconPeriod, reconPeriodMachine } from "../route";

export const GET = createHandler({
  auth: "admin",
  handler: async (ctx) => {
    const period = await prisma.reconPeriod.findUnique({
      where: { id: ctx.params.id },
    });
    if (!period) {
      throw new NotFoundError("RECON_PERIOD_NOT_FOUND", "Reconciliation period not found.");
    }
    return NextResponse.json({ data: serializeReconPeriod(period) });
  },
});

const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  status: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const PATCH = createHandler({
  auth: "admin",
  validate: updateSchema,
  handler: async (ctx) => {
    const result = await prisma.$transaction(async (tx) => {
      const period = await tx.reconPeriod.findUnique({
        where: { id: ctx.params.id },
      });
      if (!period) {
        throw new NotFoundError("RECON_PERIOD_NOT_FOUND", "Reconciliation period not found.");
      }

      const data: Prisma.ReconPeriodUpdateInput = {};

      if (ctx.body.status) {
        const newStatus = ctx.body.status.toUpperCase() as "OPEN" | "IN_REVIEW" | "CLOSED";
        reconPeriodMachine.assertTransition(
          period.status as "OPEN" | "IN_REVIEW" | "CLOSED",
          newStatus,
        );
        data.status = newStatus;
        if (newStatus === "CLOSED") {
          data.closedAt = new Date();
          data.closedBy = ctx.apiKey.id;
        }
      }
      if (ctx.body.name !== undefined) data.name = ctx.body.name;
      if (ctx.body.metadata !== undefined) {
        data.metadata = ctx.body.metadata as Prisma.InputJsonValue;
      }

      const updated = await tx.reconPeriod.update({
        where: { id: period.id },
        data,
      });

      if (ctx.body.status) {
        await emitDomainEvent(tx, {
          merchantId: period.merchantId,
          type: `recon.period.${ctx.body.status.toLowerCase().replace("_", "-")}`,
          entityType: "ReconPeriod",
          entityId: updated.id,
          payload: serializeReconPeriod(updated) as Record<string, unknown>,
          actorType: "api_key",
          actorId: ctx.apiKey.id,
        });
      }

      return updated;
    });

    return NextResponse.json({ data: serializeReconPeriod(result) });
  },
});
