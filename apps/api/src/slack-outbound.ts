import {
  type ApprovalRequest,
  type BekStore,
  type BekSnapshot,
  type CredentialRecord,
  redactSecrets,
  type Run,
  type RunEvent,
} from "@bek/core";
import {
  renderSlackApprovalDecidedMessage,
  renderSlackApprovalNeededMessage,
  renderSlackFinalAnswerMessage,
  renderSlackRunQueuedMessage,
  SlackWebApiHttpClient,
  type SlackMessagePayload,
  type SlackPostMessageInput,
  type SlackWebApiClient,
  type SlackWebApiMessageResult,
} from "@bek/slack";
import {
  createLocalCredentialVaultFromEnv,
  type LocalCredentialVault,
} from "./credential-vault";

export interface SlackOutboundDeliveryOptions {
  slackClient?: SlackWebApiClient | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  credentialVault?: LocalCredentialVault | undefined;
  maxPostAttempts?: number | undefined;
  retryDelayMs?: number | undefined;
}

export interface SlackOutboundTarget {
  channelId?: string | undefined;
  threadTs?: string | undefined;
  teamId?: string | undefined;
}

interface ResolvedSlackOutboundTarget {
  channelId: string;
  threadTs?: string | undefined;
  teamId?: string | undefined;
}

type SlackOutboundFailureCategory =
  | "auth"
  | "channel"
  | "config"
  | "payload"
  | "rate_limited"
  | "transient"
  | "unknown";

interface SlackOutboundFailureClassification {
  category: SlackOutboundFailureCategory;
  retryable: boolean;
}

interface SlackOutboundAttemptDiagnostic {
  attempt: number;
  ok: boolean;
  error?: string | undefined;
  failureCategory?: SlackOutboundFailureCategory | undefined;
  retryable?: boolean | undefined;
}

interface SlackOutboundPostResult {
  result: SlackWebApiMessageResult;
  attempts: SlackOutboundAttemptDiagnostic[];
}

export interface SlackOutboundDeliveryResult {
  attempted: boolean;
  ok: boolean;
  error?: string | undefined;
  retryable?: boolean | undefined;
}

export interface SlackPreparedOutboundMessage {
  kind: "queued" | "approval_needed" | "approval_decision" | "final_answer";
  runId: string;
  approvalId?: string | undefined;
  target: SlackOutboundTarget;
  message: SlackMessagePayload;
}

const defaultSlackPostMaxAttempts = 3;
const defaultSlackPostRetryDelayMs = 100;
const maximumSlackPostAttempts = 5;
const maxSlackOutboundErrorLength = 300;

export class SlackOutboundDelivery {
  private readonly env: NodeJS.ProcessEnv;
  private readonly credentialVault: LocalCredentialVault | undefined;
  private readonly maxPostAttempts: number;
  private readonly retryDelayMs: number;

  constructor(
    private readonly store: BekStore,
    private readonly client?: SlackWebApiClient | undefined,
    options: Omit<SlackOutboundDeliveryOptions, "slackClient"> = {},
  ) {
    this.env = options.env ?? process.env;
    this.credentialVault =
      options.credentialVault ?? createLocalCredentialVaultFromEnv(this.env);
    this.maxPostAttempts = normalizePositiveInteger(
      options.maxPostAttempts,
      defaultSlackPostMaxAttempts,
    );
    this.retryDelayMs = normalizeNonNegativeInteger(
      options.retryDelayMs,
      defaultSlackPostRetryDelayMs,
    );
  }

  get configured(): boolean {
    return Boolean(
      this.client || this.env.SLACK_BOT_TOKEN?.trim() || this.credentialVault,
    );
  }

  async deliverRunOutcome(
    runId: string,
    target: SlackOutboundTarget,
  ): Promise<SlackOutboundDeliveryResult> {
    const prepared = this.prepareRunOutcome(runId, target);
    return prepared
      ? this.deliverPreparedMessage(prepared)
      : slackOutboundSkipped("Run outcome could not be prepared.");
  }

  prepareRunOutcome(
    runId: string,
    target: SlackOutboundTarget,
  ): SlackPreparedOutboundMessage | undefined {
    const resolvedTarget = resolveSlackTarget(target);
    if (!resolvedTarget) {
      return undefined;
    }

    const snapshot = this.store.read();
    const run = findRun(snapshot, runId);
    if (!run) {
      return undefined;
    }

    const pendingApproval = latestPendingApproval(snapshot, run.id);
    if (run.status === "awaiting_approval" && pendingApproval) {
      return {
        kind: "approval_needed",
        runId: run.id,
        approvalId: pendingApproval.id,
        target: resolvedTarget,
        message: renderSlackApprovalNeededMessage({
          runId: run.id,
          approvalId: pendingApproval.id,
          payloadHash: pendingApproval.payloadHash,
          action: pendingApproval.action,
          risk: pendingApproval.risk,
          prompt: run.prompt,
          expiresAt: pendingApproval.expiresAt,
          ...optionalString(
            "requesterName",
            principalDisplayName(snapshot, run.requesterPrincipalId),
          ),
        }),
      };
    }

    if (run.status === "completed") {
      return {
        kind: "final_answer",
        runId: run.id,
        target: resolvedTarget,
        message: renderSlackFinalAnswerMessage({
          runId: run.id,
          answer: latestEventMessage(snapshot, run.id, "run.completed"),
        }),
      };
    }

    if (run.status === "failed") {
      return {
        kind: "final_answer",
        runId: run.id,
        target: resolvedTarget,
        message: renderSlackFinalAnswerMessage({
          runId: run.id,
          title: "Bek could not complete this.",
          answer: latestEventMessage(snapshot, run.id, "run.failed"),
        }),
      };
    }

    if (run.status === "cancelled") {
      return {
        kind: "final_answer",
        runId: run.id,
        target: resolvedTarget,
        message: renderSlackFinalAnswerMessage({
          runId: run.id,
          title: "Bek stopped.",
          answer: latestEventMessage(snapshot, run.id, "run.status_changed"),
        }),
      };
    }

    return {
      kind: "queued",
      runId: run.id,
      target: resolvedTarget,
      message: renderSlackRunQueuedMessage({
        runId: run.id,
        prompt: run.prompt,
        ...optionalString(
          "requesterName",
          principalDisplayName(snapshot, run.requesterPrincipalId),
        ),
        ...optionalString("channelName", placeName(snapshot, run.placeScopeId)),
      }),
    };
  }

  async deliverApprovalDecision(
    approvalId: string,
    target: SlackOutboundTarget,
  ): Promise<SlackOutboundDeliveryResult> {
    const prepared = this.prepareApprovalDecision(approvalId, target);
    if (prepared.length === 0) {
      return slackOutboundSkipped("Approval decision could not be prepared.");
    }
    return combineSlackDeliveryResults(
      await Promise.all(
        prepared.map((message) => this.deliverPreparedMessage(message)),
      ),
    );
  }

  prepareApprovalDecision(
    approvalId: string,
    target: SlackOutboundTarget,
  ): SlackPreparedOutboundMessage[] {
    const resolvedTarget = resolveSlackTarget(target);
    if (!resolvedTarget) {
      return [];
    }

    const snapshot = this.store.read();
    const approval = snapshot.approvals.find(
      (candidate) => candidate.id === approvalId,
    );
    if (
      !approval ||
      approval.status === "pending" ||
      approval.status === "expired"
    ) {
      return [];
    }

    const run = findRun(snapshot, approval.runId);
    if (!run) {
      return [];
    }

    const prepared: SlackPreparedOutboundMessage[] = [];
    prepared.push({
      kind: "approval_decision",
      runId: run.id,
      target: resolvedTarget,
      message: renderSlackApprovalDecidedMessage({
        runId: run.id,
        approvalId: approval.id,
        decision: approval.status,
        ...optionalString(
          "decidedByName",
          principalDisplayName(snapshot, approval.decidedByPrincipalId),
        ),
      }),
    });

    if (approval.status === "approved" && run.status === "completed") {
      prepared.push({
        kind: "final_answer",
        runId: run.id,
        target: resolvedTarget,
        message: renderSlackFinalAnswerMessage({
          runId: run.id,
          answer: latestEventMessage(snapshot, run.id, "run.completed"),
        }),
      });
    }
    return prepared;
  }

  async deliverSavedMessage(
    input: SlackPreparedOutboundMessage,
  ): Promise<SlackOutboundDeliveryResult> {
    return this.deliverPreparedMessage(input);
  }

  private async deliverPreparedMessage(
    input: SlackPreparedOutboundMessage,
  ): Promise<SlackOutboundDeliveryResult> {
    const resolvedTarget = resolveSlackTarget(input.target);
    if (!resolvedTarget) {
      return slackOutboundSkipped(
        "Slack outbound target is missing channel_id.",
      );
    }
    const client = this.resolveClient(resolvedTarget);
    if (!client) {
      return slackOutboundSkipped("Slack bot token is not configured.");
    }
    const run = findRun(this.store.read(), input.runId);
    if (!run) {
      return slackOutboundSkipped("Run not found for Slack outbound delivery.");
    }

    const delivery = await this.postMessageWithRetry(
      client,
      slackPostMessageInput(resolvedTarget, input.message),
    );
    this.recordDeliveryResult(run, input.kind, resolvedTarget, delivery);
    const finalAttempt = delivery.attempts.at(-1);
    return {
      attempted: true,
      ok: delivery.result.ok,
      error: delivery.result.ok ? undefined : finalAttempt?.error,
      retryable: delivery.result.ok ? undefined : finalAttempt?.retryable,
    };
  }

  private async postMessageWithRetry(
    client: SlackWebApiClient,
    message: SlackPostMessageInput,
  ): Promise<SlackOutboundPostResult> {
    const attempts: SlackOutboundAttemptDiagnostic[] = [];

    for (let attempt = 1; attempt <= this.maxPostAttempts; attempt += 1) {
      const result = await postSlackMessageOnce(client, message);
      const diagnostic = slackOutboundAttemptDiagnostic(attempt, result);
      attempts.push(diagnostic);

      if (result.ok) {
        return { result, attempts };
      }

      if (!diagnostic.retryable || attempt >= this.maxPostAttempts) {
        return { result, attempts };
      }

      await sleep(this.retryDelayMs * attempt);
    }

    const fallback: SlackWebApiMessageResult = {
      ok: false,
      error: "Slack outbound delivery was not attempted.",
    };
    return { result: fallback, attempts };
  }

  private resolveClient(
    target: ResolvedSlackOutboundTarget,
  ): SlackWebApiClient | undefined {
    if (this.client) {
      return this.client;
    }

    const storedToken = this.resolveStoredSlackBotToken(target.teamId);
    if (storedToken) {
      return new SlackWebApiHttpClient({ token: storedToken });
    }

    const envToken = this.env.SLACK_BOT_TOKEN?.trim();
    return envToken
      ? new SlackWebApiHttpClient({ token: envToken })
      : undefined;
  }

  private resolveStoredSlackBotToken(
    teamId?: string | undefined,
  ): string | undefined {
    if (!this.credentialVault) {
      return undefined;
    }
    if (!teamId) {
      return undefined;
    }

    const snapshot = this.store.read();
    const install = snapshot.connectorInstalls.find(
      (candidate) =>
        candidate.kind === "slack" &&
        candidate.provider === "slack" &&
        candidate.status === "active" &&
        candidate.externalId === teamId,
    );
    if (!install) {
      return undefined;
    }

    const credential = latestActiveSlackCredential(
      snapshot,
      install.id,
      install.externalId,
    );
    if (!credential) {
      return undefined;
    }

    try {
      return this.credentialVault.decryptSlackBotToken({ credential });
    } catch {
      return undefined;
    }
  }

  private recordDeliveryResult(
    run: Run,
    kind: string,
    target: ResolvedSlackOutboundTarget,
    delivery: SlackOutboundPostResult,
  ): void {
    const result = delivery.result;
    const attemptCount = Math.max(delivery.attempts.length, 1);
    const finalAttempt = delivery.attempts.at(-1);
    this.store.appendRunEvent({
      runId: run.id,
      type: "run.status_changed",
      message: slackOutboundDeliveryMessage(kind, delivery),
      data: compactRecord({
        slackOutbound: compactRecord({
          kind,
          ok: result.ok,
          channel: result.ok ? result.channel : target.channelId,
          threadTs: target.threadTs,
          ts: result.ok ? result.ts : undefined,
          attempts: attemptCount,
          retried: attemptCount > 1 ? true : undefined,
          error: result.ok ? undefined : finalAttempt?.error,
          failureCategory: result.ok
            ? undefined
            : finalAttempt?.failureCategory,
          retryable: result.ok ? undefined : finalAttempt?.retryable,
          attemptLog: attemptCount > 1 ? delivery.attempts : undefined,
        }),
      }),
    });
  }
}

export function createSlackOutboundDelivery(
  store: BekStore,
  options: SlackOutboundDeliveryOptions = {},
): SlackOutboundDelivery {
  if (options.slackClient) {
    return new SlackOutboundDelivery(store, options.slackClient, options);
  }
  return new SlackOutboundDelivery(store, undefined, options);
}

function slackOutboundSkipped(error: string): SlackOutboundDeliveryResult {
  return { attempted: false, ok: false, error, retryable: false };
}

function combineSlackDeliveryResults(
  results: SlackOutboundDeliveryResult[],
): SlackOutboundDeliveryResult {
  const failed = results.find((result) => !result.ok);
  if (!failed) {
    return { attempted: results.some((result) => result.attempted), ok: true };
  }
  return {
    attempted: results.some((result) => result.attempted),
    ok: false,
    error: failed.error,
    retryable: failed.retryable,
  };
}

async function postSlackMessageOnce(
  client: SlackWebApiClient,
  message: SlackPostMessageInput,
): Promise<SlackWebApiMessageResult> {
  try {
    return await client.postMessage(message);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Slack client threw.",
    };
  }
}

function slackOutboundAttemptDiagnostic(
  attempt: number,
  result: SlackWebApiMessageResult,
): SlackOutboundAttemptDiagnostic {
  if (result.ok) {
    return { attempt, ok: true };
  }

  const classification = classifySlackOutboundFailure(result.error);
  return {
    attempt,
    ok: false,
    error: sanitizeSlackOutboundError(result.error),
    failureCategory: classification.category,
    retryable: classification.retryable,
  };
}

function slackOutboundDeliveryMessage(
  kind: string,
  delivery: SlackOutboundPostResult,
): string {
  const attemptCount = Math.max(delivery.attempts.length, 1);
  if (delivery.result.ok) {
    return attemptCount > 1
      ? `Slack ${kind} message posted after ${attemptCount} attempts.`
      : `Slack ${kind} message posted.`;
  }

  const finalError =
    delivery.attempts.at(-1)?.error ??
    sanitizeSlackOutboundError(delivery.result.error);
  const suffix = finalError.endsWith(".") ? finalError : `${finalError}.`;
  return attemptCount > 1
    ? `Slack ${kind} message failed after ${attemptCount} attempts: ${suffix}`
    : `Slack ${kind} message failed: ${suffix}`;
}

function classifySlackOutboundFailure(
  error: string,
): SlackOutboundFailureClassification {
  const normalized = error.toLowerCase();

  if (
    /rate[_ -]?limit|ratelimited|too_many_requests|http\s+429\b/.test(
      normalized,
    )
  ) {
    return { category: "rate_limited", retryable: false };
  }

  if (
    /http\s+(500|502|503|504)\b|timeout|timed out|fetch failed|network|econnreset|econnrefused|ehostunreach|enetunreach|etimedout|socket hang up|temporarily unavailable|service_unavailable|server_error|internal_error|non-json|invalid response/.test(
      normalized,
    )
  ) {
    return { category: "transient", retryable: true };
  }

  if (
    /invalid_auth|not_authed|token_revoked|account_inactive|missing_scope|no_permission/.test(
      normalized,
    )
  ) {
    return { category: "auth", retryable: false };
  }

  if (
    /channel_not_found|not_in_channel|is_archived|method_not_supported_for_channel|restricted_action/.test(
      normalized,
    )
  ) {
    return { category: "channel", retryable: false };
  }

  if (/slack bot token is missing|token is missing/.test(normalized)) {
    return { category: "config", retryable: false };
  }

  if (
    /invalid_blocks|invalid_attachments|invalid_json|invalid_post_type|invalid_charset|msg_too_long|no_text|too_many_attachments/.test(
      normalized,
    )
  ) {
    return { category: "payload", retryable: false };
  }

  return { category: "unknown", retryable: false };
}

function sanitizeSlackOutboundError(error: string): string {
  const redacted = redactSecrets(error).replace(/\s+/g, " ").trim();
  const fallback = redacted || "Slack Web API call failed.";
  return fallback.length > maxSlackOutboundErrorLength
    ? `${fallback.slice(0, maxSlackOutboundErrorLength)}...`
    : fallback;
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(maximumSlackPostAttempts, Math.max(1, Math.floor(value)));
}

function normalizeNonNegativeInteger(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function slackPostMessageInput(
  target: ResolvedSlackOutboundTarget,
  message: SlackMessagePayload,
): SlackPostMessageInput {
  const input: SlackPostMessageInput = {
    ...message,
    channel: target.channelId,
  };
  if (target.threadTs) {
    input.thread_ts = target.threadTs;
  }
  return input;
}

function resolveSlackTarget(
  target: SlackOutboundTarget,
): ResolvedSlackOutboundTarget | undefined {
  if (!target.channelId) {
    return undefined;
  }
  return target.threadTs
    ? compactTarget({
        channelId: target.channelId,
        threadTs: target.threadTs,
        teamId: target.teamId,
      })
    : compactTarget({
        channelId: target.channelId,
        teamId: target.teamId,
      });
}

function latestActiveSlackCredential(
  snapshot: BekSnapshot,
  connectorInstallId: string,
  teamId?: string | undefined,
): CredentialRecord | undefined {
  return snapshot.credentials.find(
    (credential) =>
      credential.provider === "slack" &&
      credential.status === "active" &&
      (credential.connectorInstallId === connectorInstallId ||
        (teamId ? credential.externalAccountId === teamId : false)),
  );
}

function compactTarget(
  target: ResolvedSlackOutboundTarget,
): ResolvedSlackOutboundTarget {
  return Object.fromEntries(
    Object.entries(target).filter(([, value]) => value !== undefined),
  ) as unknown as ResolvedSlackOutboundTarget;
}

function latestPendingApproval(
  snapshot: BekSnapshot,
  runId: string,
): ApprovalRequest | undefined {
  const now = Date.now();
  return snapshot.approvals.find(
    (approval) =>
      approval.runId === runId &&
      approval.status === "pending" &&
      Date.parse(approval.expiresAt) > now,
  );
}

function latestEventMessage(
  snapshot: BekSnapshot,
  runId: string,
  eventType: RunEvent["type"],
): string {
  return (
    snapshot.events.find(
      (event) => event.runId === runId && event.type === eventType,
    )?.message ?? "Bek finished this run."
  );
}

function findRun(snapshot: BekSnapshot, runId: string): Run | undefined {
  return snapshot.runs.find((candidate) => candidate.id === runId);
}

function principalDisplayName(
  snapshot: BekSnapshot,
  principalId?: string | undefined,
): string | undefined {
  if (!principalId) {
    return undefined;
  }
  return snapshot.principals.find((principal) => principal.id === principalId)
    ?.displayName;
}

function placeName(snapshot: BekSnapshot, placeId: string): string | undefined {
  return snapshot.places.find((place) => place.id === placeId)?.name;
}

function compactRecord(
  input: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
}

function optionalString<K extends string>(
  key: K,
  value: string | undefined,
): Partial<Record<K, string>> {
  return value ? ({ [key]: value } as Partial<Record<K, string>>) : {};
}
