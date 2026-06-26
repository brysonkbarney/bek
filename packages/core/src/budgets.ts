import type { AccessBundle, BudgetPolicy, Run } from "./types";

// Daily budget status: maps runs to budget policies (via the access bundles that
// reference each policy and the places they attach), sums today's actual spend,
// and flags warning/exceeded states. Pure: reads only its inputs.

export type BudgetState = "ok" | "warning" | "exceeded";

export interface BudgetStatus {
  budgetPolicyId: string;
  name: string;
  perDayCents: number;
  spentTodayCents: number;
  remainingTodayCents: number;
  /** Fraction of the daily ceiling consumed (0..1+, 0 when no ceiling). */
  utilization: number;
  state: BudgetState;
  runCountToday: number;
}

export interface SummarizeBudgetStatusInput {
  policies: readonly BudgetPolicy[];
  accessBundles: readonly AccessBundle[];
  runs: readonly Run[];
  now: Date;
  /** Utilization at or above which a policy is flagged "warning". */
  warningThreshold?: number;
}

const DEFAULT_WARNING_THRESHOLD = 0.8;

function utcDay(iso: string): string {
  return iso.slice(0, 10);
}

export function summarizeBudgetStatus(
  input: SummarizeBudgetStatusInput,
): BudgetStatus[] {
  const nowMs = input.now.getTime();
  if (!Number.isFinite(nowMs)) {
    throw new Error("now must be a valid date.");
  }
  const today = utcDay(input.now.toISOString());
  const warningThreshold = input.warningThreshold ?? DEFAULT_WARNING_THRESHOLD;

  return input.policies.map((policy) => {
    const placeIds = new Set<string>();
    for (const bundle of input.accessBundles) {
      if (bundle.budgetPolicyId === policy.id) {
        for (const placeId of bundle.attachedPlaceIds) {
          placeIds.add(placeId);
        }
      }
    }
    const todayRuns = input.runs.filter(
      (run) =>
        placeIds.has(run.placeScopeId) && utcDay(run.createdAt) === today,
    );
    const spentTodayCents = todayRuns.reduce(
      (total, run) => total + (run.actualCostCents || 0),
      0,
    );
    const remainingTodayCents = Math.max(
      0,
      policy.perDayCents - spentTodayCents,
    );
    const utilization =
      policy.perDayCents > 0 ? spentTodayCents / policy.perDayCents : 0;
    const state: BudgetState =
      policy.perDayCents > 0 && spentTodayCents >= policy.perDayCents
        ? "exceeded"
        : utilization >= warningThreshold && policy.perDayCents > 0
          ? "warning"
          : "ok";
    return {
      budgetPolicyId: policy.id,
      name: policy.name,
      perDayCents: policy.perDayCents,
      spentTodayCents,
      remainingTodayCents,
      utilization,
      state,
      runCountToday: todayRuns.length,
    };
  });
}
