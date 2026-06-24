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
  agent: {
    name: string;
    handle: string;
    description: string;
    status: string;
    defaultModelPolicyId?: string;
    defaultRuntimeProfileId?: string;
  };
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

export interface SetupStatus {
  visibleHandle: string;
  singleVisibleAgent: boolean;
  slackChannels: number;
  accessBundles: number;
  modelPolicies: number;
  runtimeProfiles: number;
  githubGrantCount: number;
  pendingApprovals: number;
  readyForLocalDemo: boolean;
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

async function jsonRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: headers(init?.headers),
  });
  if (!res.ok) {
    let message = `Bek API request failed: ${path}`;
    try {
      const body = (await res.json()) as { error?: string };
      message = body.error ?? message;
    } catch {
      // Keep the generic message when the response is not JSON.
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export async function fetchSetupStatus(): Promise<SetupStatus> {
  return jsonRequest<SetupStatus>("/api/setup/status");
}

export async function updateAgent(input: {
  name?: string;
  description?: string;
  status?: "active" | "paused" | "disabled";
  defaultModelPolicyId?: string;
  defaultRuntimeProfileId?: string;
}): Promise<Bootstrap["agent"]> {
  return jsonRequest<Bootstrap["agent"]>("/api/agent", {
    method: "PATCH",
    body: JSON.stringify(input),
    headers: { "content-type": "application/json" },
  });
}

export async function createChannel(input: {
  externalId: string;
  name: string;
  sensitivity: string;
}): Promise<PlaceScope> {
  return jsonRequest<PlaceScope>("/api/channels", {
    method: "POST",
    body: JSON.stringify(input),
    headers: { "content-type": "application/json" },
  });
}

export async function updateChannel(input: {
  channelId: string;
  name?: string;
  externalId?: string;
  sensitivity?: string;
}): Promise<PlaceScope> {
  const { channelId, ...body } = input;
  return jsonRequest<PlaceScope>(`/api/channels/${channelId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

export async function createAccessBundle(input: {
  name: string;
  description: string;
  attachedPlaceIds?: string[];
}): Promise<AccessBundle> {
  return jsonRequest<AccessBundle>("/api/access-bundles", {
    method: "POST",
    body: JSON.stringify(input),
    headers: { "content-type": "application/json" },
  });
}

export async function attachBundleToPlace(input: {
  bundleId: string;
  placeId: string;
}): Promise<AccessBundle> {
  return jsonRequest<AccessBundle>(
    `/api/access-bundles/${input.bundleId}/places`,
    {
      method: "POST",
      body: JSON.stringify({ placeId: input.placeId }),
      headers: { "content-type": "application/json" },
    },
  );
}

export async function createGrant(input: {
  bundleId: string;
  capability: string;
  resource: string;
  decision: "allow" | "ask" | "deny";
  risk: string;
  requiresApproval: boolean;
}): Promise<CapabilityGrant> {
  const { bundleId, ...body } = input;
  return jsonRequest<CapabilityGrant>(
    `/api/access-bundles/${bundleId}/grants`,
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    },
  );
}

export async function updateModelPolicy(input: {
  modelPolicyId: string;
  defaultModel?: string;
  fallbackModels?: string[];
  perRunBudgetCents?: number;
}): Promise<ModelPolicy> {
  const { modelPolicyId, ...body } = input;
  return jsonRequest<ModelPolicy>(`/api/model-policies/${modelPolicyId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
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
