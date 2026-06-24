import type {
  AccessBundle,
  ApprovalRequest,
  CapabilityGrant,
  ModelPolicy,
  PlaceScope,
  Principal,
  RiskLevel,
  Run,
  RuntimeProfile,
} from "@bek/core";
import type { SandboxLease, SandboxPolicy } from "@bek/sandbox";

export type RuntimeAdapterKind = RuntimeProfile["runtimeKind"];
export type RuntimeWorkReason =
  | "new_run"
  | "approval_granted"
  | "retry"
  | "resume";

export interface RunWorkItem {
  orgId: string;
  runId: string;
  attempt: number;
  reason: RuntimeWorkReason;
  traceId: string;
  enqueuedAt: string;
}

export interface RuntimeModelRoute {
  provider: string;
  model: string;
  reason: string;
  estimatedCostCents?: number | undefined;
  budget?: RuntimeModelBudgetPreflight | undefined;
}

export interface RuntimeModelBudgetPreflight {
  decision: "within_budget" | "over_budget";
  budgetCents: number;
  estimatedCostCents: number;
  remainingBudgetCents: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
}

export interface RuntimeArtifactRef {
  id: string;
  kind: "patch" | "log" | "test_report" | "screenshot" | "summary" | "other";
  contentHash: string;
  sizeBytes: number;
  uri?: string | undefined;
}

export type RuntimeCheckpointKind =
  | "sandbox.start"
  | "sandbox.network"
  | "sandbox.command"
  | "filesystem.write"
  | "external.write"
  | "budget.increase";

export interface RuntimeApprovalCheckpoint {
  kind: RuntimeCheckpointKind;
  action: string;
  resource: string;
  risk: RiskLevel;
  payload: Record<string, unknown>;
}

export type RuntimeObservabilityEventType =
  | "worker.claimed"
  | "runtime.selected"
  | "runtime.started"
  | "runtime.completed"
  | "model.requested"
  | "model.completed"
  | "budget.checked"
  | "sandbox.requested"
  | "sandbox.started"
  | "sandbox.network_changed"
  | "sandbox.command.started"
  | "sandbox.command.completed"
  | "sandbox.artifact.created"
  | "tool.requested"
  | "tool.approved"
  | "tool.denied"
  | "tool.completed"
  | "credential.leased"
  | "credential.revoked";

export interface RuntimeObservabilityEvent {
  type: RuntimeObservabilityEventType;
  message: string;
  data?: Record<string, unknown> | undefined;
}

export interface RuntimeToolRequest {
  name: string;
  capabilityGrant: CapabilityGrant;
  input: Record<string, unknown>;
  risk: RiskLevel;
}

export interface RuntimeToolResult {
  ok: boolean;
  output?: unknown;
  error?: string | undefined;
  artifactRefs?: RuntimeArtifactRef[] | undefined;
}

export interface RuntimeToolProxy {
  call(request: RuntimeToolRequest): Promise<RuntimeToolResult>;
}

export interface RuntimeStartInput {
  workItem: RunWorkItem;
  run: Run;
  requester: Principal;
  place: PlaceScope;
  accessBundles: AccessBundle[];
  modelPolicy: ModelPolicy;
  modelRoute: RuntimeModelRoute;
  runtimeProfile: RuntimeProfile;
  grants: CapabilityGrant[];
  sandbox?: RuntimeSandboxContext | undefined;
  tools: RuntimeToolProxy;
  requestApproval(
    checkpoint: RuntimeApprovalCheckpoint,
  ): Promise<ApprovalRequest>;
  emit(event: RuntimeObservabilityEvent): void | Promise<void>;
}

export interface RuntimeSandboxContext {
  policy: SandboxPolicy;
  lease?: SandboxLease | undefined;
}

export interface RuntimeResumeInput extends RuntimeStartInput {
  approval: ApprovalRequest;
}

export interface RuntimeResult {
  status: "completed" | "awaiting_approval" | "failed" | "cancelled";
  finalText?: string | undefined;
  artifactRefs: RuntimeArtifactRef[];
  actualCostCents: number;
  error?: string | undefined;
}

export interface RuntimeAdapter {
  id: string;
  kind: RuntimeAdapterKind;
  canRun(profile: RuntimeProfile): boolean;
  start(input: RuntimeStartInput): Promise<RuntimeResult>;
  resume(input: RuntimeResumeInput): Promise<RuntimeResult>;
  cancel(runId: string): Promise<void>;
}

export function adapterMatchesProfile(
  adapter: RuntimeAdapter,
  profile: RuntimeProfile,
): boolean {
  return adapter.kind === profile.runtimeKind && adapter.id === profile.adapter;
}

export function createRunWorkItem(input: {
  orgId: string;
  runId: string;
  attempt?: number | undefined;
  reason: RuntimeWorkReason;
  traceId: string;
  now?: string | undefined;
}): RunWorkItem {
  return {
    orgId: input.orgId,
    runId: input.runId,
    attempt: input.attempt ?? 1,
    reason: input.reason,
    traceId: input.traceId,
    enqueuedAt: input.now ?? new Date().toISOString(),
  };
}
