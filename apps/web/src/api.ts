const DEFAULT_API_URL = "http://localhost:4317";
const ADMIN_TOKEN_STORAGE_KEY = "bek.adminApiToken";
const SESSION_CSRF_STORAGE_KEY = "bek.sessionCsrfToken";

let sessionCsrfToken: string | undefined;

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

export interface SessionInfo {
  ok: boolean;
  role: string;
  principalId: string;
  orgId: string;
  csrfToken?: string;
  method?: string;
  expiresAt?: string;
}

export function readSessionCsrfToken(): string | undefined {
  if (sessionCsrfToken) {
    return sessionCsrfToken;
  }
  const stored = browserSessionStorage()
    ?.getItem(SESSION_CSRF_STORAGE_KEY)
    ?.trim();
  if (stored) {
    sessionCsrfToken = stored;
    return stored;
  }
  return undefined;
}

export function hasSessionCsrfToken(): boolean {
  return Boolean(readSessionCsrfToken());
}

function storeSessionCsrfToken(token: string | undefined): void {
  const trimmed = token?.trim();
  if (!trimmed) {
    clearSessionCsrfToken();
    return;
  }
  sessionCsrfToken = trimmed;
  browserSessionStorage()?.setItem(SESSION_CSRF_STORAGE_KEY, trimmed);
}

function clearSessionCsrfToken(): void {
  sessionCsrfToken = undefined;
  browserSessionStorage()?.removeItem(SESSION_CSRF_STORAGE_KEY);
}

function isWriteMethod(method: string | undefined): boolean {
  const normalized = (method ?? "GET").toUpperCase();
  return (
    normalized === "POST" ||
    normalized === "PATCH" ||
    normalized === "DELETE" ||
    normalized === "PUT"
  );
}

/**
 * Builds request headers shared by every admin request. Includes the bearer
 * token when present (existing behavior) and adds the `x-bek-csrf` header for
 * write requests when a session csrf token is stored, so cookie-authenticated
 * writes are accepted. Reads never need the csrf header.
 */
function adminRequestHeaders(
  method: string | undefined,
  extra?: HeadersInit,
): HeadersInit {
  const csrf = isWriteMethod(method) ? readSessionCsrfToken() : undefined;
  return {
    ...adminAuthHeaders(extra),
    ...(csrf ? { "x-bek-csrf": csrf } : {}),
  };
}

/**
 * Exchanges a bearer admin token for an httpOnly session cookie. On success the
 * returned csrf token is stored (in-memory + sessionStorage) so later write
 * requests can send `x-bek-csrf`. Returns undefined when sessions are disabled
 * on the server (HTTP 501); callers should keep using the bearer token.
 */
export async function signInWithSession(
  token: string,
): Promise<SessionInfo | undefined> {
  const trimmed = token.trim();
  if (!trimmed) {
    return undefined;
  }
  const res = await fetch(`${readBekApiUrl()}/api/auth/session`, {
    method: "POST",
    credentials: "include",
    headers: { authorization: `Bearer ${trimmed}` },
  });
  if (res.status === 501) {
    return undefined;
  }
  if (!res.ok) {
    throw await apiError("/api/auth/session", res);
  }
  const info = (await res.json()) as SessionInfo;
  storeSessionCsrfToken(info.csrfToken);
  return info;
}

/**
 * Returns the current session when the cookie is valid, else undefined.
 */
export async function fetchCurrentSession(): Promise<SessionInfo | undefined> {
  const res = await fetch(`${readBekApiUrl()}/api/auth/session`, {
    method: "GET",
    credentials: "include",
    headers: adminAuthHeaders(),
  });
  if (!res.ok) {
    return undefined;
  }
  return (await res.json()) as SessionInfo;
}

/**
 * Clears the session cookie on the server and the locally stored csrf token.
 * Resilient: never throws so it can always be paired with clearing the token.
 */
export async function signOut(): Promise<void> {
  try {
    await fetch(`${readBekApiUrl()}/api/auth/logout`, {
      method: "POST",
      credentials: "include",
      headers: adminRequestHeaders("POST"),
    });
  } catch {
    // Best effort: clearing the local token still signs the user out client-side.
  } finally {
    clearSessionCsrfToken();
  }
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
  modelPricingBasis?: "configured_benchmark";
  modelPricingSource?: "bek_default" | "env_registry" | "env_benchmarks";
  modelPricingNotice?: string;
  runtimeProfiles: number;
  runtimeExecutableProfiles?: number;
  runtimeExecutionReady?: boolean;
  runtimeExecutionErrors?: string[];
  sandboxedRuntimeProfiles?: number;
  sandboxProviderMode?: string;
  sandboxProviderEnabled?: boolean;
  sandboxProviderReady?: boolean;
  sandboxProviderNetworkCalls?: string;
  sandboxProviderErrors?: string[];
  githubGrantCount: number;
  githubExecutionMode?: string;
  githubExecutionEnabled?: boolean;
  githubExecutionReady?: boolean;
  githubExecutionNetworkCalls?: string;
  githubExecutionErrors?: string[];
  githubRepoBindingsReady?: boolean;
  missingGithubRepoBindings?: string[];
  pendingApprovals: number;
  readyForLocalDemo: boolean;
  readyForWorkspace: boolean;
}

export type GitHubInstallationPermissionAccess = "read" | "write";

export interface GitHubRepoResource {
  provider: "github";
  owner: string;
  repo: string;
  fullName: string;
  resource: string;
  url: string;
  repositoryId?: number;
}

export type GitHubInstallationTokenPermissions = Partial<
  Record<
    "checks" | "contents" | "metadata" | "pull_requests",
    GitHubInstallationPermissionAccess
  >
>;

export interface GitHubSetupGrant {
  bundleId: string;
  bundleName: string;
  grantId: string;
  capability: "github.read" | "github.branch" | "github.pr";
  resource: string;
  decision: CapabilityGrant["decision"];
  risk: CapabilityGrant["risk"];
  requiresApproval: boolean;
}

export interface GitHubInvalidSetupGrant extends GitHubSetupGrant {
  errors: string[];
}

export interface GitHubInstallationTokenRequestPreview {
  installationId: string;
  repository?: GitHubRepoResource;
  repositoryIds?: number[];
  permissions: GitHubInstallationTokenPermissions;
}

export interface GitHubDraftPullRequestWorkflowPreview {
  type: string;
  visibleAgentHandle: string;
  resource: string;
  steps: string[];
  tokenRequestPermissions: GitHubInstallationTokenPermissions;
  pullRequestProposal: {
    type: string;
    capability: string;
    resource: string;
    draft: boolean;
    baseBranch: string;
    headBranch: string;
    approval: {
      action: string;
      risk: string;
      required: boolean;
    };
  };
  approvalHashInput: {
    type: string;
    version: number;
    action: string;
    resource: string;
    repository: GitHubRepoResource;
    installationId: string | null;
  };
}

export interface GitHubSetupRepositoryPreview {
  repository: GitHubRepoResource;
  grants: GitHubSetupGrant[];
  requiredPermissions: GitHubInstallationTokenPermissions;
  installationTokenRequestPreview: GitHubInstallationTokenRequestPreview | null;
  draftPullRequestWorkflowPreview: GitHubDraftPullRequestWorkflowPreview | null;
}

export interface GitHubSetupPreview {
  ok: boolean;
  appConfig: {
    ok: boolean;
    appId: string | null;
    privateKeyConfigured: boolean;
    webhookSecretConfigured: boolean;
    legacyWebhookSecretConfigured: boolean;
    clientIdConfigured: boolean;
    clientSecretConfigured: boolean;
    errors: string[];
    warnings: string[];
  };
  installation: {
    configured: boolean;
    source: "query" | "env" | null;
    installationId: string | null;
    errors: string[];
  };
  githubGrantCount: number;
  validRepoGrantCount: number;
  invalidGrantCount: number;
  repositories: GitHubSetupRepositoryPreview[];
  invalidGrants: GitHubInvalidSetupGrant[];
  errors: string[];
  networkCalls: "none";
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

export type McpTransportKind = "stdio" | "http" | "sse" | "in_process";
export type McpConnectorStatus =
  | "pending"
  | "active"
  | "paused"
  | "revoked"
  | "error";

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

export interface AuditEvent {
  id: string;
  orgId: string;
  actorPrincipalId?: string;
  runId?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  decision?: "allow" | "ask" | "deny";
  risk?: string;
  message: string;
  data?: Record<string, unknown>;
  createdAt: string;
}

export type AuditLogEntry = AuditEvent | RunEvent;
export type AuditEventSource = "all" | "audit" | "run";
export type AuditExportFormat = "ndjson" | "csv";

export interface AuditEventFilters {
  source?: AuditEventSource;
  action?: string;
  runId?: string;
  resourceType?: string;
  resourceId?: string;
  actorPrincipalId?: string;
  decision?: AuditEvent["decision"];
  risk?: string;
  q?: string;
  since?: string;
  until?: string;
  limit?: number;
}

export interface AuditEventExport {
  filename: string;
  contentType: string;
  text: string;
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

export type HealthStatus = "ok" | "degraded" | "down" | "unknown";

export interface HealthComponent {
  name: string;
  status: HealthStatus;
  detail?: string;
  checkedAt?: string;
}

export interface HealthDashboard {
  status: HealthStatus;
  generatedAt: string;
  componentCount: number;
  healthy: boolean;
  statusCounts: Partial<Record<HealthStatus, number>>;
  unhealthy: Array<{ name: string; status: HealthStatus; reason: string }>;
  components: HealthComponent[];
}

export interface RunTracePhase {
  type: string;
  status: string;
  message?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
}

export interface RunTraceModelCall {
  model?: string;
  status?: string;
  message?: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface RunTraceToolCall {
  name?: string;
  status: string;
  message?: string;
  durationMs?: number;
}

export interface RunTraceApproval {
  decision: string;
  message?: string;
  at?: string;
}

export interface RunTrace {
  runId: string;
  eventCount: number;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  finalStatus: string;
  phases: RunTracePhase[];
  modelCalls: RunTraceModelCall[];
  toolCalls: RunTraceToolCall[];
  approvals: RunTraceApproval[];
}

export interface MemoryCitation {
  label: string;
  [key: string]: unknown;
}

export interface MemorySource {
  id: string;
  kind: string;
  sensitivity: string;
  placeId?: string;
  title?: string;
  createdAt: string;
}

export interface MemoryChunk {
  id: string;
  sourceId: string;
  sensitivity: string;
  placeId?: string;
  citation: MemoryCitation;
  text: string;
}

export interface MemoryInventory {
  sources: MemorySource[];
  chunks: MemoryChunk[];
}

export interface MemoryExcluded {
  chunk?: MemoryChunk;
  contentHash?: string;
  reason: string;
}

export interface MemoryRetrieval {
  placeId: string;
  identityId: string;
  isolated: boolean;
  allowed: MemoryChunk[];
  excluded: MemoryExcluded[];
}

export type BudgetState = "ok" | "warning" | "exceeded";

export interface BudgetStatus {
  budgetPolicyId: string;
  name: string;
  perDayCents: number;
  spentTodayCents: number;
  remainingTodayCents: number;
  utilization: number;
  state: BudgetState;
  runCountToday: number;
}

export interface BudgetStatusResponse {
  budgets: BudgetStatus[];
  alerts: BudgetStatus[];
}

export type IdentityScope =
  | "workspace"
  | "private_channel"
  | "dm"
  | "external"
  | string;

export interface CompartmentIdentity {
  id: string;
  orgId: string;
  scope: IdentityScope;
  name: string;
  baseline?: boolean;
  enabled: boolean;
  placeId?: string;
  accessBundleIds: string[];
}

export interface IdentityBinding {
  [key: string]: unknown;
}

export interface IdentitiesResponse {
  identities: CompartmentIdentity[];
  bindings: IdentityBinding[];
  derived: boolean;
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
  trust?: {
    durability: "durable_ledger" | "run_fallback";
    costBasis: "bek_benchmark_estimate" | "mixed";
    providerReconciled: boolean;
    completeness: "ledger_backed" | "run_totals_only";
    warnings: string[];
  };
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
    credentials: "include",
    headers: adminRequestHeaders(init?.method, init?.headers),
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

export function githubSetupPath(
  input: { installationId?: string | undefined } = {},
): string {
  const installationId = input.installationId?.trim();
  if (!installationId) {
    return "/api/setup/github";
  }
  const params = new URLSearchParams({ installationId });
  return `/api/setup/github?${params.toString()}`;
}

export async function fetchGitHubSetup(
  input: { installationId?: string | undefined } = {},
): Promise<GitHubSetupPreview> {
  return jsonRequest<GitHubSetupPreview>(githubSetupPath(input));
}

export async function fetchModelUsage(): Promise<ModelUsage> {
  return jsonRequest<ModelUsage>("/api/model-usage");
}

export async function fetchBudgetStatus(): Promise<BudgetStatusResponse> {
  return jsonRequest<BudgetStatusResponse>("/api/budgets/status");
}

export async function fetchIdentities(): Promise<IdentitiesResponse> {
  return jsonRequest<IdentitiesResponse>("/api/identities");
}

export function auditEventsPath(filters: AuditEventFilters = {}): string {
  const params = auditEventFilterParams(filters);
  const query = params.toString();
  return query ? `/api/audit-events?${query}` : "/api/audit-events";
}

export function auditEventsExportPath(
  format: AuditExportFormat,
  filters: AuditEventFilters = {},
): string {
  const params = auditEventFilterParams(filters);
  params.set("format", format);
  return `/api/audit-events/export?${params.toString()}`;
}

export async function fetchAuditEvents(
  filters: AuditEventFilters = {},
): Promise<AuditLogEntry[]> {
  return jsonRequest<AuditLogEntry[]>(auditEventsPath(filters));
}

export async function fetchAuditEventExport(
  format: AuditExportFormat,
  filters: AuditEventFilters = {},
): Promise<AuditEventExport> {
  const path = auditEventsExportPath(format, filters);
  const res = await fetch(`${readBekApiUrl()}${path}`, {
    credentials: "include",
    headers: adminAuthHeaders(),
  });
  if (!res.ok) {
    throw await apiError(path, res);
  }
  const fallbackName = `bek-audit.${format === "csv" ? "csv" : "ndjson"}`;
  return {
    filename:
      filenameFromContentDisposition(res.headers.get("content-disposition")) ??
      fallbackName,
    contentType:
      res.headers.get("content-type") ??
      (format === "csv" ? "text/csv" : "application/x-ndjson"),
    text: await res.text(),
  };
}

function auditEventFilterParams(filters: AuditEventFilters): URLSearchParams {
  const params = new URLSearchParams();
  appendOptionalParam(params, "source", filters.source);
  appendOptionalParam(params, "action", filters.action);
  appendOptionalParam(params, "runId", filters.runId);
  appendOptionalParam(params, "resourceType", filters.resourceType);
  appendOptionalParam(params, "resourceId", filters.resourceId);
  appendOptionalParam(params, "actorPrincipalId", filters.actorPrincipalId);
  appendOptionalParam(params, "decision", filters.decision);
  appendOptionalParam(params, "risk", filters.risk);
  appendOptionalParam(params, "q", filters.q);
  appendOptionalParam(params, "since", filters.since);
  appendOptionalParam(params, "until", filters.until);
  if (filters.limit !== undefined) {
    params.set("limit", String(filters.limit));
  }
  return params;
}

function appendOptionalParam(
  params: URLSearchParams,
  key: string,
  value: string | undefined,
) {
  const trimmed = value?.trim();
  if (trimmed) {
    params.set(key, trimmed);
  }
}

function filenameFromContentDisposition(
  disposition: string | null,
): string | undefined {
  const match = disposition?.match(/filename="([^"]+)"/i);
  return match?.[1];
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

export async function registerMcpConnector(input: {
  serverId: string;
  displayName: string;
  transport: McpTransportKind;
  origin: string;
  tags?: string[];
}): Promise<ConnectorInstall> {
  return jsonRequest<ConnectorInstall>("/api/connectors/mcp", {
    method: "POST",
    body: JSON.stringify(input),
    headers: { "content-type": "application/json" },
  });
}

export async function updateMcpConnector(input: {
  serverId: string;
  status?: McpConnectorStatus;
  displayName?: string;
  transport?: McpTransportKind;
  origin?: string;
  tags?: string[];
}): Promise<ConnectorInstall> {
  const { serverId, ...body } = input;
  return jsonRequest<ConnectorInstall>(
    `/api/connectors/mcp/${encodeURIComponent(serverId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    },
  );
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

export async function updateAccessBundle(input: {
  bundleId: string;
  name?: string;
  description?: string;
  budgetPolicyId?: string;
}): Promise<AccessBundle> {
  const { bundleId, ...body } = input;
  return jsonRequest<AccessBundle>(`/api/access-bundles/${bundleId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
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

export async function detachBundleFromPlace(input: {
  bundleId: string;
  placeId: string;
}): Promise<AccessBundle> {
  return jsonRequest<AccessBundle>(
    `/api/access-bundles/${input.bundleId}/places/${input.placeId}`,
    { method: "DELETE" },
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

export async function updateGrant(input: {
  bundleId: string;
  grantId: string;
  capability?: string;
  resource?: string;
  decision?: "allow" | "ask" | "deny";
  risk?: string;
  requiresApproval?: boolean;
}): Promise<CapabilityGrant> {
  const { bundleId, grantId, ...body } = input;
  return jsonRequest<CapabilityGrant>(
    `/api/access-bundles/${bundleId}/grants/${grantId}`,
    {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    },
  );
}

export async function deleteGrant(input: {
  bundleId: string;
  grantId: string;
}): Promise<CapabilityGrant> {
  return jsonRequest<CapabilityGrant>(
    `/api/access-bundles/${input.bundleId}/grants/${input.grantId}`,
    { method: "DELETE" },
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
    credentials: "include",
    headers: adminRequestHeaders("POST", {
      "content-type": "application/json",
    }),
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw await apiError("/api/runs", res);
  }
  return res.json() as Promise<Run>;
}

export async function fetchRunDetail(runId: string): Promise<RunDetail> {
  const res = await fetch(`${readBekApiUrl()}/api/runs/${runId}`, {
    credentials: "include",
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
      credentials: "include",
      headers: adminRequestHeaders("POST", {
        "content-type": "application/json",
      }),
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

export async function fetchHealthDashboard(): Promise<HealthDashboard> {
  return jsonRequest<HealthDashboard>("/api/health/dashboard");
}

export function runTracePath(runId: string): string {
  return `/api/runs/${encodeURIComponent(runId)}/trace`;
}

export async function fetchRunTrace(runId: string): Promise<RunTrace> {
  return jsonRequest<RunTrace>(runTracePath(runId));
}

export async function fetchMemoryInventory(): Promise<MemoryInventory> {
  return jsonRequest<MemoryInventory>("/api/memory/chunks");
}

export function memoryRetrievePath(placeId: string): string {
  const params = new URLSearchParams({ placeId });
  return `/api/memory/retrieve?${params.toString()}`;
}

export async function retrieveMemory(
  placeId: string,
): Promise<MemoryRetrieval> {
  return jsonRequest<MemoryRetrieval>(memoryRetrievePath(placeId));
}
