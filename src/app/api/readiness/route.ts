import { NextResponse } from "next/server";

import { prisma } from "../../../lib/prisma";

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({
      status: "ready",
      service: "atlas-treasury",
      checks: { database: "ok" },
      timestamp: new Date().toISOString(),
    });
  } catch {
    return NextResponse.json(
      {
        status: "not_ready",
        service: "atlas-treasury",
        checks: { database: "error" },
        timestamp: new Date().toISOString(),
      },
      { status: 503 },
    );
  }
}
