import { NextResponse } from "next/server";
import { type Prisma } from "@prisma/client";
import { z } from "zod";

import { createHandler } from "../../../../../lib/handler";
import { NotFoundError } from "../../../../../lib/errors";
import { emitDomainEvent } from "../../../../../lib/events";
import { prisma } from "../../../../../lib/prisma";
import { serializeTransfer, transferMachine } from "../route";

export const GET = createHandler({
  auth: "merchant",
  handler: async (ctx) => {
    const transfer = await prisma.transfer.findFirst({
      where: { id: ctx.params.id, merchantId: ctx.merchantId },
    });
    if (!transfer) {
      throw new NotFoundError("TRANSFER_NOT_FOUND", "Transfer not found.");
    }
    return NextResponse.json({ transfer: serializeTransfer(transfer) });
  },
});

const updateSchema = z.object({
  status: z.string().min(1).optional(),
  description: z.string().max(500).optional(),
  reference: z.string().max(200).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const PATCH = createHandler({
  auth: "merchant",
  validate: updateSchema,
  handler: async (ctx) => {
    const result = await prisma.$transaction(async (tx) => {
      const transfer = await tx.transfer.findFirst({
        where: { id: ctx.params.id, merchantId: ctx.merchantId },
      });
      if (!transfer) {
        throw new NotFoundError("TRANSFER_NOT_FOUND", "Transfer not found.");
      }

      const data: Prisma.TransferUpdateInput = {};

      if (ctx.body.status) {
        const newStatus = ctx.body.status.toUpperCase() as "PENDING" | "COMPLETED" | "FAILED" | "REVERSED";
        transferMachine.assertTransition(
          transfer.status as "PENDING" | "COMPLETED" | "FAILED" | "REVERSED",
          newStatus,
        );
        data.status = newStatus;
        if (newStatus === "COMPLETED") {
          data.completedAt = new Date();
        }
      }
      if (ctx.body.description !== undefined) data.description = ctx.body.description;
      if (ctx.body.reference !== undefined) data.reference = ctx.body.reference;
      if (ctx.body.metadata !== undefined) {
        data.metadata = ctx.body.metadata as Prisma.InputJsonValue;
      }

      const updated = await tx.transfer.update({
        where: { id: transfer.id },
        data,
      });

      if (ctx.body.status) {
        await emitDomainEvent(tx, {
          merchantId: ctx.merchantId,
          type: `transfer.${ctx.body.status.toLowerCase()}`,
          entityType: "Transfer",
          entityId: updated.id,
          payload: serializeTransfer(updated) as Record<string, unknown>,
          actorType: "api_key",
          actorId: ctx.apiKey.id,
        });
      }

      return updated;
    });

    return NextResponse.json({ transfer: serializeTransfer(result) });
  },
});
