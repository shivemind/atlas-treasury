import { NextResponse } from "next/server";
import { type Prisma } from "@prisma/client";
import { z } from "zod";

import { createHandler } from "../../../../../lib/handler";
import { NotFoundError } from "../../../../../lib/errors";
import { emitDomainEvent } from "../../../../../lib/events";
import { prisma } from "../../../../../lib/prisma";
import { serializeReserve, reserveMachine } from "../route";

export const GET = createHandler({
  auth: "merchant",
  handler: async (ctx) => {
    const reserve = await prisma.reserve.findFirst({
      where: { id: ctx.params.id, merchantId: ctx.merchantId },
    });
    if (!reserve) {
      throw new NotFoundError("RESERVE_NOT_FOUND", "Reserve not found.");
    }
    return NextResponse.json({ reserve: serializeReserve(reserve) });
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
      const reserve = await tx.reserve.findFirst({
        where: { id: ctx.params.id, merchantId: ctx.merchantId },
      });
      if (!reserve) {
        throw new NotFoundError("RESERVE_NOT_FOUND", "Reserve not found.");
      }

      const data: Prisma.ReserveUpdateInput = {};

      if (ctx.body.status) {
        const newStatus = ctx.body.status.toUpperCase() as "ACTIVE" | "RELEASED" | "FORFEITED";
        reserveMachine.assertTransition(
          reserve.status as "ACTIVE" | "RELEASED" | "FORFEITED",
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

      const updated = await tx.reserve.update({
        where: { id: reserve.id },
        data,
      });

      if (ctx.body.status) {
        await emitDomainEvent(tx, {
          merchantId: ctx.merchantId,
          type: `reserve.${ctx.body.status.toLowerCase()}`,
          entityType: "Reserve",
          entityId: updated.id,
          payload: serializeReserve(updated) as Record<string, unknown>,
          actorType: "api_key",
          actorId: ctx.apiKey.id,
        });
      }

      return updated;
    });

    return NextResponse.json({ reserve: serializeReserve(result) });
  },
});
