import { NextResponse } from "next/server";

import { createHandler } from "../../../../../../../lib/handler";
import { NotFoundError } from "../../../../../../../lib/errors";
import { emitDomainEvent } from "../../../../../../../lib/events";
import { prisma } from "../../../../../../../lib/prisma";
import { serializeReconPeriod, reconPeriodMachine } from "../../route";

export const POST = createHandler({
  auth: "admin",
  handler: async (ctx) => {
    const result = await prisma.$transaction(async (tx) => {
      const period = await tx.reconPeriod.findUnique({
        where: { id: ctx.params.id },
      });
      if (!period) {
        throw new NotFoundError("RECON_PERIOD_NOT_FOUND", "Reconciliation period not found.");
      }

      reconPeriodMachine.assertTransition(
        period.status as "OPEN" | "IN_REVIEW" | "CLOSED",
        "CLOSED",
      );

      const closed = await tx.reconPeriod.update({
        where: { id: period.id },
        data: {
          status: "CLOSED",
          closedAt: new Date(),
          closedBy: ctx.apiKey.id,
        },
      });

      await emitDomainEvent(tx, {
        merchantId: period.merchantId,
        type: "recon.period.closed",
        entityType: "ReconPeriod",
        entityId: closed.id,
        payload: serializeReconPeriod(closed) as Record<string, unknown>,
        actorType: "api_key",
        actorId: ctx.apiKey.id,
      });

      return closed;
    });

    return NextResponse.json({ data: serializeReconPeriod(result) });
  },
});
