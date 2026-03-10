import { createHash } from "node:crypto";

import { prisma } from "./prisma";

type AuthResult =
  | {
      ok: true;
      merchant: {
        id: string;
        name: string;
        status: string;
      };
      apiKey: {
        id: string;
        name: string;
        role: string;
        scopes: string[];
        keyPrefix: string;
        createdAt: string;
        lastUsedAt: string | null;
      };
    }
  | {
      ok: false;
      status: 401;
      code: "AUTH_REQUIRED" | "INVALID_API_KEY";
      message: string;
    };

function hashApiKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseBearerToken(authHeader: string | null): string | null {
  if (!authHeader) {
    return null;
  }

  const [scheme, token] = authHeader.split(" ");
  if (!scheme || !token || scheme.toLowerCase() !== "bearer") {
    return null;
  }

  return token.trim() || null;
}

export async function authenticateApiKey(request: Request): Promise<AuthResult> {
  const bearerToken = parseBearerToken(request.headers.get("authorization"));

  if (!bearerToken) {
    return {
      ok: false,
      status: 401,
      code: "AUTH_REQUIRED",
      message: "Authorization bearer token is required.",
    };
  }

  const keyHash = hashApiKey(bearerToken);
  const apiKey = await prisma.apiKey.findFirst({
    where: {
      keyHash,
      isActive: true,
    },
    include: {
      merchant: true,
    },
  });

  if (!apiKey) {
    return {
      ok: false,
      status: 401,
      code: "INVALID_API_KEY",
      message: "Invalid API key.",
    };
  }

  const scopes = Array.isArray(apiKey.scopes)
    ? apiKey.scopes.filter((scope): scope is string => typeof scope === "string")
    : [];

  return {
    ok: true,
    merchant: {
      id: apiKey.merchant.id,
      name: apiKey.merchant.name,
      status: apiKey.merchant.status,
    },
    apiKey: {
      id: apiKey.id,
      name: apiKey.name,
      role: apiKey.role,
      scopes,
      keyPrefix: apiKey.keyPrefix,
      createdAt: apiKey.createdAt.toISOString(),
      lastUsedAt: apiKey.lastUsedAt?.toISOString() ?? null,
    },
  };
}

export function makeApiKeyHash(rawKey: string): string {
  return hashApiKey(rawKey);
}
