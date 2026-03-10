import { NextResponse } from "next/server";
import { type Prisma } from "@prisma/client";
import { z } from "zod";

import { createHandler } from "../../../../../lib/handler";
import { NotFoundError } from "../../../../../lib/errors";
import { emitDomainEvent } from "../../../../../lib/events";
import { prisma } from "../../../../../lib/prisma";
import { serializeHold, holdMachine } from "../route";

export const GET = createHandler({
  auth: "merchant",
  handler: async (ctx) => {
    const hold = await prisma.hold.findFirst({
      where: { id: ctx.params.id, merchantId: ctx.merchantId },
    });
    if (!hold) {
      throw new NotFoundError("HOLD_NOT_FOUND", "Hold not found.");
    }
    return NextResponse.json({ hold: serializeHold(hold) });
  },
});

const updateSchema = z.object({
  status: z.string().min(1).optional(),
  reason: z.string().max(500).optional(),
  expires_at: z.string().datetime().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const PATCH = createHandler({
  auth: "merchant",
  validate: updateSchema,
  handler: async (ctx) => {
    const result = await prisma.$transaction(async (tx) => {
      const hold = await tx.hold.findFirst({
        where: { id: ctx.params.id, merchantId: ctx.merchantId },
      });
      if (!hold) {
        throw new NotFoundError("HOLD_NOT_FOUND", "Hold not found.");
      }

      const data: Prisma.HoldUpdateInput = {};

      if (ctx.body.status) {
        const newStatus = ctx.body.status.toUpperCase() as "ACTIVE" | "RELEASED" | "EXPIRED" | "CAPTURED";
        holdMachine.assertTransition(
          hold.status as "ACTIVE" | "RELEASED" | "EXPIRED" | "CAPTURED",
          newStatus,
        );
        data.status = newStatus;
        if (newStatus === "RELEASED") {
          data.releasedAt = new Date();
        }
      }
      if (ctx.body.reason !== undefined) data.reason = ctx.body.reason;
      if (ctx.body.expires_at !== undefined) {
        data.expiresAt = new Date(ctx.body.expires_at);
      }
      if (ctx.body.metadata !== undefined) {
        data.metadata = ctx.body.metadata as Prisma.InputJsonValue;
      }

      const updated = await tx.hold.update({
        where: { id: hold.id },
        data,
      });

      if (ctx.body.status) {
        await emitDomainEvent(tx, {
          merchantId: ctx.merchantId,
          type: `hold.${ctx.body.status.toLowerCase()}`,
          entityType: "Hold",
          entityId: updated.id,
          payload: serializeHold(updated) as Record<string, unknown>,
          actorType: "api_key",
          actorId: ctx.apiKey.id,
        });
      }

      return updated;
    });

    return NextResponse.json({ hold: serializeHold(result) });
  },
});
