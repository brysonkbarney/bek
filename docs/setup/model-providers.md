# Model Providers

Bek is provider-neutral by design. End users tag `@bek`; admins govern model policies, budgets, and fallbacks behind that single teammate.

## Current Status

The seed workspace includes one model policy:

| Field          | Seed value                                               |
| -------------- | -------------------------------------------------------- |
| Name           | `Auto balanced`                                          |
| Default model  | `openai/gpt-5.4`                                         |
| Fallbacks      | `anthropic/claude-sonnet-4.8`, `openai-compatible/local` |
| Per-run budget | `$20.00`                                                 |

The model-router package now includes local productization foundations:

- An in-memory provider registry for configured providers and model metadata.
- A built-in priced registry for the seed models:
  `openai/gpt-5.4`, `openai/gpt-5.5`,
  `anthropic/claude-sonnet-4.8`, and `openai-compatible/local`.
- A deterministic fake model gateway for tests and demos.
- An optional AI SDK Gateway runtime adapter selected with `BEK_MODEL_GATEWAY`.
- Cost ledger helpers for preflight estimates and locally estimated completed
  calls.
- A budget preflight result shape with per-model estimates and remaining-budget status.
- Failover routing that can try configured fallbacks when a provider call fails.
- Failover attempt metadata that records whether each tried route was primary or fallback, its estimate, and its budget decision.

The default local demo is still deterministic and does not spend provider money.
Live text generation is available when an operator explicitly sets
`BEK_MODEL_GATEWAY=vercel_ai_sdk` and provides either `AI_GATEWAY_API_KEY` or
`VERCEL_OIDC_TOKEN`. `VERCEL_AI_GATEWAY_API_KEY` is not read by the AI SDK and
should not be used for new installs.

Budget-enforced Gateway calls fail closed unless every default and fallback
model in the policy has benchmark pricing in Bek's model provider registry. The
built-in registry covers the seed policy. Add custom/private models with either
`BEK_MODEL_PROVIDER_REGISTRY_JSON`, `BEK_MODEL_PROVIDER_REGISTRY_PATH`,
`BEK_MODEL_BENCHMARKS_JSON`, or `BEK_MODEL_BENCHMARKS_PATH`.

## AI Gateway Execution

Vercel AI Gateway is the preferred first live model path for hosted or shared deployments because it can route many providers through one API, model catalog, and spend surface. Bek uses:

- `AI_GATEWAY_API_KEY` for static API-key authentication in local, CI, or non-Vercel environments.
- `VERCEL_OIDC_TOKEN` for Vercel project authentication where the platform can issue OIDC credentials.
- `provider/model` policy strings selected from the live Gateway model catalog, such as `openai/...`, `anthropic/...`, or another available provider prefix.
- `BEK_MODEL_GATEWAY=vercel_ai_sdk` to select live calls over the deterministic local runtime.
- `BEK_MODEL_PROVIDER_REGISTRY_JSON` or `BEK_MODEL_PROVIDER_REGISTRY_PATH` for
  a full provider/model registry override.
- `BEK_MODEL_BENCHMARKS_JSON` or `BEK_MODEL_BENCHMARKS_PATH` for benchmark
  pricing overlays on top of Bek's built-in provider registry.
- `BEK_AI_GATEWAY_TAGS` for optional low-cardinality reporting tags such as `env:staging` or `team:platform`.

Minimal local/live configuration:

```bash
export BEK_MODEL_GATEWAY=vercel_ai_sdk
export AI_GATEWAY_API_KEY=...
```

Before a real pilot, replace seeded model IDs with models available in your
Gateway catalog, or keep the seed policy only if those exact IDs are available
to your Gateway account. Every selected default and fallback model must also
have benchmark pricing in Bek's registry; otherwise budget-enforced routes fail
closed before spending provider money.

The adapter emits `model.requested` and `model.completed` worker events with
route attempts, provider, model, usage counts, estimated cost, local actual
estimate, latency, finish reason, and Gateway response ID when the provider
returns one. The completed-event `actualCostCents` value is Bek's local estimate
from AI SDK response usage and model benchmark pricing. In Postgres mode, Bek
writes those completed events into the durable `model_usage` ledger; the value
is useful for local cost review, but it is not billed-cost evidence.

## Admin Setup Model

A production-ready setup should let admins configure:

- Provider connections, such as OpenAI-compatible endpoints, Anthropic, OpenRouter, LiteLLM, or a private gateway.
- Model policies by workspace, channel, or access bundle.
- Per-run and per-day budget ceilings.
- Fallback order and allowed model classes.
- Approval requirements for unusually expensive, privileged, or data-sensitive runs.
- Audit records for selected model, cost estimate, local actual estimate,
  billed-cost reconciliation status, and fallback reason.

## User Experience Rule

Users should not pick from bot names or model-specific agents. They should write:

```txt
@bek investigate this failure
```

Bek should route internally based on place, task, policy, capability profile, model policy, runtime, and budget.

## Credential Handling

- Store provider keys in a secrets manager or credential broker.
- Do not pass provider keys into prompts or untrusted runtime sandboxes.
- Prefer scoped credentials, short-lived tokens, or delegated provider access where possible.
- Redact provider keys from logs, audit event payloads, screenshots, and issue reports.

## Current Cost Controls

The current repo has the product primitives for cost control:

- model policies with `perRunBudgetCents`,
- fallback model lists,
- deterministic route estimates from Bek's priced provider registry,
- explicit budget preflight metadata for selected and fallback routes,
- model usage ledger helpers for estimates and local actuals,
- run-level estimated and actual cost fields,
- `/api/model-usage` summary that prefers the durable ledger in Postgres mode
  and falls back to run-level totals in memory mode.

These are not yet invoice-grade billing controls. Live AI Gateway execution
emits `model.completed` events, Postgres-backed API instances persist those
calls to `model_usage`, and `/api/model-usage` reports
`source: "model_usage"` when it is reading that ledger. Bek now fails closed
for budget-enforced routes without pricing metadata and pauses over-budget
routes for approval, but before a shared workspace or hosted beta it still
needs daily/workspace ceilings, billed provider response reconciliation, and
alerts.

Model routing is useful today for local demos and self-hosted pilots, but it is
not yet a full provider management product. Admins can edit `provider/model`
IDs and per-run caps, and the worker can pause over-budget runs before runtime
execution. Bek does not yet have live model catalog discovery, provider
credential installation, persisted benchmark refresh UI, forecast/projection
UI, daily budget enforcement, workspace budget enforcement, or invoice-grade
cost reconciliation.

Usage ledger entries should record each attempt with org, run, model policy,
provider, model, input/output usage counts, estimated cost, local actual
estimate, latency, status, error code, fallback metadata, and Gateway response
ID when present. Failed attempts and fallback attempts should be recorded too;
otherwise budget and incident review will undercount real execution. Keep
billed-cost reconciliation separate: provider invoices and Gateway dashboards
can validate or annotate ledger rows, but the ledger's `actualCostCents` field
currently means Bek's local estimated actual.

Recommended local/pilot defaults:

| Control          | Default posture                                       |
| ---------------- | ----------------------------------------------------- |
| Per-run budget   | Low cap per model policy, raised only by admins.      |
| Fallback models  | Explicit allowlist, ordered by cost and reliability.  |
| Expensive runs   | Require approval before crossing the configured cap.  |
| Provider keys    | Stored outside prompts, sandboxes, logs, and tests.   |
| Usage visibility | Review run costs and `/api/model-usage` during demos. |

## Launch Blockers

- Credential broker.
- Billed-cost reconciliation against Gateway/provider invoices and dashboards.
- Model catalog picker and live Gateway model discovery in the admin UI.
- Production budget enforcement across persisted daily and per-run usage.
- Forecast and alerting surfaces for projected daily/workspace spend.
- Tests for failed/fallback attempt accounting and billed-cost reconciliation
  semantics.
