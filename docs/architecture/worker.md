# Worker Orchestrator Foundation

Status: deterministic queue/runtime service plus local runner. API run
creation is still synchronous in the local demo; durable API-to-worker dispatch
is the next integration step.

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

Worker events are local to `@bek/worker` for now because persisted
`@bek/core` run events still have a narrower union. The emitted event type can
be either a runtime observability event such as `worker.claimed`,
`runtime.started`, or `tool.requested`, or a worker lifecycle event such as
`worker.retry_scheduled`, `worker.cancel_requested`,
`worker.dead_lettered`, and `worker.approval_resumed`.

Messages and data pass through core redaction helpers before storage. The event
model is ready to map into durable run events once the DB/API schema is expanded.

`WorkerEventSink` is the storage/streaming boundary for durable event
publication. `InMemoryWorkerQueue` still keeps a local event log for tests, and
optionally forwards every redacted event to the injected sink. A durable worker
should publish event sink writes in the same transaction as the queue mutation
or make the sink itself idempotent by event ID.
