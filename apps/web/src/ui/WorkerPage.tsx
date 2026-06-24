import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  ListChecks,
  Play,
  RefreshCw,
  TimerReset,
} from "lucide-react";
import { useState } from "react";
import {
  cancelRun,
  drainWorker,
  fetchWorkerQueue,
  type WorkerDeadLetterRecord,
  type WorkerEvent,
  type WorkerWorkRecord,
} from "../api";
import {
  EmptyState,
  MetricCard,
  PageHeader,
  Panel,
  StatusBadge,
  SuccessCallout,
  WarningCallout,
} from "./components";
import { formatDateTime, workerQueueSummary } from "./product-model";

export function WorkerPage() {
  const queryClient = useQueryClient();
  const [maxItems, setMaxItems] = useState(10);
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["worker-queue"],
    queryFn: fetchWorkerQueue,
    refetchInterval: 5000,
  });
  const drainMutation = useMutation({
    mutationFn: () => drainWorker({ maxItems }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["worker-queue"] });
      void queryClient.invalidateQueries({ queryKey: ["bootstrap"] });
    },
  });
  const cancelMutation = useMutation({
    mutationFn: (record: WorkerWorkRecord) =>
      cancelRun({
        runId: record.item.runId,
        reason: "Cancelled from worker queue.",
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["worker-queue"] });
      void queryClient.invalidateQueries({ queryKey: ["bootstrap"] });
    },
  });

  if (isLoading) {
    return <div className="state">Loading worker queue...</div>;
  }
  if (error || !data) {
    return <div className="state error">Worker queue is not reachable.</div>;
  }

  const summary = workerQueueSummary(data.queue);

  return (
    <div className="page">
      <PageHeader
        eyebrow="Worker"
        title="Queue, leases, retries, and dead letters."
        actions={
          <div className="row-actions">
            <button
              className="secondary"
              type="button"
              onClick={() => void refetch()}
              disabled={isFetching}
            >
              <RefreshCw size={16} aria-hidden="true" />
              Refresh
            </button>
            <label className="inline-control">
              <span className="sr-only">Drain max items</span>
              <input
                type="number"
                min={1}
                max={100}
                value={maxItems}
                onChange={(event) => setMaxItems(Number(event.target.value))}
                aria-label="Drain max items"
              />
            </label>
            <button
              className="primary"
              type="button"
              disabled={!data.enabled || drainMutation.isPending}
              onClick={() => drainMutation.mutate()}
            >
              <Play size={16} aria-hidden="true" />
              Drain
            </button>
          </div>
        }
      />

      {!data.enabled ? (
        <WarningCallout>
          Worker mode is {data.mode}. Set `BEK_RUN_ADVANCEMENT=worker_local`.
        </WarningCallout>
      ) : null}
      {drainMutation.isSuccess ? (
        <SuccessCallout>
          Processed {drainMutation.data.result.processed} item(s); stopped at{" "}
          {drainMutation.data.result.stoppedReason}.
        </SuccessCallout>
      ) : null}
      {drainMutation.isError || cancelMutation.isError ? (
        <WarningCallout>
          Bek could not update the worker queue. Refresh and try again.
        </WarningCallout>
      ) : null}

      <section className="worker-metrics">
        <MetricCard
          icon={<ListChecks />}
          label="Active work"
          value={String(summary.active)}
          detail={`${summary.queued} queued, ${summary.claimed} claimed`}
        />
        <MetricCard
          icon={<TimerReset />}
          label="Retries"
          value={String(summary.retryScheduled)}
          detail={`${summary.awaitingApproval} awaiting approval`}
        />
        <MetricCard
          icon={<AlertTriangle />}
          label="Dead letters"
          value={String(summary.deadLetters)}
          detail={`${summary.cancelled} cancelled`}
        />
        <MetricCard
          icon={<CheckCircle2 />}
          label="Completed"
          value={String(summary.completed)}
          detail={`${summary.events} worker events`}
        />
      </section>

      <Panel title="Work Records">
        <WorkerRecordsTable
          records={data.queue.records}
          cancellingRunId={cancelMutation.variables?.item.runId}
          onCancel={(record) => cancelMutation.mutate(record)}
        />
      </Panel>

      <section className="grid">
        <Panel title="Dead Letters">
          <DeadLettersTable deadLetters={data.queue.deadLetters} />
        </Panel>
        <Panel title="Recent Worker Events">
          <WorkerEventsList events={data.queue.events.slice(-8).reverse()} />
        </Panel>
      </section>
    </div>
  );
}

function WorkerRecordsTable({
  records,
  cancellingRunId,
  onCancel,
}: {
  records: WorkerWorkRecord[];
  cancellingRunId?: string | undefined;
  onCancel: (record: WorkerWorkRecord) => void;
}) {
  if (records.length === 0) {
    return (
      <EmptyState title="No worker records" body="Worker records land here." />
    );
  }
  return (
    <div className="table-scroll">
      <table className="responsive-table">
        <caption className="sr-only">Bek worker work records</caption>
        <thead>
          <tr>
            <th>Run</th>
            <th>Status</th>
            <th>Attempt</th>
            <th>Available</th>
            <th>Lease</th>
            <th>Result</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {records.map((record) => (
            <tr key={record.id}>
              <td data-label="Run">
                <Link
                  to="/runs/$runId"
                  params={{ runId: record.item.runId }}
                  className="inline-link"
                >
                  {record.item.runId}
                </Link>
                <small className="muted"> {record.item.reason}</small>
              </td>
              <td data-label="Status">
                <StatusBadge value={record.status} />
                <small className="muted"> {record.attemptState}</small>
              </td>
              <td data-label="Attempt">{record.item.attempt}</td>
              <td data-label="Available">
                {formatDateTime(record.availableAt)}
              </td>
              <td data-label="Lease">
                {record.lease ? (
                  <span>
                    {record.lease.workerId}
                    <small className="muted">
                      {" "}
                      until {formatDateTime(record.lease.expiresAt)}
                    </small>
                  </span>
                ) : (
                  <span className="muted">none</span>
                )}
              </td>
              <td data-label="Result">
                {record.result?.status ?? record.terminalReason ?? "-"}
              </td>
              <td data-label="Action">
                {canCancel(record) ? (
                  <button
                    className="icon-button danger"
                    type="button"
                    onClick={() => onCancel(record)}
                    aria-label={`Cancel ${record.item.runId}`}
                    disabled={cancellingRunId === record.item.runId}
                    title="Cancel run"
                  >
                    <Ban size={15} aria-hidden="true" />
                  </button>
                ) : (
                  <span className="muted">-</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DeadLettersTable({
  deadLetters,
}: {
  deadLetters: WorkerDeadLetterRecord[];
}) {
  if (deadLetters.length === 0) {
    return (
      <EmptyState
        title="No dead letters"
        body="Failed terminal work lands here."
      />
    );
  }
  return (
    <div className="table-scroll">
      <table className="responsive-table">
        <caption className="sr-only">Bek worker dead letters</caption>
        <thead>
          <tr>
            <th>Run</th>
            <th>Reason</th>
            <th>Attempts</th>
            <th>Failed</th>
          </tr>
        </thead>
        <tbody>
          {deadLetters.map((deadLetter) => (
            <tr key={deadLetter.id}>
              <td data-label="Run">
                <Link
                  to="/runs/$runId"
                  params={{ runId: deadLetter.item.runId }}
                  className="inline-link"
                >
                  {deadLetter.item.runId}
                </Link>
              </td>
              <td data-label="Reason">{deadLetter.reason}</td>
              <td data-label="Attempts">
                {deadLetter.item.attempt}/
                {deadLetter.retryPolicy.maxAttempts ?? "-"}
              </td>
              <td data-label="Failed">{formatDateTime(deadLetter.failedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WorkerEventsList({ events }: { events: WorkerEvent[] }) {
  if (events.length === 0) {
    return (
      <EmptyState title="No worker events" body="Worker events land here." />
    );
  }
  return (
    <div className="bundle-list">
      {events.map((event) => (
        <div className="bundle" key={event.id}>
          <div className="split-row">
            <strong>{event.type}</strong>
            <small>{formatDateTime(event.createdAt)}</small>
          </div>
          <span>{event.message}</span>
          <small className="muted">{event.runId}</small>
        </div>
      ))}
    </div>
  );
}

function canCancel(record: WorkerWorkRecord): boolean {
  return (
    record.status === "queued" ||
    record.status === "claimed" ||
    record.status === "awaiting_approval"
  );
}
