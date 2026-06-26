import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import {
  ArrowUp,
  Check,
  ChevronDown,
  Clock,
  Copy,
  Cpu,
  Download,
  ExternalLink,
  FileDiff,
  FileText,
  GitBranch,
  GitPullRequest,
  KeyRound,
  MapPin,
  PanelRight,
  Route,
  Sparkles,
  Terminal,
  User,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import {
  fetchBootstrap,
  fetchRunDetail,
  fetchRunTrace,
  type ApprovalRequest,
  type Bootstrap,
  type Run,
  type RunDetail,
  type RunEvent,
  type RunTrace,
} from "../api";
import { ErrorState, LoadingState, Spinner, StatusBadge } from "./components";
import { formatDuration, formatMoney } from "./product-model";

export function RunSessionView() {
  const { runId } = useParams({ from: "/runs/$runId" });
  const runQuery = useQuery({
    queryKey: ["run", runId],
    queryFn: () => fetchRunDetail(runId),
  });
  const bootstrapQuery = useQuery({
    queryKey: ["bootstrap"],
    queryFn: fetchBootstrap,
  });
  const traceQuery = useQuery({
    queryKey: ["run-trace", runId],
    queryFn: () => fetchRunTrace(runId),
  });

  if (runQuery.isLoading) {
    return <LoadingState label="Loading session..." />;
  }
  if (runQuery.error || !runQuery.data) {
    return (
      <ErrorState
        title="Session not found"
        message="This run could not be loaded. It may have been removed, or the link is stale."
        onRetry={() => void runQuery.refetch()}
        isRetrying={runQuery.isFetching}
      />
    );
  }

  return (
    <RunSession
      detail={runQuery.data}
      bootstrap={bootstrapQuery.data}
      trace={traceQuery.data}
      traceLoading={traceQuery.isLoading}
      traceError={Boolean(traceQuery.error)}
    />
  );
}

function RunSession({
  detail,
  bootstrap,
  trace,
  traceLoading,
  traceError,
}: {
  detail: RunDetail;
  bootstrap?: Bootstrap | undefined;
  trace?: RunTrace | undefined;
  traceLoading: boolean;
  traceError: boolean;
}) {
  const { run, events, approvals } = detail;
  const place = bootstrap?.places.find((p) => p.id === run.placeScopeId);
  const requester = bootstrap?.principals?.find(
    (p) => p.id === run.requesterPrincipalId,
  );
  const repo = parseRepoResource(run);
  const finalMessage = finalAnswer(events);
  const steps = events.filter((event) => event.type !== "run.created");

  return (
    <div className="session">
      <header className="session-bar">
        <div className="session-crumbs">
          <Link to="/runs" className="crumb crumb-root">
            {place?.name ?? "Sessions"}
          </Link>
          <span className="crumb-sep">/</span>
          <span className="crumb crumb-current">{shortTitle(run.prompt)}</span>
        </div>
        <div className="session-bar-actions">
          {repo ? (
            <span className="pr-chip">
              <GitPullRequest size={13} aria-hidden="true" />
              {repo.repo}
            </span>
          ) : null}
          <StatusBadge value={run.status} />
          <span className="session-cost">
            {formatMoney(run.actualCostCents || run.estimatedCostCents)}
          </span>
          <span className="session-bar-icon" aria-hidden="true">
            <PanelRight size={16} />
          </span>
        </div>
      </header>

      <div className="session-body">
        <div className="session-thread">
          <div className="thread-scroll">
            <UserMessage
              prompt={run.prompt}
              requester={requester?.displayName}
            />

            {approvals.map((approval) => (
              <ApprovalStep key={approval.id} approval={approval} />
            ))}

            {steps.length > 0 ? (
              <ol className="session-steps">
                {steps.map((event) => (
                  <TimelineStep key={event.id} event={event} />
                ))}
              </ol>
            ) : null}

            <TraceSection
              trace={trace}
              loading={traceLoading}
              error={traceError}
            />

            <ArtifactSection
              artifacts={collectArtifacts({
                run,
                events,
                trace,
                finalMessage,
                repo,
              })}
            />

            {repo ? <PullRequestCard run={run} repo={repo} /> : null}

            {finalMessage ? (
              <AgentMessage text={finalMessage} run={run} />
            ) : null}

            <div className="thread-status" role="status" aria-live="polite">
              {isTerminal(run.status) ? (
                <Sparkles size={15} aria-hidden="true" />
              ) : (
                <Spinner size={15} />
              )}
              <span>
                {isTerminal(run.status)
                  ? "Bek finished this run."
                  : "Bek is working on this run."}
              </span>
            </div>
          </div>

          <div className="composer" aria-hidden="true">
            <span className="composer-text">
              Follow-up instructions run through Slack or the API.
            </span>
            <span className="composer-send">
              <ArrowUp size={15} />
            </span>
          </div>
        </div>

        <ReportPane
          run={run}
          place={place?.name}
          requester={requester?.displayName}
          approvals={approvals}
          repo={repo}
        />
      </div>
    </div>
  );
}

function UserMessage({
  prompt,
  requester,
}: {
  prompt: string;
  requester?: string | undefined;
}) {
  return (
    <div className="msg msg-user">
      <div className="msg-bubble">{prompt}</div>
      <div className="msg-avatar" title={requester ?? "Requester"}>
        {(requester ?? "U").slice(0, 1).toUpperCase()}
      </div>
    </div>
  );
}

function AgentMessage({ text, run }: { text: string; run: Run }) {
  return (
    <div className="msg msg-agent">
      <div className="agent-head">
        <span className="agent-mark" aria-hidden="true">
          B
        </span>
        <span className="agent-name">Bek</span>
      </div>
      <div className="agent-body">
        <p className="agent-text">{text}</p>
        <span className="attachment-chip">
          <FileText size={14} aria-hidden="true" />
          run_{run.id.slice(-8)}_report.md
        </span>
      </div>
    </div>
  );
}

function ApprovalStep({ approval }: { approval: ApprovalRequest }) {
  const decided = approval.status !== "pending";
  return (
    <div className={`approval-step approval-${approval.status}`}>
      <KeyRound size={15} aria-hidden="true" />
      <div>
        <strong>Approval · {approval.action.replaceAll("_", " ")}</strong>
        <span className="approval-hash">
          {approval.payloadHash.slice(0, 24)}…
        </span>
      </div>
      <StatusBadge value={approval.status} />
      {decided ? null : (
        <span className="muted approval-hint">awaiting human decision</span>
      )}
    </div>
  );
}

function TraceSection({
  trace,
  loading,
  error,
}: {
  trace: RunTrace | undefined;
  loading: boolean;
  error: boolean;
}) {
  if (loading) {
    return (
      <section className="trace-section" aria-label="Run trace">
        <h4 className="trace-heading">Trace</h4>
        <p className="muted">Loading trace…</p>
      </section>
    );
  }
  if (error || !trace) {
    return (
      <section className="trace-section" aria-label="Run trace">
        <h4 className="trace-heading">Trace</h4>
        <p className="muted">Trace is not available for this run.</p>
      </section>
    );
  }

  const isEmpty =
    trace.phases.length === 0 &&
    trace.toolCalls.length === 0 &&
    trace.approvals.length === 0;

  return (
    <section className="trace-section" aria-label="Run trace">
      <div className="trace-head">
        <h4 className="trace-heading">Trace</h4>
        <span className="trace-summary muted">
          {trace.eventCount} event{trace.eventCount === 1 ? "" : "s"}
          {trace.durationMs !== undefined
            ? ` · ${formatDuration(trace.durationMs)}`
            : ""}
          {" · "}
          {trace.finalStatus.replaceAll("_", " ")}
        </span>
      </div>

      {isEmpty ? (
        <p className="muted">No trace steps were recorded for this run.</p>
      ) : null}

      {trace.phases.length > 0 ? (
        <div className="trace-group">
          <span className="trace-group-label">Phases</span>
          <ol className="trace-list">
            {trace.phases.map((phase, index) => (
              <li className="trace-row" key={`phase-${index}-${phase.type}`}>
                <StatusBadge value={phase.status} />
                <span className="trace-row-copy">
                  <span>{phase.type.replaceAll("_", " ")}</span>
                  {phase.message ? <small>{phase.message}</small> : null}
                </span>
                <span className="trace-row-time">
                  {formatDuration(phase.durationMs)}
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {trace.toolCalls.length > 0 ? (
        <div className="trace-group">
          <span className="trace-group-label">Tool calls</span>
          <ol className="trace-list">
            {trace.toolCalls.map((tool, index) => (
              <li
                className="trace-row"
                key={`tool-${index}-${tool.name ?? ""}`}
              >
                <StatusBadge value={tool.status} />
                <span className="trace-row-copy">
                  <span>{tool.name ?? "tool"}</span>
                  {tool.message ? <small>{tool.message}</small> : null}
                </span>
                <span className="trace-row-time">
                  {formatDuration(tool.durationMs)}
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {trace.approvals.length > 0 ? (
        <div className="trace-group">
          <span className="trace-group-label">Approvals</span>
          <ol className="trace-list">
            {trace.approvals.map((approval, index) => (
              <li
                className="trace-row"
                key={`approval-${index}-${approval.decision}`}
              >
                <StatusBadge value={approval.decision} />
                <span className="trace-row-copy">
                  <span>{approval.decision.replaceAll("_", " ")}</span>
                  {approval.message ? <small>{approval.message}</small> : null}
                </span>
                <span className="trace-row-time">
                  {approval.at ? shortTime(approval.at) : ""}
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}

type Artifact =
  | { kind: "report"; label: string; text: string }
  | { kind: "diff"; label: string; text: string }
  | {
      kind: "pr";
      label: string;
      title: string;
      repo: string;
      branch: string;
      baseBranch: string;
      status: string;
      open: boolean;
    }
  | { kind: "log"; label: string; lines: string[] };

const ARTIFACT_TAB_META: Record<
  Artifact["kind"],
  { label: string; icon: typeof FileText }
> = {
  report: { label: "Report", icon: FileText },
  diff: { label: "Diff", icon: FileDiff },
  pr: { label: "Pull request", icon: GitPullRequest },
  log: { label: "Command log", icon: Terminal },
};

/**
 * Builds the artifact list strictly from data already present on the run detail
 * and trace. Nothing is fabricated: a markdown report only appears when there is
 * a final answer, a diff/log only when matching text is found on event data or
 * tool calls, and a PR card only when the run resolves to a repository resource.
 */
function collectArtifacts(input: {
  run: Run;
  events: RunEvent[];
  trace: RunTrace | undefined;
  finalMessage: string | null;
  repo: RepoRef | null;
}): Artifact[] {
  const { run, events, trace, finalMessage, repo } = input;
  const artifacts: Artifact[] = [];

  if (finalMessage && finalMessage.trim().length > 0) {
    artifacts.push({
      kind: "report",
      label: `run_${run.id.slice(-8)}_report.md`,
      text: finalMessage,
    });
  }

  const diffText = findDiffText(events);
  if (diffText) {
    artifacts.push({ kind: "diff", label: "Unified diff", text: diffText });
  }

  if (repo) {
    artifacts.push({
      kind: "pr",
      label: "Pull request",
      title: shortTitle(run.prompt),
      repo: repo.number ? `${repo.repo} #${repo.number}` : repo.repo,
      branch: `bek/${run.id.slice(-12)}`,
      baseBranch: "main",
      status: run.status.replaceAll("_", " "),
      open: isTerminal(run.status),
    });
  }

  const logLines = collectCommandLog(events, trace);
  if (logLines.length > 0) {
    artifacts.push({ kind: "log", label: "Command log", lines: logLines });
  }

  return artifacts;
}

const DIFF_DATA_KEYS = ["diff", "patch", "unifiedDiff", "fileDiff"];

function findDiffText(events: RunEvent[]): string | null {
  for (const event of events) {
    const data = event.data;
    if (!data) continue;
    for (const key of DIFF_DATA_KEYS) {
      const value = data[key];
      if (typeof value === "string" && looksLikeDiff(value)) {
        return value;
      }
    }
  }
  return null;
}

function looksLikeDiff(value: string): boolean {
  return /^(diff --git |--- |\+\+\+ |@@ )/m.test(value);
}

const LOG_DATA_KEYS = ["stdout", "output", "log", "logs", "command", "stderr"];

function collectCommandLog(
  events: RunEvent[],
  trace: RunTrace | undefined,
): string[] {
  const lines: string[] = [];
  for (const event of events) {
    const data = event.data;
    if (!data) continue;
    for (const key of LOG_DATA_KEYS) {
      const value = data[key];
      if (typeof value === "string" && value.trim().length > 0) {
        const prefix = key === "command" ? "$ " : "";
        for (const line of value.split("\n")) {
          lines.push(`${prefix}${line}`);
        }
      }
    }
  }
  if (lines.length === 0 && trace) {
    for (const tool of trace.toolCalls) {
      const name = tool.name ?? "tool";
      const status = tool.status;
      const detail = tool.message ? ` — ${tool.message}` : "";
      lines.push(`[${status}] ${name}${detail}`);
    }
  }
  return lines;
}

function ArtifactSection({ artifacts }: { artifacts: Artifact[] }) {
  const [activeKind, setActiveKind] = useState<Artifact["kind"] | undefined>(
    artifacts[0]?.kind,
  );

  const first = artifacts[0];
  if (!first) {
    return (
      <section className="artifact-section" aria-label="Run artifacts">
        <h4 className="trace-heading">Artifacts</h4>
        <p className="muted">No artifacts were produced for this run.</p>
      </section>
    );
  }

  const active =
    artifacts.find((artifact) => artifact.kind === activeKind) ?? first;

  return (
    <section className="artifact-section" aria-label="Run artifacts">
      <div className="trace-head">
        <h4 className="trace-heading">Artifacts</h4>
        <span className="trace-summary muted">
          {artifacts.length} artifact{artifacts.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="artifact-tabs" role="tablist" aria-label="Run artifacts">
        {artifacts.map((artifact) => {
          const meta = ARTIFACT_TAB_META[artifact.kind];
          const Icon = meta.icon;
          const selected = artifact.kind === active.kind;
          return (
            <button
              type="button"
              role="tab"
              id={`artifact-tab-${artifact.kind}`}
              aria-selected={selected}
              aria-controls="artifact-panel"
              tabIndex={selected ? 0 : -1}
              className={`artifact-tab ${selected ? "active" : ""}`}
              key={artifact.kind}
              onClick={() => setActiveKind(artifact.kind)}
            >
              <Icon size={14} aria-hidden="true" />
              {meta.label}
            </button>
          );
        })}
      </div>
      <div className="artifact-body" role="tabpanel" id="artifact-panel">
        <ArtifactView artifact={active} />
      </div>
    </section>
  );
}

function ArtifactView({ artifact }: { artifact: Artifact }) {
  if (artifact.kind === "report") {
    return <MarkdownReport text={artifact.text} />;
  }
  if (artifact.kind === "diff") {
    return <DiffView text={artifact.text} />;
  }
  if (artifact.kind === "log") {
    return (
      <pre className="artifact-log" aria-label={artifact.label}>
        {artifact.lines.join("\n")}
      </pre>
    );
  }
  return (
    <article className="artifact-pr">
      <div className="artifact-pr-head">
        <span className={`pr-status ${artifact.open ? "open" : "pending"}`}>
          <GitPullRequest size={13} aria-hidden="true" />
          {artifact.status}
        </span>
        <span className="pr-repo">{artifact.repo}</span>
      </div>
      <h3 className="pr-title">{artifact.title}</h3>
      <div className="pr-meta">
        <span className="branch-chip">{artifact.branch}</span>
        <span className="pr-arrow">→ {artifact.baseBranch}</span>
      </div>
    </article>
  );
}

/**
 * Lightweight markdown rendering with no new dependency: handles headings, bold,
 * inline code, and unordered list items, falling back to plain paragraphs. This
 * is intentionally minimal — enough to make a report legible, not a full parser.
 */
function MarkdownReport({ text }: { text: string }) {
  const blocks = renderMarkdownBlocks(text);
  return <div className="artifact-markdown">{blocks}</div>;
}

function renderMarkdownBlocks(text: string): ReactNode[] {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let listItems: string[] = [];
  let key = 0;

  const flushList = () => {
    if (listItems.length === 0) return;
    const items = listItems;
    listItems = [];
    blocks.push(
      <ul key={`list-${key++}`}>
        {items.map((item, index) => (
          <li key={index}>{renderInline(item)}</li>
        ))}
      </ul>,
    );
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const listItem = /^[-*]\s+(.*)$/.exec(line);
    if (heading) {
      flushList();
      const level = Math.min(heading[1]?.length ?? 1, 6);
      const Tag = `h${level + 2 <= 6 ? level + 2 : 6}` as
        | "h3"
        | "h4"
        | "h5"
        | "h6";
      blocks.push(
        <Tag key={`h-${key++}`}>{renderInline(heading[2] ?? "")}</Tag>,
      );
    } else if (listItem) {
      listItems.push(listItem[1] ?? "");
    } else if (line.trim().length === 0) {
      flushList();
    } else {
      flushList();
      blocks.push(<p key={`p-${key++}`}>{renderInline(line)}</p>);
    }
  }
  flushList();
  return blocks;
}

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith("**")) {
      nodes.push(<strong key={`b-${key++}`}>{token.slice(2, -2)}</strong>);
    } else {
      nodes.push(<code key={`c-${key++}`}>{token.slice(1, -1)}</code>);
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}

function DiffView({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <pre className="artifact-diff" aria-label="Unified diff">
      {lines.map((line, index) => (
        <span className={`diff-line ${diffLineTone(line)}`} key={index}>
          {line === "" ? " " : line}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

function diffLineTone(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "diff-meta";
  if (line.startsWith("@@")) return "diff-hunk";
  if (line.startsWith("+")) return "diff-add";
  if (line.startsWith("-")) return "diff-remove";
  return "";
}

function TimelineStep({ event }: { event: RunEvent }) {
  const [open, setOpen] = useState(false);
  const hasData = event.data && Object.keys(event.data).length > 0;
  const Icon = stepIcon(event.type);
  return (
    <li className="session-step">
      <button
        type="button"
        className="step-row"
        onClick={() => hasData && setOpen((value) => !value)}
        aria-expanded={hasData ? open : undefined}
        data-static={hasData ? undefined : "true"}
      >
        {hasData ? (
          <ChevronDown
            size={14}
            className={`step-caret ${open ? "open" : ""}`}
            aria-hidden="true"
          />
        ) : (
          <span className="step-caret-spacer" aria-hidden="true" />
        )}
        <span className="step-icon" aria-hidden="true">
          <Icon size={14} />
        </span>
        <span className="step-message">{event.message}</span>
        <time className="step-time">{shortTime(event.createdAt)}</time>
      </button>
      {hasData && open ? (
        <pre className="step-data">{JSON.stringify(event.data, null, 2)}</pre>
      ) : null}
    </li>
  );
}

function PullRequestCard({ run, repo }: { run: Run; repo: RepoRef }) {
  const open = !isTerminal(run.status) ? "Awaiting approval" : "Open";
  const branch = `bek/${run.id.slice(-12)}`;
  return (
    <article className="pr-card">
      <div className="pr-card-head">
        <span
          className={`pr-status ${isTerminal(run.status) ? "open" : "pending"}`}
        >
          <GitPullRequest size={13} aria-hidden="true" />
          {open}
        </span>
        <span className="pr-repo">
          {repo.repo}
          {repo.number ? ` #${repo.number}` : ""}
        </span>
        <span className="pr-card-actions" aria-hidden="true">
          <GitBranch size={14} />
          <ExternalLink size={14} />
        </span>
      </div>
      <h3 className="pr-title">{shortTitle(run.prompt)}</h3>
      <div className="pr-meta">
        <span className="branch-chip">
          {branch}
          <Copy size={12} aria-hidden="true" />
        </span>
        <span className="pr-arrow">→ main</span>
        <span className="pr-stat">{repo.scope}</span>
      </div>
    </article>
  );
}

function ReportPane({
  run,
  place,
  requester,
  approvals,
  repo,
}: {
  run: Run;
  place?: string | undefined;
  requester?: string | undefined;
  approvals: ApprovalRequest[];
  repo: RepoRef | null;
}) {
  return (
    <aside className="session-report" aria-label="Run report">
      <header className="report-head">
        <span className="report-file">
          <FileText size={14} aria-hidden="true" />
          run_{run.id.slice(-8)}_report.md
        </span>
        <span className="report-head-actions" aria-hidden="true">
          <Copy size={14} />
          <Download size={14} />
        </span>
      </header>
      <div className="report-body">
        <h2 className="report-title">Run report</h2>
        <p className="report-prompt">{run.prompt}</p>

        <dl className="report-facts">
          <ReportFact icon={<Clock size={14} />} label="Status">
            <StatusBadge value={run.status} />
          </ReportFact>
          <ReportFact icon={<Route size={14} />} label="Trigger">
            {run.trigger}
          </ReportFact>
          <ReportFact icon={<Cpu size={14} />} label="Runtime">
            {run.runtimeProfileId}
          </ReportFact>
          <ReportFact icon={<KeyRound size={14} />} label="Cost">
            {formatMoney(run.actualCostCents || run.estimatedCostCents)}
            {run.actualCostCents === 0 ? (
              <span className="muted"> est.</span>
            ) : null}
          </ReportFact>
          {place ? (
            <ReportFact icon={<MapPin size={14} />} label="Place">
              {place}
            </ReportFact>
          ) : null}
          {requester ? (
            <ReportFact icon={<User size={14} />} label="Requester">
              {requester}
            </ReportFact>
          ) : null}
        </dl>

        {repo ? (
          <section className="report-section">
            <h4>Repository</h4>
            <p className="report-mono">{repo.repo}</p>
            <p className="muted report-note">
              Bek opens a hash-bound draft PR only after approval.
            </p>
          </section>
        ) : null}

        <section className="report-section">
          <h4>Approvals</h4>
          {approvals.length === 0 ? (
            <p className="muted">
              No approval required — this run stayed within channel policy.
            </p>
          ) : (
            <ul className="report-approvals">
              {approvals.map((approval) => (
                <li key={approval.id}>
                  <div className="report-approval-head">
                    <span>{approval.action.replaceAll("_", " ")}</span>
                    <StatusBadge value={approval.status} />
                  </div>
                  <code className="report-hash">{approval.payloadHash}</code>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </aside>
  );
}

function ReportFact({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="report-fact">
      <dt>
        <span className="report-fact-icon" aria-hidden="true">
          {icon}
        </span>
        {label}
      </dt>
      <dd>{children}</dd>
    </div>
  );
}

interface RepoRef {
  repo: string;
  number?: number | undefined;
  scope: string;
}

function parseRepoResource(run: Run): RepoRef | null {
  const resource = (run as Run & { resource?: string }).resource;
  const capability = (run as Run & { capability?: string }).capability;
  const source = resource ?? "";
  if (!source.startsWith("github:") && !capability?.startsWith("github")) {
    return null;
  }
  const repo = source.startsWith("github:")
    ? source.slice("github:".length)
    : "repository";
  return { repo, scope: "draft pull request" };
}

function finalAnswer(events: RunEvent[]): string | null {
  const terminal = [...events]
    .reverse()
    .find(
      (event) =>
        event.type.endsWith("completed") || event.type === "run.completed",
    );
  return terminal?.message ?? null;
}

function isTerminal(status: string): boolean {
  return ["completed", "failed", "cancelled"].includes(status);
}

function shortTitle(prompt: string): string {
  const trimmed = prompt.replace(/^@bek\s+/i, "").trim();
  return trimmed.length > 70 ? `${trimmed.slice(0, 67)}…` : trimmed;
}

function shortTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function stepIcon(type: string) {
  if (type.includes("model")) return Cpu;
  if (type.includes("tool")) return Sparkles;
  if (type.includes("approval") || type.includes("approved")) return KeyRound;
  if (type.includes("runtime") || type.includes("completed")) return Check;
  return Clock;
}
