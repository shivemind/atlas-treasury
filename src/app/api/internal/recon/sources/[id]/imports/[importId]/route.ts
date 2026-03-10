import { NextResponse } from "next/server";
import { z } from "zod";

import { createHandler } from "../../../../../../../../lib/handler";
import { NotFoundError } from "../../../../../../../../lib/errors";
import { prisma } from "../../../../../../../../lib/prisma";
import { serializeReconImport } from "../route";

export const GET = createHandler({
  auth: "admin",
  handler: async (ctx) => {
    const reconImport = await prisma.reconImport.findFirst({
      where: {
        id: ctx.params.importId,
        reconSourceId: ctx.params.id,
      },
    });
    if (!reconImport) {
      throw new NotFoundError("RECON_IMPORT_NOT_FOUND", "Reconciliation import not found.");
    }
    return NextResponse.json({ data: serializeReconImport(reconImport) });
  },
});

const updateSchema = z.object({
  status: z.string().min(1).optional(),
  record_count: z.number().int().min(0).optional(),
  error_message: z.string().max(5000).optional(),
});

export const PATCH = createHandler({
  auth: "admin",
  validate: updateSchema,
  handler: async (ctx) => {
    const reconImport = await prisma.reconImport.findFirst({
      where: {
        id: ctx.params.importId,
        reconSourceId: ctx.params.id,
      },
    });
    if (!reconImport) {
      throw new NotFoundError("RECON_IMPORT_NOT_FOUND", "Reconciliation import not found.");
    }

    const data: Record<string, unknown> = {};
    if (ctx.body.status !== undefined) {
      data.status = ctx.body.status;
      if (ctx.body.status === "completed") {
        data.processedAt = new Date();
      }
    }
    if (ctx.body.record_count !== undefined) data.recordCount = ctx.body.record_count;
    if (ctx.body.error_message !== undefined) data.errorMessage = ctx.body.error_message;

    const updated = await prisma.reconImport.update({
      where: { id: reconImport.id },
      data,
    });

    return NextResponse.json({ data: serializeReconImport(updated) });
  },
});
