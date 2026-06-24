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
- A deterministic fake model gateway for tests and demos.
- Cost ledger helpers for preflight estimates and completed calls.
- Failover routing that can try configured fallbacks when a provider call fails.

The current local demo still does not call external model APIs. Provider adapters must plug into these contracts without changing the one visible `@bek` user experience.

## Admin Setup Model

A production-ready setup should let admins configure:

- Provider connections, such as OpenAI-compatible endpoints, Anthropic, OpenRouter, LiteLLM, or a private gateway.
- Model policies by workspace, channel, or access bundle.
- Per-run and per-day budget ceilings.
- Fallback order and allowed model classes.
- Approval requirements for unusually expensive, privileged, or data-sensitive runs.
- Audit records for selected model, cost estimate, actual cost, and fallback reason.

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
- deterministic route estimates in `@bek/model-router`,
- model usage ledger helpers,
- run-level estimated and actual cost fields,
- `/api/model-usage` summary for seeded/local runs.

These are not yet production billing controls. Before a shared workspace or
hosted beta, Bek still needs persistent usage records, daily/workspace ceilings,
provider response accounting, alerts, and approval checkpoints for budget
step-ups.

Recommended local/pilot defaults:

| Control          | Default posture                                       |
| ---------------- | ----------------------------------------------------- |
| Per-run budget   | Low cap per model policy, raised only by admins.      |
| Fallback models  | Explicit allowlist, ordered by cost and reliability.  |
| Expensive runs   | Require approval before crossing the configured cap.  |
| Provider keys    | Stored outside prompts, sandboxes, logs, and tests.   |
| Usage visibility | Review run costs and `/api/model-usage` during demos. |

## Launch Blockers

- Concrete provider adapters.
- Credential broker.
- Cost ledger persistence wired to real calls.
- Admin UI for model policies.
- Production budget enforcement across persisted daily and per-run usage.
