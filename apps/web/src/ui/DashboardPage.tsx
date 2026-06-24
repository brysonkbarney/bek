import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { ShieldCheck, Sparkles, Timer, WalletCards } from "lucide-react";
import { createRun, fetchBootstrap, type Run } from "../api";
import {
  CostCell,
  EmptyState,
  MetricCard,
  Panel,
  RunLink,
  StatusBadge,
} from "./components";
import { formatDateTime } from "./product-model";

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
  const { data, isLoading, error } = useQuery({
    queryKey: ["bootstrap"],
    queryFn: fetchBootstrap,
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

  if (isLoading) return <div className="state">Loading Bek...</div>;
  if (error || !data)
    return <div className="state error">Bek API is not reachable.</div>;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Open-source Claude Tag</p>
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

      <section className="grid">
        <article className="panel">
          <h2>Internal Capabilities</h2>
          <div className="chips">
            {data.capabilityProfiles.map((capability) => (
              <span className="chip" key={capability.id}>
                {capability.name}
              </span>
            ))}
          </div>
        </article>
        <article className="panel">
          <h2>Access Bundles</h2>
          <div className="bundle-list">
            {data.accessBundles.map((bundle) => (
              <div className="bundle" key={bundle.id}>
                <strong>{bundle.name}</strong>
                <span>{bundle.description}</span>
              </div>
            ))}
          </div>
        </article>
      </section>

      <Panel title="Recent Runs">
        {table.getRowModel().rows.length === 0 ? (
          <EmptyState
            title="No runs yet"
            body="Start the demo PR run to create the first auditable Bek run."
          />
        ) : (
          <div className="table-scroll">
            <table>
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
                      <td key={cell.id}>
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
