#!/usr/bin/env bash
set -euo pipefail

API_URL="${VITE_BEK_API_URL:-http://localhost:4317}"

curl_auth_args() {
  if [[ -n "${BEK_ADMIN_API_TOKEN:-}" ]]; then
    printf '%s\n' -H "authorization: Bearer ${BEK_ADMIN_API_TOKEN}"
  fi
}

echo "Checking ${API_URL}/health"
curl -fsS "${API_URL}/health" >/dev/null

echo "Creating approval-gated PR run"
RUN_JSON="$(
  curl -fsS "${API_URL}/api/runs" \
    $(curl_auth_args) \
    -H "content-type: application/json" \
    -d '{
      "placeScopeId": "place_checkout",
      "prompt": "@bek inspect checkout retries and open a PR if needed",
      "capability": "github.pr",
      "resource": "github:redohq/checkout"
    }'
)"

RUN_ID="$(node -e 'const data = JSON.parse(process.argv[1]); process.stdout.write(data.id)' "${RUN_JSON}")"
DETAIL_JSON="$(curl -fsS "${API_URL}/api/runs/${RUN_ID}" $(curl_auth_args))"
APPROVAL_ID="$(node -e 'const data = JSON.parse(process.argv[1]); process.stdout.write(data.approvals[0].id)' "${DETAIL_JSON}")"
PAYLOAD_HASH="$(node -e 'const data = JSON.parse(process.argv[1]); process.stdout.write(data.approvals[0].payloadHash)' "${DETAIL_JSON}")"

echo "Approving ${APPROVAL_ID}"
curl -fsS "${API_URL}/api/approvals/${APPROVAL_ID}/approve" \
  $(curl_auth_args) \
  -H "content-type: application/json" \
  -d "{\"principalId\":\"principal_admin\",\"payloadHash\":\"${PAYLOAD_HASH}\"}" >/dev/null

echo "Bek smoke test passed for run ${RUN_ID}"
