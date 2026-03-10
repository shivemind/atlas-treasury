import { NextResponse } from "next/server";
import { type Prisma } from "@prisma/client";
import { z } from "zod";

import {
  createHandler,
  paginationSchema,
  paginationMeta,
  paginationSkip,
} from "../../../../../../../lib/handler";
import { NotFoundError } from "../../../../../../../lib/errors";
import { prisma } from "../../../../../../../lib/prisma";

function serializeReconImport(i: {
  id: string;
  reconSourceId: string;
  fileName: string | null;
  recordCount: number;
  status: string;
  errorMessage: string | null;
  processedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: i.id,
    recon_source_id: i.reconSourceId,
    file_name: i.fileName,
    record_count: i.recordCount,
    status: i.status,
    error_message: i.errorMessage,
    processed_at: i.processedAt?.toISOString() ?? null,
    created_at: i.createdAt.toISOString(),
    updated_at: i.updatedAt.toISOString(),
  };
}

export { serializeReconImport };

const createImportSchema = z.object({
  file_name: z.string().min(1).max(500).optional(),
  record_count: z.number().int().min(0).optional(),
});

export const POST = createHandler({
  auth: "admin",
  validate: createImportSchema,
  handler: async (ctx) => {
    const source = await prisma.reconSource.findUnique({
      where: { id: ctx.params.id },
    });
    if (!source) {
      throw new NotFoundError("RECON_SOURCE_NOT_FOUND", "Reconciliation source not found.");
    }

    const reconImport = await prisma.reconImport.create({
      data: {
        reconSourceId: source.id,
        fileName: ctx.body.file_name,
        recordCount: ctx.body.record_count ?? 0,
        status: "pending",
      },
    });

    return NextResponse.json(
      { data: serializeReconImport(reconImport) },
      { status: 201 },
    );
  },
});

const listQuery = paginationSchema.extend({
  status: z.string().optional(),
});

export const GET = createHandler({
  auth: "admin",
  query: listQuery,
  handler: async (ctx) => {
    const source = await prisma.reconSource.findUnique({
      where: { id: ctx.params.id },
    });
    if (!source) {
      throw new NotFoundError("RECON_SOURCE_NOT_FOUND", "Reconciliation source not found.");
    }

    const where: Prisma.ReconImportWhereInput = {
      reconSourceId: source.id,
    };
    if (ctx.query.status) where.status = ctx.query.status;

    const skip = paginationSkip(ctx.query);
    const [total, imports] = await Promise.all([
      prisma.reconImport.count({ where }),
      prisma.reconImport.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: ctx.query.pageSize,
      }),
    ]);

    return NextResponse.json({
      data: imports.map(serializeReconImport),
      pagination: paginationMeta(ctx.query, total),
    });
  },
});
