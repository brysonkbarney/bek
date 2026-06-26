import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ExternalLink,
  PartyPopper,
  Sparkles,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createRun, fetchBootstrap, fetchSetupStatus, type Run } from "../api";
import {
  ErrorState,
  LoadingState,
  PageHeader,
  Panel,
  RunLink,
  StatusBadge,
  SuccessCallout,
  WarningCallout,
} from "./components";
import {
  guidedSetupComplete,
  guidedSetupProgress,
  guidedSetupSteps,
  guidedSmokePlace,
  type GuidedSetupStep,
} from "./product-model";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

const SMOKE_PROMPT = "@bek what can you access here?";

export function GuidedSetupPage() {
  const queryClient = useQueryClient();
  const { data, isLoading, error, isFetching, refetch } = useQuery({
    queryKey: ["bootstrap"],
    queryFn: fetchBootstrap,
  });
  const {
    data: setupStatus,
    isLoading: isSetupLoading,
    error: setupError,
    isFetching: isSetupFetching,
    refetch: refetchSetup,
  } = useQuery({
    queryKey: ["setupStatus"],
    queryFn: fetchSetupStatus,
  });

  // The active step the wizard is focused on. Kept as an index so step nav and
  // focus management have a single source of truth.
  const [activeIndex, setActiveIndex] = useState(0);
  const [smokeRun, setSmokeRun] = useState<Run | undefined>(undefined);
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);
  // Move focus to the active step heading after navigation so keyboard and
  // screen-reader users follow along. Skip the very first render.
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    stepHeadingRef.current?.focus();
  }, [activeIndex]);

  const smokeMutation = useMutation({
    mutationFn: createRun,
    onSuccess: (run) => {
      setSmokeRun(run);
      void queryClient.invalidateQueries({ queryKey: ["bootstrap"] });
    },
  });

  const steps = useMemo<GuidedSetupStep[]>(() => {
    if (!data || !setupStatus) return [];
    return guidedSetupSteps(data, setupStatus, {
      smokeComplete: smokeMutation.isSuccess,
    });
  }, [data, setupStatus, smokeMutation.isSuccess]);

  if (isLoading || isSetupLoading)
    return <LoadingState label="Loading guided setup..." />;
  if (error || setupError || !data || !setupStatus)
    return (
      <ErrorState
        title="Guided setup is unavailable"
        message="Bek API is not reachable."
        onRetry={() => {
          void refetch();
          void refetchSetup();
        }}
        isRetrying={isFetching || isSetupFetching}
      />
    );

  const progress = guidedSetupProgress(steps);
  const setupComplete = guidedSetupComplete(data, setupStatus);
  const smokePlace = guidedSmokePlace(data);
  const boundedIndex = Math.min(activeIndex, steps.length - 1);
  const activeStep = steps[boundedIndex];

  // Already finished: recede to a calm compact summary, never nag.
  if (setupComplete) {
    return (
      <CompleteSummary
        steps={steps}
        smokeRun={smokeRun}
        agentHandle={data.agent.handle}
      />
    );
  }

  if (!activeStep) {
    return (
      <ErrorState
        title="Guided setup is unavailable"
        message="No setup steps could be derived."
      />
    );
  }

  const isSmokeStep = activeStep.id === "smoke";
  const canRunSmoke = Boolean(smokePlace) && !smokeMutation.isPending;

  return (
    <div className="page">
      <PageHeader
        eyebrow="Guided setup"
        title="Bring your Bek teammate online in seven steps."
        description="Each step reads live workspace data, so it always reflects what is really configured. Finish them in order, or jump to whatever still needs action."
        actions={
          <Link to="/setup" className="secondary">
            Skip to checklist
            <ExternalLink size={14} aria-hidden="true" />
          </Link>
        }
      />

      <ProgressIndicator
        activeIndex={boundedIndex}
        steps={steps}
        completeCount={progress.complete}
        total={progress.total}
        onSelect={setActiveIndex}
      />

      <div className="guided-layout">
        <Panel title="Steps">
          <ol className="guided-step-rail" aria-label="Guided setup steps">
            {steps.map((step, index) => {
              const isActive = index === boundedIndex;
              return (
                <li key={step.id}>
                  <button
                    type="button"
                    className={`guided-rail-item${isActive ? " active" : ""}${
                      step.complete ? " done" : ""
                    }`}
                    aria-current={isActive ? "step" : undefined}
                    onClick={() => setActiveIndex(index)}
                  >
                    <span className="guided-rail-marker" aria-hidden="true">
                      {step.complete ? <Check size={13} /> : index + 1}
                    </span>
                    <span className="guided-rail-title">{step.title}</span>
                    <StatusBadge
                      value={step.complete ? "ready" : step.status}
                    />
                  </button>
                </li>
              );
            })}
          </ol>
        </Panel>

        <Panel
          title={`Step ${boundedIndex + 1} of ${steps.length}`}
          action={
            <StatusBadge
              value={activeStep.complete ? "ready" : activeStep.status}
            />
          }
        >
          <div className="guided-step-detail">
            <h3
              className="guided-step-heading"
              ref={stepHeadingRef}
              tabIndex={-1}
            >
              {activeStep.title}
            </h3>
            <p className="muted">{activeStep.explanation}</p>
            <p className="guided-step-status-line">{activeStep.detail}</p>

            {isSmokeStep ? (
              <SmokeStep
                place={smokePlace}
                run={smokeRun}
                isPending={smokeMutation.isPending}
                isError={smokeMutation.isError}
                error={smokeMutation.error}
                canRun={canRunSmoke}
                onRun={() => {
                  if (!smokePlace) return;
                  smokeMutation.mutate({
                    prompt: SMOKE_PROMPT,
                    placeScopeId: smokePlace.id,
                  });
                }}
              />
            ) : activeStep.action ? (
              <div className="row-actions">
                <Link to={activeStep.action.route} className="primary">
                  {activeStep.action.label}
                  <ExternalLink size={14} aria-hidden="true" />
                </Link>
              </div>
            ) : null}
          </div>

          <div className="guided-step-nav">
            <button
              type="button"
              className="secondary"
              disabled={boundedIndex === 0}
              onClick={() => setActiveIndex((index) => Math.max(0, index - 1))}
            >
              <ArrowLeft size={15} aria-hidden="true" />
              Previous
            </button>
            <button
              type="button"
              className="secondary"
              disabled={boundedIndex >= steps.length - 1}
              onClick={() =>
                setActiveIndex((index) => Math.min(steps.length - 1, index + 1))
              }
            >
              Next
              <ArrowRight size={15} aria-hidden="true" />
            </button>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function ProgressIndicator({
  activeIndex,
  steps,
  completeCount,
  total,
  onSelect,
}: {
  activeIndex: number;
  steps: GuidedSetupStep[];
  completeCount: number;
  total: number;
  onSelect: (index: number) => void;
}) {
  const percent = total > 0 ? Math.round((completeCount / total) * 100) : 0;
  return (
    <section className="guided-progress" aria-label="Setup progress">
      <div className="guided-progress-head">
        <strong>
          Step {activeIndex + 1} of {total}
        </strong>
        <span className="muted">{completeCount} ready</span>
      </div>
      <div
        className="guided-progress-track"
        role="progressbar"
        aria-valuenow={completeCount}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-label={`${completeCount} of ${total} setup steps complete`}
      >
        <div
          className="guided-progress-fill"
          style={{ width: `${percent}%` }}
        />
      </div>
      <ol className="guided-progress-dots">
        {steps.map((step, index) => (
          <li key={step.id}>
            <button
              type="button"
              className={`guided-dot${index === activeIndex ? " active" : ""}${
                step.complete ? " done" : ""
              }`}
              aria-current={index === activeIndex ? "step" : undefined}
              aria-label={`Step ${index + 1}: ${step.title} (${
                step.complete ? "ready" : step.status
              })`}
              onClick={() => onSelect(index)}
            >
              {step.complete ? (
                <Check size={12} aria-hidden="true" />
              ) : (
                index + 1
              )}
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

function SmokeStep({
  place,
  run,
  isPending,
  isError,
  error,
  canRun,
  onRun,
}: {
  place: ReturnType<typeof guidedSmokePlace>;
  run: Run | undefined;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  canRun: boolean;
  onRun: () => void;
}) {
  if (!place) {
    return (
      <WarningCallout>
        Add a pilot channel before running the smoke prompt — the run needs a
        place to execute in.
      </WarningCallout>
    );
  }

  return (
    <div className="guided-smoke">
      <div className="guided-smoke-prompt">
        <span className="muted">Smoke prompt</span>
        <code>{SMOKE_PROMPT}</code>
        <small className="muted">
          Runs in {place.name} through the full governed pipeline.
        </small>
      </div>
      {isError ? (
        <WarningCallout>
          {errorMessage(error, "Bek could not start the smoke run.")}
        </WarningCallout>
      ) : null}
      {run ? (
        <SuccessCallout>
          Smoke run {run.status.replaceAll("_", " ")}. Open{" "}
          <RunLink run={run} /> to watch it end to end.
        </SuccessCallout>
      ) : null}
      <div className="row-actions">
        <button
          type="button"
          className="primary"
          disabled={!canRun}
          aria-busy={isPending}
          onClick={onRun}
        >
          <Sparkles size={16} aria-hidden="true" />
          {isPending ? "Running..." : run ? "Run again" : "Run smoke prompt"}
        </button>
        {run ? (
          <Link to="/runs" className="secondary">
            View all runs
            <ExternalLink size={14} aria-hidden="true" />
          </Link>
        ) : null}
      </div>
    </div>
  );
}

function CompleteSummary({
  steps,
  smokeRun,
  agentHandle,
}: {
  steps: GuidedSetupStep[];
  smokeRun: Run | undefined;
  agentHandle: string;
}) {
  const persisted = steps.filter((step) => step.id !== "smoke");
  return (
    <div className="page">
      <PageHeader
        eyebrow="Guided setup"
        title="Your Bek teammate is set up."
        description={`${agentHandle} is connected, governed, and ready to work. You can revisit any step from the setup checklist whenever you change configuration.`}
      />
      <Panel title="Setup complete" action={<StatusBadge value="ready" />}>
        <div className="guided-complete">
          <span className="guided-complete-icon" aria-hidden="true">
            <PartyPopper size={26} />
          </span>
          <div className="guided-complete-body">
            <strong>You&apos;re set up.</strong>
            <p className="muted">
              Every required step is configured. Bek will only act inside the
              channels, access bundles, models, and runtimes you chose, with
              risky actions waiting for your mapped approvers.
            </p>
            <ul className="guided-complete-list">
              {persisted.map((step) => (
                <li key={step.id}>
                  <span className="guided-complete-check" aria-hidden="true">
                    <Check size={13} />
                  </span>
                  {step.title}
                </li>
              ))}
            </ul>
            {smokeRun ? (
              <p className="guided-step-status-line">
                Smoke run created — open <RunLink run={smokeRun} /> to review
                it.
              </p>
            ) : null}
          </div>
        </div>
        <div className="row-actions guided-complete-actions">
          <Link to="/" className="primary">
            Open overview
            <ExternalLink size={14} aria-hidden="true" />
          </Link>
          <Link to="/runs" className="secondary">
            View runs
          </Link>
          <Link to="/setup" className="secondary">
            Full checklist
          </Link>
        </div>
      </Panel>
    </div>
  );
}
