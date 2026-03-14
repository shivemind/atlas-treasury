#!/usr/bin/env bash
set -euo pipefail

POSTMAN_API_BASE="https://api.getpostman.com"
SPEC_FILE="${1:?Usage: sync-to-postman.sh <spec-path> <api-name>}"
API_NAME="${2:?Usage: sync-to-postman.sh <spec-path> <api-name>}"

: "${POSTMAN_API_KEY:?POSTMAN_API_KEY is required}"
: "${POSTMAN_WORKSPACE_ID:?POSTMAN_WORKSPACE_ID is required}"

PRODUCTION_URL="${PRODUCTION_URL:-}"
GITHUB_REPO_URL="${GITHUB_REPO_URL:-}"
GITHUB_SHA="${GITHUB_SHA:-unknown}"

if [ ! -f "$SPEC_FILE" ]; then
  echo "ERROR: Spec file not found: $SPEC_FILE" >&2
  exit 1
fi

for cmd in jq curl yq; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: ${cmd} is required but not installed" >&2
    exit 1
  fi
done

postman_api() {
  local method="$1" endpoint="$2"
  shift 2
  local tmpfile http_code body
  tmpfile=$(mktemp)
  http_code=$(curl -s -o "$tmpfile" -w '%{http_code}' \
    -X "$method" \
    "${POSTMAN_API_BASE}${endpoint}" \
    -H "X-Api-Key: ${POSTMAN_API_KEY}" \
    -H "Content-Type: application/json" \
    "$@")
  body=$(cat "$tmpfile")
  rm -f "$tmpfile"
  if [[ "$http_code" -lt 200 || "$http_code" -ge 300 ]]; then
    echo "ERROR: ${method} ${endpoint} returned HTTP ${http_code}" >&2
    echo "$body" | jq . 2>/dev/null || echo "$body" >&2
    return 1
  fi
  echo "$body"
}

# ===========================================================================
#  PHASE 1 — Git → Spec Hub (v12 Spec Hub)
# ===========================================================================
echo ""
echo "######  PHASE 1: Git → Spec Hub  ######"
echo ""

EXISTING_SPECS=$(postman_api GET "/specs?workspaceId=${POSTMAN_WORKSPACE_ID}")
SPEC_ID=$(echo "$EXISTING_SPECS" | jq -r --arg name "$API_NAME" \
  '[.specs[] | select(.name == $name)] | first // empty | .id // empty')

SPEC_CONTENT_FILE=$(mktemp)
cat "$SPEC_FILE" > "$SPEC_CONTENT_FILE"

if [ -n "$SPEC_ID" ]; then
  echo "    Found existing spec: ${SPEC_ID}"
  PATCH_BODY_FILE=$(mktemp)
  jq -n --arg name "$API_NAME" --rawfile content "$SPEC_CONTENT_FILE" \
    '{name: $name, files: [{path: "openapi.yaml", content: $content}]}' > "$PATCH_BODY_FILE"
  postman_api PATCH "/specs/${SPEC_ID}" -d @"$PATCH_BODY_FILE" > /dev/null
  rm -f "$PATCH_BODY_FILE"
  echo "    Updated."
else
  echo "    Creating new spec..."
  CREATE_BODY_FILE=$(mktemp)
  jq -n --arg name "$API_NAME" --rawfile content "$SPEC_CONTENT_FILE" \
    '{name: $name, type: "OPENAPI:3.0", files: [{path: "openapi.yaml", content: $content}]}' > "$CREATE_BODY_FILE"
  CREATE_RESP=$(postman_api POST "/specs?workspaceId=${POSTMAN_WORKSPACE_ID}" -d @"$CREATE_BODY_FILE")
  rm -f "$CREATE_BODY_FILE"
  SPEC_ID=$(echo "$CREATE_RESP" | jq -r '.id')
  echo "    Created spec: ${SPEC_ID}"
fi
rm -f "$SPEC_CONTENT_FILE"

echo "    Spec is now in Spec Hub (id: ${SPEC_ID})"

# ===========================================================================
#  PHASE 2 — Spec Hub → Collection + Environments + Monitor
# ===========================================================================
echo ""
echo "######  PHASE 2: Spec Hub → Collection + Environments + Monitor  ######"
echo ""

echo "==> 2a: Generate/update collection from spec"

SPEC_JSON_FILE=$(mktemp)
yq -o=json "$SPEC_FILE" > "$SPEC_JSON_FILE"

EXISTING_COLLS=$(postman_api GET "/collections?workspace=${POSTMAN_WORKSPACE_ID}")
EXISTING_COLL_ID=$(echo "$EXISTING_COLLS" | jq -r --arg name "$API_NAME" \
  '[.collections[] | select(.name == $name)] | first // empty | .uid // empty')

if [ -n "$EXISTING_COLL_ID" ]; then
  echo "    Deleting stale collection ${EXISTING_COLL_ID} to re-import..."
  postman_api DELETE "/collections/${EXISTING_COLL_ID}" > /dev/null 2>&1 || true
fi

echo "    Importing spec as new collection..."
IMPORT_BODY_FILE=$(mktemp)
jq -n --slurpfile input "$SPEC_JSON_FILE" '{type: "json", input: $input[0]}' > "$IMPORT_BODY_FILE"
COLL_RESP=$(curl -s -X POST "${POSTMAN_API_BASE}/import/openapi" \
  -H "X-Api-Key: ${POSTMAN_API_KEY}" \
  -H "X-Workspace-Id: ${POSTMAN_WORKSPACE_ID}" \
  -H "Content-Type: application/json" \
  -d @"$IMPORT_BODY_FILE")
rm -f "$SPEC_JSON_FILE" "$IMPORT_BODY_FILE"
COLLECTION_UID=$(echo "$COLL_RESP" | jq -r '.collections[0].uid // empty')

if [ -z "$COLLECTION_UID" ]; then
  echo "WARNING: Collection import did not return UID. Response: $COLL_RESP" >&2
  COLLECTION_UID="unknown"
fi
echo "    Collection: ${COLLECTION_UID}"

# 2a-ii: Update collection description and add collection-level test scripts
if [ "$COLLECTION_UID" != "unknown" ]; then
  echo "    Adding collection-level test scripts and metadata..."
  COLL_DETAIL=$(postman_api GET "/collections/${COLLECTION_UID}")
  COLL_DESC="Source: ${GITHUB_REPO_URL:-n/a} | Commit: ${GITHUB_SHA} | Auto-synced from OpenAPI spec via CI/CD"

  PATCH_BODY_FILE=$(mktemp)
  echo "$COLL_DETAIL" | jq --arg desc "$COLL_DESC" '
    .collection.info.description = $desc |
    .collection.event = [
      { "listen": "test",
        "script": {
          "type": "text/javascript",
          "exec": [
            "pm.test(\"Status code is successful\", function () {",
            "    pm.expect(pm.response.code).to.be.within(200, 399);",
            "});",
            "pm.test(\"Response time is under 5s\", function () {",
            "    pm.expect(pm.response.responseTime).to.be.below(5000);",
            "});",
            "pm.test(\"Valid JSON response\", function () {",
            "    if (pm.response.text().length > 0) { pm.response.to.have.jsonBody(); }",
            "});"
          ]
        }
      }
    ]' > "$PATCH_BODY_FILE"
  postman_api PUT "/collections/${COLLECTION_UID}" -d @"$PATCH_BODY_FILE" > /dev/null 2>&1 || echo "    (collection update skipped)"
  rm -f "$PATCH_BODY_FILE"
  echo "    Collection updated with tests and description"
fi

echo "==> 2b: Create/update environments (Dev + Production)"

BASE_URL=$(yq -r '.servers[0].url // "http://localhost:3000"' "$SPEC_FILE")
SPEC_VERSION=$(yq -r '.info.version // "0.1.0"' "$SPEC_FILE")

EXISTING_ENVS=$(postman_api GET "/environments?workspace=${POSTMAN_WORKSPACE_ID}")

create_or_update_env() {
  local env_name="$1" env_base_url="$2"
  local existing_env_id
  existing_env_id=$(echo "$EXISTING_ENVS" | jq -r --arg name "$env_name" \
    '[.environments[] | select(.name == $name)] | first // empty | .uid // empty')

  local env_values
  env_values=$(jq -n \
    --arg baseUrl "$env_base_url" \
    --arg version "$SPEC_VERSION" \
    --arg apiKey "test-api-key" \
    --arg repo "${GITHUB_REPO_URL:-n/a}" \
    '[{key: "baseUrl", value: $baseUrl, enabled: true},
      {key: "apiVersion", value: $version, enabled: true},
      {key: "apiKey", value: $apiKey, enabled: true, type: "secret"},
      {key: "githubRepo", value: $repo, enabled: true}]')

  if [ -n "$existing_env_id" ]; then
    postman_api PUT "/environments/${existing_env_id}" \
      -d "$(jq -n --arg name "$env_name" --argjson values "$env_values" \
        '{environment: {name: $name, values: $values}}')" > /dev/null
    echo "    Updated environment: ${env_name} (${existing_env_id})"
    echo "$existing_env_id"
  else
    local env_resp
    env_resp=$(postman_api POST "/environments?workspace=${POSTMAN_WORKSPACE_ID}" \
      -d "$(jq -n --arg name "$env_name" --argjson values "$env_values" \
        '{environment: {name: $name, values: $values}}')")
    local env_id
    env_id=$(echo "$env_resp" | jq -r '.environment.id // empty')
    echo "    Created environment: ${env_name} (${env_id})"
    echo "$env_id"
  fi
}

DEV_ENV_ID=$(create_or_update_env "${API_NAME} - Dev" "$BASE_URL" 2>&1 | tail -1)
echo "    Dev env: ${DEV_ENV_ID}"

if [ -n "$PRODUCTION_URL" ]; then
  PROD_ENV_ID=$(create_or_update_env "${API_NAME} - Production" "$PRODUCTION_URL" 2>&1 | tail -1)
  echo "    Production env: ${PROD_ENV_ID}"
fi

echo "==> 2c: Create/update monitor (best-effort)"

MON_NAME="${API_NAME} - Health Monitor"
MON_ID=""

if EXISTING_MONITORS=$(postman_api GET "/monitors?workspace=${POSTMAN_WORKSPACE_ID}" 2>/dev/null); then
  EXISTING_MON_ID=$(echo "$EXISTING_MONITORS" | jq -r --arg name "$MON_NAME" \
    '[.monitors[] | select(.name == $name)] | first // empty | .id // empty')

  if [ -n "$EXISTING_MON_ID" ]; then
    echo "    Monitor already exists: ${EXISTING_MON_ID}"
    MON_ID="$EXISTING_MON_ID"
  elif [ "$COLLECTION_UID" != "unknown" ]; then
    MON_ENV="${PROD_ENV_ID:-$DEV_ENV_ID}"
    MON_RESP=$(postman_api POST "/monitors?workspace=${POSTMAN_WORKSPACE_ID}" \
      -d "$(jq -n --arg name "$MON_NAME" --arg coll "$COLLECTION_UID" --arg env "$MON_ENV" \
        '{monitor: {name: $name, collection: $coll, environment: $env, schedule: {cron: "0 */6 * * *", timezone: "America/New_York"}}}')" 2>/dev/null) || true
    MON_ID=$(echo "$MON_RESP" | jq -r '.monitor.id // empty' 2>/dev/null || echo "")
    if [ -n "$MON_ID" ]; then
      echo "    Created monitor: ${MON_ID}"
    else
      echo "    Monitor creation skipped (plan may not support monitors)"
    fi
  fi
else
  echo "    Monitor API unavailable, skipping"
fi

echo ""
echo "============================================="
echo "  Sync complete for: ${API_NAME}"
echo "---------------------------------------------"
echo "  Spec Hub ID:     ${SPEC_ID}"
echo "  Collection UID:  ${COLLECTION_UID}"
echo "  Dev Env ID:      ${DEV_ENV_ID:-n/a}"
echo "  Prod Env ID:     ${PROD_ENV_ID:-n/a}"
echo "  Monitor ID:      ${MON_ID:-n/a}"
echo "  GitHub Repo:     ${GITHUB_REPO_URL:-n/a}"
echo "  Commit SHA:      ${GITHUB_SHA}"
echo "============================================="
