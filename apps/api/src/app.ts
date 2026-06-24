import { timingSafeEqual } from "node:crypto";
import {
  BekStore,
  bundlesForPlace,
  evaluatePolicy,
  redactSecrets,
  redactUnknown,
} from "@bek/core";
import type {
  CapabilityGrant,
  BekSnapshot,
  ConnectorInstall,
  CredentialRecord,
  OutboundDelivery,
  PlaceScope,
  Run,
  RunEvent,
} from "@bek/core";
import {
  createGitHubDraftPullRequestWorkflowPlan,
  createGitHubInstallationTokenRequest,
  parseGitHubRepoResource,
  validateGitHubAppConfig,
  type GitHubInstallationPermissionAccess,
  type GitHubInstallationTokenPermissions,
  type GitHubRepoResource,
} from "@bek/github";
import {
  buildSlackCommandErrorResponse,
  buildSlackCommandDurableKey,
  buildSlackCommandIgnoredResponse,
  buildSlackCommandQueuedResponse,
  buildSlackEphemeralResponse,
  buildSlackInteractionDurableKey,
  buildSlackEventDurableKey,
  createSlackOAuthState,
  exchangeSlackOAuthCode,
  normalizeSlackEvent,
  parseSlackRetryHeaders,
  parseSlackCommand,
  parseSlackInteraction,
  redactSlackInstallRecord,
  type SlackInstallRecord,
  type SlackWebApiClient,
  verifySlackOAuthState,
  verifySlackSignature,
} from "@bek/slack";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import {
  requireLocalCredentialVault,
  type LocalCredentialVault,
} from "./credential-vault";
import {
  createSlackOutboundDelivery,
  type SlackPreparedOutboundMessage,
} from "./slack-outbound";
import {
  LocalWorkerController,
  runAdvancementModeFromEnv,
  type RunAdvancementMode,
  type WorkerQueuePersistenceOptions,
} from "./worker-runtime";
import {
  modelUsageTotalsFromRuns,
  type ModelUsageRepository,
  type ModelUsageSink,
} from "./persistence";

export interface CreateAppOptions {
  runAdvancement?: RunAdvancementMode | undefined;
  slackClient?: SlackWebApiClient | undefined;
  workerQueuePersistence?: WorkerQueuePersistenceOptions | undefined;
  modelUsageRepository?: Partial<ModelUsageRepository> | undefined;
}

type CreateStoreRunInput = Parameters<BekStore["createRun"]>[0];
type ApprovalDecisionBody = Parameters<BekStore["decideApproval"]>[2];

export function createApp(
  store = new BekStore(),
  options: CreateAppOptions = {},
) {
  const app = new Hono();
  const modelUsageSink = modelUsageSinkFromRepository(
    options.modelUsageRepository,
  );
  const workerController = new LocalWorkerController(
    store,
    options.runAdvancement ?? runAdvancementModeFromEnv(),
    {
      persistence: options.workerQueuePersistence,
      modelUsageSink,
    },
  );
  const slackOutbound = createSlackOutboundDelivery(store, {
    slackClient: options.slackClient,
  });
  const rateLimitBuckets = new Map<string, RateLimitBucket>();
  app.use(
    "*",
    cors({
      origin: (origin) => {
        if (!origin) {
          return null;
        }
        return isAllowedAdminOrigin(origin) ? origin : null;
      },
      allowHeaders: [
        "authorization",
        "content-type",
        "x-slack-request-timestamp",
        "x-slack-signature",
      ],
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    }),
  );
  app.use("/api/*", async (c, next) => {
    const maxBytes = maxRequestBodyBytes();
    const contentLength = parseContentLength(c.req.header("content-length"));
    if (contentLength !== undefined && contentLength > maxBytes) {
      return requestBodyTooLarge(c, maxBytes);
    }

    const rawBody = await readRequestBodyWithinLimit(c.req.raw, maxBytes);
    if (rawBody?.ok === false) {
      return requestBodyTooLarge(c, maxBytes);
    }
    if (rawBody?.ok === true) {
      c.req.raw = new Request(c.req.raw.url, {
        method: c.req.raw.method,
        headers: c.req.raw.headers,
        body: rawBody.text,
        signal: c.req.raw.signal,
      });
    }

    await next();
  });
  app.use("/api/*", async (c, next) => {
    if (c.req.raw.method === "OPTIONS") {
      await next();
      return;
    }
    const result = consumeRateLimit(rateLimitBuckets, c);
    if (!result.allowed) {
      return rateLimitExceeded(c, result);
    }
    c.header("x-ratelimit-limit", String(result.limit));
    c.header("x-ratelimit-remaining", String(result.remaining));
    c.header("x-ratelimit-reset", String(Math.ceil(result.resetAt / 1000)));
    await next();
  });
  app.use("/api/*", async (c, next) => {
    if (isSlackPublicCallback(c.req.path)) {
      await next();
      return;
    }

    const token = process.env.BEK_ADMIN_API_TOKEN;
    const authRequired =
      process.env.NODE_ENV === "production" ||
      process.env.BEK_REQUIRE_ADMIN_AUTH === "true";
    if (!token) {
      if (authRequired) {
        return c.json(
          {
            error:
              "BEK_ADMIN_API_TOKEN is required when admin auth is enabled.",
          },
          500,
        );
      }
      await next();
      return;
    }
    if (!isExpectedBearerToken(c.req.header("authorization"), token)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  });
  app.onError((error, c) => {
    const message =
      error instanceof Error ? error.message : "Bek request failed.";
    const status = message.toLowerCase().includes("not found") ? 404 : 400;
    return c.json({ error: message }, status);
  });

  function createRunAndQueue(input: CreateStoreRunInput) {
    const run = store.createRun({
      ...input,
      advanceMode: workerController.enabled ? "worker" : "inline_stub",
    });
    if (workerController.enabled && run.status === "queued") {
      workerController.enqueueRun(run);
    }
    return latestRun(store, run.id);
  }

  async function createRunAndAdvance(input: CreateStoreRunInput) {
    const run = createRunAndQueue(input);
    if (workerController.enabled && run.status === "queued") {
      await workerController.drain({ maxItems: 10 });
      await workerController.flushChanges();
    }
    return latestRun(store, run.id);
  }

  function decideApprovalAndQueue(
    approvalId: string,
    decision: "approved" | "denied",
    input: ApprovalDecisionBody,
  ) {
    const approval = store.decideApproval(approvalId, decision, {
      ...input,
      advanceMode: workerController.enabled ? "worker" : "inline_stub",
    });
    if (workerController.enabled) {
      workerController.queueApprovalDecision(approval);
    }
    return latestApproval(store, approval.id);
  }

  async function decideApprovalAndAdvance(
    approvalId: string,
    decision: "approved" | "denied",
    input: ApprovalDecisionBody,
  ) {
    const approval = decideApprovalAndQueue(approvalId, decision, input);
    if (workerController.enabled && approval.status === "approved") {
      await workerController.drain({ maxItems: 10 });
      await workerController.flushChanges();
    }
    return latestApproval(store, approval.id);
  }

  async function flushChangesWithDeliveryRollback(deliveryKey?: string) {
    try {
      await workerController.flushChanges();
      await store.flushChanges();
    } catch (error) {
      if (deliveryKey) {
        store.removeIngressDelivery(deliveryKey, { recordChange: false });
      }
      throw error;
    }

    await workerController.flushModelUsageChanges();
  }

  async function flushSlackOutboundChanges() {
    try {
      await store.flushChanges();
    } catch {
      // Slack delivery diagnostics are best-effort. Ingress dedupe and run state
      // have already been flushed before outbound posting starts.
    }
  }

  function enqueueSlackPreparedMessage(
    message: SlackPreparedOutboundMessage,
    input: { approvalId?: string | undefined; now?: string | undefined } = {},
  ) {
    return store.enqueueOutboundDelivery({
      key: slackOutboundDeliveryKey(message, input.approvalId),
      kind:
        message.kind === "approval_decision"
          ? "slack.approval_decision"
          : "slack.run_outcome",
      runId: message.runId,
      approvalId: input.approvalId,
      target: slackOutboundTargetRecord(message),
      payload: message.message as unknown as Record<string, unknown>,
      now: input.now,
    });
  }

  function enqueueSlackRunOutcome(
    runId: string,
    target: {
      channelId?: string | undefined;
      threadTs?: string | undefined;
      teamId?: string | undefined;
    },
  ) {
    const prepared = slackOutbound.prepareRunOutcome(runId, target);
    return prepared ? enqueueSlackPreparedMessage(prepared) : undefined;
  }

  function enqueueSlackApprovalDecision(
    approvalId: string,
    target: {
      channelId?: string | undefined;
      threadTs?: string | undefined;
      teamId?: string | undefined;
    },
  ) {
    const nowMs = Date.now();
    const messages = slackOutbound.prepareApprovalDecision(approvalId, target);
    return messages.map((message, index) =>
      enqueueSlackPreparedMessage(message, {
        approvalId,
        now: new Date(nowMs - messages.length + index).toISOString(),
      }),
    );
  }

  async function drainSlackOutboundDeliveries(
    input: { limit?: number | undefined } = {},
  ) {
    const due = store.listDueOutboundDeliveries({
      provider: "slack",
      limit: input.limit ?? 10,
    });
    const results = [];
    for (const delivery of due) {
      const prepared = preparedSlackMessageFromOutboundDelivery(delivery);
      const delivering = store.beginOutboundDelivery(delivery.id);
      if (!prepared) {
        results.push(
          store.failOutboundDelivery({
            id: delivery.id,
            error:
              "Slack outbound delivery is missing persisted run, target, or payload.",
            retryable: false,
          }),
        );
        continue;
      }

      const result = await slackOutbound.deliverSavedMessage(prepared);
      results.push(
        result.ok
          ? store.completeOutboundDelivery(delivering.id)
          : store.failOutboundDelivery({
              id: delivering.id,
              error: result.error ?? "Slack outbound delivery failed.",
              retryable: result.retryable,
              retryDelayMs: result.retryable === false ? 0 : 5_000,
            }),
      );
    }
    await flushSlackOutboundChanges();
    return {
      attempted: due.length,
      deliveries: results,
    };
  }

  async function drainWorkerAndQueueSlackOutcomes() {
    if (!workerController.enabled) {
      return;
    }
    const result = await workerController.drain({ maxItems: 10 });
    enqueueSlackOutcomesForWorkerDrain(result);
    await workerController.flushChanges();
    await store.flushChanges();
    await workerController.flushModelUsageChanges();
  }

  let slackBackgroundWork: Promise<void> | undefined;
  function scheduleSlackBackgroundWork() {
    if (process.env.BEK_SLACK_BACKGROUND_DRAIN === "false") {
      return;
    }
    slackBackgroundWork ??= (async () => {
      try {
        await drainWorkerAndQueueSlackOutcomes();
        await drainSlackOutboundDeliveries({ limit: 25 });
      } catch {
        // Slack ingress has already been durably acknowledged. Operators can
        // retry queued work from the worker and outbound drain endpoints.
      } finally {
        slackBackgroundWork = undefined;
      }
    })();
  }

  function enqueueSlackOutcomesForWorkerDrain(
    result: Awaited<ReturnType<LocalWorkerController["drain"]>>,
  ) {
    const runIds = new Set<string>();
    for (const decision of result.decisions) {
      if (
        decision.decision === "processed" &&
        decision.settlement.decision !== "lost_lease"
      ) {
        runIds.add(decision.settlement.record.item.runId);
      }
    }
    for (const runId of runIds) {
      enqueueSlackRunOutcomesForKnownTargets(runId);
    }
  }

  function enqueueSlackRunOutcomesForKnownTargets(runId: string) {
    const snapshot = store.read();
    const targets = snapshot.outboundDeliveries.filter(
      (delivery) =>
        delivery.provider === "slack" &&
        delivery.kind === "slack.run_outcome" &&
        delivery.runId === runId,
    );
    for (const target of targets) {
      enqueueSlackRunOutcome(runId, slackTargetFromRecord(target.target));
    }
  }

  function persistSlackInstall(
    install: SlackInstallRecord,
    input: { credentialVault: LocalCredentialVault },
  ) {
    const snapshot = store.read();
    const now = new Date().toISOString();
    const teamName = install.teamName ?? install.teamId;
    const connectorInstall = store.upsertConnectorInstall({
      id: `connector_slack_${safeIdPart(install.teamId)}`,
      kind: "slack",
      provider: "slack",
      externalId: install.teamId,
      displayName: teamName,
      status: "active",
      metadata: {
        appId: install.appId,
        teamId: install.teamId,
        teamName: install.teamName,
        enterpriseId: install.enterpriseId,
        enterpriseName: install.enterpriseName,
        botUserId: install.botUserId,
        authedUserId: install.authedUserId,
        scopes: install.scope,
        installedAt: install.installedAt,
      },
      now,
    });
    const credentialId = `credential_slack_bot_${safeIdPart(install.teamId)}`;
    const encrypted = input.credentialVault.encryptSlackBotToken({
      orgId: snapshot.org.id,
      teamId: install.teamId,
      credentialId,
      botToken: install.botToken,
    });
    const credential = store.upsertCredential({
      id: credentialId,
      connectorInstallId: connectorInstall.id,
      name: `${teamName} Slack bot token`,
      provider: "slack",
      externalAccountId: install.teamId,
      secretRef: encrypted.secretRef,
      status: "active",
      scopeSummary: install.scope.join(","),
      metadata: {
        vaultEnvelope: encrypted.vaultEnvelope,
        fingerprint: encrypted.fingerprint,
        source: "slack_oauth",
      },
      now,
    });
    return { install: connectorInstall, credential };
  }

  app.get("/health", (c) =>
    c.json({
      ok: true,
      name: "bek-api",
      time: new Date().toISOString(),
    }),
  );

  app.get("/api/bootstrap", (c) => c.json(publicSnapshot(store.read())));
  app.get("/api/org", (c) => c.json(store.read().org));
  app.get("/api/agent", (c) => c.json(store.read().agent));
  app.patch("/api/agent", async (c) => {
    const body = updateAgentSchema.parse(await c.req.json());
    const agent = store.updateAgent(body);
    await store.flushChanges();
    return c.json(agent);
  });
  app.get("/api/capabilities", (c) => c.json(store.read().capabilityProfiles));
  app.get("/api/setup/status", (c) => {
    const snapshot = store.read();
    const slackChannels = snapshot.places.filter(
      (place) => place.kind === "slack_channel",
    );
    const pendingApprovals = snapshot.approvals.filter(
      (approval) => approval.status === "pending",
    );
    const slackInstall = latestSlackInstall(snapshot);
    const slackCredential =
      slackInstall?.status === "active"
        ? latestSlackCredential(
            snapshot,
            slackInstall.id,
            slackInstall.externalId,
          )
        : undefined;
    const githubGrantCount = snapshot.accessBundles
      .flatMap((bundle) => bundle.grants)
      .filter((grant) => grant.resource.startsWith("github:")).length;
    const singleVisibleAgent = snapshot.agent.handle === "@bek";
    const readyForLocalDemo =
      singleVisibleAgent &&
      slackChannels.length > 0 &&
      snapshot.accessBundles.length > 0 &&
      snapshot.modelPolicies.length > 0;
    const readyForWorkspace =
      readyForLocalDemo &&
      slackInstall?.status === "active" &&
      Boolean(slackCredential) &&
      snapshot.runtimeProfiles.length > 0 &&
      githubGrantCount > 0;
    return c.json({
      visibleHandle: snapshot.agent.handle,
      singleVisibleAgent,
      slackChannels: slackChannels.length,
      slackInstalled: Boolean(slackInstall),
      slackInstallStatus: slackInstall?.status ?? null,
      slackWorkspaceName: slackInstall?.displayName ?? null,
      slackWorkspaceId: slackInstall?.externalId ?? null,
      slackBotUserId:
        typeof slackInstall?.metadata?.botUserId === "string"
          ? slackInstall.metadata.botUserId
          : null,
      slackTokenStored: Boolean(slackCredential),
      accessBundles: snapshot.accessBundles.length,
      modelPolicies: snapshot.modelPolicies.length,
      runtimeProfiles: snapshot.runtimeProfiles.length,
      githubGrantCount,
      pendingApprovals: pendingApprovals.length,
      readyForLocalDemo,
      readyForWorkspace,
    });
  });
  app.get("/api/channels", (c) =>
    c.json(
      store
        .read()
        .places.filter((place) => place.kind === "slack_channel")
        .map(publicPlace),
    ),
  );
  app.get("/api/connectors/slack", (c) =>
    c.json(slackInstallSummaries(store.read())),
  );
  app.get("/api/setup/github", (c) =>
    c.json(
      githubSetupPreview(
        store.read(),
        c.req.query("installationId"),
        process.env.GITHUB_APP_INSTALLATION_ID,
      ),
    ),
  );
  app.post("/api/channels", async (c) => {
    const body = createChannelSchema.parse(await c.req.json());
    const { externalTeamId, ...placeInput } = body;
    const channel = store.createPlace({
      kind: "slack_channel",
      provider: "slack",
      ...placeInput,
      ...(externalTeamId ? { metadata: { teamId: externalTeamId } } : {}),
    });
    await store.flushChanges();
    return c.json(channel, 201);
  });
  app.get("/api/channels/:channelId", (c) => {
    const snapshot = store.read();
    const channel = snapshot.places.find(
      (place) =>
        place.id === c.req.param("channelId") ||
        place.externalId === c.req.param("channelId"),
    );
    if (!channel) {
      return c.json({ error: "Channel not found" }, 404);
    }
    const bundles = snapshot.accessBundles.filter((bundle) =>
      bundle.attachedPlaceIds.includes(channel.id),
    );
    const runs = snapshot.runs
      .filter((run) => run.placeScopeId === channel.id)
      .map(publicRun);
    return c.json({ channel: publicPlace(channel), bundles, runs });
  });
  app.patch("/api/channels/:channelId", async (c) => {
    const body = updateChannelSchema.parse(await c.req.json());
    const { externalTeamId, ...placeInput } = body;
    const channel = store.updatePlace(c.req.param("channelId"), {
      ...placeInput,
      ...(externalTeamId ? { metadata: { teamId: externalTeamId } } : {}),
    });
    await store.flushChanges();
    return c.json(channel);
  });
  app.delete("/api/channels/:channelId", async (c) => {
    const channel = store.deletePlace(c.req.param("channelId"));
    await store.flushChanges();
    return c.json(channel);
  });
  app.get("/api/access-bundles", (c) => c.json(store.read().accessBundles));
  app.post("/api/access-bundles", async (c) => {
    const body = createAccessBundleSchema.parse(await c.req.json());
    const bundle = store.createAccessBundle(body);
    await store.flushChanges();
    return c.json(bundle, 201);
  });
  app.patch("/api/access-bundles/:bundleId", async (c) => {
    const body = updateAccessBundleSchema.parse(await c.req.json());
    const bundle = store.updateAccessBundle(c.req.param("bundleId"), body);
    await store.flushChanges();
    return c.json(bundle);
  });
  app.post("/api/access-bundles/:bundleId/places", async (c) => {
    const body = attachPlaceSchema.parse(await c.req.json());
    const bundle = store.attachBundleToPlace(
      c.req.param("bundleId"),
      body.placeId,
    );
    await store.flushChanges();
    return c.json(bundle);
  });
  app.delete("/api/access-bundles/:bundleId/places/:placeId", async (c) => {
    const bundle = store.detachBundleFromPlace(
      c.req.param("bundleId"),
      c.req.param("placeId"),
    );
    await store.flushChanges();
    return c.json(bundle);
  });
  app.post("/api/access-bundles/:bundleId/grants", async (c) => {
    const body = grantSchema.parse(await c.req.json());
    const grant = store.createGrant(c.req.param("bundleId"), body);
    await store.flushChanges();
    return c.json(grant, 201);
  });
  app.patch("/api/access-bundles/:bundleId/grants/:grantId", async (c) => {
    const body = updateGrantSchema.parse(await c.req.json());
    const grant = store.updateGrant(
      c.req.param("bundleId"),
      c.req.param("grantId"),
      body,
    );
    await store.flushChanges();
    return c.json(grant);
  });
  app.delete("/api/access-bundles/:bundleId/grants/:grantId", async (c) => {
    const grant = store.deleteGrant(
      c.req.param("bundleId"),
      c.req.param("grantId"),
    );
    await store.flushChanges();
    return c.json(grant);
  });
  app.get("/api/model-policies", (c) => c.json(store.read().modelPolicies));
  app.patch("/api/model-policies/:modelPolicyId", async (c) => {
    const body = updateModelPolicySchema.parse(await c.req.json());
    const policy = store.updateModelPolicy(c.req.param("modelPolicyId"), body);
    await store.flushChanges();
    return c.json(policy);
  });
  app.get("/api/runtime-profiles", (c) => c.json(store.read().runtimeProfiles));
  app.patch("/api/runtime-profiles/:runtimeProfileId", async (c) => {
    const body = updateRuntimeProfileSchema.parse(await c.req.json());
    const profile = store.updateRuntimeProfile(
      c.req.param("runtimeProfileId"),
      body,
    );
    await store.flushChanges();
    return c.json(profile);
  });
  app.get("/api/runs", (c) => c.json(store.read().runs.map(publicRun)));
  app.get("/api/approvals", (c) => c.json(store.read().approvals));
  app.get("/api/audit-events", (c) =>
    c.json(store.read().events.map(publicRunEvent)),
  );
  app.get("/api/model-usage", async (c) => {
    const snapshot = store.read();
    const repositoryTotals =
      await options.modelUsageRepository?.readModelUsageTotals?.(
        snapshot.org.id,
      );
    return c.json({
      ...(repositoryTotals ?? modelUsageTotalsFromRuns(snapshot.runs)),
      source: repositoryTotals ? "model_usage" : "runs",
    });
  });
  app.get("/api/runs/:runId", (c) => {
    const snapshot = store.read();
    const run = snapshot.runs.find(
      (candidate) => candidate.id === c.req.param("runId"),
    );
    if (!run) {
      return c.json({ error: "Run not found" }, 404);
    }
    return c.json({
      run: publicRun(run),
      events: snapshot.events
        .filter((event) => event.runId === run.id)
        .map(publicRunEvent),
      approvals: snapshot.approvals.filter(
        (approval) => approval.runId === run.id,
      ),
    });
  });
  app.get("/api/runs/:runId/events", (c) => {
    const events = store
      .read()
      .events.filter((event) => event.runId === c.req.param("runId"));
    return c.json(events.map(publicRunEvent));
  });
  app.get("/api/worker/queue", (c) =>
    c.json({
      mode: workerController.mode,
      enabled: workerController.enabled,
      queue: workerController.read(),
    }),
  );
  app.get("/api/outbound/slack", (c) =>
    c.json({
      deliveries: store
        .read()
        .outboundDeliveries.filter((delivery) => delivery.provider === "slack"),
    }),
  );
  app.post("/api/outbound/slack/drain", async (c) => {
    const body = drainOutboundSchema.parse(
      await c.req.json().catch(() => ({})),
    );
    const outbound = await drainSlackOutboundDeliveries(body);
    return c.json({ outbound });
  });
  app.post("/api/worker/drain", async (c) => {
    if (!workerController.enabled) {
      return c.json(
        {
          error:
            "Local worker advancement is disabled. Set BEK_RUN_ADVANCEMENT=worker_local to use this endpoint.",
        },
        409,
      );
    }
    const body = drainWorkerSchema.parse(await c.req.json().catch(() => ({})));
    const result = await workerController.drain(body);
    enqueueSlackOutcomesForWorkerDrain(result);
    await workerController.flushChanges();
    await store.flushChanges();
    await workerController.flushModelUsageChanges();
    const outbound = await drainSlackOutboundDeliveries({ limit: 25 });
    return c.json({
      mode: workerController.mode,
      enabled: workerController.enabled,
      result,
      outbound,
      queue: workerController.read(),
    });
  });

  app.post("/api/worker/dead-letters/:deadLetterId/redrive", async (c) => {
    if (!workerController.enabled) {
      return c.json(
        {
          error:
            "Dead-letter redrive requires BEK_RUN_ADVANCEMENT=worker_local.",
        },
        409,
      );
    }
    const snapshot = store.read();
    const deadLetterId = c.req.param("deadLetterId");
    const deadLetter = workerController
      .read()
      .deadLetters.find(
        (candidate) =>
          candidate.id === deadLetterId &&
          candidate.item.orgId === snapshot.org.id,
      );
    if (!deadLetter) {
      return c.json({ error: "Dead letter not found" }, 404);
    }
    const run = snapshot.runs.find(
      (candidate) =>
        candidate.id === deadLetter.item.runId &&
        candidate.orgId === snapshot.org.id,
    );
    if (!run) {
      return c.json({ error: "Dead-lettered run not found" }, 409);
    }

    const body = redriveDeadLetterSchema.parse(
      await c.req.json().catch(() => ({})),
    );
    const decision = workerController.redriveDeadLetter({
      orgId: snapshot.org.id,
      deadLetterId,
      reason: body.reason ?? "Queued dead-letter redrive from Bek admin.",
    });
    if (decision.decision === "not_found") {
      return c.json({ error: decision.reason }, 404);
    }
    if (decision.decision === "active_work_exists") {
      return c.json(
        {
          mode: workerController.mode,
          enabled: workerController.enabled,
          decision,
          run: publicRun(run),
          queue: workerController.read(),
        },
        409,
      );
    }

    store.setRunStatus({
      runId: run.id,
      status: "queued",
      actualCostCents: run.actualCostCents,
      message: body.reason ?? "Bek queued a dead-letter redrive.",
      data: {
        workerDecision: decision.decision,
        deadLetterId,
        workerRecordId: decision.record.id,
      },
    });
    await workerController.flushChanges();
    await store.flushChanges();
    await workerController.flushModelUsageChanges();
    return c.json({
      mode: workerController.mode,
      enabled: workerController.enabled,
      decision,
      run: publicRun(latestRun(store, run.id)),
      queue: workerController.read(),
    });
  });

  app.post("/api/runs/:runId/cancel", async (c) => {
    if (!workerController.enabled) {
      return c.json(
        {
          error: "Run cancellation requires BEK_RUN_ADVANCEMENT=worker_local.",
        },
        409,
      );
    }
    const snapshot = store.read();
    const run = snapshot.runs.find(
      (candidate) => candidate.id === c.req.param("runId"),
    );
    if (!run) {
      return c.json({ error: "Run not found" }, 404);
    }
    if (isTerminalRunStatus(run.status)) {
      return c.json({
        mode: workerController.mode,
        decision: { decision: "already_terminal", affectedRecords: [] },
        run: publicRun(run),
        queue: workerController.read(),
      });
    }

    const body = cancelRunSchema.parse(await c.req.json().catch(() => ({})));
    const decision = workerController.cancelRun(
      run,
      body.reason ?? "Cancelled from Bek admin.",
    );
    const claimedCancellation =
      decision.decision === "cancel_requested" &&
      decision.affectedRecords.some((record) => record.status === "claimed");
    if (!claimedCancellation) {
      store.setRunStatus({
        runId: run.id,
        status: "cancelled",
        actualCostCents: run.actualCostCents,
        message: body.reason ?? "Bek run cancelled.",
        data: { workerCancelDecision: decision.decision },
      });
    }
    await workerController.flushChanges();
    await store.flushChanges();
    await workerController.flushModelUsageChanges();
    return c.json({
      mode: workerController.mode,
      decision,
      run: publicRun(latestRun(store, run.id)),
      queue: workerController.read(),
    });
  });

  app.post("/api/runs", async (c) => {
    const body = createRunSchema.parse(await c.req.json());
    const run = await createRunAndAdvance(body);
    await store.flushChanges();
    await workerController.flushModelUsageChanges();
    return c.json(run, 201);
  });

  app.post("/api/approvals/:approvalId/approve", async (c) => {
    const body = approvalDecisionSchema.parse(await c.req.json());
    const approval = await decideApprovalAndAdvance(
      c.req.param("approvalId"),
      "approved",
      body,
    );
    await store.flushChanges();
    await workerController.flushModelUsageChanges();
    return c.json(approval);
  });

  app.post("/api/approvals/:approvalId/deny", async (c) => {
    const body = approvalDecisionSchema.parse(await c.req.json());
    const approval = await decideApprovalAndAdvance(
      c.req.param("approvalId"),
      "denied",
      body,
    );
    await store.flushChanges();
    await workerController.flushModelUsageChanges();
    return c.json(approval);
  });

  app.post("/api/policy/evaluate", async (c) => {
    const body = policySchema.parse(await c.req.json());
    const snapshot = store.read();
    const place = snapshot.places.find(
      (candidate) => candidate.id === body.placeScopeId,
    );
    if (!place) {
      return c.json({ error: "Place not found" }, 404);
    }
    return c.json(
      evaluatePolicy(bundlesForPlace(snapshot.accessBundles, place), {
        placeScopeId: body.placeScopeId,
        capability: body.capability,
        resource: body.resource,
      }),
    );
  });

  app.get("/api/slack/install", (c) => {
    const missing = missingEnv([
      "SLACK_CLIENT_ID",
      "SLACK_REDIRECT_URI",
      "SLACK_STATE_SECRET",
    ]);
    if (missing.length > 0) {
      return c.json(slackConfigError("Slack install", missing), 500);
    }

    const install = slackInstallAuthorization({
      returnTo: c.req.query("return_to") ?? c.req.query("returnTo"),
    });

    return c.redirect(install.url, 302);
  });

  app.get("/api/slack/install-url", (c) => {
    const missing = missingEnv([
      "SLACK_CLIENT_ID",
      "SLACK_REDIRECT_URI",
      "SLACK_STATE_SECRET",
    ]);
    if (missing.length > 0) {
      return c.json(slackConfigError("Slack install", missing), 500);
    }

    const install = slackInstallAuthorization({
      returnTo: c.req.query("return_to") ?? c.req.query("returnTo"),
      callbackMode: "redirect",
    });

    c.header("cache-control", "no-store");
    return c.json({
      ok: true,
      url: install.url,
      scopes: install.scopes,
      redirectUri: process.env.SLACK_REDIRECT_URI!,
      exchangeEnabled: shouldExchangeSlackOAuth(),
      tokenStorageConfigured: Boolean(
        process.env.BEK_CREDENTIAL_MASTER_KEY?.trim(),
      ),
    });
  });

  app.get("/api/slack/oauth/callback", async (c) => {
    const slackError = c.req.query("error");
    if (slackError) {
      return c.json(
        { ok: false, error: `Slack OAuth returned ${slackError}.` },
        400,
      );
    }

    if (!c.req.query("code")) {
      return c.json(
        { ok: false, error: "Slack OAuth callback is missing code." },
        400,
      );
    }

    const state = verifySlackOAuthState({
      stateSecret: process.env.SLACK_STATE_SECRET,
      state: c.req.query("state"),
    });
    if (!state.ok) {
      return c.json(
        { ok: false, error: state.reason },
        state.reason.includes("SLACK_STATE_SECRET") ? 500 : 400,
      );
    }

    const missing = missingEnv([
      "SLACK_CLIENT_ID",
      "SLACK_CLIENT_SECRET",
      "SLACK_REDIRECT_URI",
    ]);
    if (missing.length > 0) {
      if (state.payload.callbackMode === "redirect") {
        return c.redirect(
          adminReturnUrl(state.payload.returnTo, {
            slack_install: "error",
            slack_error: `missing_${missing.join("_")}`,
          }),
          302,
        );
      }
      return c.json(slackConfigError("Slack OAuth callback", missing), 500);
    }

    if (!shouldExchangeSlackOAuth()) {
      if (state.payload.callbackMode === "redirect") {
        return c.redirect(
          adminReturnUrl(state.payload.returnTo, {
            slack_install: "validated",
          }),
          302,
        );
      }
      return c.json(
        {
          ok: true,
          status: "state_validated",
          message:
            "Slack OAuth callback state validated. Set BEK_SLACK_OAUTH_EXCHANGE=true to exchange the code in local mode.",
          codeReceived: true,
          returnTo: state.payload.returnTo ?? null,
        },
        202,
      );
    }

    let credentialVault;
    try {
      credentialVault = requireLocalCredentialVault();
    } catch (error) {
      if (state.payload.callbackMode === "redirect") {
        return c.redirect(
          adminReturnUrl(state.payload.returnTo, {
            slack_install: "error",
            slack_error: "token_storage_not_configured",
          }),
          302,
        );
      }
      return c.json(
        {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : "Slack OAuth token storage is not configured.",
        },
        500,
      );
    }

    const exchange = await exchangeSlackOAuthCode({
      clientId: process.env.SLACK_CLIENT_ID!,
      clientSecret: process.env.SLACK_CLIENT_SECRET!,
      code: c.req.query("code")!,
      redirectUri: process.env.SLACK_REDIRECT_URI!,
    });
    if (!exchange.ok) {
      if (state.payload.callbackMode === "redirect") {
        return c.redirect(
          adminReturnUrl(state.payload.returnTo, {
            slack_install: "error",
            slack_error: "oauth_exchange_failed",
          }),
          302,
        );
      }
      return c.json(
        {
          ok: false,
          error: exchange.error,
          returnTo: state.payload.returnTo ?? null,
        },
        400,
      );
    }

    const persistedInstall = persistSlackInstall(exchange.install, {
      credentialVault,
    });
    await store.flushChanges();

    if (state.payload.callbackMode === "redirect") {
      return c.redirect(
        adminReturnUrl(state.payload.returnTo, {
          slack_install: "installed",
          slack_workspace: exchange.install.teamId,
        }),
        302,
      );
    }

    return c.json({
      ok: true,
      status: "installed",
      install: redactSlackInstallRecord(exchange.install),
      connectorInstall: publicConnectorInstall(persistedInstall.install),
      credential: publicCredential(persistedInstall.credential),
      tokenStored: true,
      returnTo: state.payload.returnTo ?? null,
    });
  });

  app.post("/api/slack/interactivity", async (c) => {
    const rawBody = await c.req.text();
    const retry = slackRetryForRequest(c);
    if (
      !isVerifiedSlackRequest({
        rawBody,
        timestamp: c.req.header("x-slack-request-timestamp"),
        signature: c.req.header("x-slack-signature"),
      })
    ) {
      markSlackNoRetry(c);
      return c.json(
        withSlackRetryMetadata({ error: "Invalid Slack signature" }, retry),
        401,
      );
    }

    const interaction = parseSlackInteraction(rawBody);
    if (interaction.type !== "approval") {
      return c.json(
        buildSlackEphemeralResponse({
          ok: true,
          ignored: true,
          reason: interaction.reason,
          text: interaction.reason,
        }),
      );
    }

    const interactionKey = buildSlackInteractionDurableKey(interaction);
    if (interactionKey && store.findIngressDelivery(interactionKey)) {
      acknowledgeSlackRetry(c, retry);
      return c.json({
        ...withSlackRetryMetadata(
          {
            ...buildSlackEphemeralResponse({
              ok: true,
              text: "Bek already handled this approval action.",
            }),
            ok: true,
            deduped: true,
          },
          retry,
        ),
      });
    }

    if (!interaction.slackUserId) {
      markSlackNoRetry(c);
      return c.json(
        withSlackRetryMetadata(
          buildSlackEphemeralResponse({
            ok: false,
            error: "Slack approval payload is missing user.id.",
            text: "Bek could not identify the Slack user who clicked this approval.",
          }),
          retry,
        ),
        400,
      );
    }

    const principalId = slackPrincipalIdForUser(interaction.slackUserId);
    if (!principalId) {
      markSlackNoRetry(c);
      return c.json(
        withSlackRetryMetadata(
          buildSlackEphemeralResponse({
            ok: false,
            error: `Slack user ${interaction.slackUserId} is not mapped to a Bek principal. Set BEK_SLACK_USER_PRINCIPAL_MAP or approve in the admin API.`,
            text: "Bek parsed this approval button, but this Slack user is not mapped to an approver yet.",
          }),
          retry,
        ),
        400,
      );
    }

    const approval = decideApprovalAndQueue(
      interaction.approvalId,
      interaction.decision,
      {
        principalId,
        payloadHash: interaction.payloadHash,
      },
    );
    if (interactionKey) {
      store.recordIngressDelivery({
        key: interactionKey,
        kind: "slack.interaction",
        status: "processed",
        approvalId: approval.id,
        response: {
          approvalId: approval.id,
          decision: interaction.decision,
        },
      });
    }
    enqueueSlackApprovalDecision(approval.id, {
      channelId: interaction.channelId,
      threadTs: interaction.messageTs,
      teamId: interaction.teamId,
    });
    await flushChangesWithDeliveryRollback(interactionKey);
    scheduleSlackBackgroundWork();

    return c.json({
      ...buildSlackEphemeralResponse({
        ok: true,
        text:
          interaction.decision === "approved"
            ? "Bek approved the request."
            : "Bek denied the request.",
      }),
      ok: true,
      approval,
    });
  });

  app.post("/api/slack/commands", async (c) => {
    const rawBody = await c.req.text();
    const retry = slackRetryForRequest(c);
    if (
      !isVerifiedSlackRequest({
        rawBody,
        timestamp: c.req.header("x-slack-request-timestamp"),
        signature: c.req.header("x-slack-signature"),
      })
    ) {
      markSlackNoRetry(c);
      return c.json(
        withSlackRetryMetadata({ error: "Invalid Slack signature" }, retry),
        401,
      );
    }

    const command = parseSlackCommand(rawBody);
    const commandKey = buildSlackCommandDurableKey(command);
    const existingCommand = commandKey
      ? store.findIngressDelivery(commandKey)
      : undefined;
    if (existingCommand) {
      const response =
        existingCommand.response ??
        (existingCommand.runId
          ? buildSlackCommandQueuedResponse({ runId: existingCommand.runId })
          : buildSlackCommandIgnoredResponse({
              reason: "Bek already handled this Slack command.",
              text: "Bek already handled this Slack command.",
            }));
      acknowledgeSlackRetry(c, retry);
      return c.json({
        ...withSlackRetryMetadata(
          {
            ...response,
            deduped: true,
          },
          retry,
        ),
      });
    }

    if (!command.channelId) {
      markSlackNoRetry(c);
      return c.json(
        withSlackRetryMetadata(
          buildSlackCommandErrorResponse({
            error: "Slack command payload is missing channel_id.",
            text: "Bek could not identify the Slack channel for this command.",
          }),
          retry,
        ),
        400,
      );
    }

    const snapshot = store.read();
    const place = resolveSlackPlace(
      snapshot,
      command.channelId,
      command.teamId,
    );
    if (!place) {
      const response = buildSlackCommandIgnoredResponse({
        reason: "Bek is not configured for this Slack channel.",
        text: "Bek is not configured for this Slack channel yet.",
      });
      if (commandKey) {
        store.recordIngressDelivery({
          key: commandKey,
          kind: "slack.command",
          status: "ignored",
          response: { ...response },
        });
        await flushChangesWithDeliveryRollback(commandKey);
      }
      return c.json(response);
    }

    const requesterPrincipalId = slackPrincipalIdForUser(command.userId);
    if (!requesterPrincipalId) {
      const response = buildSlackCommandIgnoredResponse({
        reason: slackUserMappingReason(command.userId),
        text: slackUserMappingText(command.userId),
      });
      if (commandKey) {
        store.recordIngressDelivery({
          key: commandKey,
          kind: "slack.command",
          status: "ignored",
          response: { ...response },
        });
        await flushChangesWithDeliveryRollback(commandKey);
      }
      return c.json(response);
    }

    const run = createRunAndQueue({
      placeScopeId: place.id,
      prompt: command.text.trim() || `${command.command || "/bek"} help`,
      requesterPrincipalId,
      trigger: "slash_command",
      capability: "slack.read",
      resource: `slack:${place.externalId}`,
    });
    const response = buildSlackCommandQueuedResponse({ runId: run.id });
    if (commandKey) {
      store.recordIngressDelivery({
        key: commandKey,
        kind: "slack.command",
        status: "processed",
        runId: run.id,
        response: { ...response },
      });
    }
    enqueueSlackRunOutcome(run.id, {
      channelId: command.channelId,
      teamId: command.teamId,
    });
    await flushChangesWithDeliveryRollback(commandKey);
    scheduleSlackBackgroundWork();

    return c.json(response);
  });

  app.post("/api/slack/events", async (c) => {
    const rawBody = await c.req.text();
    const retry = slackRetryForRequest(c);
    const verified = isVerifiedSlackRequest({
      rawBody,
      timestamp: c.req.header("x-slack-request-timestamp"),
      signature: c.req.header("x-slack-signature"),
    });
    if (!verified) {
      markSlackNoRetry(c);
      return c.json(
        withSlackRetryMetadata({ error: "Invalid Slack signature" }, retry),
        401,
      );
    }

    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(rawBody) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Slack event payload must be a JSON object.");
      }
      payload = parsed as Record<string, unknown>;
    } catch {
      markSlackNoRetry(c);
      return c.json(
        withSlackRetryMetadata(
          {
            ok: false,
            error: "Slack event payload must be valid JSON.",
          },
          retry,
        ),
        400,
      );
    }
    const eventKey = buildSlackEventDurableKey(payload);
    const existingEvent = eventKey
      ? store.findIngressDelivery(eventKey)
      : undefined;
    if (existingEvent) {
      acknowledgeSlackRetry(c, retry);
      return c.json(
        withSlackRetryMetadata(
          duplicateSlackEventResponse(existingEvent),
          retry,
        ),
      );
    }
    const event = normalizeSlackEvent(payload);
    if (event.type === "url_verification") {
      return c.json({ challenge: event.challenge });
    }
    if (event.type === "mention" || event.type === "reaction") {
      const snapshot = store.read();
      if (!event.channelId) {
        const response = {
          ok: false,
          ignored: true,
          reason: "Slack event payload is missing channel.",
        };
        if (eventKey) {
          store.recordIngressDelivery({
            key: eventKey,
            kind: "slack.event",
            status: "ignored",
            response: { ...response },
          });
          await flushChangesWithDeliveryRollback(eventKey);
        }
        markSlackNoRetry(c);
        return c.json(withSlackRetryMetadata(response, retry));
      }
      const place = resolveSlackPlace(snapshot, event.channelId, event.teamId);
      if (!place) {
        const response = {
          ok: false,
          ignored: true,
          reason: "Bek is not configured for this Slack channel.",
        };
        if (eventKey) {
          store.recordIngressDelivery({
            key: eventKey,
            kind: "slack.event",
            status: "ignored",
            response: { ...response },
          });
          await flushChangesWithDeliveryRollback(eventKey);
        }
        return c.json(response);
      }
      const requesterPrincipalId = slackPrincipalIdForUser(event.userId);
      if (!requesterPrincipalId) {
        const response = {
          ok: false,
          ignored: true,
          reason: slackUserMappingReason(event.userId),
        };
        if (eventKey) {
          store.recordIngressDelivery({
            key: eventKey,
            kind: "slack.event",
            status: "ignored",
            response: { ...response },
          });
          await flushChangesWithDeliveryRollback(eventKey);
        }
        markSlackNoRetry(c);
        return c.json(withSlackRetryMetadata(response, retry));
      }
      const run = createRunAndQueue({
        placeScopeId: place.id,
        prompt:
          event.text ?? `Reaction ${event.reaction ?? "agent"} triggered Bek`,
        requesterPrincipalId,
        trigger: event.type,
        capability: "slack.read",
        resource: `slack:${place.externalId}`,
      });
      const response = { ok: true, runId: run.id };
      if (eventKey) {
        store.recordIngressDelivery({
          key: eventKey,
          kind: "slack.event",
          status: "processed",
          runId: run.id,
          response: { ...response },
        });
      }
      enqueueSlackRunOutcome(run.id, {
        channelId: event.channelId,
        threadTs: event.threadTs,
        teamId: event.teamId,
      });
      await flushChangesWithDeliveryRollback(eventKey);
      scheduleSlackBackgroundWork();
      return c.json(response);
    }
    const response = {
      ok: true,
      ignored: true,
      reason: "Unsupported Slack event type.",
    };
    if (eventKey) {
      store.recordIngressDelivery({
        key: eventKey,
        kind: "slack.event",
        status: "ignored",
        response: { ...response },
      });
      await flushChangesWithDeliveryRollback(eventKey);
    }
    return c.json(response);
  });

  return app;
}

const createRunSchema = z
  .object({
    prompt: z.string().min(1),
    placeScopeId: z.string().min(1),
    requesterPrincipalId: z.string().optional(),
    trigger: z
      .enum(["mention", "reaction", "dm", "slash_command", "api", "schedule"])
      .optional(),
    capability: z
      .enum([
        "slack.read",
        "slack.write",
        "github.read",
        "github.branch",
        "github.pr",
        "linear.read",
        "linear.write",
        "mcp.tool",
        "sandbox.exec",
        "model.call",
      ])
      .optional(),
    resource: z.string().optional(),
  })
  .strict();

const drainWorkerSchema = z
  .object({
    maxItems: z.number().int().min(1).max(100).optional(),
  })
  .strict();

const drainOutboundSchema = z
  .object({
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

const cancelRunSchema = z
  .object({
    reason: z.string().min(1).max(500).optional(),
  })
  .strict();

const redriveDeadLetterSchema = z
  .object({
    reason: z.string().min(1).max(500).optional(),
  })
  .strict();

const sensitivitySchema = z.enum([
  "public",
  "internal",
  "confidential",
  "restricted",
]);
const decisionSchema = z.enum(["allow", "ask", "deny"]);
const riskSchema = z.enum([
  "read_internal",
  "write_draft",
  "write_external",
  "privileged",
]);
const capabilitySchema = createRunSchema.shape.capability.unwrap();

const updateAgentSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    status: z.enum(["active", "paused", "disabled"]).optional(),
    defaultModelPolicyId: z.string().min(1).optional(),
    defaultRuntimeProfileId: z.string().min(1).optional(),
  })
  .strict()
  .refine(hasAtLeastOneField, {
    message: "At least one field must be provided.",
  });

const createChannelSchema = z
  .object({
    externalId: z.string().min(1),
    externalTeamId: z.string().min(1).optional(),
    name: z.string().min(1),
    sensitivity: sensitivitySchema,
  })
  .strict();

const updateChannelSchema = createChannelSchema
  .partial()
  .refine(hasAtLeastOneField, {
    message: "At least one field must be provided.",
  });

const createAccessBundleSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    budgetPolicyId: z.string().min(1).optional(),
    attachedPlaceIds: z.array(z.string().min(1)).optional(),
  })
  .strict();

const updateAccessBundleSchema = createAccessBundleSchema
  .pick({
    name: true,
    description: true,
    budgetPolicyId: true,
  })
  .partial()
  .refine(hasAtLeastOneField, {
    message: "At least one field must be provided.",
  });

const attachPlaceSchema = z
  .object({
    placeId: z.string().min(1),
  })
  .strict();

const grantSchema = z
  .object({
    capability: capabilitySchema,
    resource: z.string().min(1),
    decision: decisionSchema,
    risk: riskSchema,
    requiresApproval: z.boolean(),
  })
  .strict();

const updateGrantSchema = grantSchema.partial().refine(hasAtLeastOneField, {
  message: "At least one field must be provided.",
});

const updateModelPolicySchema = z
  .object({
    name: z.string().min(1).optional(),
    defaultModel: z.string().min(1).optional(),
    fallbackModels: z.array(z.string().min(1)).optional(),
    perRunBudgetCents: z.number().int().min(1).max(10_000_000).optional(),
  })
  .strict()
  .refine(hasAtLeastOneField, {
    message: "At least one field must be provided.",
  });

const updateRuntimeProfileSchema = z
  .object({
    name: z.string().min(1).optional(),
    runtimeKind: z
      .enum(["ai_sdk", "opencode", "langgraph", "external"])
      .optional(),
    adapter: z.string().min(1).optional(),
  })
  .strict()
  .refine(hasAtLeastOneField, {
    message: "At least one field must be provided.",
  });

const policySchema = z
  .object({
    placeScopeId: z.string(),
    capability: capabilitySchema,
    resource: z.string().optional(),
  })
  .strict();

const approvalDecisionSchema = z
  .object({
    principalId: z.string().min(1),
    payloadHash: z.string().min(16),
  })
  .strict();

function hasAtLeastOneField(input: object): boolean {
  return Object.keys(input).length > 0;
}

function latestRun(store: BekStore, runId: string) {
  const run = store.read().runs.find((candidate) => candidate.id === runId);
  if (!run) {
    throw new Error("Run not found.");
  }
  return run;
}

function latestApproval(store: BekStore, approvalId: string) {
  const approval = store
    .read()
    .approvals.find((candidate) => candidate.id === approvalId);
  if (!approval) {
    throw new Error("Approval not found.");
  }
  return approval;
}

function isTerminalRunStatus(status: Run["status"]): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

function resolveSlackPlace(
  snapshot: BekSnapshot,
  channelId: string,
  teamId?: string | undefined,
): PlaceScope | undefined {
  return snapshot.places.find(
    (candidate) =>
      candidate.kind === "slack_channel" &&
      candidate.provider === "slack" &&
      candidate.externalId === channelId &&
      slackPlaceAcceptsTeam(snapshot, candidate, teamId),
  );
}

function slackPlaceAcceptsTeam(
  snapshot: BekSnapshot,
  place: PlaceScope,
  teamId?: string | undefined,
): boolean {
  const placeTeamId =
    stringMetadata(place.metadata, "teamId") ??
    stringMetadata(place.metadata, "slackTeamId");
  const slackInstalls = snapshot.connectorInstalls.filter(
    (install) => install.kind === "slack" && install.provider === "slack",
  );

  if (placeTeamId) {
    if (teamId && teamId !== placeTeamId) {
      return false;
    }
    const matchingInstall = slackInstalls.find(
      (install) => install.externalId === placeTeamId,
    );
    return !matchingInstall || matchingInstall.status === "active";
  }

  if (slackInstalls.length === 0) {
    return true;
  }

  return Boolean(
    teamId &&
    slackInstalls.some(
      (install) => install.status === "active" && install.externalId === teamId,
    ),
  );
}

function publicSnapshot(snapshot: BekSnapshot): BekSnapshot {
  return {
    ...snapshot,
    places: snapshot.places.map(publicPlace),
    runs: snapshot.runs.map(publicRun),
    events: snapshot.events.map(publicRunEvent),
    connectorInstalls: snapshot.connectorInstalls.map(publicConnectorInstall),
    credentials: snapshot.credentials.map(publicCredential),
  };
}

function modelUsageSinkFromRepository(
  repository: Partial<ModelUsageRepository> | undefined,
): ModelUsageSink | undefined {
  if (!repository?.recordModelUsage) {
    return undefined;
  }
  return {
    recordModelUsage: (input) => repository.recordModelUsage!(input),
  };
}

function publicPlace(place: PlaceScope): PlaceScope {
  const { metadata, ...rest } = place;
  const publicPlaceScope: PlaceScope = { ...rest };
  const publicMetadata = publicMetadataRecord(metadata);
  if (publicMetadata) {
    publicPlaceScope.metadata = publicMetadata;
  }
  return publicPlaceScope;
}

function publicRun(run: Run): Run {
  return {
    ...run,
    prompt: redactSecrets(run.prompt),
  };
}

function publicRunEvent(event: RunEvent): RunEvent {
  const publicEvent: RunEvent = {
    ...event,
    message: redactSecrets(event.message),
  };
  if (event.data) {
    publicEvent.data = redactUnknown(event.data) as Record<string, unknown>;
  }
  return publicEvent;
}

function publicConnectorInstall(install: ConnectorInstall): ConnectorInstall {
  const { config, metadata, ...rest } = install;
  const publicInstall: ConnectorInstall = { ...rest };
  const publicConfig = publicMetadataRecord(config);
  if (publicConfig) {
    publicInstall.config = publicConfig;
  }
  const publicMetadata = publicMetadataRecord(metadata);
  if (publicMetadata) {
    publicInstall.metadata = publicMetadata;
  }
  return publicInstall;
}

function publicCredential(credential: CredentialRecord): CredentialRecord {
  const { metadata, ...rest } = credential;
  const publicCredentialRecord: CredentialRecord = {
    ...rest,
    secretRef: "[redacted:secret-ref]",
  };
  const publicMetadata = publicCredentialMetadata(metadata);
  if (publicMetadata) {
    publicCredentialRecord.metadata = publicMetadata;
  }
  return publicCredentialRecord;
}

function slackInstallSummaries(snapshot: BekSnapshot) {
  return snapshot.connectorInstalls
    .filter(
      (install) => install.kind === "slack" && install.provider === "slack",
    )
    .map((install) => {
      const credential = latestSlackCredential(
        snapshot,
        install.id,
        install.externalId,
      );
      return {
        id: install.id,
        status: install.status,
        externalId: install.externalId ?? null,
        displayName: install.displayName,
        appId: stringMetadata(install.metadata, "appId"),
        teamId:
          stringMetadata(install.metadata, "teamId") ?? install.externalId,
        teamName: stringMetadata(install.metadata, "teamName"),
        enterpriseId: stringMetadata(install.metadata, "enterpriseId"),
        enterpriseName: stringMetadata(install.metadata, "enterpriseName"),
        botUserId: stringMetadata(install.metadata, "botUserId"),
        authedUserId: stringMetadata(install.metadata, "authedUserId"),
        scopes: arrayMetadata(install.metadata, "scopes"),
        installedAt: stringMetadata(install.metadata, "installedAt"),
        updatedAt: install.updatedAt,
        credentialStatus: credential?.status ?? null,
        scopeSummary: credential?.scopeSummary ?? null,
        tokenPresent: Boolean(credential),
      };
    });
}

type GitHubGrantCapability = Extract<
  CapabilityGrant["capability"],
  "github.read" | "github.branch" | "github.pr"
>;

interface GitHubGrantSetupSummary {
  bundleId: string;
  bundleName: string;
  grantId: string;
  capability: GitHubGrantCapability;
  resource: string;
  decision: CapabilityGrant["decision"];
  risk: CapabilityGrant["risk"];
  requiresApproval: boolean;
}

interface GitHubRepoGrantGroup {
  repository: GitHubRepoResource;
  grants: GitHubGrantSetupSummary[];
}

function githubSetupPreview(
  snapshot: BekSnapshot,
  queryInstallationId: string | undefined,
  envInstallationId: string | undefined,
) {
  const appValidation = validateGitHubAppConfig(process.env);
  const appConfig = githubAppConfigSummary(appValidation);
  const installation = githubInstallationSummary(
    queryInstallationId,
    envInstallationId,
  );
  const grantPreview = githubRepoGrantPreview(snapshot);
  const repositories = grantPreview.repositories.map((group) =>
    githubRepositorySetupPreview(group, installation.installationId),
  );
  const errors = [
    ...appConfig.errors,
    ...installation.errors,
    ...(repositories.length === 0
      ? [
          "At least one canonical GitHub repo grant is required for a repo-scoped setup preview.",
        ]
      : []),
    ...grantPreview.invalidGrants.flatMap((grant) => grant.errors),
  ];

  return {
    ok:
      errors.length === 0 &&
      appConfig.ok &&
      installation.configured &&
      repositories.length > 0,
    appConfig,
    installation,
    githubGrantCount: grantPreview.githubGrantCount,
    validRepoGrantCount: grantPreview.validRepoGrantCount,
    invalidGrantCount: grantPreview.invalidGrants.length,
    repositories,
    invalidGrants: grantPreview.invalidGrants,
    errors,
    networkCalls: "none",
  };
}

function githubAppConfigSummary(
  validation: ReturnType<typeof validateGitHubAppConfig>,
) {
  return {
    ok: validation.ok,
    appId: validation.ok ? validation.config.appId : null,
    privateKeyConfigured: Boolean(process.env.GITHUB_APP_PRIVATE_KEY?.trim()),
    webhookSecretConfigured: Boolean(
      (
        process.env.GITHUB_APP_WEBHOOK_SECRET ??
        process.env.GITHUB_WEBHOOK_SECRET
      )?.trim(),
    ),
    legacyWebhookSecretConfigured: Boolean(
      !process.env.GITHUB_APP_WEBHOOK_SECRET?.trim() &&
      process.env.GITHUB_WEBHOOK_SECRET?.trim(),
    ),
    clientIdConfigured: Boolean(process.env.GITHUB_APP_CLIENT_ID?.trim()),
    clientSecretConfigured: Boolean(
      process.env.GITHUB_APP_CLIENT_SECRET?.trim(),
    ),
    errors: validation.errors,
    warnings: validation.warnings,
  };
}

function githubInstallationSummary(
  queryInstallationId: string | undefined,
  envInstallationId: string | undefined,
) {
  const queryValue = queryInstallationId?.trim();
  const envValue = envInstallationId?.trim();
  const rawInstallationId = queryValue || envValue;
  const source = queryValue ? "query" : envValue ? "env" : null;

  if (!rawInstallationId) {
    return {
      configured: false,
      source,
      installationId: null,
      errors: [
        "GITHUB_APP_INSTALLATION_ID or installationId query parameter is required for installation-token previews.",
      ],
    };
  }

  try {
    const request = createGitHubInstallationTokenRequest({
      installationId: rawInstallationId,
      permissions: {},
    });
    return {
      configured: true,
      source,
      installationId: request.installationId,
      errors: [],
    };
  } catch (error) {
    return {
      configured: true,
      source,
      installationId: null,
      errors: [errorMessage(error)],
    };
  }
}

function githubRepoGrantPreview(snapshot: BekSnapshot) {
  const repositories = new Map<string, GitHubRepoGrantGroup>();
  const invalidGrants: Array<GitHubGrantSetupSummary & { errors: string[] }> =
    [];
  let githubGrantCount = 0;
  let validRepoGrantCount = 0;

  for (const bundle of snapshot.accessBundles) {
    for (const grant of bundle.grants) {
      if (!isGitHubGrantCapability(grant.capability)) {
        continue;
      }
      githubGrantCount += 1;
      const summary: GitHubGrantSetupSummary = {
        bundleId: bundle.id,
        bundleName: bundle.name,
        grantId: grant.id,
        capability: grant.capability,
        resource: grant.resource,
        decision: grant.decision,
        risk: grant.risk,
        requiresApproval: grant.requiresApproval,
      };

      try {
        const repository = parseGitHubRepoResource(grant.resource);
        const existing = repositories.get(repository.resource);
        if (existing) {
          existing.grants.push(summary);
        } else {
          repositories.set(repository.resource, {
            repository,
            grants: [summary],
          });
        }
        validRepoGrantCount += 1;
      } catch (error) {
        invalidGrants.push({
          ...summary,
          errors: [errorMessage(error)],
        });
      }
    }
  }

  return {
    githubGrantCount,
    validRepoGrantCount,
    invalidGrants,
    repositories: [...repositories.values()].sort((left, right) =>
      left.repository.resource.localeCompare(right.repository.resource),
    ),
  };
}

function githubRepositorySetupPreview(
  group: GitHubRepoGrantGroup,
  installationId: string | null,
) {
  const requiredPermissions = requiredGitHubPermissionsForGrants(group);
  const installationTokenRequestPreview = installationId
    ? createGitHubInstallationTokenRequest({
        installationId,
        repository: group.repository,
        permissions: requiredPermissions,
      })
    : null;
  const draftPullRequestWorkflowPreview = group.grants.some(
    (grant) => grant.capability === "github.pr",
  )
    ? githubDraftPullRequestWorkflowPreview(group.repository, installationId)
    : null;

  return {
    repository: group.repository,
    grants: group.grants.sort((left, right) =>
      left.grantId.localeCompare(right.grantId),
    ),
    requiredPermissions,
    installationTokenRequestPreview,
    draftPullRequestWorkflowPreview,
  };
}

function githubDraftPullRequestWorkflowPreview(
  repository: GitHubRepoResource,
  installationId: string | null,
) {
  const plan = createGitHubDraftPullRequestWorkflowPlan({
    repository,
    installationId: installationId ?? "1",
    title: "Bek setup preview",
    body: "Preview only. The API does not call GitHub from this route.",
    baseBranch: "main",
    headBranch: "bek/setup-preview",
    commitMessage: "Bek setup preview",
    changes: [
      {
        path: ".bek/github-setup-preview.txt",
        content: "preview only\n",
      },
    ],
  });

  return {
    type: plan.type,
    visibleAgentHandle: plan.visibleAgentHandle,
    resource: plan.resource,
    steps: plan.steps,
    tokenRequestPermissions: plan.tokenRequest.permissions,
    pullRequestProposal: {
      type: plan.pullRequest.type,
      capability: plan.pullRequest.capability,
      resource: plan.pullRequest.resource,
      draft: plan.pullRequest.draft,
      baseBranch: plan.pullRequest.baseBranch,
      headBranch: plan.pullRequest.headBranch,
      approval: plan.pullRequest.approval,
    },
    approvalHashInput: {
      type: plan.approvalHashInput.type,
      version: plan.approvalHashInput.version,
      action: plan.approvalHashInput.action,
      resource: plan.approvalHashInput.resource,
      repository: plan.approvalHashInput.repository,
      installationId,
    },
  };
}

function requiredGitHubPermissionsForGrants(
  group: GitHubRepoGrantGroup,
): GitHubInstallationTokenPermissions {
  return group.grants.reduce<GitHubInstallationTokenPermissions>(
    (permissions, grant) =>
      mergeGitHubPermissions(
        permissions,
        requiredGitHubPermissionsForCapability(
          grant.capability,
          group.repository,
        ),
      ),
    {},
  );
}

function requiredGitHubPermissionsForCapability(
  capability: GitHubGrantCapability,
  repository: GitHubRepoResource,
): GitHubInstallationTokenPermissions {
  if (capability === "github.pr") {
    return createGitHubDraftPullRequestWorkflowPlan({
      repository,
      installationId: "1",
      title: "Bek setup preview",
      headBranch: "bek/setup-preview",
      commitMessage: "Bek setup preview",
      changes: [
        { path: ".bek/github-setup-preview.txt", content: "preview\n" },
      ],
    }).tokenRequest.permissions;
  }

  return createGitHubInstallationTokenRequest({
    installationId: "1",
    repository,
    permissions:
      capability === "github.branch"
        ? { contents: "write", metadata: "read" }
        : { contents: "read", metadata: "read" },
  }).permissions;
}

function mergeGitHubPermissions(
  target: GitHubInstallationTokenPermissions,
  source: GitHubInstallationTokenPermissions,
): GitHubInstallationTokenPermissions {
  for (const [name, access] of Object.entries(source) as Array<
    [
      keyof GitHubInstallationTokenPermissions,
      GitHubInstallationPermissionAccess | undefined,
    ]
  >) {
    if (!access) {
      continue;
    }
    const permissionName = name as keyof GitHubInstallationTokenPermissions;
    const current = target[permissionName];
    if (
      !current ||
      permissionAccessRank(access) > permissionAccessRank(current)
    ) {
      target[permissionName] = access;
    }
  }
  return target;
}

function permissionAccessRank(
  access: GitHubInstallationPermissionAccess,
): number {
  return access === "write" ? 2 : 1;
}

function isGitHubGrantCapability(
  capability: CapabilityGrant["capability"],
): capability is GitHubGrantCapability {
  return (
    capability === "github.read" ||
    capability === "github.branch" ||
    capability === "github.pr"
  );
}

function latestSlackInstall(
  snapshot: BekSnapshot,
): ConnectorInstall | undefined {
  return snapshot.connectorInstalls.find(
    (install) => install.kind === "slack" && install.provider === "slack",
  );
}

function latestSlackCredential(
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

function publicCredentialMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) {
    return undefined;
  }
  const publicMetadata = publicMetadataRecord(metadata) ?? {};
  if (metadata.vaultEnvelope) {
    publicMetadata.vaultEnvelopeStored = true;
  }
  return Object.keys(publicMetadata).length > 0 ? publicMetadata : undefined;
}

function publicMetadataRecord(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) {
    return undefined;
  }
  const { vaultEnvelope: _vaultEnvelope, ...rest } = metadata;
  const redacted = redactUnknown(rest) as Record<string, unknown>;
  return Object.keys(redacted).length > 0 ? redacted : undefined;
}

function stringMetadata(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function arrayMetadata(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string[] {
  const value = metadata?.[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

const defaultSlackBotScopes = [
  "app_mentions:read",
  "reactions:read",
  "commands",
  "chat:write",
];

function adminOrigins(): string[] {
  return (process.env.BEK_ADMIN_ORIGINS ?? "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function isAllowedAdminOrigin(origin: string): boolean {
  if (adminOrigins().includes(origin)) {
    return true;
  }
  if (process.env.NODE_ENV === "production") {
    return false;
  }
  try {
    const url = new URL(origin);
    return (
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      Boolean(url.port)
    );
  } catch {
    return false;
  }
}

const defaultMaxRequestBodyBytes = 256 * 1024;
const defaultRateLimitMaxRequests = 600;
const defaultRateLimitWindowMs = 60_000;
const maxRateLimitBuckets = 1_000;

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
  windowMs: number;
}

function maxRequestBodyBytes(
  value = process.env.BEK_MAX_REQUEST_BODY_BYTES,
): number {
  if (!value) {
    return defaultMaxRequestBodyBytes;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : defaultMaxRequestBodyBytes;
}

function parseContentLength(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function requestBodyTooLarge(c: Context, maxBytes: number) {
  if (isSlackPublicCallback(c.req.path)) {
    markSlackNoRetry(c);
  }
  return c.json(
    {
      error: "Request body too large.",
      maxBytes,
    },
    413,
  );
}

async function readRequestBodyWithinLimit(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false } | undefined> {
  if (!request.body) {
    return undefined;
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = concatUint8Arrays(chunks, totalBytes);
  return { ok: true, text: new TextDecoder().decode(bytes) };
}

function consumeRateLimit(
  buckets: Map<string, RateLimitBucket>,
  c: Context,
  now = Date.now(),
): RateLimitDecision {
  const config = rateLimitConfig();
  if (!config.enabled) {
    return {
      allowed: true,
      limit: config.maxRequests,
      remaining: config.maxRequests,
      resetAt: now + config.windowMs,
      retryAfterSeconds: 0,
      windowMs: config.windowMs,
    };
  }

  if (buckets.size > maxRateLimitBuckets) {
    pruneExpiredRateLimitBuckets(buckets, now);
  }

  const key = rateLimitKey(c);
  const current = buckets.get(key);
  const bucket =
    current && current.resetAt > now
      ? current
      : { count: 0, resetAt: now + config.windowMs };
  bucket.count += 1;
  buckets.set(key, bucket);

  const remaining = Math.max(0, config.maxRequests - bucket.count);
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((bucket.resetAt - now) / 1000),
  );
  return {
    allowed: bucket.count <= config.maxRequests,
    limit: config.maxRequests,
    remaining,
    resetAt: bucket.resetAt,
    retryAfterSeconds,
    windowMs: config.windowMs,
  };
}

function rateLimitConfig(): {
  enabled: boolean;
  maxRequests: number;
  windowMs: number;
} {
  const maxRequests = parsePositiveInteger(
    process.env.BEK_RATE_LIMIT_MAX_REQUESTS,
    defaultRateLimitMaxRequests,
  );
  return {
    enabled: maxRequests > 0,
    maxRequests,
    windowMs: parsePositiveInteger(
      process.env.BEK_RATE_LIMIT_WINDOW_MS,
      defaultRateLimitWindowMs,
    ),
  };
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function pruneExpiredRateLimitBuckets(
  buckets: Map<string, RateLimitBucket>,
  now: number,
) {
  for (const [key, bucket] of buckets.entries()) {
    if (bucket.resetAt <= now) {
      buckets.delete(key);
    }
  }
}

function rateLimitKey(c: Context): string {
  const routeClass = isSlackPublicCallback(c.req.path) ? "slack" : "api";
  return `${routeClass}:${requestPeerKey(c)}`;
}

function requestPeerKey(c: Context): string {
  if (process.env.BEK_TRUST_PROXY_HEADERS !== "true") {
    return "direct";
  }
  const forwardedFor = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  return (
    forwardedFor ||
    c.req.header("x-real-ip") ||
    c.req.header("cf-connecting-ip") ||
    "direct"
  );
}

function rateLimitExceeded(c: Context, decision: RateLimitDecision) {
  if (isSlackPublicCallback(c.req.path)) {
    markSlackNoRetry(c);
  }
  c.header("retry-after", String(decision.retryAfterSeconds));
  c.header("x-ratelimit-limit", String(decision.limit));
  c.header("x-ratelimit-remaining", "0");
  c.header("x-ratelimit-reset", String(Math.ceil(decision.resetAt / 1000)));
  return c.json(
    {
      error: "Too many requests.",
      limit: decision.limit,
      retryAfterSeconds: decision.retryAfterSeconds,
      windowMs: decision.windowMs,
    },
    429,
  );
}

function concatUint8Arrays(
  chunks: readonly Uint8Array[],
  totalBytes: number,
): Uint8Array {
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function isExpectedBearerToken(
  authorization: string | undefined,
  expectedToken: string,
): boolean {
  const prefix = "Bearer ";
  if (!authorization?.startsWith(prefix)) {
    return false;
  }
  const supplied = authorization.slice(prefix.length);
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expectedToken);
  if (suppliedBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(suppliedBuffer, expectedBuffer);
}

function isSlackPublicCallback(path: string): boolean {
  return [
    "/api/slack/events",
    "/api/slack/oauth/callback",
    "/api/slack/interactivity",
    "/api/slack/commands",
  ].includes(path);
}

function isVerifiedSlackRequest(input: {
  rawBody: string;
  timestamp?: string | undefined;
  signature?: string | undefined;
}): boolean {
  return verifySlackSignature({
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    timestamp: input.timestamp,
    signature: input.signature,
    rawBody: input.rawBody,
    allowUnsigned:
      process.env.NODE_ENV !== "production" &&
      (process.env.NODE_ENV === "test" ||
        process.env.BEK_DEV_UNSIGNED_SLACK === "true"),
  });
}

type SlackRetryInfo = NonNullable<ReturnType<typeof parseSlackRetryHeaders>>;

function slackRetryForRequest(c: Context): SlackRetryInfo | undefined {
  return parseSlackRetryHeaders({
    retryNum: c.req.header("x-slack-retry-num"),
    retryReason: c.req.header("x-slack-retry-reason"),
  });
}

function markSlackNoRetry(c: Context) {
  c.header("x-slack-no-retry", "1");
}

function acknowledgeSlackRetry(c: Context, retry: SlackRetryInfo | undefined) {
  if (retry) {
    markSlackNoRetry(c);
  }
}

function withSlackRetryMetadata<T extends object>(
  response: T,
  retry: SlackRetryInfo | undefined,
): T | (T & { slackRetry: SlackRetryInfo }) {
  if (!retry) {
    return response;
  }
  return { ...response, slackRetry: retry };
}

function duplicateSlackEventResponse(existingEvent: {
  status: "processed" | "ignored";
  runId?: string | undefined;
  response?: Record<string, unknown> | undefined;
}): Record<string, unknown> {
  return {
    ok: existingEvent.status === "processed",
    ...(existingEvent.status === "ignored" ? { ignored: true } : {}),
    ...(existingEvent.response ?? {}),
    ...(existingEvent.runId ? { runId: existingEvent.runId } : {}),
    deduped: true,
  };
}

function slackOutboundDeliveryKey(
  message: SlackPreparedOutboundMessage,
  approvalId?: string | undefined,
): string {
  const target = slackOutboundTargetRecord(message);
  return [
    "slack",
    "outbound",
    message.kind,
    message.runId,
    approvalId ?? "run",
    stringValue(target.channelId) ?? "unknown-channel",
    stringValue(target.threadTs) ?? "root",
  ].join(":");
}

function slackOutboundTargetRecord(
  message: SlackPreparedOutboundMessage,
): Record<string, unknown> {
  return {
    channelId: message.target.channelId,
    threadTs: message.target.threadTs,
    teamId: message.target.teamId,
    messageKind: message.kind,
  };
}

function preparedSlackMessageFromOutboundDelivery(
  delivery: OutboundDelivery,
): SlackPreparedOutboundMessage | undefined {
  const kind = slackPreparedMessageKind(delivery.target.messageKind);
  const target = slackTargetFromRecord(delivery.target);
  if (!kind || !delivery.runId || !target.channelId) {
    return undefined;
  }
  return {
    kind,
    runId: delivery.runId,
    target,
    message:
      delivery.payload as unknown as SlackPreparedOutboundMessage["message"],
  };
}

function slackPreparedMessageKind(
  value: unknown,
): SlackPreparedOutboundMessage["kind"] | undefined {
  return value === "queued" ||
    value === "approval_needed" ||
    value === "approval_decision" ||
    value === "final_answer"
    ? value
    : undefined;
}

function slackTargetFromRecord(
  value: Record<string, unknown>,
): SlackPreparedOutboundMessage["target"] {
  return {
    channelId: stringValue(value.channelId),
    threadTs: stringValue(value.threadTs),
    teamId: stringValue(value.teamId),
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function missingEnv(names: string[]): string[] {
  return names.filter((name) => !process.env[name]);
}

function slackConfigError(feature: string, missing: string[]) {
  return {
    ok: false,
    error: `${feature} is not configured. Set ${missing.join(", ")}.`,
  };
}

function slackBotScopes(): string[] {
  return (process.env.SLACK_BOT_SCOPES ?? defaultSlackBotScopes.join(","))
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function slackInstallAuthorization(input: {
  returnTo?: string | undefined;
  callbackMode?: "json" | "redirect" | undefined;
}): {
  url: string;
  scopes: string[];
} {
  const scopes = slackBotScopes();
  const state = createSlackOAuthState({
    stateSecret: process.env.SLACK_STATE_SECRET!,
    returnTo: input.returnTo,
    callbackMode: input.callbackMode,
  });
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", process.env.SLACK_CLIENT_ID!);
  url.searchParams.set("scope", scopes.join(","));
  url.searchParams.set("redirect_uri", process.env.SLACK_REDIRECT_URI!);
  url.searchParams.set("state", state);
  return { url: url.toString(), scopes };
}

function adminReturnUrl(
  returnTo: string | undefined,
  params: Record<string, string>,
): string {
  const origin = adminOrigins()[0] ?? "http://localhost:5173";
  const url = new URL(returnTo ?? "/connectors", origin);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function shouldExchangeSlackOAuth(): boolean {
  const configured = process.env.BEK_SLACK_OAUTH_EXCHANGE;
  if (configured) {
    return configured === "true";
  }
  return process.env.NODE_ENV === "production";
}

function slackPrincipalIdForUser(slackUserId?: string | undefined) {
  if (!slackUserId) {
    return undefined;
  }
  const rawMap = process.env.BEK_SLACK_USER_PRINCIPAL_MAP;
  if (!rawMap) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMap);
  } catch {
    throw new Error("BEK_SLACK_USER_PRINCIPAL_MAP must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      "BEK_SLACK_USER_PRINCIPAL_MAP must be a JSON object mapping Slack user IDs to Bek principal IDs.",
    );
  }

  const principalId = (parsed as Record<string, unknown>)[slackUserId];
  return typeof principalId === "string" && principalId.length > 0
    ? principalId
    : undefined;
}

function slackUserMappingReason(slackUserId?: string | undefined): string {
  if (!slackUserId) {
    return "Slack payload is missing user identity.";
  }
  return `Slack user ${slackUserId} is not mapped to a Bek principal.`;
}

function slackUserMappingText(slackUserId?: string | undefined): string {
  if (!slackUserId) {
    return "Bek could not identify the Slack user for this request.";
  }
  return "Bek can see this Slack request, but this Slack user is not mapped to a Bek principal yet.";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}
