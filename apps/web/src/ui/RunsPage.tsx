import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef } from "react";
import { fetchBootstrap } from "../api";
import {
  CostCell,
  EmptyState,
  ErrorState,
  LoadingState,
  RunLink,
  StatusBadge,
} from "./components";
import { findRunPlace, formatDateTime } from "./product-model";

export function RunsPage() {
  const { data, isLoading, error, isFetching, refetch } = useQuery({
    queryKey: ["bootstrap"],
    queryFn: fetchBootstrap,
  });
  const parentRef = useRef<HTMLDivElement>(null);
  const runs = data?.runs ?? [];
  const virtualizer = useVirtualizer({
    count: runs.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 112,
  });

  if (isLoading) return <LoadingState label="Loading runs..." />;
  if (error || !data)
    return (
      <ErrorState
        message="Bek API is not reachable."
        onRetry={() => void refetch()}
        isRetrying={isFetching}
      />
    );

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Run Timeline</p>
          <h1>Every Bek action becomes an auditable run.</h1>
        </div>
      </header>
      {runs.length === 0 ? (
        <EmptyState
          title="No runs yet"
          body="Runs will appear here after a teammate asks Bek to do work."
        />
      ) : (
        <div
          className="virtual-list"
          ref={parentRef}
          role="list"
          aria-label="Bek runs timeline"
          tabIndex={0}
        >
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              position: "relative",
            }}
          >
            {virtualizer.getVirtualItems().map((item) => {
              const run = runs[item.index]!;
              const place = findRunPlace(data, run);
              const runPromptId = `run-prompt-${run.id}`;
              return (
                <article
                  className="run-row"
                  key={run.id}
                  role="listitem"
                  aria-labelledby={runPromptId}
                  style={{
                    transform: `translateY(${item.start}px)`,
                  }}
                >
                  <div className="run-row-header">
                    <RunLink run={run} />
                    <StatusBadge value={run.status} />
                  </div>
                  <span className="run-prompt" id={runPromptId}>
                    {run.prompt}
                  </span>
                  <div className="run-row-meta">
                    <small>{place?.name ?? run.placeScopeId}</small>
                    <small>
                      <CostCell run={run} />
                    </small>
                    <small>{formatDateTime(run.createdAt)}</small>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
