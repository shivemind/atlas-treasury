#!/usr/bin/env bash
set -euo pipefail

POSTMAN_API_BASE="https://api.getpostman.com"
SPEC_FILE="${1:?Usage: sync-to-postman.sh <spec-path> <api-name>}"
API_NAME="${2:?Usage: sync-to-postman.sh <spec-path> <api-name>}"

: "${POSTMAN_API_KEY:?POSTMAN_API_KEY is required}"
: "${POSTMAN_WORKSPACE_ID:?POSTMAN_WORKSPACE_ID is required}"

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
#  PHASE 1 — Git → Spec Hub
# ===========================================================================
echo ""
echo "######  PHASE 1: Git → Spec Hub  ######"
echo ""

EXISTING_SPECS=$(postman_api GET "/specs?workspaceId=${POSTMAN_WORKSPACE_ID}")
SPEC_ID=$(echo "$EXISTING_SPECS" | jq -r --arg name "$API_NAME" \
  '[.specs[] | select(.name == $name)] | first // empty | .id // empty')

SPEC_CONTENT=$(cat "$SPEC_FILE")

if [ -n "$SPEC_ID" ]; then
  echo "    Found existing spec: ${SPEC_ID}"
  postman_api PATCH "/specs/${SPEC_ID}" \
    -d "$(jq -n --arg name "$API_NAME" --arg content "$SPEC_CONTENT" \
      '{name: $name, files: [{path: "openapi.yaml", content: $content}]}')" > /dev/null
  echo "    Updated."
else
  echo "    Creating new spec..."
  CREATE_RESP=$(postman_api POST "/specs?workspaceId=${POSTMAN_WORKSPACE_ID}" \
    -d "$(jq -n --arg name "$API_NAME" --arg content "$SPEC_CONTENT" \
      '{name: $name, type: "OPENAPI:3.0", files: [{path: "openapi.yaml", content: $content}]}')")
  SPEC_ID=$(echo "$CREATE_RESP" | jq -r '.id')
  echo "    Created spec: ${SPEC_ID}"
fi

echo "    Spec is now in Spec Hub (id: ${SPEC_ID})"

# ===========================================================================
#  PHASE 2 — Spec Hub → Collection + Environment + Monitor
# ===========================================================================
echo ""
echo "######  PHASE 2: Spec Hub → Collection + Environment + Monitor  ######"
echo ""

echo "==> 2a: Generate/update collection from spec"

SPEC_JSON=$(yq -o=json "$SPEC_FILE")

EXISTING_COLLS=$(postman_api GET "/collections?workspace=${POSTMAN_WORKSPACE_ID}")
EXISTING_COLL_ID=$(echo "$EXISTING_COLLS" | jq -r --arg name "$API_NAME" \
  '[.collections[] | select(.name == $name)] | first // empty | .uid // empty')

if [ -n "$EXISTING_COLL_ID" ]; then
  echo "    Deleting stale collection ${EXISTING_COLL_ID} to re-import..."
  postman_api DELETE "/collections/${EXISTING_COLL_ID}" > /dev/null 2>&1 || true
fi

echo "    Importing spec as new collection..."
IMPORT_BODY=$(jq -n --argjson input "$SPEC_JSON" '{type: "json", input: $input}')
COLL_RESP=$(curl -s -X POST "${POSTMAN_API_BASE}/import/openapi" \
  -H "X-Api-Key: ${POSTMAN_API_KEY}" \
  -H "X-Workspace-Id: ${POSTMAN_WORKSPACE_ID}" \
  -H "Content-Type: application/json" \
  -d "$IMPORT_BODY")
COLLECTION_UID=$(echo "$COLL_RESP" | jq -r '.collections[0].uid // empty')

if [ -z "$COLLECTION_UID" ]; then
  echo "WARNING: Collection import did not return UID. Response: $COLL_RESP" >&2
  COLLECTION_UID="unknown"
fi
echo "    Collection: ${COLLECTION_UID}"

echo "==> 2b: Create/update environment"

BASE_URL=$(yq -r '.servers[0].url // "http://localhost:3000"' "$SPEC_FILE")
SPEC_VERSION=$(yq -r '.info.version // "0.1.0"' "$SPEC_FILE")

EXISTING_ENVS=$(postman_api GET "/environments?workspace=${POSTMAN_WORKSPACE_ID}")
ENV_NAME="${API_NAME} - Dev"
EXISTING_ENV_ID=$(echo "$EXISTING_ENVS" | jq -r --arg name "$ENV_NAME" \
  '[.environments[] | select(.name == $name)] | first // empty | .uid // empty')

ENV_VALUES=$(jq -n \
  --arg baseUrl "$BASE_URL" \
  --arg version "$SPEC_VERSION" \
  --arg apiKey "test-api-key" \
  '[{key: "baseUrl", value: $baseUrl, enabled: true},
    {key: "apiVersion", value: $version, enabled: true},
    {key: "apiKey", value: $apiKey, enabled: true, type: "secret"}]')

if [ -n "$EXISTING_ENV_ID" ]; then
  postman_api PUT "/environments/${EXISTING_ENV_ID}" \
    -d "$(jq -n --arg name "$ENV_NAME" --argjson values "$ENV_VALUES" \
      '{environment: {name: $name, values: $values}}')" > /dev/null
  ENV_ID="$EXISTING_ENV_ID"
  echo "    Updated environment: ${ENV_ID}"
else
  ENV_RESP=$(postman_api POST "/environments?workspace=${POSTMAN_WORKSPACE_ID}" \
    -d "$(jq -n --arg name "$ENV_NAME" --argjson values "$ENV_VALUES" \
      '{environment: {name: $name, values: $values}}')")
  ENV_ID=$(echo "$ENV_RESP" | jq -r '.environment.id // empty')
  echo "    Created environment: ${ENV_ID}"
fi

echo "==> 2c: Create/update monitor"

EXISTING_MONITORS=$(postman_api GET "/monitors?workspace=${POSTMAN_WORKSPACE_ID}")
MON_NAME="${API_NAME} - Health Monitor"
EXISTING_MON_ID=$(echo "$EXISTING_MONITORS" | jq -r --arg name "$MON_NAME" \
  '[.monitors[] | select(.name == $name)] | first // empty | .id // empty')

if [ -n "$EXISTING_MON_ID" ]; then
  echo "    Monitor already exists: ${EXISTING_MON_ID}"
elif [ "$COLLECTION_UID" != "unknown" ]; then
  MON_RESP=$(postman_api POST "/monitors?workspace=${POSTMAN_WORKSPACE_ID}" \
    -d "$(jq -n --arg name "$MON_NAME" --arg coll "$COLLECTION_UID" --arg env "$ENV_ID" \
      '{monitor: {name: $name, collection: $coll, environment: $env, schedule: {cron: "0 */6 * * *", timezone: "America/New_York"}}}')")
  MON_ID=$(echo "$MON_RESP" | jq -r '.monitor.id // empty')
  echo "    Created monitor: ${MON_ID}"
else
  echo "    Skipping monitor (no collection UID)."
fi

echo ""
echo "============================================="
echo "  Sync complete for: ${API_NAME}"
echo "---------------------------------------------"
echo "  Spec Hub ID:     ${SPEC_ID}"
echo "  Collection UID:  ${COLLECTION_UID}"
echo "  Environment ID:  ${ENV_ID:-n/a}"
echo "============================================="
