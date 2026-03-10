import { NextResponse } from "next/server";

import { createHandler } from "../../../../../../lib/handler";
import { NotFoundError } from "../../../../../../lib/errors";
import { emitDomainEvent } from "../../../../../../lib/events";
import { prisma } from "../../../../../../lib/prisma";
import { serializeTransfer, transferMachine } from "../../route";

export const POST = createHandler({
  auth: "merchant",
  handler: async (ctx) => {
    const result = await prisma.$transaction(async (tx) => {
      const transfer = await tx.transfer.findFirst({
        where: { id: ctx.params.id, merchantId: ctx.merchantId },
      });
      if (!transfer) {
        throw new NotFoundError("TRANSFER_NOT_FOUND", "Transfer not found.");
      }

      transferMachine.assertTransition(
        transfer.status as "PENDING" | "COMPLETED" | "FAILED" | "REVERSED",
        "REVERSED",
      );

      const reversed = await tx.transfer.update({
        where: { id: transfer.id },
        data: { status: "REVERSED" },
      });

      await emitDomainEvent(tx, {
        merchantId: ctx.merchantId,
        type: "transfer.reversed",
        entityType: "Transfer",
        entityId: reversed.id,
        payload: serializeTransfer(reversed) as Record<string, unknown>,
        actorType: "api_key",
        actorId: ctx.apiKey.id,
      });

      return reversed;
    });

    return NextResponse.json({ transfer: serializeTransfer(result) });
  },
});
