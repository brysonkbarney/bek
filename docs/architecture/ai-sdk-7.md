# AI SDK 7 Architecture

Status: adopted. Bek runs on `ai@7` (`@ai-sdk/openai@4`, `@ai-sdk/anthropic@4`).
This doc records exactly which AI SDK 7 primitives Bek uses, which are not yet in
the stable package, and how the agent loop maps onto Bek's governance model.

## What Bek uses from `ai@7`

- **`ToolLoopAgent`** — the multi-step agent loop in
  [`packages/runtime/src/agent-loop.ts`](../../packages/runtime/src/agent-loop.ts).
  `runBekAgentLoop()` builds an agent from Bek capability grants and maps the
  result onto the `RuntimeResult` contract.
- **`tool()` with `contextSchema`** — every capability grant becomes one tool.
  The `contextSchema` carries an **identity-scoped, secret-free** context
  (`orgId`, `identityId`, `placeId`, `requesterId`). Credentials are never placed
  in tool context; they are leased per action by the governed tool proxy.
- **Tool approvals** — Bek gates risky tools two ways: (1) in-loop, each tool's
  `execute` refuses to call the proxy when its grant `requiresApproval` and it is
  not yet approved, which suspends the run with `awaiting_approval` and raises a
  Bek approval checkpoint for the durable worker to resume; (2) AI SDK 7's native
  `experimental_toolApprovalSecret` (HMAC-signed approvals) is threaded through
  for conversational (useChat) flows.
- **First-class `timeout`** — `runBekAgentLoop` accepts a number (total ms) or the
  structured AI SDK 7 `{ totalMs, stepMs, chunkMs, toolMs }` config. The worker
  adapter defaults to 120s and exposes `timeoutMs`.
- **`registerTelemetry`** — global, once-per-process telemetry registration via
  [`registerBekTelemetry`](../../packages/runtime/src/telemetry.ts). Deployments
  pass their chosen integration (e.g. `new OpenTelemetry()` from `@ai-sdk/otel`,
  or Langfuse/Braintrust/Sentry). Bek does not hard-depend on an OTel backend.
- **AI Gateway model strings** — `model-router`'s `VercelAiGatewayModelGateway`
  passes model ids straight to the Gateway and reads the v7-canonical cumulative
  `usage` and `finalStep` metadata.

## What is NOT in stable `ai@7` (do not depend on it)

The AI SDK 7 launch blog describes more than the stable npm package currently
exports. As of this writing the following are **not** available in `ai@7.0.0` and
Bek must not import them:

- **`WorkflowAgent`** (durable, resumable agent). Not exported. Bek does not need
  it: the `@bek/worker` queue already provides durability — claim, heartbeat,
  retry, cancel, dead-letter, and resume-after-approval. The `ToolLoopAgent` runs
  one attempt; the worker owns restart safety and resume.
- **`HarnessAgent`** (Claude Code / OpenCode / Codex wrapper). Not exported.
  Bek's coding-runtime seam stays its own `RuntimeAdapter` contract; the existing
  `createSandboxRuntimeAdapter` (Docker) is the integration point for shelling
  out to a coding harness inside a governed sandbox.
- **`@ai-sdk/sandbox` / `SandboxSession`**. The package is not published. The
  `experimental_sandbox` parameter exists on `generate`/`stream`, so the seam is
  ready, but Bek's sandbox isolation continues to run through
  [`@bek/sandbox`](../../packages/sandbox) contracts until the package ships.

When these land in stable, the integration points above are where they plug in.

## Durability split

```
Slack/GitHub/API trigger
        │
        ▼
@bek/worker queue   ← durability: claim, heartbeat, retry, cancel, resume
        │
        ▼
RuntimeAdapter (ai-sdk-agent)
        │
        ▼
runBekAgentLoop → ToolLoopAgent (one attempt)
        │
        ├── tool() per capability grant → governed RuntimeToolProxy
        ├── approval-required tool → suspend → worker resumes after decision
        └── usage → priced via model-router benchmark → RuntimeResult.actualCostCents
```

## Migration notes

- `result.usage` is cumulative in v7; `totalUsage` is deprecated. Per-step values
  (`response`, `finishReason`) moved to `result.finalStep`. The model-router
  adapter prefers `usage`/`finalStep` with a backward-compatible fallback.
- `system` → `instructions` on agent/generate settings (both still accepted).
- `experimental_context` → `context`; `toolsContext` is keyed by tool name and is
  set on the `ToolLoopAgent` constructor (not on `generate()`).
- Node 22+ and ESM-only. Bek targets Node 24.
