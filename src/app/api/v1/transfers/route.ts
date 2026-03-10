import { NextResponse } from "next/server";
import { type Prisma } from "@prisma/client";
import { z } from "zod";

import {
  createHandler,
  paginationSchema,
  paginationMeta,
  paginationSkip,
} from "../../../../lib/handler";
import { emitDomainEvent } from "../../../../lib/events";
import { prisma } from "../../../../lib/prisma";
import { defineTransitions } from "../../../../lib/state-machine";

type TransferStatus = "PENDING" | "COMPLETED" | "FAILED" | "REVERSED";

export const transferMachine = defineTransitions<TransferStatus>({
  PENDING: ["COMPLETED", "FAILED"],
  COMPLETED: ["REVERSED"],
  FAILED: [],
  REVERSED: [],
});

function serializeTransfer(t: {
  id: string;
  merchantId: string;
  amount: number;
  currency: string;
  status: string;
  sourceAccountId: string | null;
  destAccountId: string | null;
  description: string | null;
  reference: string | null;
  metadata: unknown;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: t.id,
    merchant_id: t.merchantId,
    amount: t.amount,
    currency: t.currency,
    status: t.status.toLowerCase(),
    source_account_id: t.sourceAccountId,
    dest_account_id: t.destAccountId,
    description: t.description,
    reference: t.reference,
    metadata: t.metadata,
    completed_at: t.completedAt?.toISOString() ?? null,
    created_at: t.createdAt.toISOString(),
    updated_at: t.updatedAt.toISOString(),
  };
}

export { serializeTransfer, transferMachine as _transferMachine };

const createTransferSchema = z.object({
  amount: z.number().int().positive(),
  currency: z
    .string()
    .length(3)
    .transform((v) => v.toUpperCase()),
  source_account_id: z.string().min(1).optional(),
  dest_account_id: z.string().min(1).optional(),
  description: z.string().max(500).optional(),
  reference: z.string().max(200).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const POST = createHandler({
  auth: "merchant",
  idempotent: true,
  validate: createTransferSchema,
  handler: async (ctx) => {
    const transfer = await prisma.$transaction(async (tx) => {
      const created = await tx.transfer.create({
        data: {
          merchantId: ctx.merchantId,
          amount: ctx.body.amount,
          currency: ctx.body.currency,
          status: "PENDING",
          sourceAccountId: ctx.body.source_account_id,
          destAccountId: ctx.body.dest_account_id,
          description: ctx.body.description,
          reference: ctx.body.reference,
          metadata: ctx.body.metadata as Prisma.InputJsonValue | undefined,
        },
      });

      await emitDomainEvent(tx, {
        merchantId: ctx.merchantId,
        type: "transfer.created",
        entityType: "Transfer",
        entityId: created.id,
        payload: serializeTransfer(created) as Record<string, unknown>,
        actorType: "api_key",
        actorId: ctx.apiKey.id,
      });

      return created;
    });

    return NextResponse.json(
      { transfer: serializeTransfer(transfer) },
      { status: 201 },
    );
  },
});

const listQuery = paginationSchema.extend({
  status: z.string().optional(),
});

export const GET = createHandler({
  auth: "merchant",
  query: listQuery,
  handler: async (ctx) => {
    const where: Prisma.TransferWhereInput = {
      merchantId: ctx.merchantId,
    };
    if (ctx.query.status) {
      where.status = ctx.query.status.toUpperCase() as TransferStatus;
    }

    const skip = paginationSkip(ctx.query);
    const [total, transfers] = await Promise.all([
      prisma.transfer.count({ where }),
      prisma.transfer.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: ctx.query.pageSize,
      }),
    ]);

    return NextResponse.json({
      data: transfers.map(serializeTransfer),
      pagination: paginationMeta(ctx.query, total),
    });
  },
});
