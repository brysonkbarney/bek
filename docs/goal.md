# Bek Goal (Updated)

Last updated: 2026-06-25. Supersedes the original "make Bek a marketable
open-source product" directive. Read alongside the
[build checklist](./build-checklist.md), which remains the line-item ledger.

## Why this is an update, not a restart

The original goal treated Bek as an alpha that needed its spine built. That spine
now exists in the repo:

- One visible `@bek` Slack teammate model with admin-governed control plane.
- Hono API with admin-token gating, idempotent run creation, approvals, policy
  evaluation, and audit.
- Worker queue with claim, heartbeat, retry, cancel, dead-letter, approval
  resume, run settlement, and runtime event emission (memory- or Postgres-backed).
- Model router with benchmark pricing, fail-closed pricing gates, per-run and
  same-day budget ceilings, failover, and an AI SDK Gateway adapter.
- MCP connector registration, schema quarantine, and access-grant binding.
- Runtime and sandbox **contracts** for AI SDK, OpenCode, Docker, Vercel
  Sandbox, and E2B-style adapters.
- Slack signed ingress, OAuth, encrypted local token vault, outbox posting, and
  GitHub signed-webhook ingress with opt-in hash-bound draft-PR execution.
- Drizzle/Postgres snapshot persistence, audit export, CI, CodeQL, secret
  scanning, release workflow, and docs.

What is still mostly **contract + fake/local adapter** rather than real:
durable agentic execution, first-class agent identity, real RBAC/sessions/tenant
isolation, live MCP transport, hosted sandbox, managed credential broker, and
memory. Those are the remaining product, not the spine.

## The updated mission

Turn Bek from a credible local spine into a genuinely working, demonstrably
secure, marketable open-source product — and do it on top of **AI SDK 7**, whose
new agent, workflow, harness, tool-approval, and telemetry primitives replace
large amounts of the hand-rolled orchestration Bek would otherwise have to build
and maintain.

Continue until the product is genuinely working or only blocked by external
credentials / paid infrastructure (real Slack workspace, GitHub App, provider
keys, hosted sandbox/KMS). Do not soften or delete checklist items until
implementation, tests, docs, and the operator workflow are all in place.

## Keystone: adopt AI SDK 7

`ai@7.0.0` is the stable `latest` release. The repo is pinned to v6
(`packages/model-router` → `ai ^6.0.209`). Upgrading is the highest-leverage move
available because AI SDK 7's primitives map almost 1:1 onto Bek's hardest
unchecked work:

> Reality check (verified against `ai@7.0.0` on npm): `ToolLoopAgent`,
> `tool()`+`contextSchema`, tool approvals (incl. HMAC `experimental_toolApprovalSecret`),
> `registerTelemetry`, and first-class `timeout` ARE in stable. `WorkflowAgent`,
> `HarnessAgent`, and `@ai-sdk/sandbox`/`SandboxSession` are blog-announced but
> NOT in the stable package — Bek uses its own durable worker queue and sandbox
> contracts for those. See [AI SDK 7 architecture](./architecture/ai-sdk-7.md).

| AI SDK 7 primitive                                                        | What it replaces / unblocks in Bek                                                                         | Status                             |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `ToolLoopAgent` — lifecycle callbacks, runtime context, `prepareStep`     | The real agent loop in `packages/runtime` (`agent-loop.ts`), exposed as the worker `ai-sdk-agent` adapter. | ✅ adopted                         |
| Tool approvals, incl. **HMAC-signed** (`experimental_toolApprovalSecret`) | Bek's approval-gated risky writes; in-loop gate suspends to the durable worker.                            | ✅ adopted                         |
| Tool **`contextSchema`** — per-tool scoped context                        | Identity-scoped, secret-free tool context; credentials stay lease-only.                                    | ✅ adopted                         |
| `registerTelemetry` + OpenTelemetry                                       | One-shot telemetry registration (`registerBekTelemetry`).                                                  | ✅ adopted                         |
| First-class `timeout` (`totalMs`/`stepMs`/`chunkMs`/`toolMs`)             | Agent-loop/tool resource limits.                                                                           | ✅ adopted                         |
| `WorkflowAgent` — durable, resumable execution                            | Already covered by the `@bek/worker` durable queue (claim/retry/resume).                                   | ⛔ not in stable; worker covers it |
| `HarnessAgent` — Claude Code/Codex/OpenCode                               | Bek's `RuntimeAdapter`/sandbox contract is the seam.                                                       | ⛔ not in stable; deferred         |
| `SandboxSession` (`@ai-sdk/sandbox`)                                      | Bek `@bek/sandbox` contracts; `experimental_sandbox` is the future hook.                                   | ⛔ package unpublished; deferred   |
| `uploadFile` / `uploadSkill`                                              | Artifact/skill handling for runtime work.                                                                  | later                              |
| `@ai-sdk/tui` `runAgentTUI`                                               | Local agent testing/QA loop.                                                                               | optional dev                       |

### Upgrade plan (do this first, gated by `pnpm check`)

1. Bump `ai` 6 → 7 and add `@ai-sdk/anthropic@4`, `@ai-sdk/openai@4` (and
   `@ai-sdk/tui@1` for dev) where used. Run `npx @ai-sdk/codemod v7` and review
   every change by hand.
2. Re-validate `packages/model-router`: `generateText` signature, `providerOptions`
   gateway tags, `LanguageModelUsage`/finish-reason shapes, and the
   `VercelAiGatewayModelGateway` adapter. Keep `FakeModelGateway` behavior stable
   so existing tests stay meaningful.
3. Introduce a real agent loop in `packages/runtime` built on `ToolLoopAgent` /
   `WorkflowAgent`, wiring Bek's existing `RuntimeStartInput`/`RuntimeResult`
   contracts, approval checkpoints, and observability events onto SDK callbacks.
4. Map Bek approval checkpoints onto AI SDK 7 tool approvals (prefer HMAC-signed)
   and Bek capability grants onto tool `contextSchema`.
5. Prototype one `HarnessAgent`-backed coding runtime and one `SandboxSession`
   sandbox adapter behind the existing adapter contracts; keep them opt-in.
6. Register telemetry once at startup and route SDK spans into Bek's audit/trace
   surfaces.
7. Update `docs/setup/model-providers.md`, `docs/architecture/runtime-sandbox.md`,
   and `docs/architecture/worker.md` to describe the AI SDK 7 architecture, and
   add an AI SDK 7 section to the build checklist as the migration ledger.

Keep every step reversible and green: `pnpm check` must pass after each.

## Workstreams

Drive the [build checklist](./build-checklist.md) to completion in batches of
focused subagents. Suggested parallel workstreams:

- **Backend** — AI SDK 7 migration, durable workflow execution, persistence
  beyond snapshots, RBAC/sessions, tenant isolation.
- **Agent identity** — first-class identity records, inheritance, channel/DM
  semantics, identity-aware credentials and audit (the biggest conceptual gap).
- **Integrations** — live Slack reliability, GitHub App install + real PR
  workflow, MCP transports + worker-only execution, sandbox adapters.
- **UI** — Devin/Cognition-style console, guided first-run setup, session/run
  teammate surface, approvals, connector design system, empty/loading/error and
  a11y states.
- **QA / red-team** — endpoint authorization tests, multi-org isolation,
  Slack/GitHub replay-tamper, approval-hash drift, prompt-injection, browser
  E2E, visual regression, load/chaos.
- **Docs / GTM** — architecture and identity docs, setup guides with
  screenshots, golden demo packet, SKU boundaries, sales-safe claims,
  comparison and launch materials.

## Definition of done

The product is "genuinely working" when the **Final Release Criteria** in the
[build checklist](./build-checklist.md) are met: clean install on fresh Node 24,
`pnpm check` green locally and in CI, browser E2E over core admin paths, smoke
over every governed side effect, accurate docs, publicly showable UI, and demo
assets — now running on AI SDK 7. Hosted paid beta remains gated on the
hosted-readiness criteria (tenant isolation, real sessions/RBAC, first-class
identity, managed credential broker, durable fleet, hosted sandbox, MCP
worker-only execution, budgets/reconciliation, and external security review).
