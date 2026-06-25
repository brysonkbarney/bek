const API_URL = import.meta.env.VITE_BEK_API_URL ?? "http://localhost:4317";
const ADMIN_TOKEN = import.meta.env.VITE_BEK_ADMIN_API_TOKEN;
const ADMIN_TOKEN_STORAGE_KEY = "bek.adminApiToken";

export class BekApiError extends Error {
  readonly status: number;
  readonly path: string;

  constructor(path: string, status: number, message: string) {
    super(message);
    this.name = "BekApiError";
    this.path = path;
    this.status = status;
  }
}

export function isBekApiError(error: unknown): error is BekApiError {
  return error instanceof BekApiError;
}

export function hasBuildTimeAdminToken(): boolean {
  return Boolean(ADMIN_TOKEN);
}

export function hasStoredAdminToken(): boolean {
  return Boolean(readStoredAdminToken());
}

export function readAdminApiToken(): string | undefined {
  const stored = readStoredAdminToken();
  return stored || ADMIN_TOKEN || undefined;
}

export function saveAdminApiToken(token: string): void {
  const trimmed = token.trim();
  if (!trimmed) {
    clearAdminApiToken();
    return;
  }
  browserStorage()?.setItem(ADMIN_TOKEN_STORAGE_KEY, trimmed);
}

export function clearAdminApiToken(): void {
  browserStorage()?.removeItem(ADMIN_TOKEN_STORAGE_KEY);
}

export function adminAuthHeaders(extra?: HeadersInit): HeadersInit {
  const token = readAdminApiToken();
  return {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

function readStoredAdminToken(): string | undefined {
  const token = browserStorage()?.getItem(ADMIN_TOKEN_STORAGE_KEY)?.trim();
  return token || undefined;
}

function browserStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
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
  connectorInstalls: ConnectorInstall[];
  credentials: CredentialRecord[];
  runs: Run[];
  events: RunEvent[];
  approvals: ApprovalRequest[];
}

export interface SetupStatus {
  visibleHandle: string;
  singleVisibleAgent: boolean;
  slackChannels: number;
  slackInstalled?: boolean;
  slackInstallStatus?: string | null;
  slackWorkspaceName?: string | null;
  slackWorkspaceId?: string | null;
  slackBotUserId?: string | null;
  slackTokenStored?: boolean;
  accessBundles: number;
  modelPolicies: number;
  runtimeProfiles: number;
  githubGrantCount: number;
  pendingApprovals: number;
  readyForLocalDemo: boolean;
  readyForWorkspace: boolean;
}

export interface SlackInstallStart {
  ok: true;
  url: string;
  scopes: string[];
  redirectUri: string;
  exchangeEnabled: boolean;
  tokenStorageConfigured: boolean;
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
  metadata?: Record<string, unknown>;
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

export interface ConnectorInstall {
  id: string;
  kind: string;
  provider: string;
  externalId?: string;
  displayName: string;
  status: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CredentialRecord {
  id: string;
  connectorInstallId?: string;
  name: string;
  provider: string;
  externalAccountId?: string;
  secretRef: string;
  status: string;
  scopeSummary: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
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

export interface ModelUsage {
  runs: number;
  totalEstimatedCents: number;
  totalActualCents: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  source: "runs" | "model_usage";
}

export interface WorkerWorkItem {
  orgId: string;
  runId: string;
  attempt: number;
  reason: string;
  traceId: string;
  enqueuedAt: string;
}

export interface WorkerLease {
  id: string;
  workerId: string;
  expiresAt: string;
  heartbeatAt: string;
}

export interface WorkerWorkRecord {
  id: string;
  sequence: number;
  idempotencyKey: string;
  item: WorkerWorkItem;
  status: string;
  attemptState: string;
  availableAt: string;
  createdAt: string;
  updatedAt: string;
  lease?: WorkerLease;
  retryOf?: string;
  cancelRequestedAt?: string;
  cancelReason?: string;
  terminalReason?: string;
  result?: { status?: string; error?: string; finalText?: string };
}

export interface WorkerDeadLetterRecord {
  id: string;
  sequence: number;
  workId: string;
  idempotencyKey: string;
  item: WorkerWorkItem;
  reason: string;
  failedAt: string;
  result: { status?: string; error?: string };
  retryPolicy: { maxAttempts?: number };
}

export interface WorkerEvent {
  id: string;
  sequence: number;
  type: string;
  orgId: string;
  runId: string;
  attempt?: number;
  traceId?: string;
  message: string;
  data?: Record<string, unknown>;
  createdAt: string;
}

export interface WorkerSnapshot {
  records: WorkerWorkRecord[];
  deadLetters: WorkerDeadLetterRecord[];
  events: WorkerEvent[];
}

export interface WorkerQueueResponse {
  mode: string;
  enabled: boolean;
  queue: WorkerSnapshot;
}

export interface DrainWorkerResponse extends WorkerQueueResponse {
  result: {
    processed: number;
    stoppedReason: string;
    decisions: Array<{ decision: string }>;
  };
}

export interface CancelRunResponse {
  mode: string;
  decision: { decision: string };
  run: Run;
  queue: WorkerSnapshot;
}

export interface RedriveDeadLetterResponse extends WorkerQueueResponse {
  decision: { decision: string };
  run: Run;
}

export async function fetchBootstrap(): Promise<Bootstrap> {
  return jsonRequest<Bootstrap>("/api/bootstrap");
}

async function jsonRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: adminAuthHeaders(init?.headers),
  });
  if (!res.ok) {
    throw await apiError(path, res);
  }
  return res.json() as Promise<T>;
}

async function apiError(path: string, res: Response): Promise<BekApiError> {
  let message = `Bek API request failed: ${path}`;
  try {
    const body = (await res.json()) as { error?: string };
    message = body.error ?? message;
  } catch {
    // Keep the generic message when the response is not JSON.
  }
  if (res.status === 401) {
    message = "Admin API authorization required.";
  }
  return new BekApiError(path, res.status, message);
}

export async function fetchSetupStatus(): Promise<SetupStatus> {
  return jsonRequest<SetupStatus>("/api/setup/status");
}

export async function fetchModelUsage(): Promise<ModelUsage> {
  return jsonRequest<ModelUsage>("/api/model-usage");
}

export function slackInstallStartPath(returnTo = "/connectors"): string {
  const params = new URLSearchParams({ return_to: returnTo });
  return `/api/slack/install-url?${params.toString()}`;
}

export async function fetchSlackInstallStart(
  returnTo = "/connectors",
): Promise<SlackInstallStart> {
  return jsonRequest<SlackInstallStart>(slackInstallStartPath(returnTo));
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
  externalTeamId?: string;
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
  externalTeamId?: string;
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
    headers: adminAuthHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw await apiError("/api/runs", res);
  }
  return res.json() as Promise<Run>;
}

export async function fetchRunDetail(runId: string): Promise<RunDetail> {
  const res = await fetch(`${API_URL}/api/runs/${runId}`, {
    headers: adminAuthHeaders(),
  });
  if (!res.ok) {
    throw await apiError(`/api/runs/${runId}`, res);
  }
  return res.json() as Promise<RunDetail>;
}

export async function fetchWorkerQueue(): Promise<WorkerQueueResponse> {
  return jsonRequest<WorkerQueueResponse>("/api/worker/queue");
}

export async function drainWorker(input: {
  maxItems?: number;
}): Promise<DrainWorkerResponse> {
  return jsonRequest<DrainWorkerResponse>("/api/worker/drain", {
    method: "POST",
    body: JSON.stringify(input),
    headers: { "content-type": "application/json" },
  });
}

export async function cancelRun(input: {
  runId: string;
  reason?: string;
}): Promise<CancelRunResponse> {
  const { runId, ...body } = input;
  return jsonRequest<CancelRunResponse>(cancelRunPath(runId), {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

export function cancelRunPath(runId: string): string {
  return `/api/runs/${encodeURIComponent(runId)}/cancel`;
}

export async function redriveDeadLetter(input: {
  deadLetterId: string;
  reason?: string;
}): Promise<RedriveDeadLetterResponse> {
  const { deadLetterId, ...body } = input;
  return jsonRequest<RedriveDeadLetterResponse>(
    redriveDeadLetterPath(deadLetterId),
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    },
  );
}

export function redriveDeadLetterPath(deadLetterId: string): string {
  return `/api/worker/dead-letters/${encodeURIComponent(deadLetterId)}/redrive`;
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
      headers: adminAuthHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        principalId: input.principalId,
        payloadHash: input.payloadHash,
      }),
    },
  );
  if (!res.ok) {
    throw await apiError(`/api/approvals/${input.approvalId}`, res);
  }
  return res.json() as Promise<ApprovalRequest>;
}
