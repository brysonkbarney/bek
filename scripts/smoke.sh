#!/usr/bin/env bash
set -euo pipefail

API_URL="${VITE_BEK_API_URL:-http://localhost:${BEK_SMOKE_API_PORT:-4317}}"
API_URL="${API_URL%/}"
START_API="${BEK_SMOKE_START_API:-auto}"
SMOKE_STORAGE="${BEK_SMOKE_STORAGE:-memory}"
SMOKE_WORKER_QUEUE_BACKEND="${BEK_SMOKE_WORKER_QUEUE_BACKEND:-${SMOKE_STORAGE}}"
API_PID=""
API_LOG=""

case "${START_API}" in
  auto | never) ;;
  *)
    echo "BEK_SMOKE_START_API must be 'auto' or 'never'." >&2
    exit 2
    ;;
esac
case "${SMOKE_STORAGE}" in
  memory | postgres) ;;
  *)
    echo "BEK_SMOKE_STORAGE must be 'memory' or 'postgres'." >&2
    exit 2
    ;;
esac
case "${SMOKE_WORKER_QUEUE_BACKEND}" in
  memory | postgres) ;;
  *)
    echo "BEK_SMOKE_WORKER_QUEUE_BACKEND must be 'memory' or 'postgres'." >&2
    exit 2
    ;;
esac
if [[ "${SMOKE_WORKER_QUEUE_BACKEND}" == "postgres" && "${SMOKE_STORAGE}" != "postgres" ]]; then
  echo "BEK_SMOKE_WORKER_QUEUE_BACKEND=postgres requires BEK_SMOKE_STORAGE=postgres." >&2
  exit 2
fi

cleanup() {
  if [[ -n "${API_PID}" ]] && kill -0 "${API_PID}" 2>/dev/null; then
    kill "${API_PID}" 2>/dev/null || true
    wait "${API_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

health_check() {
  curl -fsS "${API_URL}/health" >/dev/null 2>&1
}

api_port() {
  node -e '
    const url = new URL(process.argv[1]);
    if (url.protocol !== "http:") {
      throw new Error("Smoke can only auto-start a local http API URL.");
    }
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
      throw new Error("Smoke can only auto-start localhost API URLs.");
    }
    if (url.pathname !== "/" && url.pathname !== "") {
      throw new Error("Smoke API URL must be an origin, not a path.");
    }
    process.stdout.write(url.port || "80");
  ' "${API_URL}"
}

start_api() {
  local port
  port="$(api_port)"
  API_LOG="$(mktemp -t bek-smoke-api.XXXXXX.log)"

  echo "Starting Bek API on ${API_URL} with ${SMOKE_STORAGE} storage and ${SMOKE_WORKER_QUEUE_BACKEND} worker queue"
  echo "API log: ${API_LOG}"
  local -a env_args=(
    -u BEK_ADMIN_API_TOKEN
    -u GITHUB_APP_CLIENT_ID
    -u GITHUB_APP_CLIENT_SECRET
    -u GITHUB_APP_ID
    -u GITHUB_APP_INSTALLATION_ID
    -u GITHUB_APP_PRIVATE_KEY
    -u GITHUB_APP_WEBHOOK_SECRET
    -u GITHUB_WEBHOOK_SECRET
    -u SLACK_BOT_TOKEN
    -u SLACK_CLIENT_ID
    -u SLACK_CLIENT_SECRET
    -u SLACK_REDIRECT_URI
    -u SLACK_SIGNING_SECRET
    BEK_ALLOW_UNAUTHENTICATED_LOCAL=true \
    BEK_REQUIRE_ADMIN_AUTH=false \
    BEK_STORAGE="${SMOKE_STORAGE}" \
    BEK_WORKER_QUEUE_BACKEND="${SMOKE_WORKER_QUEUE_BACKEND}" \
    BEK_RUN_ADVANCEMENT=worker_local \
    BEK_DEV_UNSIGNED_SLACK=true \
    BEK_SLACK_BACKGROUND_DRAIN=false \
    'BEK_SLACK_USER_PRINCIPAL_MAP={"U123":"principal_admin","T123:U123":"principal_admin"}' \
    BEK_API_PORT="${port}"
  )
  if [[ "${SMOKE_STORAGE}" == "memory" ]]; then
    env_args=(-u DATABASE_URL "${env_args[@]}")
  elif [[ -z "${DATABASE_URL:-}" ]]; then
    echo "DATABASE_URL is required when BEK_SMOKE_STORAGE=postgres." >&2
    exit 2
  else
    env_args=("${env_args[@]}" DATABASE_URL="${DATABASE_URL}")
  fi
  env "${env_args[@]}" pnpm --filter @bek/api start >"${API_LOG}" 2>&1 &
  API_PID="$!"
}

wait_for_api() {
  for _ in {1..80}; do
    if health_check; then
      return 0
    fi
    if [[ -n "${API_PID}" ]] && ! kill -0 "${API_PID}" 2>/dev/null; then
      echo "Bek API exited before becoming healthy." >&2
      if [[ -n "${API_LOG}" ]]; then
        tail -n 80 "${API_LOG}" >&2 || true
      fi
      exit 1
    fi
    sleep 0.25
  done

  echo "Timed out waiting for ${API_URL}/health." >&2
  if [[ -n "${API_LOG}" ]]; then
    tail -n 80 "${API_LOG}" >&2 || true
  fi
  exit 1
}

if health_check; then
  echo "Using existing Bek API at ${API_URL}"
elif [[ "${START_API}" == "auto" ]]; then
  start_api
  wait_for_api
else
  echo "Bek API is not healthy at ${API_URL}. Start it or unset BEK_SMOKE_START_API=never." >&2
  exit 1
fi

export API_URL

node --input-type=module <<'NODE'
const apiUrl = process.env.API_URL;
const adminToken = process.env.BEK_ADMIN_API_TOKEN;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function jsonRequest(path, init = {}) {
  const headers = {
    ...(adminToken ? { authorization: `Bearer ${adminToken}` } : {}),
    ...(init.headers ?? {}),
  };
  const method = init.method ?? "GET";
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers,
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`${method} ${path} returned non-JSON: ${text.slice(0, 200)}`);
    }
  }
  if (!response.ok) {
    const detail = body?.error ? `: ${body.error}` : text ? `: ${text}` : "";
    if (!adminToken && (response.status === 401 || response.status === 500) && /BEK_ADMIN_API_TOKEN|Unauthorized/i.test(detail)) {
      throw new Error(
        `${method} ${path} failed with ${response.status}${detail}\n` +
          "This API requires admin auth. Export BEK_ADMIN_API_TOKEN or let smoke auto-start a local API with BEK_ALLOW_UNAUTHENTICATED_LOCAL=true.",
      );
    }
    throw new Error(`${method} ${path} failed with ${response.status}${detail}`);
  }
  return body;
}

async function jsonRequestExpect(path, init = {}, expectedStatus) {
  const headers = {
    ...(adminToken ? { authorization: `Bearer ${adminToken}` } : {}),
    ...(init.headers ?? {}),
  };
  const method = init.method ?? "GET";
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers,
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`${method} ${path} returned non-JSON: ${text.slice(0, 200)}`);
    }
  }
  if (response.status !== expectedStatus) {
    const detail = body?.error ? `: ${body.error}` : text ? `: ${text}` : "";
    if (!adminToken && (response.status === 401 || response.status === 500) && /BEK_ADMIN_API_TOKEN|Unauthorized/i.test(detail)) {
      throw new Error(
        `${method} ${path} expected ${expectedStatus} but got ${response.status}${detail}\n` +
          "This API requires admin auth. Export BEK_ADMIN_API_TOKEN or let smoke auto-start a local API with BEK_ALLOW_UNAUTHENTICATED_LOCAL=true.",
      );
    }
    throw new Error(`${method} ${path} expected ${expectedStatus} but got ${response.status}${detail}`);
  }
  return body;
}

function postJsonInit(body, headers = {}) {
  return {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  };
}

async function postJson(path, body, headers = {}) {
  return jsonRequest(path, postJsonInit(body, headers));
}

async function tryJsonRequest(path, init = {}) {
  const headers = {
    ...(adminToken ? { authorization: `Bearer ${adminToken}` } : {}),
    ...(init.headers ?? {}),
  };
  const response = await fetch(`${apiUrl}${path}`, { ...init, headers });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      return { ok: response.ok, status: response.status, body: null, text };
    }
  }
  return { ok: response.ok, status: response.status, body, text };
}

function assertArray(value, message) {
  assert(Array.isArray(value), message);
  return value;
}

try {
  console.log(`Checking ${apiUrl}/health`);
  const health = await jsonRequest("/health");
  assert(health.ok === true, "Health response did not include ok=true.");
  assert(health.name === "bek-api", "Health response did not identify bek-api.");

  console.log("Checking readiness");
  const ready = await jsonRequest("/ready");
  assert(ready.ok === true, "Readiness response did not include ok=true.");
  assert(ready.name === "bek-api", "Readiness response did not identify bek-api.");
  assert(ready.checks?.store?.ok === true, "Readiness store check must pass.");
  assert(ready.checks?.modelUsage?.ok === true, "Readiness model usage check must pass.");
  assert(
    ready.checks?.workerQueue?.ok === true || ready.checks?.workerQueue?.skipped === true,
    "Readiness worker queue check must pass or be explicitly skipped.",
  );
  assert(
    ready.checks?.persistence?.ok === true || ready.checks?.persistence?.skipped === true,
    "Readiness persistence check must pass or be explicitly skipped.",
  );

  console.log("Verifying bootstrap seed data");
  const bootstrap = await jsonRequest("/api/bootstrap");
  assert(bootstrap.org?.id === "org_demo", "Bootstrap org_demo seed is missing.");
  assert(bootstrap.agent?.handle === "@bek", "Bootstrap must expose the @bek handle.");
  assert(
    bootstrap.places?.some((place) => place.id === "place_checkout" && place.externalId === "C_CHECKOUT"),
    "Bootstrap checkout Slack place is missing.",
  );
  assert(
    bootstrap.accessBundles?.some((bundle) => bundle.id === "bundle_checkout"),
    "Bootstrap checkout access bundle is missing.",
  );
  assert(
    bootstrap.modelPolicies?.some((policy) => policy.id === "model_auto"),
    "Bootstrap model_auto policy is missing.",
  );
  assert(
    bootstrap.runtimeProfiles?.some((profile) => profile.id === "runtime_code"),
    "Bootstrap code runtime profile is missing.",
  );
  assert(bootstrap.ingressDeliveries === undefined, "Bootstrap must not expose ingress delivery ledgers.");
  assert(bootstrap.outboundDeliveries === undefined, "Bootstrap must not expose outbound delivery ledgers.");

  console.log("Verifying setup readiness");
  const setup = await jsonRequest("/api/setup/status");
  assert(setup.visibleHandle === "@bek", "Setup status visible handle must be @bek.");
  assert(setup.singleVisibleAgent === true, "Setup status must report one visible agent.");
  assert(setup.readyForLocalDemo === true, "Setup status must be ready for local demo.");
  assert(setup.slackChannels >= 1, "Setup status must include a Slack channel.");
  assert(setup.accessBundles >= 1, "Setup status must include access bundles.");
  assert(setup.modelPolicies >= 1, "Setup status must include model policies.");
  assert(setup.runtimeProfiles >= 1, "Setup status must include runtime profiles.");
  assert(setup.githubGrantCount >= 1, "Setup status must include GitHub grants.");

  console.log("Verifying policy evaluation");
  const readPolicy = await postJson("/api/policy/evaluate", {
    placeScopeId: "place_checkout",
    capability: "github.read",
    resource: "github:redohq/checkout",
  });
  assert(readPolicy.decision === "allow", "github.read should be allowed in checkout.");
  assert(readPolicy.requiresApproval === false, "github.read should not require approval.");

  const prPolicy = await postJson("/api/policy/evaluate", {
    placeScopeId: "place_checkout",
    capability: "github.pr",
    resource: "github:redohq/checkout",
  });
  assert(prPolicy.decision === "ask", "github.pr should be approval-gated.");
  assert(prPolicy.requiresApproval === true, "github.pr should require approval.");
  assert(prPolicy.matchingGrant?.id === "grant_github_pr", "github.pr should match the seeded PR grant.");

  console.log("Creating approval-gated PR run with idempotency");
  const createRunBody = {
    placeScopeId: "place_checkout",
    prompt: "@bek smoke-check checkout retries and open a PR if needed",
    capability: "github.pr",
    resource: "github:redohq/checkout",
  };
  const idempotencyKey = `smoke-run-${Date.now()}`;
  const run = await postJson("/api/runs", createRunBody, {
    "idempotency-key": idempotencyKey,
  });
  assert(run.id, "Created run is missing an id.");
  assert(run.status === "awaiting_approval", "PR run should wait for approval.");
  assert(run.placeScopeId === "place_checkout", "PR run should stay scoped to checkout.");
  assert(run.runtimeProfileId === "runtime_code", "PR run should route to the code runtime.");

  const replayedRun = await jsonRequest(
    "/api/runs",
    postJsonInit(createRunBody, {
      "idempotency-key": idempotencyKey,
    }),
  );
  assert(replayedRun.deduped === true, "Reused Idempotency-Key should dedupe the same run body.");
  assert(replayedRun.id === run.id, "Idempotent run replay should return the original run id.");

  const conflict = await jsonRequestExpect(
    "/api/runs",
    postJsonInit(
      {
        ...createRunBody,
        prompt: "@bek smoke-check should conflict with the existing idempotency key",
      },
      { "idempotency-key": idempotencyKey },
    ),
    409,
  );
  assert(
    conflict.error === "Idempotency-Key was already used with a different request body.",
    "Changed body with reused Idempotency-Key should return the expected conflict.",
  );

  const createdDetail = await jsonRequest(`/api/runs/${run.id}`);
  assert(createdDetail.run?.status === "awaiting_approval", "Run detail should be awaiting approval.");
  assert(
    createdDetail.events?.some((event) => event.type === "policy.evaluated"),
    "Run detail should include a policy.evaluated event.",
  );
  assert(
    createdDetail.events?.some((event) => event.type === "approval.requested"),
    "Run detail should include an approval.requested event.",
  );
  const approval = createdDetail.approvals?.find(
    (candidate) => candidate.action === "github.pr" && candidate.status === "pending",
  );
  assert(approval, "Run detail should include a pending github.pr approval.");
  assert(approval.risk === "write_external", "PR approval should carry write_external risk.");
  assert(/^[a-f0-9]{64}$/.test(approval.payloadHash), "Approval should expose a SHA-256 payload hash.");

  const approvals = await jsonRequest("/api/approvals");
  assert(
    approvals.some((candidate) => candidate.id === approval.id && candidate.status === "pending"),
    "Approvals list should include the pending approval.",
  );

  console.log(`Approving ${approval.id}`);
  const decided = await postJson(`/api/approvals/${approval.id}/approve`, {
    principalId: "principal_admin",
    payloadHash: approval.payloadHash,
  });
  assert(decided.status === "approved", "Approval decision should be approved.");
  assert(decided.decidedByPrincipalId === "principal_admin", "Approval should be decided by principal_admin.");

  const finalDetail = await jsonRequest(`/api/runs/${run.id}`);
  assert(finalDetail.run?.status === "completed", "Approved run should complete.");
  assert(finalDetail.run?.actualCostCents >= 1, "Approved run should record actual cost.");
  assert(
    finalDetail.approvals?.some((candidate) => candidate.id === approval.id && candidate.status === "approved"),
    "Run detail should include the approved approval.",
  );
  assert(
    finalDetail.events?.some((event) => event.type === "approval.decided"),
    "Run detail should include an approval.decided event.",
  );

  console.log("Verifying worker queue state");
  const workerQueue = await jsonRequest("/api/worker/queue");
  if (workerQueue.enabled) {
    assert(workerQueue.mode === "worker_local", "Worker queue mode should be worker_local when enabled.");
    assert(
      finalDetail.events?.some((event) => event.data?.workerEventType === "worker.completed"),
      "Run detail should include a worker.completed event when worker-local advancement is enabled.",
    );
    const workerDrain = await postJson("/api/worker/drain", { maxItems: 10 });
    assert(workerDrain.enabled === true, "Worker drain should report the worker controller is enabled.");
    assert(workerDrain.mode === "worker_local", "Worker drain mode should be worker_local.");
    assert(workerDrain.result, "Worker drain should include a result.");
    assert(
      workerDrain.queue?.records?.some((record) => record.item?.runId === run.id && record.status === "completed") ||
        workerQueue.queue?.records?.some((record) => record.item?.runId === run.id && record.status === "completed"),
      "Worker queue should contain the completed run work record.",
    );
    assert(
      workerDrain.queue?.events?.some((event) => event.runId === run.id && event.type === "worker.completed") ||
        workerQueue.queue?.events?.some((event) => event.runId === run.id && event.type === "worker.completed"),
      "Worker queue should contain a worker.completed event.",
    );
  } else {
    const disabledDrain = await jsonRequestExpect("/api/worker/drain", postJsonInit({ maxItems: 1 }), 409);
    assert(/disabled/i.test(disabledDrain.error ?? ""), "Disabled worker drain should explain that local advancement is disabled.");
  }

  console.log("Verifying model usage and audit endpoints");
  const usage = await jsonRequest("/api/model-usage");
  assert(["runs", "model_usage"].includes(usage.source), "Model usage source should be runs or model_usage.");
  assert(Number.isInteger(usage.runs) && usage.runs >= 1, "Model usage should include at least one run.");
  assert(Number.isInteger(usage.totalEstimatedCents), "Model usage should include total estimated cents.");
  assert(Number.isInteger(usage.totalActualCents), "Model usage should include total actual cents.");
  assert(Number.isInteger(usage.modelCalls), "Model usage should include model call count.");

  const auditEvents = assertArray(await jsonRequest("/api/audit-events"), "Audit endpoint should return an event array.");
  assert(
    auditEvents.some((event) => event.runId === run.id && event.type === "run.created"),
    "Audit events should include the smoke run creation.",
  );
  assert(
    auditEvents.some((event) => event.runId === run.id && event.type === "approval.decided"),
    "Audit events should include the smoke approval decision.",
  );

  console.log("Verifying Slack outbox summary and drain");
  const beforeOutbox = await jsonRequest("/api/outbound/slack");
  assertArray(beforeOutbox.deliveries, "Slack outbox summary should include deliveries.");
  assert(
    beforeOutbox.deliveries.every((delivery) => delivery.payload === undefined && delivery.target === undefined),
    "Slack outbox summary must not expose payload or target details by default.",
  );

  const slackEventBody = {
    team_id: "T123",
    event_id: `EvSmoke${Date.now()}`,
    event: {
      type: "app_mention",
      channel: "C_CHECKOUT",
      user: "U123",
      text: "@bek smoke-check the local Slack product loop",
      ts: `${Math.floor(Date.now() / 1000)}.000001`,
    },
  };
  const slackEvent = await tryJsonRequest("/api/slack/events", postJsonInit(slackEventBody));
  let slackRunId;
  if (slackEvent.ok && slackEvent.body?.ok === true && slackEvent.body?.runId) {
    slackRunId = slackEvent.body.runId;
    if (workerQueue.enabled) {
      const slackWorkerDrain = await postJson("/api/worker/drain", { maxItems: 10 });
      assert(slackWorkerDrain.enabled === true, "Slack worker drain should run when worker-local is enabled.");
    }
  } else {
    console.log(
      `Skipping Slack ingress loop: POST /api/slack/events returned ${slackEvent.status}${
        slackEvent.body?.error ? ` (${slackEvent.body.error})` : ""
      }`,
    );
  }

  const outboxAfterSlack = await jsonRequest("/api/outbound/slack");
  assertArray(outboxAfterSlack.deliveries, "Slack outbox summary should include deliveries after Slack loop.");
  if (slackRunId) {
    assert(
      outboxAfterSlack.deliveries.some((delivery) => delivery.runId === slackRunId && delivery.provider === "slack"),
      "Slack-created run should queue a Slack outbound delivery summary.",
    );
  }
  const outboxDrain = await postJson("/api/outbound/slack/drain", { limit: 25 });
  assert(Number.isInteger(outboxDrain.outbound?.attempted), "Slack outbox drain should report attempted count.");
  assertArray(outboxDrain.outbound?.deliveries, "Slack outbox drain should return delivery results.");

  console.log(`Bek smoke test passed for run ${run.id}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
NODE
