import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import {
  ArrowLeft,
  Check,
  CircleSlash,
  Clock,
  Database,
  GitPullRequest,
  KeyRound,
  LockKeyhole,
  Server,
  ShieldCheck,
} from "lucide-react";
import {
  decideApproval,
  fetchBootstrap,
  fetchRunDetail,
  type AccessBundle,
  type ApprovalRequest,
  type RunEvent,
} from "../api";
import {
  bundlesForPlace,
  connectorSummaries,
  findRunPlace,
  formatDateTime,
  formatMoney,
  grantsByDecision,
  pendingApprovals,
  setupSteps,
  visibleHandleAntiPatterns,
} from "./product-model";
import {
  CostCell,
  DecisionBadge,
  EmptyState,
  MetricCard,
  PageHeader,
  Panel,
  RiskBadge,
  RunLink,
  StatusBadge,
  WarningCallout,
} from "./components";

export function SetupPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["bootstrap"],
    queryFn: fetchBootstrap,
  });

  if (isLoading) return <div className="state">Loading setup...</div>;
  if (!data)
    return <div className="state error">Bek API is not reachable.</div>;

  return (
    <div className="page">
      <PageHeader
        eyebrow="First install"
        title="One Slack teammate, then governed access behind it."
        description="Bek should feel like a coworker: tag @bek once, then let policy decide which tools, repos, runtimes, and models are available in that place."
      />
      <section className="metrics">
        <MetricCard
          icon={<ShieldCheck />}
          label="Visible teammate"
          value={data.agent.handle}
          detail="No specialist bot names"
        />
        <MetricCard
          icon={<Server />}
          label="Pilot channels"
          value={String(data.places.length)}
          detail="Slack scopes configured"
        />
        <MetricCard
          icon={<KeyRound />}
          label="Pending approvals"
          value={String(pendingApprovals(data.approvals).length)}
          detail="Human gate for risky work"
        />
      </section>
      <section className="grid">
        <Panel title="Setup checklist">
          <ol className="checklist">
            {setupSteps.map((step, index) => (
              <li key={step}>
                <Check size={16} aria-hidden="true" />
                <span>
                  {index + 1}. {step}
                </span>
              </li>
            ))}
          </ol>
        </Panel>
        <Panel title="Not Bek">
          <div className="bundle-list">
            {visibleHandleAntiPatterns.map((item) => (
              <div className="bundle danger-outline" key={item}>
                <strong>{item}</strong>
                <span>
                  Teams should not need to choose the right bot before asking
                  for help.
                </span>
              </div>
            ))}
          </div>
        </Panel>
      </section>
    </div>
  );
}

export function ChannelsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["bootstrap"],
    queryFn: fetchBootstrap,
  });

  if (isLoading) return <div className="state">Loading channels...</div>;
  if (!data)
    return <div className="state error">Bek API is not reachable.</div>;

  return (
    <div className="page">
      <PageHeader
        eyebrow="Channel scopes"
        title="Decide what @bek can do in each place."
      />
      <section className="channel-grid">
        {data.places.length === 0 ? (
          <EmptyState
            title="No channel scopes"
            body="Connect Slack and choose a pilot channel to scope Bek access."
          />
        ) : (
          data.places.map((place) => {
            const bundles = bundlesForPlace(data.accessBundles, place.id);
            const runs = data.runs.filter(
              (run) => run.placeScopeId === place.id,
            );
            return (
              <Panel key={place.id} title={place.name}>
                <div className="meta-row">
                  <StatusBadge value={place.sensitivity} />
                  <span>{place.externalId}</span>
                </div>
                <div className="bundle-list">
                  {bundles.length === 0 ? (
                    <EmptyState
                      title="No bundles attached"
                      body="Attach an access bundle before Bek can act here."
                    />
                  ) : (
                    bundles.map((bundle) => (
                      <div className="bundle" key={bundle.id}>
                        <strong>{bundle.name}</strong>
                        <span>{bundle.grants.length} grants attached</span>
                      </div>
                    ))
                  )}
                </div>
                <p className="muted">{runs.length} runs from this place</p>
              </Panel>
            );
          })
        )}
      </section>
    </div>
  );
}

export function AccessBundlesPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["bootstrap"],
    queryFn: fetchBootstrap,
  });

  if (isLoading) return <div className="state">Loading access bundles...</div>;
  if (!data)
    return <div className="state error">Bek API is not reachable.</div>;

  return (
    <div className="page">
      <PageHeader
        eyebrow="Access bundles"
        title="Bundle tools, repos, models, and approvals by place."
      />
      {data.accessBundles.length === 0 ? (
        <EmptyState
          title="No access bundles"
          body="Create a bundle to define what Bek can do in each place."
        />
      ) : (
        <div className="bundle-board">
          {data.accessBundles.map((bundle) => (
            <AccessBundlePanel bundle={bundle} key={bundle.id} />
          ))}
        </div>
      )}
    </div>
  );
}

function AccessBundlePanel({ bundle }: { bundle: AccessBundle }) {
  const grouped = grantsByDecision(bundle.grants);
  return (
    <Panel title={bundle.name}>
      <p className="muted">{bundle.description}</p>
      <div className="grant-columns">
        {(["allow", "ask", "deny"] as const).map((decision) => (
          <div className="grant-column" key={decision}>
            <DecisionBadge value={decision} />
            {grouped[decision].length === 0 ? (
              <span className="muted">No grants</span>
            ) : null}
            {grouped[decision].map((grant) => (
              <div className="grant" key={grant.id}>
                <strong>{grant.capability}</strong>
                <span>{grant.resource}</span>
                <RiskBadge value={grant.risk} />
              </div>
            ))}
          </div>
        ))}
      </div>
    </Panel>
  );
}

export function ApprovalsPage() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["bootstrap"],
    queryFn: fetchBootstrap,
  });
  const decisionMutation = useMutation({
    mutationFn: decideApproval,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["bootstrap"] }),
  });

  if (isLoading) return <div className="state">Loading approvals...</div>;
  if (!data)
    return <div className="state error">Bek API is not reachable.</div>;

  return (
    <div className="page">
      <PageHeader
        eyebrow="Human gates"
        title="Risky Bek actions wait for approval."
      />
      <Panel>
        {decisionMutation.isError ? (
          <WarningCallout>
            Bek could not save that approval decision. Try again.
          </WarningCallout>
        ) : null}
        {data.approvals.length === 0 ? (
          <EmptyState
            title="No approvals yet"
            body="Trigger the demo PR run to see a write_external approval."
          />
        ) : (
          <div className="table-scroll">
            <table>
              <caption className="sr-only">Bek approval requests</caption>
              <thead>
                <tr>
                  <th scope="col">Action</th>
                  <th scope="col">Risk</th>
                  <th scope="col">Status</th>
                  <th scope="col">Expires</th>
                  <th scope="col">Decision</th>
                </tr>
              </thead>
              <tbody>
                {data.approvals.map((approval) => (
                  <ApprovalRow
                    approval={approval}
                    isDisabled={decisionMutation.isPending}
                    pendingDecision={
                      decisionMutation.variables?.approvalId === approval.id
                        ? decisionMutation.variables.decision
                        : undefined
                    }
                    onDecision={(decision) =>
                      decisionMutation.mutate({
                        approvalId: approval.id,
                        decision,
                        principalId: "principal_admin",
                        payloadHash: approval.payloadHash,
                      })
                    }
                    key={approval.id}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

function ApprovalRow({
  approval,
  isDisabled,
  pendingDecision,
  onDecision,
}: {
  approval: ApprovalRequest;
  isDisabled: boolean;
  pendingDecision: "approve" | "deny" | undefined;
  onDecision: (decision: "approve" | "deny") => void;
}) {
  const approvePending = pendingDecision === "approve";
  const denyPending = pendingDecision === "deny";
  return (
    <tr>
      <td>{approval.action}</td>
      <td>
        <RiskBadge value={approval.risk} />
      </td>
      <td>
        <StatusBadge value={approval.status} />
      </td>
      <td>{formatDateTime(approval.expiresAt)}</td>
      <td>
        {approval.status === "pending" ? (
          <div className="row-actions">
            <button
              className={`icon-button${approvePending ? " pending" : ""}`}
              aria-label={
                approvePending
                  ? `Approving ${approval.action}`
                  : `Approve ${approval.action}`
              }
              aria-busy={approvePending}
              disabled={isDisabled}
              title="Approve"
              onClick={() => onDecision("approve")}
            >
              <Check size={16} aria-hidden="true" />
            </button>
            <button
              className={`icon-button danger${denyPending ? " pending" : ""}`}
              aria-label={
                denyPending
                  ? `Denying ${approval.action}`
                  : `Deny ${approval.action}`
              }
              aria-busy={denyPending}
              disabled={isDisabled}
              title="Deny"
              onClick={() => onDecision("deny")}
            >
              <CircleSlash size={16} aria-hidden="true" />
            </button>
          </div>
        ) : (
          <span className="muted">decided</span>
        )}
      </td>
    </tr>
  );
}

export function ConnectorsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["bootstrap"],
    queryFn: fetchBootstrap,
  });

  if (isLoading) return <div className="state">Loading connectors...</div>;
  if (!data)
    return <div className="state error">Bek API is not reachable.</div>;

  return (
    <div className="page">
      <PageHeader
        eyebrow="Connectors"
        title="Slack, repos, MCP tools, sandboxes, and model providers plug into one agent."
      />
      <section className="connector-grid">
        {connectorSummaries(data).map((connector) => (
          <Panel title={connector.name} key={connector.id}>
            <StatusBadge value={connector.status} />
            <p className="muted">{connector.detail}</p>
          </Panel>
        ))}
      </section>
    </div>
  );
}

export function ModelsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["bootstrap"],
    queryFn: fetchBootstrap,
  });

  if (isLoading) return <div className="state">Loading models...</div>;
  if (!data)
    return <div className="state error">Bek API is not reachable.</div>;

  return (
    <div className="page">
      <PageHeader
        eyebrow="Model routing"
        title="Model choice is policy, not lock-in."
      />
      {data.modelPolicies.length === 0 ? (
        <EmptyState
          title="No model policies"
          body="Add a model policy before Bek can route work."
        />
      ) : (
        <section className="bundle-list">
          {data.modelPolicies.map((policy) => (
            <Panel title={policy.name} key={policy.id}>
              <div className="split-row">
                <div>
                  <span className="muted">Default</span>
                  <strong>{policy.defaultModel}</strong>
                </div>
                <div>
                  <span className="muted">Per-run limit</span>
                  <strong>{formatMoney(policy.perRunBudgetCents)}</strong>
                </div>
              </div>
              <div className="chips">
                {policy.fallbackModels.map((model) => (
                  <span className="chip" key={model}>
                    {model}
                  </span>
                ))}
              </div>
            </Panel>
          ))}
        </section>
      )}
    </div>
  );
}

export function MemoryPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["bootstrap"],
    queryFn: fetchBootstrap,
  });

  if (isLoading) return <div className="state">Loading memory...</div>;
  if (!data)
    return <div className="state error">Bek API is not reachable.</div>;

  return (
    <div className="page">
      <PageHeader
        eyebrow="Memory"
        title="Team memory must be scoped, reviewable, and removable."
      />
      <section className="metrics">
        <MetricCard
          icon={<Database />}
          label="Workspace memories"
          value="0"
          detail="Planned for v0.2"
        />
        <MetricCard
          icon={<LockKeyhole />}
          label="Retention"
          value="Off"
          detail="No silent long-term memory in alpha"
        />
        <MetricCard
          icon={<ShieldCheck />}
          label="Visibility"
          value="Admin review"
          detail="Every future memory has provenance"
        />
      </section>
      <Panel title="Alpha stance">
        <p className="muted">
          Bek stores auditable run events and approvals today. Durable memory
          should ship only after tenant isolation, redaction, retention
          controls, and per-place memory policy are in place.
        </p>
      </Panel>
    </div>
  );
}

export function AuditPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["bootstrap"],
    queryFn: fetchBootstrap,
  });

  if (isLoading) return <div className="state">Loading audit log...</div>;
  if (!data)
    return <div className="state error">Bek API is not reachable.</div>;

  return (
    <div className="page">
      <PageHeader
        eyebrow="Audit"
        title="Every policy decision and action should leave a trail."
      />
      <Panel>
        <EventTimeline events={data.events} />
      </Panel>
    </div>
  );
}

export function RunDetailPage() {
  const { runId } = useParams({ from: "/runs/$runId" });
  const { data, isLoading } = useQuery({
    queryKey: ["run", runId],
    queryFn: () => fetchRunDetail(runId),
  });

  if (isLoading) return <div className="state">Loading run...</div>;
  if (!data) return <div className="state error">Run not found.</div>;

  return (
    <div className="page">
      <PageHeader
        eyebrow="Run detail"
        title={data.run.prompt}
        actions={
          <Link to="/runs" className="secondary">
            <ArrowLeft size={16} aria-hidden="true" />
            Runs
          </Link>
        }
      />
      <section className="metrics">
        <MetricCard
          icon={<Clock />}
          label="Status"
          value={data.run.status.replaceAll("_", " ")}
          detail={formatDateTime(data.run.updatedAt)}
        />
        <MetricCard
          icon={<GitPullRequest />}
          label="Trigger"
          value={data.run.trigger}
          detail={data.run.runtimeProfileId}
        />
        <MetricCard
          icon={<KeyRound />}
          label="Cost"
          value={formatMoney(
            data.run.actualCostCents || data.run.estimatedCostCents,
          )}
          detail="estimated or actual"
        />
      </section>
      <section className="grid">
        <Panel title="Approvals">
          {data.approvals.length === 0 ? (
            <EmptyState
              title="No approval required"
              body="This run completed under channel policy."
            />
          ) : (
            <div className="bundle-list">
              {data.approvals.map((approval) => (
                <div className="bundle" key={approval.id}>
                  <strong>{approval.action}</strong>
                  <span>{approval.payloadHash}</span>
                  <StatusBadge value={approval.status} />
                </div>
              ))}
            </div>
          )}
        </Panel>
        <Panel title="Events">
          <EventTimeline events={data.events} />
        </Panel>
      </section>
    </div>
  );
}

export function RunsTable({
  data,
}: {
  data: Awaited<ReturnType<typeof fetchBootstrap>>;
}) {
  if (data.runs.length === 0) {
    return (
      <EmptyState
        title="No runs yet"
        body="Runs will appear here after Bek completes work."
      />
    );
  }
  return (
    <div className="table-scroll">
      <table>
        <caption className="sr-only">Bek runs</caption>
        <thead>
          <tr>
            <th scope="col">Run</th>
            <th scope="col">Place</th>
            <th scope="col">Status</th>
            <th scope="col">Cost</th>
            <th scope="col">Updated</th>
          </tr>
        </thead>
        <tbody>
          {data.runs.map((run) => (
            <tr key={run.id}>
              <td>
                <RunLink run={run} />
              </td>
              <td>{findRunPlace(data, run)?.name ?? run.placeScopeId}</td>
              <td>
                <StatusBadge value={run.status} />
              </td>
              <td>
                <CostCell run={run} />
              </td>
              <td>{formatDateTime(run.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EventTimeline({ events }: { events: RunEvent[] }) {
  if (events.length === 0) {
    return (
      <EmptyState
        title="No events"
        body="Bek has not recorded events for this scope yet."
      />
    );
  }
  return (
    <ol className="timeline">
      {events.map((event) => (
        <li key={event.id}>
          <StatusBadge value={event.type} />
          <span>{event.message}</span>
          <small>{formatDateTime(event.createdAt)}</small>
        </li>
      ))}
    </ol>
  );
}
