import { NextResponse } from "next/server";
import { type Prisma } from "@prisma/client";
import { z } from "zod";

import {
  createHandler,
  paginationSchema,
  paginationMeta,
  paginationSkip,
} from "../../../../../lib/handler";
import { ConflictError } from "../../../../../lib/errors";
import { prisma } from "../../../../../lib/prisma";

function serializeReconSource(s: {
  id: string;
  name: string;
  description: string | null;
  config: unknown;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    config: s.config,
    is_active: s.isActive,
    created_at: s.createdAt.toISOString(),
    updated_at: s.updatedAt.toISOString(),
  };
}

export { serializeReconSource };

const createSourceSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  is_active: z.boolean().optional(),
});

export const POST = createHandler({
  auth: "admin",
  validate: createSourceSchema,
  handler: async (ctx) => {
    const existing = await prisma.reconSource.findUnique({
      where: { name: ctx.body.name },
    });
    if (existing) {
      throw new ConflictError(
        "RECON_SOURCE_NAME_TAKEN",
        "A reconciliation source with this name already exists.",
      );
    }

    const source = await prisma.reconSource.create({
      data: {
        name: ctx.body.name,
        description: ctx.body.description,
        config: ctx.body.config as Prisma.InputJsonValue | undefined,
        isActive: ctx.body.is_active ?? true,
      },
    });

    return NextResponse.json(
      { data: serializeReconSource(source) },
      { status: 201 },
    );
  },
});

const listQuery = paginationSchema.extend({
  is_active: z.coerce.boolean().optional(),
});

export const GET = createHandler({
  auth: "admin",
  query: listQuery,
  handler: async (ctx) => {
    const where: Prisma.ReconSourceWhereInput = {};
    if (ctx.query.is_active !== undefined) {
      where.isActive = ctx.query.is_active;
    }

    const skip = paginationSkip(ctx.query);
    const [total, sources] = await Promise.all([
      prisma.reconSource.count({ where }),
      prisma.reconSource.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: ctx.query.pageSize,
      }),
    ]);

    return NextResponse.json({
      data: sources.map(serializeReconSource),
      pagination: paginationMeta(ctx.query, total),
    });
  },
});
