# Worker Orchestrator Foundation

Status: deterministic queue/runtime service, local runner, and API
`worker_local` bridge. API and Slack-created runs can be advanced through the
worker path in-process by setting `BEK_RUN_ADVANCEMENT=worker_local`. The next
production step is replacing the in-memory queue with a durable queue/worker
process while preserving this contract.

Bek keeps one visible Slack teammate, `@bek`. The worker is an internal control
plane component: it chooses runtimes, claims work, retries safely, pauses for
approval, and records audit events without exposing internal agent names.

## Boundary

The worker queue payload is only a pointer:

```ts
RunWorkItem {
  orgId: string;
  runId: string;
  attempt: number;
  reason: "new_run" | "approval_granted" | "retry" | "resume";
  traceId: string;
  enqueuedAt: string;
}
```

On claim, the future durable implementation must reload run state, place scope,
the single visible `@bek` agent identity, access bundles, runtime profile,
model policy, budget state, pending approvals, and cancellation markers. Policy
and budget decisions are never trusted from the queue payload.

## In-Memory Contract

`@bek/worker` provides `InMemoryWorkerQueue` as a deterministic model of the
durable worker boundary. It is intentionally storage-neutral and can be mapped
to Postgres, a queue, or a workflow engine later.

- `enqueue` stores active work idempotently by
  `run_attempt:{orgId}:{runId}:{attempt}`. The same key is copied onto leases
  so runtime side effects can be deduped per attempt.
- `claimNext` returns one leased work record in FIFO order by availability time.
- Expired leases are returned to the queue before a new claim is selected.
- `expireLeases` exposes the same heartbeat-expiry behavior as a scheduler
  sweep, without requiring a new worker claim.
- `heartbeat` extends an active lease, reports lost leases, or tells a worker to
  cancel when a human/system cancellation has been requested.
- `settle` records completion, cancellation, retry, terminal failure, or an
  approval pause from a `RuntimeResult`.
- `resumeAfterApproval` requeues the same attempt only after the matching
  approval is approved with the same payload hash.
- `emitRuntimeEvent` records redacted runtime observability events while the
  worker holds a lease.

The in-memory contract has injectable clocks and ID factories so tests can
assert exact claim, heartbeat, retry, and resume decisions.

## API Bridge

`apps/api` owns a `LocalWorkerController` when run advancement mode is
`worker_local`.

- `POST /api/runs` creates the run in core with `advanceMode: "worker"`, then
  enqueues and drains queued work through `WorkerRuntimeService`.
- Slack mentions and slash commands use the same helper, so Slack ingress,
  direct API calls, and future UI-triggered runs share one execution path.
- Allowed reads complete through the deterministic local runtime adapter.
- Policy-gated work, such as `github.pr`, stays `awaiting_approval` until a
  human approves it; approval then enqueues `approval_granted` work and resumes
  the runtime.
- Runtime-requested approvals are upserted into core approvals from the worker
  pause record, so mid-run checkpoints show up in the same admin approval UI.
- `GET /api/worker/queue` exposes the local worker queue snapshot.
- `POST /api/worker/drain` manually drains pending local work when the mode is
  enabled.

This bridge is deliberately in-process for the local product loop. Hosted or
multi-instance deployments must move the same queue contract to Postgres,
Valkey, a workflow engine, or another durable backend so claims, leases, event
publication, and run settlement are transactional and crash-safe.

## Attempt State Machine

Worker records have two related fields:

- `status`: queue storage status (`queued`, `claimed`, `awaiting_approval`,
  `completed`, `failed`, `cancelled`, `dead`).
- `attemptState`: orchestration state (`queued`, `claimed`,
  `awaiting_approval`, `retry_scheduled`, `cancel_requested`, `completed`,
  `cancelled`, `dead_lettered`).

All internal mutations pass through the exported state transition table. A
durable implementation should enforce the same transitions transactionally:
queued work can be claimed or cancelled; claimed work can complete, pause,
retry, dead-letter, be cancelled, or be requeued after heartbeat expiry; paused
approval work can resume or cancel; terminal states do not reopen.

## Retry And Cancel Rules

Retries are deterministic exponential backoff:

```txt
delay = min(maxDelayMs, baseDelayMs * 2 ^ (failedAttempt - 1))
```

Retries create a new work record with `reason: "retry"` and `attempt + 1`.
Approval resumes do not increment attempts; they continue the same attempt with
`reason: "approval_granted"` so side-effect idempotency remains tied to
`(runId, attempt)`.

When an attempt exhausts `maxAttempts`, the worker marks the work record `dead`
with `attemptState: "dead_lettered"` and appends a `WorkerDeadLetterRecord`
containing the work ID, idempotency key, runtime result, retry policy snapshot,
failure reason, and failed-at timestamp. Re-drives from the dead-letter queue
must create a new work item intentionally; the in-memory contract does not
automatically resurrect terminal work.

Cancellation is cooperative for claimed work. `cancelRun` marks queued or
paused work cancelled immediately, but claimed work keeps its lease until the
worker heartbeats or settles. The heartbeat decision tells the runtime to stop,
and settlement records the terminal cancellation.

## Approval Resume

Approval pauses store only the approval ID, action, payload hash, status, and
expiry metadata. Resume behavior is:

- `pending`: keep waiting.
- `approved` with matching payload hash: requeue the same attempt for resume.
- `approved` with a mismatched hash: block and emit an approval-blocked event.
- `denied` or `expired`: cancel the paused work.

This mirrors Bek's approval invariant: the requester and runtime cannot mutate
the approved payload after a human decision.

Approval callbacks are idempotent. A repeated approved callback after resume
returns `already_resumed` with the current work record. A pending callback after
the stored approval expiry cancels the paused attempt as expired.

## Event Model

Worker events are emitted by `@bek/worker` and mapped by the API bridge into
persisted core run events. The original worker event type, trace ID, attempt,
and event ID are stored in event data while the persisted event type stays in
the stable core union, such as `run.status_changed`, `model.selected`,
`tool.requested`, `approval.requested`, `run.completed`, and `run.failed`.

Messages and data pass through core redaction helpers before storage. The event
model is ready to map into a richer durable run-event enum once the DB/API
schema is expanded.

`WorkerEventSink` is the storage/streaming boundary for durable event
publication. `InMemoryWorkerQueue` still keeps a local event log for tests, and
optionally forwards every redacted event to the injected sink. A durable worker
should publish event sink writes in the same transaction as the queue mutation
or make the sink itself idempotent by event ID.
