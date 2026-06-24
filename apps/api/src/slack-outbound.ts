import {
  type ApprovalRequest,
  type BekStore,
  type BekSnapshot,
  type CredentialRecord,
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

export class SlackOutboundDelivery {
  private readonly env: NodeJS.ProcessEnv;
  private readonly credentialVault: LocalCredentialVault | undefined;

  constructor(
    private readonly store: BekStore,
    private readonly client?: SlackWebApiClient | undefined,
    options: Omit<SlackOutboundDeliveryOptions, "slackClient"> = {},
  ) {
    this.env = options.env ?? process.env;
    this.credentialVault =
      options.credentialVault ?? createLocalCredentialVaultFromEnv(this.env);
  }

  get configured(): boolean {
    return Boolean(
      this.client || this.env.SLACK_BOT_TOKEN?.trim() || this.credentialVault,
    );
  }

  async deliverRunOutcome(
    runId: string,
    target: SlackOutboundTarget,
  ): Promise<void> {
    const resolvedTarget = resolveSlackTarget(target);
    if (!resolvedTarget) {
      return;
    }

    const snapshot = this.store.read();
    const run = findRun(snapshot, runId);
    if (!run) {
      return;
    }

    const pendingApproval = latestPendingApproval(snapshot, run.id);
    if (run.status === "awaiting_approval" && pendingApproval) {
      await this.postRunMessage({
        kind: "approval_needed",
        run,
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
      });
      return;
    }

    if (run.status === "completed") {
      await this.postRunMessage({
        kind: "final_answer",
        run,
        target: resolvedTarget,
        message: renderSlackFinalAnswerMessage({
          runId: run.id,
          answer: latestEventMessage(snapshot, run.id, "run.completed"),
        }),
      });
      return;
    }

    if (run.status === "failed") {
      await this.postRunMessage({
        kind: "final_answer",
        run,
        target: resolvedTarget,
        message: renderSlackFinalAnswerMessage({
          runId: run.id,
          title: "Bek could not complete this.",
          answer: latestEventMessage(snapshot, run.id, "run.failed"),
        }),
      });
      return;
    }

    if (run.status === "cancelled") {
      await this.postRunMessage({
        kind: "final_answer",
        run,
        target: resolvedTarget,
        message: renderSlackFinalAnswerMessage({
          runId: run.id,
          title: "Bek stopped.",
          answer: latestEventMessage(snapshot, run.id, "run.status_changed"),
        }),
      });
      return;
    }

    await this.postRunMessage({
      kind: "queued",
      run,
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
    });
  }

  async deliverApprovalDecision(
    approvalId: string,
    target: SlackOutboundTarget,
  ): Promise<void> {
    const resolvedTarget = resolveSlackTarget(target);
    if (!resolvedTarget) {
      return;
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
      return;
    }

    const run = findRun(snapshot, approval.runId);
    if (!run) {
      return;
    }

    await this.postRunMessage({
      kind: "approval_decision",
      run,
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
      await this.postRunMessage({
        kind: "final_answer",
        run,
        target: resolvedTarget,
        message: renderSlackFinalAnswerMessage({
          runId: run.id,
          answer: latestEventMessage(snapshot, run.id, "run.completed"),
        }),
      });
    }
  }

  private async postRunMessage(input: {
    kind: "queued" | "approval_needed" | "approval_decision" | "final_answer";
    run: Run;
    target: ResolvedSlackOutboundTarget;
    message: SlackMessagePayload;
  }): Promise<void> {
    const client = this.resolveClient(input.target);
    if (!client) {
      return;
    }

    let result: SlackWebApiMessageResult;
    try {
      result = await client.postMessage(
        slackPostMessageInput(input.target, input.message),
      );
    } catch (error) {
      result = {
        ok: false,
        error: error instanceof Error ? error.message : "Slack client threw.",
      };
    }
    this.recordDeliveryResult(input.run, input.kind, input.target, result);
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
    result: SlackWebApiMessageResult,
  ): void {
    this.store.appendRunEvent({
      runId: run.id,
      type: "run.status_changed",
      message: result.ok
        ? `Slack ${kind} message posted.`
        : `Slack ${kind} message failed: ${result.error}.`,
      data: compactRecord({
        slackOutbound: compactRecord({
          kind,
          ok: result.ok,
          channel: result.ok ? result.channel : target.channelId,
          threadTs: target.threadTs,
          ts: result.ok ? result.ts : undefined,
          error: result.ok ? undefined : result.error,
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
