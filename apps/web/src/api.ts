const DEFAULT_API_URL = "http://localhost:4317";
const ADMIN_TOKEN_STORAGE_KEY = "bek.adminApiToken";

interface BekBrowserConfig {
  apiUrl?: string | undefined;
}

declare global {
  interface Window {
    __BEK_CONFIG__?: BekBrowserConfig | undefined;
  }
}

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
  return Boolean(readBuildTimeAdminToken());
}

export function hasStoredAdminToken(): boolean {
  return Boolean(readBrowserAdminToken());
}

export function readAdminApiToken(): string | undefined {
  return readBrowserAdminToken() || readBuildTimeAdminToken();
}

export function readBekApiUrl(): string {
  return (
    normalizeApiUrl(readRuntimeConfig()?.apiUrl) ??
    normalizeApiUrl(import.meta.env.VITE_BEK_API_URL) ??
    DEFAULT_API_URL
  );
}

export function saveAdminApiToken(
  token: string,
  options: { persist?: boolean | undefined } = {},
): void {
  const trimmed = token.trim();
  if (!trimmed) {
    clearAdminApiToken();
    return;
  }
  if (options.persist) {
    browserLocalStorage()?.setItem(ADMIN_TOKEN_STORAGE_KEY, trimmed);
    browserSessionStorage()?.removeItem(ADMIN_TOKEN_STORAGE_KEY);
    return;
  }
  const session = browserSessionStorage();
  if (session) {
    session.setItem(ADMIN_TOKEN_STORAGE_KEY, trimmed);
    browserLocalStorage()?.removeItem(ADMIN_TOKEN_STORAGE_KEY);
    return;
  }
  browserLocalStorage()?.setItem(ADMIN_TOKEN_STORAGE_KEY, trimmed);
}

export function clearAdminApiToken(): void {
  browserSessionStorage()?.removeItem(ADMIN_TOKEN_STORAGE_KEY);
  browserLocalStorage()?.removeItem(ADMIN_TOKEN_STORAGE_KEY);
}

export function adminAuthHeaders(extra?: HeadersInit): HeadersInit {
  const token = readAdminApiToken();
  return {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

function readBrowserAdminToken(): string | undefined {
  return (
    readStorageToken(browserSessionStorage()) ??
    readStorageToken(browserLocalStorage())
  );
}

function readBuildTimeAdminToken(): string | undefined {
  if (!import.meta.env.DEV) {
    return undefined;
  }
  const token = import.meta.env.VITE_BEK_ADMIN_API_TOKEN?.trim();
  return token || undefined;
}

function readRuntimeConfig(): BekBrowserConfig | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.__BEK_CONFIG__;
  } catch {
    return undefined;
  }
}

function normalizeApiUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === "/") {
    return "";
  }
  return trimmed.replace(/\/+$/, "");
}

function readStorageToken(storage: Storage | undefined): string | undefined {
  const token = storage?.getItem(ADMIN_TOKEN_STORAGE_KEY)?.trim();
  return token || undefined;
}

function browserSessionStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
}

function browserLocalStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export interface Bootstrap {
  org: { name: string; plan: string };
  principals?: Principal[];
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
  slackRequiredScopes?: string[];
  slackGrantedScopes?: string[];
  missingSlackScopes?: string[];
  accessBundles: number;
  modelPolicies: number;
  modelGatewayMode?: string;
  modelPricingReady?: boolean;
  missingPricedModels?: string[];
  modelPricingError?: string | null;
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

export interface SlackAppManifestResponse {
  ok: true;
  baseUrl: string;
  manifest: Record<string, unknown>;
  scopes: string[];
  botEvents: string[];
  urls: {
    events: string;
    interactivity: string;
    command: string | null;
    redirect: string | null;
  };
}

export interface DiscoveredSlackChannel {
  id: string;
  name: string;
  isPrivate: boolean;
  isArchived: boolean;
  botIsMember: boolean;
  configured: boolean;
  configuredPlaceId: string | null;
  sensitivity: string | null;
  numMembers: number | null;
}

export interface SlackChannelDiscovery {
  ok: true;
  source: "injected" | "stored_oauth" | "env";
  teamId: string | null;
  workspaceName: string | null;
  channels: DiscoveredSlackChannel[];
  nextCursor: string | null;
}

export interface Run {
  id: string;
  placeScopeId: string;
  runtimeProfileId: string;
  modelPolicyId: string;
  prompt: string;
  status: string;
  trigger: string;
  requesterPrincipalId?: string;
  estimatedCostCents: number;
  actualCostCents: number;
  createdAt: string;
  updatedAt: string;
}

export interface Principal {
  id: string;
  kind: string;
  displayName: string;
  email?: string;
  externalProvider?: string;
  externalId?: string;
  metadata?: Record<string, unknown>;
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
  requestedByPrincipalId: string;
  decidedByPrincipalId?: string;
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

export interface SlackOutboundDelivery {
  id: string;
  provider: "slack";
  kind: "slack.run_outcome" | "slack.approval_decision";
  status: "queued" | "delivering" | "delivered" | "failed";
  attempts: number;
  maxAttempts: number;
  runId?: string;
  approvalId?: string;
  lastError?: string;
  nextAttemptAt?: string;
  deliveredAt?: string;
  createdAt: string;
  updatedAt: string;
  target?: Record<string, unknown>;
  payload?: Record<string, unknown>;
}

export interface SlackOutboxResponse {
  deliveries: SlackOutboundDelivery[];
}

export interface DrainSlackOutboxResponse {
  outbound: {
    attempted: number;
    deliveries: SlackOutboundDelivery[];
  };
}

export async function fetchBootstrap(): Promise<Bootstrap> {
  return jsonRequest<Bootstrap>("/api/bootstrap");
}

async function jsonRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${readBekApiUrl()}${path}`, {
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

export async function fetchSlackManifest(): Promise<SlackAppManifestResponse> {
  return jsonRequest<SlackAppManifestResponse>("/api/slack/manifest");
}

export function slackChannelDiscoveryPath(
  input: {
    cursor?: string;
    limit?: number;
    types?: string;
    excludeArchived?: boolean;
  } = {},
): string {
  const params = new URLSearchParams();
  if (input.cursor) params.set("cursor", input.cursor);
  if (input.limit) params.set("limit", String(input.limit));
  if (input.types) params.set("types", input.types);
  if (input.excludeArchived !== undefined) {
    params.set("excludeArchived", String(input.excludeArchived));
  }
  const query = params.toString();
  return query
    ? `/api/slack/channels/discover?${query}`
    : "/api/slack/channels/discover";
}

export async function discoverSlackChannels(
  input: {
    cursor?: string;
    limit?: number;
    types?: string;
    excludeArchived?: boolean;
  } = {},
): Promise<SlackChannelDiscovery> {
  return jsonRequest<SlackChannelDiscovery>(slackChannelDiscoveryPath(input));
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

export async function linkPrincipalExternalIdentity(input: {
  principalId: string;
  externalProvider: string;
  externalId: string;
  metadata?: Record<string, unknown>;
}): Promise<Principal> {
  const { principalId, ...body } = input;
  return jsonRequest<Principal>(
    `/api/principals/${encodeURIComponent(principalId)}/external-identity`,
    {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    },
  );
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
  const res = await fetch(`${readBekApiUrl()}/api/runs`, {
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
  const res = await fetch(`${readBekApiUrl()}/api/runs/${runId}`, {
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

export function slackOutboxPath(input: { includeDetails?: boolean } = {}) {
  if (!input.includeDetails) {
    return "/api/outbound/slack";
  }
  const params = new URLSearchParams({ include: "details" });
  return `/api/outbound/slack?${params.toString()}`;
}

export async function fetchSlackOutbox(
  input: { includeDetails?: boolean } = {},
): Promise<SlackOutboxResponse> {
  return jsonRequest<SlackOutboxResponse>(slackOutboxPath(input));
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

export async function drainSlackOutbox(input: {
  limit?: number;
}): Promise<DrainSlackOutboxResponse> {
  return jsonRequest<DrainSlackOutboxResponse>("/api/outbound/slack/drain", {
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
  payloadHash: string;
}): Promise<ApprovalRequest> {
  const res = await fetch(
    `${readBekApiUrl()}/api/approvals/${input.approvalId}/${input.decision}`,
    {
      method: "POST",
      headers: adminAuthHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        payloadHash: input.payloadHash,
      }),
    },
  );
  if (!res.ok) {
    throw await apiError(`/api/approvals/${input.approvalId}`, res);
  }
  return res.json() as Promise<ApprovalRequest>;
}
