import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { Link } from "@tanstack/react-router";
import {
  Coins,
  Compass,
  ExternalLink,
  ShieldCheck,
  Sparkles,
  Timer,
  WalletCards,
} from "lucide-react";
import {
  createRun,
  fetchBootstrap,
  fetchModelUsage,
  fetchSetupStatus,
  type ModelUsage,
  type Run,
} from "../api";
import {
  CostCell,
  EmptyState,
  ErrorState,
  InlineLoading,
  LoadingState,
  MetricCard,
  Panel,
  RunLink,
  StatusBadge,
  SuccessCallout,
  WarningCallout,
} from "./components";
import {
  formatDateTime,
  formatMoney,
  guidedSetupComplete,
  guidedSetupProgress,
  guidedSetupSteps,
} from "./product-model";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat().format(value);
}

const columnHelper = createColumnHelper<Run>();

const columns = [
  columnHelper.accessor("id", {
    header: "Run",
    cell: (info) => <RunLink run={info.row.original} />,
  }),
  columnHelper.accessor("prompt", {
    header: "Prompt",
    cell: (info) => (
      <span className="truncate" title={info.getValue()}>
        {info.getValue()}
      </span>
    ),
  }),
  columnHelper.accessor("status", {
    header: "Status",
    cell: (info) => <StatusBadge value={info.getValue()} />,
  }),
  columnHelper.display({
    id: "cost",
    header: "Cost",
    cell: (info) => <CostCell run={info.row.original} />,
  }),
  columnHelper.accessor("updatedAt", {
    header: "Updated",
    cell: (info) => formatDateTime(info.getValue()),
  }),
];

export function DashboardPage() {
  const queryClient = useQueryClient();
  const { data, isLoading, error, isFetching, refetch } = useQuery({
    queryKey: ["bootstrap"],
    queryFn: fetchBootstrap,
  });
  const usageQuery = useQuery({
    queryKey: ["model-usage"],
    queryFn: fetchModelUsage,
  });
  const setupStatusQuery = useQuery({
    queryKey: ["setupStatus"],
    queryFn: fetchSetupStatus,
  });
  const runMutation = useMutation({
    mutationFn: createRun,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["bootstrap"] }),
  });

  const table = useReactTable({
    data: data?.runs ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  if (isLoading) return <LoadingState label="Loading Bek..." />;
  if (error || !data)
    return (
      <ErrorState
        message="Bek API is not reachable."
        onRetry={() => void refetch()}
        isRetrying={isFetching}
      />
    );

  // Surface the guided wizard prominently while setup is incomplete, so a
  // first-run operator discovers it without hunting. Derived from live data; the
  // banner disappears the moment every required step is configured.
  const setupStatus = setupStatusQuery.data;
  const showSetupBanner = Boolean(
    setupStatus && !guidedSetupComplete(data, setupStatus),
  );
  const setupProgress = setupStatus
    ? guidedSetupProgress(guidedSetupSteps(data, setupStatus))
    : undefined;

  return (
    <div className="page">
      {showSetupBanner && setupProgress ? (
        <Link
          to="/setup/guided"
          className="setup-cta"
          aria-label="Open guided setup to finish configuring your Bek teammate"
        >
          <span className="setup-cta-icon" aria-hidden="true">
            <Compass size={22} />
          </span>
          <span className="setup-cta-body">
            <strong>Finish setting up {data.agent.handle}</strong>
            <span className="muted">
              {setupProgress.complete} of {setupProgress.total} steps ready —
              open the guided setup to bring your teammate fully online.
            </span>
          </span>
          <span className="setup-cta-action">
            Open guided setup
            <ExternalLink size={15} aria-hidden="true" />
          </span>
        </Link>
      ) : null}
      <header className="page-header">
        <div>
          <p className="eyebrow">Overview</p>
          <h1>
            {data.agent.handle} is one teammate with governed capabilities.
          </h1>
        </div>
        <button
          className="primary"
          disabled={runMutation.isPending}
          aria-busy={runMutation.isPending}
          onClick={() =>
            runMutation.mutate({
              prompt:
                "@bek inspect checkout retries and open a PR if you find the fix",
              placeScopeId: "place_checkout",
              capability: "github.pr",
              resource: "github:redohq/checkout",
            })
          }
        >
          <Sparkles size={17} aria-hidden="true" />
          {runMutation.isPending ? "Starting..." : "Demo PR Run"}
        </button>
      </header>
      {runMutation.isError ? (
        <WarningCallout>
          {errorMessage(runMutation.error, "Bek could not start that run.")}
        </WarningCallout>
      ) : null}
      {runMutation.isSuccess ? (
        <SuccessCallout>Demo run started.</SuccessCallout>
      ) : null}

      <section className="metrics">
        <MetricCard
          icon={<ShieldCheck />}
          label="Visible Handle"
          value={data.agent.handle}
        />
        <MetricCard
          icon={<Timer />}
          label="Runs"
          value={String(data.runs.length)}
        />
        <MetricCard
          icon={<WalletCards />}
          label="Open Approvals"
          value={String(
            data.approvals.filter((a) => a.status === "pending").length,
          )}
        />
      </section>

      <UsageCostPanel
        usage={usageQuery.data}
        isLoading={usageQuery.isLoading}
        isError={usageQuery.isError}
      />

      <section className="grid">
        <Panel title="Internal Capabilities">
          {data.capabilityProfiles.length === 0 ? (
            <EmptyState
              title="No capabilities yet"
              body="Capability profiles appear here once configured."
            />
          ) : (
            <div className="chips">
              {data.capabilityProfiles.map((capability) => (
                <span className="chip" key={capability.id}>
                  {capability.name}
                </span>
              ))}
            </div>
          )}
        </Panel>
        <Panel title="Access Bundles">
          {data.accessBundles.length === 0 ? (
            <EmptyState
              title="No access bundles"
              body="Create a bundle to govern what Bek can do in each place."
              action={
                <Link to="/access-bundles" className="secondary">
                  Open access
                  <ExternalLink size={14} aria-hidden="true" />
                </Link>
              }
            />
          ) : (
            <div className="bundle-list">
              {data.accessBundles.map((bundle) => (
                <div className="bundle" key={bundle.id}>
                  <strong>{bundle.name}</strong>
                  <span>{bundle.description}</span>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </section>

      <Panel title="Recent Runs">
        {table.getRowModel().rows.length === 0 ? (
          <EmptyState
            title="No runs yet"
            body="Start the demo PR run to create the first auditable Bek run."
          />
        ) : (
          <div className="table-scroll">
            <table className="responsive-table">
              <caption className="sr-only">Recent Bek runs</caption>
              <thead>
                {table.getHeaderGroups().map((headerGroup) => (
                  <tr key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      <th key={header.id} scope="col">
                        {flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )}
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody>
                {table.getRowModel().rows.map((row) => (
                  <tr key={row.id}>
                    {row.getVisibleCells().map((cell) => (
                      <td
                        key={cell.id}
                        data-label={
                          typeof cell.column.columnDef.header === "string"
                            ? cell.column.columnDef.header
                            : cell.column.id
                        }
                      >
                        {flexRender(
                          cell.column.columnDef.cell,
                          cell.getContext(),
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

function UsageCostPanel({
  usage,
  isLoading,
  isError,
}: {
  usage: ModelUsage | undefined;
  isLoading: boolean;
  isError: boolean;
}) {
  if (isLoading) {
    return (
      <Panel title="Usage / Cost">
        <InlineLoading label="Loading usage..." />
      </Panel>
    );
  }

  if (isError || !usage) {
    return (
      <Panel title="Usage / Cost">
        <EmptyState
          title="Usage totals are unavailable"
          body="Bek could not load model usage. Refresh once the API is reachable."
        />
      </Panel>
    );
  }

  const localTotalCents =
    usage.totalActualCents > 0
      ? usage.totalActualCents
      : usage.totalEstimatedCents;
  const sourceLabel =
    usage.trust?.durability === "durable_ledger"
      ? "Durable ledger"
      : usage.trust?.durability === "run_fallback"
        ? "Run fallback"
        : `Source: ${usage.source}`;
  const costWarning =
    usage.trust?.warnings.find((warning) => warning.includes("Costs")) ??
    "Unreconciled local estimate, not provider-billed spend.";

  return (
    <Panel
      title="Usage / Cost"
      action={<span className="chip">{sourceLabel}</span>}
    >
      <div className="usage-card">
        <div className="usage-total">
          <Coins size={22} aria-hidden="true" />
          <div>
            <span>Local estimate total</span>
            <strong>{formatMoney(localTotalCents)}</strong>
            <small>
              Run estimate {formatMoney(usage.totalEstimatedCents)}; local
              actual estimate {formatMoney(usage.totalActualCents)}
            </small>
            <small>{costWarning}</small>
          </div>
        </div>
        <div className="usage-stats" aria-label="Model usage totals">
          <div>
            <span>Runs</span>
            <strong>{formatInteger(usage.runs)}</strong>
          </div>
          <div>
            <span>Model calls</span>
            <strong>{formatInteger(usage.modelCalls)}</strong>
          </div>
          <div>
            <span>Total tokens</span>
            <strong>{formatInteger(usage.totalTokens)}</strong>
          </div>
        </div>
      </div>
    </Panel>
  );
}
