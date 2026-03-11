/**
 * openapi-validate.mjs
 *
 * Dedicated OpenAPI structural validator for openapi/openapi.yaml.
 * Checks:
 *   - Valid YAML syntax
 *   - Required top-level fields (openapi, info, paths, components)
 *   - All operations have operationId and at least one tag
 *   - operationId uniqueness across all operations
 *   - Security schemes MerchantKeyAuth and PlatformAdminKeyAuth declared
 *   - /api/v1/* operations use MerchantKeyAuth
 *   - /api/internal/* operations use PlatformAdminKeyAuth
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parseDocument } from "yaml";

const SPEC_PATH = resolve(process.cwd(), "openapi", "openapi.yaml");

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

function warn(message) {
  console.warn(`⚠️  ${message}`);
}

// ── Parse ──────────────────────────────────────────────────────────────────

const source = readFileSync(SPEC_PATH, "utf8");
const doc = parseDocument(source, { prettyErrors: true });

if (doc.errors.length > 0) {
  const details = doc.errors.map((e) => e.message).join("; ");
  fail(`YAML syntax error in ${SPEC_PATH}: ${details}`);
}

const spec = doc.toJS();

// ── Top-level structure ────────────────────────────────────────────────────

if (!spec || typeof spec !== "object") fail("Spec root must be an object.");
if (!spec.openapi) fail("Missing top-level `openapi` version field.");
if (!spec.info) fail("Missing top-level `info` object.");
if (!spec.paths || typeof spec.paths !== "object") fail("Missing top-level `paths` object.");
if (!spec.components || typeof spec.components !== "object") fail("Missing top-level `components` object.");

// ── Security schemes ───────────────────────────────────────────────────────

const schemes = spec.components?.securitySchemes ?? {};

if (!schemes.MerchantKeyAuth) fail("components.securitySchemes must declare MerchantKeyAuth.");
if (!schemes.PlatformAdminKeyAuth) fail("components.securitySchemes must declare PlatformAdminKeyAuth.");

// ── Collect all operations ─────────────────────────────────────────────────

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];

function collectOperations(paths) {
  const ops = [];
  for (const [path, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== "object") continue;
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (op && typeof op === "object") {
        ops.push({ path, method, op });
      }
    }
  }
  return ops;
}

const operations = collectOperations(spec.paths);

// ── operationId uniqueness ─────────────────────────────────────────────────

const ids = [];
const missingId = [];

for (const { path, method, op } of operations) {
  if (!op.operationId) {
    missingId.push(`${method.toUpperCase()} ${path}`);
  } else {
    ids.push(op.operationId);
  }
}

if (missingId.length > 0) {
  fail(`Operations missing operationId:\n  ${missingId.join("\n  ")}`);
}

const idSet = new Set();
const duplicates = [];
for (const id of ids) {
  if (idSet.has(id)) duplicates.push(id);
  idSet.add(id);
}
if (duplicates.length > 0) {
  fail(`Duplicate operationIds: ${duplicates.join(", ")}`);
}

// ── Tags ───────────────────────────────────────────────────────────────────

const missingTags = [];
for (const { path, method, op } of operations) {
  if (!Array.isArray(op.tags) || op.tags.length === 0) {
    missingTags.push(`${method.toUpperCase()} ${path}`);
  }
}
if (missingTags.length > 0) {
  fail(`Operations missing tags:\n  ${missingTags.join("\n  ")}`);
}

// ── Security per path prefix ───────────────────────────────────────────────

const securityViolations = [];

for (const { path, method, op } of operations) {
  const security = op.security;
  const isV1 = path.startsWith("/api/v1/");
  const isInternal = path.startsWith("/api/internal/");

  if (isV1) {
    const usesMerchant =
      Array.isArray(security) &&
      security.some((s) => typeof s === "object" && "MerchantKeyAuth" in s);
    if (!usesMerchant) {
      securityViolations.push(
        `${method.toUpperCase()} ${path} — /api/v1/* must use MerchantKeyAuth`,
      );
    }
  }

  if (isInternal) {
    const usesAdmin =
      Array.isArray(security) &&
      security.some((s) => typeof s === "object" && "PlatformAdminKeyAuth" in s);
    if (!usesAdmin) {
      securityViolations.push(
        `${method.toUpperCase()} ${path} — /api/internal/* must use PlatformAdminKeyAuth`,
      );
    }
  }
}

if (securityViolations.length > 0) {
  fail(`Security requirement violations:\n  ${securityViolations.join("\n  ")}`);
}

// ── Descriptions (warn) ────────────────────────────────────────────────────

for (const { path, method, op } of operations) {
  if (!op.description) {
    warn(`${method.toUpperCase()} ${path} is missing a description.`);
  }
}

// ── Summary ────────────────────────────────────────────────────────────────

const opCount = operations.length;
console.log(
  `✅ openapi/openapi.yaml is valid — ${opCount} operation${opCount === 1 ? "" : "s"}, ${ids.length} unique operationIds, security requirements satisfied.`,
);
