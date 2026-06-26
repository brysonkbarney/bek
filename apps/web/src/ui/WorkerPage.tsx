import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  ChevronDown,
  ListChecks,
  Play,
  RefreshCw,
  RotateCcw,
  Send,
  TimerReset,
} from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";
import {
  cancelRun,
  drainSlackOutbox,
  drainWorker,
  fetchSlackOutbox,
  fetchWorkerQueue,
  type SlackOutboundDelivery,
  redriveDeadLetter,
  type WorkerDeadLetterRecord,
  type WorkerEvent,
  type WorkerWorkRecord,
} from "../api";
import {
  EmptyState,
  ErrorState,
  InlineLoading,
  LoadingState,
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
  const [outboxLimit, setOutboxLimit] = useState(25);
  const [confirmation, setConfirmation] = useState<WorkerConfirmation | null>(
    null,
  );
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["worker-queue"],
    queryFn: fetchWorkerQueue,
    refetchInterval: 5000,
  });
  const outboxQuery = useQuery({
    queryKey: ["slack-outbox"],
    queryFn: () => fetchSlackOutbox(),
    refetchInterval: 5000,
  });
  const drainMutation = useMutation({
    mutationFn: (input: { maxItems: number }) =>
      drainWorker({ maxItems: input.maxItems }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["worker-queue"] });
      void queryClient.invalidateQueries({ queryKey: ["slack-outbox"] });
      void queryClient.invalidateQueries({ queryKey: ["bootstrap"] });
    },
  });
  const drainOutboxMutation = useMutation({
    mutationFn: (input: { limit: number }) =>
      drainSlackOutbox({ limit: input.limit }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["slack-outbox"] });
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
  const redriveMutation = useMutation({
    mutationFn: (deadLetter: WorkerDeadLetterRecord) =>
      redriveDeadLetter({
        deadLetterId: deadLetter.id,
        reason: "Redriven from worker dead-letter queue.",
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["worker-queue"] });
      void queryClient.invalidateQueries({ queryKey: ["bootstrap"] });
    },
  });

  if (isLoading) {
    return <LoadingState label="Loading worker queue..." />;
  }
  if (error || !data) {
    return (
      <ErrorState
        title="Worker queue is unavailable"
        message="Bek could not reach the worker queue."
        onRetry={() => void refetch()}
        isRetrying={isFetching}
      />
    );
  }

  const summary = workerQueueSummary(data.queue);
  const outboxDeliveries = outboxQuery.data?.deliveries ?? [];
  const outboxSummary = slackOutboxSummary(outboxDeliveries);
  const workerDrainConfirmation =
    confirmation?.kind === "worker-drain" ? confirmation : undefined;
  const outboxDrainConfirmation =
    confirmation?.kind === "slack-outbox-drain" ? confirmation : undefined;
  const dueOutboxDeliveries = dueSlackOutboxDeliveries(
    outboxDeliveries,
    outboxDrainConfirmation?.limit ?? outboxLimit,
  );
  const confirmingCancelRecordId =
    confirmation?.kind === "cancel-record" ? confirmation.recordId : undefined;
  const confirmingRedriveDeadLetterId =
    confirmation?.kind === "redrive-dead-letter"
      ? confirmation.deadLetterId
      : undefined;
  const cancellingRecordId =
    cancelMutation.isPending && cancelMutation.variables
      ? cancelMutation.variables.id
      : undefined;
  const redrivingDeadLetterId =
    redriveMutation.isPending && redriveMutation.variables
      ? redriveMutation.variables.id
      : undefined;

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
            {workerDrainConfirmation ? (
              <ConfirmationState
                title="Confirm worker drain"
                body={`Drain up to ${workerDrainConfirmation.maxItems} worker item(s).`}
                details={[
                  `${summary.queued} queued`,
                  `${summary.claimed} claimed`,
                  `${summary.awaitingApproval} awaiting approval`,
                ]}
                confirmLabel={
                  drainMutation.isPending ? "Draining..." : "Confirm"
                }
                confirmDisabled={!data.enabled || drainMutation.isPending}
                cancelDisabled={drainMutation.isPending}
                isBusy={drainMutation.isPending}
                onConfirm={() =>
                  drainMutation.mutate(
                    { maxItems: workerDrainConfirmation.maxItems },
                    { onSettled: () => setConfirmation(null) },
                  )
                }
                onCancel={() => setConfirmation(null)}
              />
            ) : (
              <>
                <label className="inline-control">
                  <span className="inline-label">Max</span>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={maxItems}
                    onChange={(event) =>
                      setMaxItems(Number(event.target.value))
                    }
                    aria-label="Drain max items"
                  />
                </label>
                <button
                  className="primary destructive"
                  type="button"
                  disabled={!data.enabled || drainMutation.isPending}
                  onClick={() =>
                    setConfirmation({ kind: "worker-drain", maxItems })
                  }
                >
                  <Play size={16} aria-hidden="true" />
                  Drain
                </button>
              </>
            )}
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
      {drainOutboxMutation.isSuccess ? (
        <SuccessCallout>
          Attempted {drainOutboxMutation.data.outbound.attempted} Slack delivery
          item(s).
        </SuccessCallout>
      ) : null}
      {redriveMutation.isSuccess ? (
        <SuccessCallout>
          Redrive queued for {redriveMutation.data.run.id}.
        </SuccessCallout>
      ) : null}
      {drainMutation.isError ||
      drainOutboxMutation.isError ||
      cancelMutation.isError ||
      redriveMutation.isError ? (
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

      <Panel
        title="Slack Outbox"
        action={
          <div className="row-actions">
            <span className="chip">{outboxSummary.queued} queued</span>
            <span className="chip">{outboxSummary.delivered} delivered</span>
            <span className="chip danger-chip">
              {outboxSummary.failed} failed
            </span>
            <button
              className="secondary"
              type="button"
              onClick={() => void outboxQuery.refetch()}
              disabled={outboxQuery.isFetching}
            >
              <RefreshCw size={16} aria-hidden="true" />
              Refresh
            </button>
            {outboxDrainConfirmation ? (
              <ConfirmationState
                title="Confirm Slack outbox drain"
                body={`Drain up to ${outboxDrainConfirmation.limit} ready Slack delivery item(s).`}
                details={[
                  `${dueOutboxDeliveries.length} ready`,
                  `${outboxSummary.queued} queued`,
                  ...dueOutboxDeliveries
                    .slice(0, 3)
                    .map((delivery) => `ID ${delivery.id}`),
                ]}
                confirmLabel={
                  drainOutboxMutation.isPending ? "Draining..." : "Confirm"
                }
                confirmDisabled={drainOutboxMutation.isPending}
                cancelDisabled={drainOutboxMutation.isPending}
                isBusy={drainOutboxMutation.isPending}
                onConfirm={() =>
                  drainOutboxMutation.mutate(
                    { limit: outboxDrainConfirmation.limit },
                    { onSettled: () => setConfirmation(null) },
                  )
                }
                onCancel={() => setConfirmation(null)}
              />
            ) : (
              <>
                <label className="inline-control">
                  <span className="inline-label">Max</span>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={outboxLimit}
                    onChange={(event) =>
                      setOutboxLimit(Number(event.target.value))
                    }
                    aria-label="Slack outbox drain limit"
                  />
                </label>
                <button
                  className="primary destructive"
                  type="button"
                  disabled={drainOutboxMutation.isPending}
                  onClick={() =>
                    setConfirmation({
                      kind: "slack-outbox-drain",
                      limit: outboxLimit,
                    })
                  }
                >
                  <Send size={16} aria-hidden="true" />
                  Drain
                </button>
              </>
            )}
          </div>
        }
      >
        {outboxQuery.isError ? (
          <WarningCallout>Bek could not load the Slack outbox.</WarningCallout>
        ) : outboxQuery.isLoading ? (
          <InlineLoading label="Loading Slack outbox..." />
        ) : (
          <SlackOutboxTable deliveries={outboxQuery.data?.deliveries ?? []} />
        )}
      </Panel>

      <Panel title="Work Records">
        <WorkerRecordsTable
          records={data.queue.records}
          confirmingCancelRecordId={confirmingCancelRecordId}
          cancellingRecordId={cancellingRecordId}
          onRequestCancel={(record) =>
            setConfirmation({ kind: "cancel-record", recordId: record.id })
          }
          onConfirmCancel={(record) =>
            cancelMutation.mutate(record, {
              onSettled: () => setConfirmation(null),
            })
          }
          onCancelConfirmation={() => setConfirmation(null)}
        />
      </Panel>

      <section className="grid">
        <Panel title="Dead Letters">
          <DeadLettersTable
            deadLetters={data.queue.deadLetters}
            confirmingRedriveDeadLetterId={confirmingRedriveDeadLetterId}
            redrivingDeadLetterId={redrivingDeadLetterId}
            onRequestRedrive={(deadLetter) =>
              setConfirmation({
                kind: "redrive-dead-letter",
                deadLetterId: deadLetter.id,
              })
            }
            onConfirmRedrive={(deadLetter) =>
              redriveMutation.mutate(deadLetter, {
                onSettled: () => setConfirmation(null),
              })
            }
            onCancelConfirmation={() => setConfirmation(null)}
          />
        </Panel>
        <Panel title="Recent Worker Events">
          <WorkerEventsList events={data.queue.events.slice(-8).reverse()} />
        </Panel>
      </section>
    </div>
  );
}

type WorkerConfirmation =
  | { kind: "worker-drain"; maxItems: number }
  | { kind: "slack-outbox-drain"; limit: number }
  | { kind: "cancel-record"; recordId: string }
  | { kind: "redrive-dead-letter"; deadLetterId: string };

function ConfirmationState({
  title,
  body,
  details,
  confirmLabel,
  confirmDisabled,
  cancelDisabled,
  isBusy,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  details: string[];
  confirmLabel: string;
  confirmDisabled: boolean;
  cancelDisabled: boolean;
  isBusy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="bundle danger-outline confirmation-state"
      role="group"
      aria-label={title}
    >
      <strong>{title}</strong>
      <span className="muted">{body}</span>
      <div className="chips">
        {details.map((detail) => (
          <span className="chip" key={detail}>
            {detail}
          </span>
        ))}
      </div>
      <div className="row-actions">
        <button
          className="secondary"
          type="button"
          disabled={confirmDisabled}
          aria-busy={isBusy}
          onClick={onConfirm}
        >
          <CheckCircle2 size={16} aria-hidden="true" />
          {confirmLabel}
        </button>
        <button
          className="secondary"
          type="button"
          disabled={cancelDisabled}
          onClick={onCancel}
        >
          <Ban size={16} aria-hidden="true" />
          Cancel
        </button>
      </div>
    </div>
  );
}

function SlackOutboxTable({
  deliveries,
}: {
  deliveries: SlackOutboundDelivery[];
}) {
  if (deliveries.length === 0) {
    return (
      <EmptyState
        title="No Slack deliveries"
        body="Slack outbound deliveries land here."
      />
    );
  }
  return (
    <div className="table-scroll">
      <table className="responsive-table wide-table">
        <caption className="sr-only">Bek Slack outbound deliveries</caption>
        <thead>
          <tr>
            <th scope="col">Delivery</th>
            <th scope="col">Status</th>
            <th scope="col">Attempts</th>
            <th scope="col">Run / Approval</th>
            <th scope="col">Last Error</th>
            <th scope="col">Next / Delivered</th>
            <th scope="col">Updated</th>
          </tr>
        </thead>
        <tbody>
          {deliveries.map((delivery) => (
            <tr key={delivery.id}>
              <td data-label="Delivery">
                <span>{delivery.id}</span>
                <small className="muted"> {delivery.kind}</small>
              </td>
              <td data-label="Status">
                <StatusBadge value={delivery.status} />
              </td>
              <td data-label="Attempts">
                {delivery.attempts}/{delivery.maxAttempts}
              </td>
              <td data-label="Run / Approval">
                {delivery.runId ? (
                  <Link
                    to="/runs/$runId"
                    params={{ runId: delivery.runId }}
                    className="inline-link"
                  >
                    {delivery.runId}
                  </Link>
                ) : (
                  <span className="muted">no run</span>
                )}
                <small className="muted">
                  {" "}
                  approval {delivery.approvalId ?? "-"}
                </small>
              </td>
              <td data-label="Last Error">
                {delivery.lastError ? (
                  <span className="truncate">{delivery.lastError}</span>
                ) : (
                  <span className="muted">-</span>
                )}
              </td>
              <td data-label="Next / Delivered">
                <span>{optionalDateTime(delivery.nextAttemptAt)}</span>
                <small className="muted">
                  {" "}
                  delivered {optionalDateTime(delivery.deliveredAt)}
                </small>
              </td>
              <td data-label="Updated">{formatDateTime(delivery.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WorkerRecordsTable({
  records,
  confirmingCancelRecordId,
  cancellingRecordId,
  onRequestCancel,
  onConfirmCancel,
  onCancelConfirmation,
}: {
  records: WorkerWorkRecord[];
  confirmingCancelRecordId?: string | undefined;
  cancellingRecordId?: string | undefined;
  onRequestCancel: (record: WorkerWorkRecord) => void;
  onConfirmCancel: (record: WorkerWorkRecord) => void;
  onCancelConfirmation: () => void;
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
            <th scope="col">Run</th>
            <th scope="col">Status</th>
            <th scope="col">Attempt</th>
            <th scope="col">Available</th>
            <th scope="col">Lease</th>
            <th scope="col">Result</th>
            <th scope="col">Action</th>
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
                {confirmingCancelRecordId === record.id ? (
                  <ConfirmationState
                    title="Confirm queued item cancel"
                    body={`Cancel run ${record.item.runId} from the worker queue.`}
                    details={[
                      `Record ${record.id}`,
                      `Status ${record.status}`,
                      `Attempt ${record.item.attempt}`,
                    ]}
                    confirmLabel={
                      cancellingRecordId === record.id
                        ? "Cancelling..."
                        : "Confirm"
                    }
                    confirmDisabled={cancellingRecordId === record.id}
                    cancelDisabled={cancellingRecordId === record.id}
                    isBusy={cancellingRecordId === record.id}
                    onConfirm={() => onConfirmCancel(record)}
                    onCancel={onCancelConfirmation}
                  />
                ) : canCancel(record) ? (
                  <button
                    className="icon-button danger"
                    type="button"
                    onClick={() => onRequestCancel(record)}
                    aria-label={`Cancel ${record.item.runId}`}
                    disabled={cancellingRecordId === record.id}
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
  confirmingRedriveDeadLetterId,
  redrivingDeadLetterId,
  onRequestRedrive,
  onConfirmRedrive,
  onCancelConfirmation,
}: {
  deadLetters: WorkerDeadLetterRecord[];
  confirmingRedriveDeadLetterId?: string | undefined;
  redrivingDeadLetterId?: string | undefined;
  onRequestRedrive: (deadLetter: WorkerDeadLetterRecord) => void;
  onConfirmRedrive: (deadLetter: WorkerDeadLetterRecord) => void;
  onCancelConfirmation: () => void;
}) {
  const [expandedId, setExpandedId] = useState<string | undefined>();
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
            <th scope="col">Run</th>
            <th scope="col">Reason</th>
            <th scope="col">Attempts</th>
            <th scope="col">Failed</th>
            <th scope="col">Action</th>
          </tr>
        </thead>
        <tbody>
          {deadLetters.map((deadLetter) => {
            const expanded = expandedId === deadLetter.id;
            const detailId = `dead-letter-detail-${deadLetter.id}`;
            return (
              <Fragment key={deadLetter.id}>
                <tr>
                  <td data-label="Run">
                    <button
                      type="button"
                      className="dead-letter-toggle"
                      aria-expanded={expanded}
                      aria-controls={detailId}
                      onClick={() =>
                        setExpandedId(expanded ? undefined : deadLetter.id)
                      }
                      title={expanded ? "Hide details" : "Show details"}
                    >
                      <ChevronDown
                        size={14}
                        className={`dead-letter-caret ${expanded ? "open" : ""}`}
                        aria-hidden="true"
                      />
                      <span className="inline-link">
                        {deadLetter.item.runId}
                      </span>
                    </button>
                  </td>
                  <td data-label="Reason">{deadLetter.reason}</td>
                  <td data-label="Attempts">
                    {deadLetter.item.attempt}/
                    {deadLetter.retryPolicy.maxAttempts ?? "-"}
                  </td>
                  <td data-label="Failed">
                    {formatDateTime(deadLetter.failedAt)}
                  </td>
                  <td data-label="Action">
                    {confirmingRedriveDeadLetterId === deadLetter.id ? (
                      <ConfirmationState
                        title="Confirm dead-letter redrive"
                        body={`Queue a redrive for run ${deadLetter.item.runId}.`}
                        details={[
                          `Dead letter ${deadLetter.id}`,
                          `Work ${deadLetter.workId}`,
                          `Attempt ${deadLetter.item.attempt}`,
                        ]}
                        confirmLabel={
                          redrivingDeadLetterId === deadLetter.id
                            ? "Redriving..."
                            : "Confirm"
                        }
                        confirmDisabled={
                          redrivingDeadLetterId === deadLetter.id
                        }
                        cancelDisabled={redrivingDeadLetterId === deadLetter.id}
                        isBusy={redrivingDeadLetterId === deadLetter.id}
                        onConfirm={() => onConfirmRedrive(deadLetter)}
                        onCancel={onCancelConfirmation}
                      />
                    ) : (
                      <button
                        className="icon-button"
                        type="button"
                        onClick={() => onRequestRedrive(deadLetter)}
                        aria-label={`Redrive ${deadLetter.item.runId}`}
                        disabled={redrivingDeadLetterId === deadLetter.id}
                        title="Redrive dead letter"
                      >
                        <RotateCcw size={15} aria-hidden="true" />
                      </button>
                    )}
                  </td>
                </tr>
                {expanded ? (
                  <tr className="dead-letter-detail-row">
                    <td colSpan={5}>
                      <DeadLetterDetail deadLetter={deadLetter} id={detailId} />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DeadLetterDetail({
  deadLetter,
  id,
}: {
  deadLetter: WorkerDeadLetterRecord;
  id: string;
}) {
  const lastError = deadLetter.result.error ?? deadLetter.reason;
  return (
    <div className="dead-letter-detail" id={id}>
      <dl className="dead-letter-facts">
        <DeadLetterFact label="Status">
          {deadLetter.result.status ?? "failed"}
        </DeadLetterFact>
        <DeadLetterFact label="Attempts">
          {deadLetter.item.attempt}/{deadLetter.retryPolicy.maxAttempts ?? "-"}
        </DeadLetterFact>
        <DeadLetterFact label="Reason">{deadLetter.reason}</DeadLetterFact>
        <DeadLetterFact label="Dead letter">{deadLetter.id}</DeadLetterFact>
        <DeadLetterFact label="Work">{deadLetter.workId}</DeadLetterFact>
        <DeadLetterFact label="Trace">{deadLetter.item.traceId}</DeadLetterFact>
        <DeadLetterFact label="Enqueued">
          {formatDateTime(deadLetter.item.enqueuedAt)}
        </DeadLetterFact>
        <DeadLetterFact label="Failed">
          {formatDateTime(deadLetter.failedAt)}
        </DeadLetterFact>
      </dl>
      <div className="dead-letter-error">
        <span className="trace-group-label">Last error</span>
        <pre className="dead-letter-error-body">{lastError}</pre>
      </div>
    </div>
  );
}

function DeadLetterFact({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="dead-letter-fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
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

function slackOutboxSummary(deliveries: SlackOutboundDelivery[]) {
  return {
    queued: deliveries.filter((delivery) => delivery.status === "queued")
      .length,
    delivered: deliveries.filter((delivery) => delivery.status === "delivered")
      .length,
    failed: deliveries.filter((delivery) => delivery.status === "failed")
      .length,
  };
}

function dueSlackOutboxDeliveries(
  deliveries: SlackOutboundDelivery[],
  limit: number,
) {
  const nowMs = Date.now();
  return deliveries
    .filter(
      (delivery) =>
        delivery.status === "queued" &&
        Date.parse(delivery.nextAttemptAt ?? delivery.createdAt) <= nowMs,
    )
    .sort((a, b) =>
      (a.nextAttemptAt ?? a.createdAt).localeCompare(
        b.nextAttemptAt ?? b.createdAt,
      ),
    )
    .slice(0, Math.max(1, limit));
}

function optionalDateTime(value?: string): string {
  return value ? formatDateTime(value) : "-";
}
