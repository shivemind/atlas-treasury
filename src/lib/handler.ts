import { NextResponse } from "next/server";
import { z } from "zod";

import { authenticateApiKey } from "./auth";
import { checkApiKeyRateLimit } from "./rate-limit";
import { executeWithIdempotency } from "./idempotency";
import { ApiError } from "./errors";

// ── Auth info types ──────────────────────────────────────────────────

interface MerchantInfo {
  id: string;
  name: string;
  status: string;
}

interface ApiKeyInfo {
  id: string;
  name: string;
  role: string;
  scopes: string[];
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

// ── Handler context types ────────────────────────────────────────────

export interface HandlerContext<TBody = unknown, TQuery = unknown> {
  merchantId: string;
  merchant: MerchantInfo;
  apiKey: ApiKeyInfo;
  body: TBody;
  query: TQuery;
  params: Record<string, string>;
  request: Request;
}

export interface PublicContext<TBody = unknown, TQuery = unknown> {
  body: TBody;
  query: TQuery;
  params: Record<string, string>;
  request: Request;
}

export interface CronContext {
  params: Record<string, string>;
  request: Request;
}

// ── Config types ─────────────────────────────────────────────────────

interface RateLimitConfig {
  maxRequests: number;
  windowSeconds: number;
}

type RouteHandler = (
  request: Request,
  context?: { params: Promise<Record<string, string>> },
) => Promise<Response>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createHandler(config: {
  auth: "merchant" | "admin" | "none" | "cron";
  rateLimit?: boolean | RateLimitConfig;
  idempotent?: boolean;
  validate?: z.ZodType;
  query?: z.ZodType;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (ctx: any) => Promise<NextResponse>;
}): RouteHandler {
  return async (request, routeContext) => {
    try {
      const params = routeContext?.params ? await routeContext.params : {};

      // ── Cron auth ────────────────────────────────────────────
      if (config.auth === "cron") {
        const cronSecret = process.env.CRON_SECRET;
        const headerSecret = request.headers.get("x-cron-secret");
        const querySecret = new URL(request.url).searchParams.get(
          "cron_secret",
        );
        const isVercelCron = request.headers.get("x-vercel-cron") === "1";

        if (
          !isVercelCron &&
          headerSecret !== cronSecret &&
          querySecret !== cronSecret
        ) {
          return errorJson("CRON_UNAUTHORIZED", "Invalid cron secret.", 401);
        }

        return await config.handler({ params, request } as CronContext);
      }

      // ── Public (no auth) ─────────────────────────────────────
      if (config.auth === "none") {
        const body = config.validate
          ? await parseBody(request, config.validate)
          : undefined;
        if (body instanceof NextResponse) return body;

        const query = config.query
          ? parseQuery(request, config.query)
          : undefined;
        if (query instanceof NextResponse) return query;

        return await config.handler({
          body,
          query,
          params,
          request,
        } as PublicContext);
      }

      // ── Authenticated (merchant/admin) ───────────────────────
      const authResult = await authenticateApiKey(request);
      if (!authResult.ok) {
        return errorJson(
          authResult.code,
          authResult.message,
          authResult.status,
        );
      }

      if (
        config.auth === "admin" &&
        authResult.apiKey.role !== "PLATFORM_ADMIN"
      ) {
        return errorJson("FORBIDDEN", "Platform admin access required.", 403);
      }

      // Rate limiting
      if (config.rateLimit) {
        const rlOpts =
          typeof config.rateLimit === "object" ? config.rateLimit : undefined;
        const rl = await checkApiKeyRateLimit(
          authResult.apiKey.id,
          rlOpts?.maxRequests,
          rlOpts?.windowSeconds,
        );
        if (!rl.allowed) {
          return rateLimitJson(rl);
        }
      }

      // Body validation
      const body = config.validate
        ? await parseBody(request, config.validate, config.idempotent)
        : undefined;
      if (body instanceof NextResponse) return body;

      // Query validation
      const query = config.query
        ? parseQuery(request, config.query)
        : undefined;
      if (query instanceof NextResponse) return query;

      const ctx: HandlerContext = {
        merchantId: authResult.merchant.id,
        merchant: authResult.merchant,
        apiKey: authResult.apiKey,
        body,
        query,
        params,
        request,
      };

      // Idempotency wrapping (await is required so errors propagate to the catch block)
      if (config.idempotent) {
        const route = new URL(request.url).pathname;
        return await executeWithIdempotency({
          request,
          merchantId: authResult.merchant.id,
          route,
          execute: () => config.handler(ctx),
        });
      }

      return await config.handler(ctx);
    } catch (error) {
      if (error instanceof ApiError) {
        return errorJson(error.code, error.message, error.status, error.details);
      }
      console.error("Unhandled handler error:", error);
      return errorJson(
        "INTERNAL_ERROR",
        "An unexpected error occurred.",
        500,
      );
    }
  };
}

// ── Pagination helpers ───────────────────────────────────────────────

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
});

export type PaginationQuery = z.infer<typeof paginationSchema>;

export function paginationMeta(query: PaginationQuery, total: number) {
  const skip = (query.page - 1) * query.pageSize;
  return {
    page: query.page,
    pageSize: query.pageSize,
    total,
    hasMore: skip + query.pageSize < total,
  };
}

export function paginationSkip(query: PaginationQuery): number {
  return (query.page - 1) * query.pageSize;
}

// ── Response helpers ─────────────────────────────────────────────────

function errorJson(
  code: string,
  message: string,
  status: number,
  details?: unknown,
): NextResponse {
  const error: Record<string, unknown> = { code, message };
  if (details !== undefined) {
    error.details = details;
  }
  return NextResponse.json({ error }, { status });
}

function rateLimitJson(rl: {
  limit: number;
  remaining: number;
  resetAt: number;
}): NextResponse {
  return NextResponse.json(
    { error: { code: "RATE_LIMITED", message: "Rate limit exceeded." } },
    {
      status: 429,
      headers: {
        "x-ratelimit-limit": String(rl.limit),
        "x-ratelimit-remaining": String(rl.remaining),
        "x-ratelimit-reset": String(Math.floor(rl.resetAt / 1000)),
      },
    },
  );
}

async function parseBody(
  request: Request,
  schema: z.ZodType,
  clone = false,
): Promise<unknown | NextResponse> {
  const raw = clone
    ? await request.clone().json().catch(() => null)
    : await request.json().catch(() => null);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return errorJson(
      "INVALID_REQUEST",
      "Request body validation failed.",
      400,
      parsed.error.flatten(),
    );
  }
  return parsed.data;
}

function parseQuery(
  request: Request,
  schema: z.ZodType,
): unknown | NextResponse {
  const url = new URL(request.url);
  const rawQuery: Record<string, string> = {};
  url.searchParams.forEach((v, k) => {
    rawQuery[k] = v;
  });
  const parsed = schema.safeParse(rawQuery);
  if (!parsed.success) {
    return errorJson(
      "INVALID_QUERY",
      "Query validation failed.",
      400,
      parsed.error.flatten(),
    );
  }
  return parsed.data;
}
