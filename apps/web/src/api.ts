const API_URL = import.meta.env.VITE_BEK_API_URL ?? "http://localhost:4317";
const ADMIN_TOKEN = import.meta.env.VITE_BEK_ADMIN_API_TOKEN;

function headers(extra?: HeadersInit): HeadersInit {
  return {
    ...(ADMIN_TOKEN ? { authorization: `Bearer ${ADMIN_TOKEN}` } : {}),
    ...extra,
  };
}

export interface Bootstrap {
  org: { name: string; plan: string };
  agent: { name: string; handle: string; description: string; status: string };
  capabilityProfiles: Array<{
    id: string;
    name: string;
    capabilityKind: string;
    enabled: boolean;
  }>;
  places: PlaceScope[];
  accessBundles: AccessBundle[];
  modelPolicies: ModelPolicy[];
  runtimeProfiles: RuntimeProfile[];
  budgetPolicies: BudgetPolicy[];
  runs: Run[];
  events: RunEvent[];
  approvals: ApprovalRequest[];
}

export interface Run {
  id: string;
  placeScopeId: string;
  runtimeProfileId: string;
  modelPolicyId: string;
  prompt: string;
  status: string;
  trigger: string;
  estimatedCostCents: number;
  actualCostCents: number;
  createdAt: string;
  updatedAt: string;
}

export interface PlaceScope {
  id: string;
  name: string;
  kind: string;
  provider: string;
  externalId: string;
  sensitivity: string;
}

export interface AccessBundle {
  id: string;
  name: string;
  description: string;
  attachedPlaceIds: string[];
  budgetPolicyId: string;
  grants: CapabilityGrant[];
}

export interface CapabilityGrant {
  id: string;
  capability: string;
  resource: string;
  decision: "allow" | "ask" | "deny";
  risk: string;
  requiresApproval: boolean;
}

export interface ModelPolicy {
  id: string;
  name: string;
  defaultModel: string;
  fallbackModels: string[];
  perRunBudgetCents: number;
}

export interface RuntimeProfile {
  id: string;
  name: string;
  runtimeKind: string;
  adapter: string;
}

export interface BudgetPolicy {
  id: string;
  name: string;
  perRunCents: number;
  perDayCents: number;
}

export interface RunEvent {
  id: string;
  runId: string;
  type: string;
  message: string;
  createdAt: string;
  data?: Record<string, unknown>;
}

export interface ApprovalRequest {
  id: string;
  runId: string;
  action: string;
  status: "pending" | "approved" | "denied" | "expired";
  risk: string;
  payloadHash: string;
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
}

export interface RunDetail {
  run: Run;
  events: RunEvent[];
  approvals: ApprovalRequest[];
}

export async function fetchBootstrap(): Promise<Bootstrap> {
  const res = await fetch(`${API_URL}/api/bootstrap`, { headers: headers() });
  if (!res.ok) {
    throw new Error("Failed to load Bek bootstrap data");
  }
  return res.json() as Promise<Bootstrap>;
}

export async function createRun(input: {
  prompt: string;
  placeScopeId: string;
  capability?: string;
  resource?: string;
}) {
  const res = await fetch(`${API_URL}/api/runs`, {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error("Failed to create run");
  }
  return res.json() as Promise<Run>;
}

export async function fetchRunDetail(runId: string): Promise<RunDetail> {
  const res = await fetch(`${API_URL}/api/runs/${runId}`, {
    headers: headers(),
  });
  if (!res.ok) {
    throw new Error("Failed to load Bek run detail");
  }
  return res.json() as Promise<RunDetail>;
}

export async function decideApproval(input: {
  approvalId: string;
  decision: "approve" | "deny";
  principalId: string;
  payloadHash: string;
}): Promise<ApprovalRequest> {
  const res = await fetch(
    `${API_URL}/api/approvals/${input.approvalId}/${input.decision}`,
    {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        principalId: input.principalId,
        payloadHash: input.payloadHash,
      }),
    },
  );
  if (!res.ok) {
    throw new Error("Failed to decide approval");
  }
  return res.json() as Promise<ApprovalRequest>;
}
