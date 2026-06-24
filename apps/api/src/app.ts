import { timingSafeEqual } from "node:crypto";
import { BekStore, bundlesForPlace, evaluatePolicy } from "@bek/core";
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
  parseSlackCommand,
  parseSlackInteraction,
  redactSlackInstallRecord,
  verifySlackOAuthState,
  verifySlackSignature,
} from "@bek/slack";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";

export function createApp(store = new BekStore()) {
  const app = new Hono();
  const seenSlackEventKeys = new Set<string>();
  const seenSlackCommandRuns = new Map<string, string>();
  const seenSlackInteractionKeys = new Set<string>();
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

  app.get("/health", (c) =>
    c.json({
      ok: true,
      name: "bek-api",
      time: new Date().toISOString(),
    }),
  );

  app.get("/api/bootstrap", (c) => c.json(store.read()));
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
    const githubGrantCount = snapshot.accessBundles
      .flatMap((bundle) => bundle.grants)
      .filter((grant) => grant.resource.startsWith("github:")).length;
    return c.json({
      visibleHandle: snapshot.agent.handle,
      singleVisibleAgent: snapshot.agent.handle === "@bek",
      slackChannels: slackChannels.length,
      accessBundles: snapshot.accessBundles.length,
      modelPolicies: snapshot.modelPolicies.length,
      runtimeProfiles: snapshot.runtimeProfiles.length,
      githubGrantCount,
      pendingApprovals: pendingApprovals.length,
      readyForLocalDemo:
        snapshot.agent.handle === "@bek" &&
        slackChannels.length > 0 &&
        snapshot.accessBundles.length > 0 &&
        snapshot.modelPolicies.length > 0,
    });
  });
  app.get("/api/channels", (c) =>
    c.json(
      store.read().places.filter((place) => place.kind === "slack_channel"),
    ),
  );
  app.post("/api/channels", async (c) => {
    const body = createChannelSchema.parse(await c.req.json());
    const channel = store.createPlace({
      kind: "slack_channel",
      provider: "slack",
      ...body,
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
    const runs = snapshot.runs.filter((run) => run.placeScopeId === channel.id);
    return c.json({ channel, bundles, runs });
  });
  app.patch("/api/channels/:channelId", async (c) => {
    const body = updateChannelSchema.parse(await c.req.json());
    const channel = store.updatePlace(c.req.param("channelId"), body);
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
  app.get("/api/runs", (c) => c.json(store.read().runs));
  app.get("/api/approvals", (c) => c.json(store.read().approvals));
  app.get("/api/audit-events", (c) => c.json(store.read().events));
  app.get("/api/model-usage", (c) => {
    const runs = store.read().runs;
    return c.json({
      totalEstimatedCents: runs.reduce(
        (sum, run) => sum + run.estimatedCostCents,
        0,
      ),
      totalActualCents: runs.reduce((sum, run) => sum + run.actualCostCents, 0),
      runs: runs.length,
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
      run,
      events: snapshot.events.filter((event) => event.runId === run.id),
      approvals: snapshot.approvals.filter(
        (approval) => approval.runId === run.id,
      ),
    });
  });
  app.get("/api/runs/:runId/events", (c) => {
    const events = store
      .read()
      .events.filter((event) => event.runId === c.req.param("runId"));
    return c.json(events);
  });

  app.post("/api/runs", async (c) => {
    const body = createRunSchema.parse(await c.req.json());
    const run = store.createRun(body);
    await store.flushChanges();
    return c.json(run, 201);
  });

  app.post("/api/approvals/:approvalId/approve", async (c) => {
    const body = approvalDecisionSchema.parse(await c.req.json());
    const approval = store.decideApproval(
      c.req.param("approvalId"),
      "approved",
      body,
    );
    await store.flushChanges();
    return c.json(approval);
  });

  app.post("/api/approvals/:approvalId/deny", async (c) => {
    const body = approvalDecisionSchema.parse(await c.req.json());
    const approval = store.decideApproval(
      c.req.param("approvalId"),
      "denied",
      body,
    );
    await store.flushChanges();
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

    const state = createSlackOAuthState({
      stateSecret: process.env.SLACK_STATE_SECRET!,
      returnTo: c.req.query("return_to") ?? c.req.query("returnTo"),
    });
    const url = new URL("https://slack.com/oauth/v2/authorize");
    url.searchParams.set("client_id", process.env.SLACK_CLIENT_ID!);
    url.searchParams.set("scope", slackBotScopes().join(","));
    url.searchParams.set("redirect_uri", process.env.SLACK_REDIRECT_URI!);
    url.searchParams.set("state", state);

    return c.redirect(url.toString(), 302);
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
      return c.json(slackConfigError("Slack OAuth callback", missing), 500);
    }

    if (!shouldExchangeSlackOAuth()) {
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

    const exchange = await exchangeSlackOAuthCode({
      clientId: process.env.SLACK_CLIENT_ID!,
      clientSecret: process.env.SLACK_CLIENT_SECRET!,
      code: c.req.query("code")!,
      redirectUri: process.env.SLACK_REDIRECT_URI!,
    });
    if (!exchange.ok) {
      return c.json(
        {
          ok: false,
          error: exchange.error,
          returnTo: state.payload.returnTo ?? null,
        },
        400,
      );
    }

    return c.json({
      ok: true,
      status: "installed",
      install: redactSlackInstallRecord(exchange.install),
      returnTo: state.payload.returnTo ?? null,
    });
  });

  app.post("/api/slack/interactivity", async (c) => {
    const rawBody = await c.req.text();
    if (
      !isVerifiedSlackRequest({
        rawBody,
        timestamp: c.req.header("x-slack-request-timestamp"),
        signature: c.req.header("x-slack-signature"),
      })
    ) {
      return c.json({ error: "Invalid Slack signature" }, 401);
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
    if (interactionKey && seenSlackInteractionKeys.has(interactionKey)) {
      return c.json({
        ...buildSlackEphemeralResponse({
          ok: true,
          text: "Bek already handled this approval action.",
        }),
        ok: true,
        deduped: true,
      });
    }

    if (!interaction.slackUserId) {
      return c.json(
        buildSlackEphemeralResponse({
          ok: false,
          error: "Slack approval payload is missing user.id.",
          text: "Bek could not identify the Slack user who clicked this approval.",
        }),
        400,
      );
    }

    const principalId = slackPrincipalIdForUser(interaction.slackUserId);
    if (!principalId) {
      return c.json(
        buildSlackEphemeralResponse({
          ok: false,
          error: `Slack user ${interaction.slackUserId} is not mapped to a Bek principal. Set BEK_SLACK_USER_PRINCIPAL_MAP or approve in the admin API.`,
          text: "Bek parsed this approval button, but this Slack user is not mapped to an approver yet.",
        }),
        400,
      );
    }

    const approval = store.decideApproval(
      interaction.approvalId,
      interaction.decision,
      {
        principalId,
        payloadHash: interaction.payloadHash,
      },
    );
    await store.flushChanges();
    if (interactionKey) {
      seenSlackInteractionKeys.add(interactionKey);
    }

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
    if (
      !isVerifiedSlackRequest({
        rawBody,
        timestamp: c.req.header("x-slack-request-timestamp"),
        signature: c.req.header("x-slack-signature"),
      })
    ) {
      return c.json({ error: "Invalid Slack signature" }, 401);
    }

    const command = parseSlackCommand(rawBody);
    const commandKey = buildSlackCommandDurableKey(command);
    const existingRunId = commandKey
      ? seenSlackCommandRuns.get(commandKey)
      : undefined;
    if (existingRunId) {
      return c.json({
        ...buildSlackCommandQueuedResponse({ runId: existingRunId }),
        deduped: true,
      });
    }

    if (!command.channelId) {
      return c.json(
        buildSlackCommandErrorResponse({
          error: "Slack command payload is missing channel_id.",
          text: "Bek could not identify the Slack channel for this command.",
        }),
        400,
      );
    }

    const snapshot = store.read();
    const place = snapshot.places.find(
      (candidate) => candidate.externalId === command.channelId,
    );
    if (!place) {
      return c.json(
        buildSlackCommandIgnoredResponse({
          reason: "Bek is not configured for this Slack channel.",
          text: "Bek is not configured for this Slack channel yet.",
        }),
      );
    }

    const run = store.createRun({
      placeScopeId: place.id,
      prompt: command.text.trim() || `${command.command || "/bek"} help`,
      requesterPrincipalId: slackPrincipalIdForUser(command.userId),
      trigger: "slash_command",
      capability: "slack.read",
      resource: `slack:${place.externalId}`,
    });
    await store.flushChanges();
    if (commandKey) {
      seenSlackCommandRuns.set(commandKey, run.id);
    }

    return c.json(buildSlackCommandQueuedResponse({ runId: run.id }));
  });

  app.post("/api/slack/events", async (c) => {
    const rawBody = await c.req.text();
    const verified = isVerifiedSlackRequest({
      rawBody,
      timestamp: c.req.header("x-slack-request-timestamp"),
      signature: c.req.header("x-slack-signature"),
    });
    if (!verified) {
      return c.json({ error: "Invalid Slack signature" }, 401);
    }

    const payload = JSON.parse(rawBody) as Record<string, unknown>;
    const eventKey = buildSlackEventDurableKey(payload);
    if (eventKey && seenSlackEventKeys.has(eventKey)) {
      return c.json({ ok: true, deduped: true });
    }
    const event = normalizeSlackEvent(payload);
    if (event.type === "url_verification") {
      return c.json({ challenge: event.challenge });
    }
    if (event.type === "mention" || event.type === "reaction") {
      const snapshot = store.read();
      const place = snapshot.places.find(
        (candidate) => candidate.externalId === event.channelId,
      );
      if (!place) {
        if (eventKey) {
          seenSlackEventKeys.add(eventKey);
        }
        return c.json({
          ok: false,
          ignored: true,
          reason: "Bek is not configured for this Slack channel.",
        });
      }
      const run = store.createRun({
        placeScopeId: place.id,
        prompt:
          event.text ?? `Reaction ${event.reaction ?? "agent"} triggered Bek`,
        trigger: event.type,
        capability: "slack.read",
        resource: `slack:${place.externalId}`,
      });
      await store.flushChanges();
      if (eventKey) {
        seenSlackEventKeys.add(eventKey);
      }
      return c.json({ ok: true, runId: run.id });
    }
    if (eventKey) {
      seenSlackEventKeys.add(eventKey);
    }
    return c.json({ ok: true, ignored: true });
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
