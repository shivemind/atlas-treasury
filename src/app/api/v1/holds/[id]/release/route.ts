import { NextResponse } from "next/server";

import { createHandler } from "../../../../../../lib/handler";
import { NotFoundError } from "../../../../../../lib/errors";
import { emitDomainEvent } from "../../../../../../lib/events";
import { prisma } from "../../../../../../lib/prisma";
import { serializeHold, holdMachine } from "../../route";

export const POST = createHandler({
  auth: "merchant",
  handler: async (ctx) => {
    const result = await prisma.$transaction(async (tx) => {
      const hold = await tx.hold.findFirst({
        where: { id: ctx.params.id, merchantId: ctx.merchantId },
      });
      if (!hold) {
        throw new NotFoundError("HOLD_NOT_FOUND", "Hold not found.");
      }

      holdMachine.assertTransition(
        hold.status as "ACTIVE" | "RELEASED" | "EXPIRED" | "CAPTURED",
        "RELEASED",
      );

      const released = await tx.hold.update({
        where: { id: hold.id },
        data: { status: "RELEASED", releasedAt: new Date() },
      });

      await emitDomainEvent(tx, {
        merchantId: ctx.merchantId,
        type: "hold.released",
        entityType: "Hold",
        entityId: released.id,
        payload: serializeHold(released) as Record<string, unknown>,
        actorType: "api_key",
        actorId: ctx.apiKey.id,
      });

      return released;
    });

    return NextResponse.json({ hold: serializeHold(result) });
  },
});
