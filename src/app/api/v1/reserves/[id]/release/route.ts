import { NextResponse } from "next/server";

import { createHandler } from "../../../../../../lib/handler";
import { NotFoundError } from "../../../../../../lib/errors";
import { emitDomainEvent } from "../../../../../../lib/events";
import { prisma } from "../../../../../../lib/prisma";
import { serializeReserve, reserveMachine } from "../../route";

export const POST = createHandler({
  auth: "merchant",
  handler: async (ctx) => {
    const result = await prisma.$transaction(async (tx) => {
      const reserve = await tx.reserve.findFirst({
        where: { id: ctx.params.id, merchantId: ctx.merchantId },
      });
      if (!reserve) {
        throw new NotFoundError("RESERVE_NOT_FOUND", "Reserve not found.");
      }

      reserveMachine.assertTransition(
        reserve.status as "ACTIVE" | "RELEASED" | "FORFEITED",
        "RELEASED",
      );

      const released = await tx.reserve.update({
        where: { id: reserve.id },
        data: { status: "RELEASED", releasedAt: new Date() },
      });

      await emitDomainEvent(tx, {
        merchantId: ctx.merchantId,
        type: "reserve.released",
        entityType: "Reserve",
        entityId: released.id,
        payload: serializeReserve(released) as Record<string, unknown>,
        actorType: "api_key",
        actorId: ctx.apiKey.id,
      });

      return released;
    });

    return NextResponse.json({ reserve: serializeReserve(result) });
  },
});
