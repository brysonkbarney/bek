export type ISODate = string;

export type PrincipalKind =
  | "human"
  | "agent"
  | "service_account"
  | "integration"
  | "system";

export type PlaceKind =
  | "slack_channel"
  | "slack_dm"
  | "github_repo"
  | "project"
  | "system";

export type CapabilityKind =
  | "slack.read"
  | "slack.write"
  | "github.read"
  | "github.branch"
  | "github.pr"
  | "linear.read"
  | "linear.write"
  | "mcp.tool"
  | "sandbox.exec"
  | "model.call";

export type RiskLevel =
  | "read_internal"
  | "write_draft"
  | "write_external"
  | "privileged";

export type Decision = "allow" | "ask" | "deny";

export type RunStatus =
  | "queued"
  | "reading_context"
  | "planning"
  | "awaiting_approval"
  | "running_tools"
  | "working_in_sandbox"
  | "completed"
  | "failed"
  | "cancelled";

export type TriggerKind =
  | "mention"
  | "reaction"
  | "dm"
  | "slash_command"
  | "api"
  | "schedule";

export interface Organization {
  id: string;
  name: string;
  slug: string;
  plan: "oss" | "team" | "enterprise";
  primaryAgentId: string;
}

export interface Principal {
  id: string;
  orgId: string;
  kind: PrincipalKind;
  displayName: string;
  email?: string;
}

export interface AgentIdentity {
  id: string;
  orgId: string;
  principalId: string;
  name: string;
  handle: string;
  description: string;
  status: "active" | "paused" | "disabled";
  defaultModelPolicyId: string;
  defaultRuntimeProfileId: string;
}

export interface CapabilityProfile {
  id: string;
  orgId: string;
  agentId: string;
  name: string;
  capabilityKind:
    | "answer"
    | "coding"
    | "incident"
    | "support"
    | "data"
    | "workflow";
  runtimeProfileId: string;
  modelPolicyId: string;
  enabled: boolean;
}

export interface PlaceScope {
  id: string;
  orgId: string;
  kind: PlaceKind;
  provider: "slack" | "github" | "system";
  externalId: string;
  name: string;
  sensitivity: "public" | "internal" | "confidential" | "restricted";
}

export interface AccessBundle {
  id: string;
  orgId: string;
  name: string;
  description: string;
  attachedPlaceIds: string[];
  grants: CapabilityGrant[];
  budgetPolicyId: string;
}

export interface CapabilityGrant {
  id: string;
  capability: CapabilityKind;
  resource: string;
  decision: Decision;
  risk: RiskLevel;
  requiresApproval: boolean;
}

export interface ModelPolicy {
  id: string;
  orgId: string;
  name: string;
  defaultModel: string;
  fallbackModels: string[];
  perRunBudgetCents: number;
}

export interface RuntimeProfile {
  id: string;
  orgId: string;
  name: string;
  runtimeKind: "ai_sdk" | "opencode" | "langgraph" | "external";
  adapter: string;
}

export interface BudgetPolicy {
  id: string;
  orgId: string;
  name: string;
  perRunCents: number;
  perDayCents: number;
}

export interface Run {
  id: string;
  orgId: string;
  agentId: string;
  requesterPrincipalId: string;
  placeScopeId: string;
  trigger: TriggerKind;
  prompt: string;
  status: RunStatus;
  modelPolicyId: string;
  runtimeProfileId: string;
  estimatedCostCents: number;
  actualCostCents: number;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface RunEvent {
  id: string;
  runId: string;
  orgId: string;
  type:
    | "run.created"
    | "policy.evaluated"
    | "model.selected"
    | "tool.requested"
    | "approval.requested"
    | "approval.decided"
    | "run.status_changed"
    | "run.completed"
    | "run.failed";
  message: string;
  data?: Record<string, unknown>;
  createdAt: ISODate;
}

export interface ApprovalRequest {
  id: string;
  orgId: string;
  runId: string;
  action: string;
  risk: RiskLevel;
  status: "pending" | "approved" | "denied" | "expired";
  payloadHash: string;
  requestedByPrincipalId: string;
  decidedByPrincipalId?: string;
  createdAt: ISODate;
  expiresAt: ISODate;
  decidedAt?: ISODate;
}

export interface BekSnapshot {
  org: Organization;
  principals: Principal[];
  agent: AgentIdentity;
  capabilityProfiles: CapabilityProfile[];
  places: PlaceScope[];
  accessBundles: AccessBundle[];
  modelPolicies: ModelPolicy[];
  runtimeProfiles: RuntimeProfile[];
  budgetPolicies: BudgetPolicy[];
  runs: Run[];
  events: RunEvent[];
  approvals: ApprovalRequest[];
}
