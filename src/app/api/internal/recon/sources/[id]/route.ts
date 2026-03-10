import { NextResponse } from "next/server";
import { type Prisma } from "@prisma/client";
import { z } from "zod";

import { createHandler } from "../../../../../../lib/handler";
import { NotFoundError, ConflictError } from "../../../../../../lib/errors";
import { prisma } from "../../../../../../lib/prisma";
import { serializeReconSource } from "../route";

export const GET = createHandler({
  auth: "admin",
  handler: async (ctx) => {
    const source = await prisma.reconSource.findUnique({
      where: { id: ctx.params.id },
    });
    if (!source) {
      throw new NotFoundError("RECON_SOURCE_NOT_FOUND", "Reconciliation source not found.");
    }
    return NextResponse.json({ data: serializeReconSource(source) });
  },
});

const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  is_active: z.boolean().optional(),
});

export const PATCH = createHandler({
  auth: "admin",
  validate: updateSchema,
  handler: async (ctx) => {
    const source = await prisma.reconSource.findUnique({
      where: { id: ctx.params.id },
    });
    if (!source) {
      throw new NotFoundError("RECON_SOURCE_NOT_FOUND", "Reconciliation source not found.");
    }

    if (ctx.body.name && ctx.body.name !== source.name) {
      const dup = await prisma.reconSource.findUnique({
        where: { name: ctx.body.name },
      });
      if (dup) {
        throw new ConflictError(
          "RECON_SOURCE_NAME_TAKEN",
          "A reconciliation source with this name already exists.",
        );
      }
    }

    const data: Prisma.ReconSourceUpdateInput = {};
    if (ctx.body.name !== undefined) data.name = ctx.body.name;
    if (ctx.body.description !== undefined) data.description = ctx.body.description;
    if (ctx.body.config !== undefined) {
      data.config = ctx.body.config as Prisma.InputJsonValue;
    }
    if (ctx.body.is_active !== undefined) data.isActive = ctx.body.is_active;

    const updated = await prisma.reconSource.update({
      where: { id: source.id },
      data,
    });

    return NextResponse.json({ data: serializeReconSource(updated) });
  },
});

export const DELETE = createHandler({
  auth: "admin",
  handler: async (ctx) => {
    const source = await prisma.reconSource.findUnique({
      where: { id: ctx.params.id },
    });
    if (!source) {
      throw new NotFoundError("RECON_SOURCE_NOT_FOUND", "Reconciliation source not found.");
    }

    await prisma.reconSource.delete({ where: { id: source.id } });

    return NextResponse.json({ deleted: true, id: source.id });
  },
});
