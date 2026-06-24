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

The model-router package is a foundation. The current local demo does not call external model APIs.

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

## Launch Blockers

- Concrete provider adapters.
- Credential broker.
- Cost estimation and usage ledger wired to real calls.
- Admin UI for model policies.
- Tests for budget enforcement and provider fallback behavior.
