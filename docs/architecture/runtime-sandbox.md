# Runtime And Sandbox Architecture

Status: implementation in progress. Bek has runtime/sandbox contracts, a local
Docker sandbox provider, and a worker runtime adapter that can create a sandbox
lease, execute a command, collect an optional artifact, emit sandbox timeline
events, and destroy the lease. Worker runtime routing now attaches selected-model
cost and budget preflight metadata to runtime inputs, and the AI SDK Gateway
runtime can make live text-generation calls when explicitly enabled with
`BEK_MODEL_GATEWAY=vercel_ai_sdk`. The current sandbox runtime command is still
a controlled placeholder; full OpenCode repo checkout/edit/test/PR orchestration
is the next integration layer. Slack-visible runtime outcomes are now returned to
Bek and queued through the durable Slack outbound-delivery outbox; runtimes still
must not post to Slack directly.

Bek has one visible Slack teammate, `@bek`. Runtime profiles, model providers,
coding agents, sandboxes, and tool bundles are internal control-plane choices
owned by admins. A user should never need to choose between agent names.

## Recommended Stack

Bek should use all of these, but at different layers:

| Layer                 | Recommendation                                     | Why                                                                                                                                                                                                                                                                   |
| --------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model/provider facade | Vercel AI SDK                                      | TypeScript-native provider abstraction for model calls, tool calls, streaming, structured outputs, and provider adapters. Bek can keep one runtime contract while admins route between OpenAI, Anthropic, local, or gateway models.                                   |
| Coding runtime        | OpenCode adapter                                   | First real coding runtime for repo work. It is open source, scriptable through a headless server/SDK, supports multiple providers, and has permissions that map cleanly to Bek policy. Users still only see `@bek`; OpenCode agent names stay internal.               |
| OSS/local sandbox     | Docker provider                                    | Best default for self-hosted development and CI. It is inspectable, cheap, and already on the roadmap. It is not strong enough as the only hosted multitenant isolation boundary.                                                                                     |
| Hosted sandbox        | Vercel Sandbox provider first, E2B provider second | Vercel Sandbox is the preferred hosted provider when Bek is deployed on Vercel because it offers isolated microVM sandboxes and project OIDC auth. E2B is the portable hosted alternative, especially for non-Vercel deployments and prebuilt coding-agent templates. |
| Provider strategy     | Adapter interfaces                                 | Runtime and sandbox providers must be replaceable. Bek policy, approvals, audit, and credential brokering stay above every provider.                                                                                                                                  |

Do not build a bespoke cgroups/seccomp sandbox for v1. Docker is enough for
local development, CI, and trusted single-tenant self-hosting when the operator
accepts that Docker CLI/socket access is host-control-plane access. Hosted
multitenant execution should use a microVM provider.

## Source Notes

- Vercel AI SDK is the TypeScript toolkit for AI apps and agents and standardizes model provider integration: <https://ai-sdk.dev/docs/introduction>.
- OpenCode exposes a headless HTTP server, SDK, provider config, and permissions: <https://opencode.ai/docs/server/>, <https://opencode.ai/docs/sdk/>, <https://opencode.ai/docs/providers/>, <https://opencode.ai/docs/permissions/>.
- Vercel Sandbox is designed to run untrusted or user-generated code, with SDKs for creating sandboxes and running commands: <https://vercel.com/docs/sandbox>. Vercel's agent guide describes the hosted sandbox as an ephemeral Firecracker microVM with no host filesystem, credentials, or network access: <https://vercel.com/kb/guide/building-an-agent-with-openai-agents-sdk-and-vercel-sandbox>.
- E2B provides isolated sandboxes for agents to execute code and tools: <https://e2b.dev/docs>.
- Docker rootless mode and `docker run` resource/network/filesystem flags are the local hardening baseline: <https://docs.docker.com/engine/security/rootless/> and <https://docs.docker.com/reference/cli/docker/container/run/>.

## High-Level Flow

```txt
Slack event or API request
  -> apps/api creates Run + RunEvent
  -> durable queue receives a run work item
  -> worker claims one attempt
  -> worker reloads org/place/access/model/runtime state
  -> policy and deterministic per-run budget preflight are evaluated
  -> runtime adapter is selected
  -> optional sandbox lease is created
  -> runtime requests model/tool/sandbox actions through Bek gateways
  -> approvals pause and resume the run
  -> artifacts, audit events, and cost ledger are written
  -> final Slack-visible reply is queued in the durable Slack outbox
  -> Slack outbox dispatcher posts to the originating channel/thread
```

The worker owns run advancement. The API should only create runs, receive
Slack/webhook callbacks, record approval decisions, and expose state. In local
worker mode, `BEK_SANDBOX_PROVIDER=docker-local` selects the executable Docker
provider for the `opencode-sandbox` runtime profile. Slack callbacks persist the
outbound intent before Web API posting, and `POST /api/worker/drain` queues any
worker-produced Slack follow-up messages before draining the Slack outbox in the
local/self-hosted path.

## Queue And Worker Boundary

The queue payload should be a small pointer, not a copy of access policy or
secret-bearing context.

```ts
interface RunWorkItem {
  orgId: string;
  runId: string;
  attempt: number;
  reason: "new_run" | "approval_granted" | "retry" | "resume";
  traceId: string;
  enqueuedAt: string;
}
```

On every claim, the worker must reload:

- run, place, requester, and visible `@bek` agent identity,
- access bundles attached to the place,
- runtime profile and model policy,
- budget policy and current usage,
- pending approval state,
- latest cancellation/status marker.

The worker must recompute policy at execution time. A queued job cannot carry a
stale allow decision. Idempotency is `(runId, attempt)`, with every side effect
recording an idempotency key before execution.

Worker responsibilities:

- claim queued work and move status from `queued` to `reading_context`,
- select runtime and sandbox providers from admin policy,
- lease short-lived credentials from a credential broker only when required,
- emit audit events for every planned, blocked, approved, denied, and executed
  side effect,
- pause at approval checkpoints and requeue only after approval,
- finalize Slack-visible output as `@bek`.

## Runtime Adapter Interface

The runtime adapter executes the reasoning loop. It never owns policy, secrets,
or final authority for side effects.

```ts
interface RuntimeAdapter {
  id: string;
  kind: "ai_sdk" | "opencode" | "external";
  canRun(profile: RuntimeProfile): boolean;
  start(input: RuntimeStartInput): Promise<RuntimeResult>;
  resume(input: RuntimeResumeInput): Promise<RuntimeResult>;
  cancel(runId: string): Promise<void>;
}
```

The adapter receives:

- run metadata and prompt/context selected by the worker,
- selected model route with estimatedCostCents and per-run budget preflight,
- a Bek tool proxy instead of raw tool credentials,
- a sandbox lease reference when code execution is allowed,
- an approval callback for proposed side effects,
- an event sink that redacts before persistence.

The adapter returns:

- final answer text,
- artifact references,
- suggested Slack thread updates to be persisted as outbound deliveries,
- cost/token usage,
- structured failure reason when it cannot continue.

Adapters must not:

- grant themselves new tools, repos, network hosts, or models,
- write directly to Slack, GitHub, Linear, MCP servers, or admin APIs,
- receive long-lived provider/API keys,
- expose internal runtime names as Slack identities.

## Adapter Choices

### AI SDK Runtime

Use this for answer, support, summarization, workflow, and light tool-calling
runs. It should call models through the model router and expose only Bek proxy
tools. It is the safest first runtime because the worker can keep all effects in
process and pause cleanly for approvals.

The first live implementation is the AI SDK Gateway adapter, selected with
`BEK_MODEL_GATEWAY=vercel_ai_sdk`. The worker wraps run prompts in Bek's
`bek-untrusted-content-v1` envelope before model calls, preserving the stored
run prompt for UI/audit display while separating untrusted user content from
Bek policy instructions. Streaming, tool-call mediation, durable usage
persistence, and billed-cost reconciliation still need to be layered on top of
that text-generation path.

### OpenCode Runtime

Use this for coding runs that need repo inspection, edits, tests, and PR prep.
Run OpenCode inside the sandbox, preferably through its headless server/SDK.

OpenCode configuration should be generated per run:

- model/provider set from Bek's selected model route,
- built-in permissions limited to the current repo workspace,
- `bash`, `edit`, `webfetch`, `websearch`, `mcp`, and external directories
  mapped to Bek approval and sandbox policy,
- host auth files disabled or absent,
- MCP tools proxied through Bek's MCP gateway, not loaded from user config,
- output captured as patches, logs, test results, and summary artifacts.

OpenCode supports multiple internal agents. Bek must not surface those as Slack
handles. If OpenCode uses plan/build subagents internally, every Slack response
still comes from `@bek`.

OpenCode also needs a heartbeat/watchdog layer before it can be trusted for
hosted long-running work. The worker should heartbeat its lease while OpenCode's
headless server or process is active, detect stalled sessions, cancel the
sandbox/process on lost lease or human cancellation, capture partial logs and
artifacts, and settle the run with a retryable or terminal failure. The current
`opencode-sandbox` path is a sandbox-command adapter, not full OpenCode process
supervision.

### External Runtime

Keep an `external` escape hatch for future LangGraph, Temporal, OpenAI Agents
SDK, or customer-owned runners. The same runtime contract applies.

## Sandbox Provider Interface

The sandbox provider owns isolated execution. It does not own the reasoning
loop or decide policy.

```ts
interface SandboxProvider {
  id: string;
  kind: "docker-local" | "vercel-sandbox" | "e2b";
  create(input: SandboxCreateInput): Promise<SandboxLease>;
  exec(lease: SandboxLease, command: SandboxCommand): Promise<SandboxResult>;
  upload(lease: SandboxLease, artifact: SandboxUpload): Promise<void>;
  download(lease: SandboxLease, path: string): Promise<SandboxArtifact>;
  destroy(lease: SandboxLease): Promise<void>;
}
```

Provider rules:

- Docker provider is for local OSS/dev and trusted single-tenant self-hosting.
- Vercel Sandbox provider is the preferred hosted provider for Vercel deploys.
- E2B provider is the hosted portability adapter for non-Vercel deploys or
  teams already standardized on E2B.
- Provider-specific IDs, URLs, and tokens are never exposed to Slack users.

### Local Docker Provider Contract

The `@bek/sandbox` local Docker surface is intentionally split into pure
construction and provider behavior:

- `buildDockerRunCommand` validates a `docker-local` policy and returns a
  shell-free `docker run` argv array. Tests assert the argv instead of starting
  Docker.
- `DockerSandboxProvider` is the executable local provider. It uses Docker CLI
  argv arrays, command timeouts, stdout/stderr caps, `docker cp` upload/download
  helpers, and best-effort container cleanup on timeout.
- The default network mode produces `--network none`. Allowlisted egress uses
  an explicit `bek-egress-allowlist` Docker network plus a
  `BEK_SANDBOX_EGRESS_ALLOWLIST` environment hint for the egress proxy layer.
- The builder never emits `--privileged`; it uses a read-only root filesystem,
  tmpfs scratch, `no-new-privileges`, dropped capabilities, PID/memory/CPU
  limits, a non-root user, and explicit bind mounts.
- Policy validation rejects disabled-network allowlists, empty egress
  allowlists, wildcard/path/CIDR allowlist entries, metadata services, and
  private/link-local/localhost targets while `blockPrivateNetworks` is true.
- Docker mounts cannot include the Docker socket or common host credential
  paths. Source mounts must be read-only.
- `FakeSandboxProvider` implements the provider interface for unit tests. It
  validates policies and commands, records executed argv, hashes uploaded
  artifacts, and enforces destroyed leases without spawning containers.
- `createSandboxRuntimeAdapter` lets the worker run a command through any
  `SandboxProvider`. When `BEK_SANDBOX_PROVIDER=docker-local` is set, the API's
  local worker controller wires this adapter to the `opencode-sandbox` runtime
  profile.
- The worker evaluates `sandbox.exec` for `sandbox:<provider-kind>` before it
  creates a provider lease. Missing or denied grants fail before sandbox start;
  `ask` grants create an approval checkpoint and do not lease a sandbox until
  the approval is granted.
- The Docker provider is not a hosted multitenant isolation claim. Use it for
  local OSS development, trusted single-tenant self-hosting, and CI-style
  validation; use a microVM provider for hosted untrusted code.

## Filesystem Policy

Default layout inside a sandbox:

```txt
/workspace/source     read-only repo checkout or mounted source
/workspace/worktree   writable copy or branch worktree for edits
/workspace/artifacts  writable output collected by Bek
/tmp                  writable scratch, size limited
```

Rules:

- never mount the host home directory,
- never mount `.env`, SSH keys, cloud config, Slack tokens, or provider auth
  files,
- never mount the Docker socket into the sandbox,
- source is read-only unless the run has explicit branch/edit permission,
- all generated patches and artifacts are copied out through the sandbox
  provider and content-scanned before use,
- destructive commands against mounted source require approval even if the
  sandbox itself is disposable.

For Docker, prefer rootless Docker, non-root container users, read-only root
filesystem where practical, dropped capabilities, no privileged mode, resource
limits, and explicit writable mounts.

## Network Policy

Default network mode is `disabled`.

Network is upgraded only by policy and, when risk is `write_external` or
`privileged`, human approval. Allowlist examples:

- `github.com` and `api.github.com` for clone, fetch, push, and PR operations,
- package registries needed by the repo, such as npm, PyPI, crates.io, or
  Maven, optionally through a cache/proxy,
- approved MCP server origins through the MCP gateway,
- project-specific preview URLs when a run is testing an app.

Always block:

- cloud metadata IPs,
- private RFC1918 and link-local ranges unless an admin explicitly configures a
  private integration,
- Slack Web API from sandbox code,
- admin/control-plane APIs,
- arbitrary DNS tunneling and unknown egress.

The runtime can ask for a network upgrade, but the worker decides through policy
and approval.

## Credential Policy

Runtimes receive capabilities, not durable secrets.

- Model provider credentials stay in the model gateway or credential broker.
- Tool credentials are scoped to the requested resource and action.
- Sandbox environment variables are empty by default.
- Short-lived tokens may be injected only for a specific approved command or
  tool call, then revoked or allowed to expire.
- Logs, events, artifacts, and model context are redacted before persistence.

OpenCode's normal provider auth storage must not be reused from the host. Bek
should generate per-run provider config that points to a Bek-controlled model
gateway or injects only short-lived run-scoped credentials.

## Approval Checkpoints

Required checkpoints:

| Checkpoint          | Examples                                                                                | Default                                 |
| ------------------- | --------------------------------------------------------------------------------------- | --------------------------------------- |
| Policy gate         | requested capability has no grant in the place                                          | deny                                    |
| Sandbox start       | privileged `sandbox.exec`, hosted provider with repo checkout                           | ask when grant says `ask`               |
| Network upgrade     | package install, repo fetch, external docs fetch                                        | ask unless allowlisted by admin         |
| Filesystem write    | source mutation, generated patch, branch worktree creation                              | allow for draft edits only when granted |
| External write      | Slack post beyond final reply, GitHub push/PR, Linear update, MCP mutation              | ask                                     |
| Privileged command  | Docker-in-Docker, service start with exposed port, package scripts from untrusted repos | ask or deny                             |
| Budget step-up      | model/tool spend would exceed configured threshold                                      | ask or deny by budget policy            |
| Retry after failure | repeated side effect after timeout or partial result                                    | ask for external writes                 |

Approval payload hashes must include the action, command/tool name, resource,
network mode, filesystem mounts, artifact hashes, risk, requester, and expiry.
Approvers must be human principals. Requesters cannot self-approve
`write_external` or `privileged` actions.

## Observability Events

Extend `RunEvent["type"]` over time rather than hiding provider activity in log
strings. Suggested event names:

- `run.queued`
- `worker.claimed`
- `runtime.selected`
- `runtime.started`
- `runtime.completed`
- `model.selected`
- `model.requested`
- `model.completed`
- `budget.checked`
- `policy.evaluated`
- `approval.requested`
- `approval.decided`
- `sandbox.requested`
- `sandbox.started`
- `sandbox.network_changed`
- `sandbox.command.started`
- `sandbox.command.completed`
- `sandbox.artifact.created`
- `tool.requested`
- `tool.approved`
- `tool.denied`
- `tool.completed`
- `credential.leased`
- `credential.revoked`
- `run.completed`
- `run.failed`
- `run.cancelled`

Event payloads should include:

- `orgId`, `runId`, `attempt`, `traceId`,
- place and requester IDs,
- runtime adapter ID and sandbox provider ID,
- model route, deterministic preflight cost counters, and budget decision,
- policy decision, risk, approval ID, and grant ID,
- command/tool name and resource,
- artifact IDs and content hashes,
- duration, exit code, retry count, and error class.

Event payloads must not include raw secrets, full provider responses with hidden
reasoning, unredacted environment variables, or full source files unless the
artifact ACL permits it.

Budget preflight data is deterministic routing metadata derived before the
runtime starts. It lets adapters and audit events agree on the selected model,
estimated cost, configured per-run budget, remaining budget, and rough prompt
and output token estimates. It is not live provider accounting; real adapters
must still reconcile actual token usage and billed cost from provider responses
into the durable model usage ledger.

## Remaining Implementation Steps

1. Replace request-scoped local drains with daemonized worker and outbox
   processes that can claim, heartbeat, retry, cancel, resume, dispatch, and
   settle work outside API request handlers.
2. Move worker queue claims and Slack outbound-delivery claims to row-level
   transactional operations, such as `FOR UPDATE SKIP LOCKED` or an equivalent
   queue backend, before enabling concurrent drainers.
3. Extend AI SDK Gateway execution with streaming, tool-call mediation,
   provider error dashboards, and durable actual usage/cost reconciliation.
4. Add the OpenCode runtime inside the sandbox with generated per-run config,
   Bek MCP/model proxies, lease heartbeat, stalled-process watchdog, cancellation
   handling, and partial artifact capture.
5. Add hosted sandbox provider adapters: Vercel Sandbox first for Vercel
   deployments, then E2B for portable hosted execution.
6. Add artifact collection for patches, logs, test summaries, and screenshots.
7. Add red-team tests for prompt injection, unsafe package scripts, metadata
   access, leaked secrets, stale policy, approval hash mismatch, row-level queue
   claim races, outbox replay, and tenant boundary failures.
