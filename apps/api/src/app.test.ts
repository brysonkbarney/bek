import { createHmac } from "node:crypto";
import {
  createSlackOAuthState,
  createSlackSignature,
  FakeSlackWebApiClient,
  parseSlackApprovalActionValue,
  type SlackActionsBlock,
  type SlackWebApiClient,
  type SlackWebApiMessageResult,
  type SlackPostMessageInput,
  verifySlackOAuthState,
} from "@bek/slack";
import { createGitHubWebhookSignature } from "@bek/github";
import { BekStore, createSeedSnapshot } from "@bek/core";
import type { WorkerSnapshot } from "@bek/worker";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app";

const managedEnvKeys = [
  "BEK_ALLOW_LEGACY_SLACK_USER_MAP",
  "BEK_ALLOW_UNAUTHENTICATED_LOCAL",
  "BEK_ADMIN_API_TOKEN",
  "BEK_ADMIN_ORIGINS",
  "BEK_ADMIN_PRINCIPAL_ID",
  "BEK_REQUIRE_ADMIN_AUTH",
  "BEK_CREDENTIAL_KEY_ID",
  "BEK_CREDENTIAL_MASTER_KEY",
  "BEK_MAX_REQUEST_BODY_BYTES",
  "BEK_MODEL_BENCHMARKS_JSON",
  "BEK_MODEL_BENCHMARKS_PATH",
  "BEK_MODEL_GATEWAY",
  "BEK_MODEL_PROVIDER_REGISTRY_JSON",
  "BEK_MODEL_PROVIDER_REGISTRY_PATH",
  "BEK_PUBLIC_URL",
  "BEK_RATE_LIMIT_MAX_REQUESTS",
  "BEK_RATE_LIMIT_WINDOW_MS",
  "BEK_RUN_ADVANCEMENT",
  "BEK_SANDBOX_PROVIDER",
  "BEK_GITHUB_EXECUTION",
  "BEK_SLACK_BACKGROUND_DRAIN",
  "BEK_SLACK_OAUTH_EXCHANGE",
  "BEK_SLACK_USER_PRINCIPAL_MAP",
  "BEK_WEB_API_URL",
  "GITHUB_API_BASE_URL",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_ID",
  "GITHUB_APP_INSTALLATION_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_WEBHOOK_SECRET",
  "GITHUB_WEBHOOK_SECRET",
  "SLACK_BOT_SCOPES",
  "SLACK_BOT_TOKEN",
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
  "SLACK_REDIRECT_URI",
  "SLACK_SIGNING_SECRET",
  "SLACK_STATE_SECRET",
  "NODE_ENV",
] as const;

const originalEnv: Partial<Record<(typeof managedEnvKeys)[number], string>> =
  {};
for (const key of managedEnvKeys) {
  originalEnv[key] = process.env[key];
}

const testCredentialMasterKey = `hex:${"7".repeat(64)}`;
const testGitHubPrivateKey =
  "-----BEGIN RSA PRIVATE KEY-----\\nabc123\\n-----END RSA PRIVATE KEY-----";

beforeEach(() => {
  process.env.BEK_ALLOW_UNAUTHENTICATED_LOCAL = "true";
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of managedEnvKeys) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }
});

type ApprovalSummary = {
  id: string;
  payloadHash: string;
  status: string;
  action: string;
};

class BlockingSlackWebApiClient implements SlackWebApiClient {
  readonly postMessageCalls: SlackPostMessageInput[] = [];

  async postMessage(input: SlackPostMessageInput) {
    this.postMessageCalls.push(input);
    return new Promise<SlackWebApiMessageResult>(() => {
      // Intentionally unresolved to prove Slack ingress does not wait on
      // outbound Slack Web API delivery.
    });
  }

  async updateMessage(): Promise<SlackWebApiMessageResult> {
    return new Promise<SlackWebApiMessageResult>(() => {});
  }

  async postEphemeral(): Promise<SlackWebApiMessageResult> {
    return new Promise<SlackWebApiMessageResult>(() => {});
  }

  async listChannels() {
    return new Promise<Awaited<ReturnType<SlackWebApiClient["listChannels"]>>>(
      () => {},
    );
  }
}

class RateLimitedSlackWebApiClient implements SlackWebApiClient {
  readonly postMessageCalls: SlackPostMessageInput[] = [];

  async postMessage(
    input: SlackPostMessageInput,
  ): Promise<SlackWebApiMessageResult> {
    this.postMessageCalls.push(structuredClone(input));
    return {
      ok: false,
      error: "ratelimited",
      retryAfterSeconds: 2,
    };
  }

  async updateMessage(): Promise<SlackWebApiMessageResult> {
    throw new Error("Unexpected Slack updateMessage call.");
  }

  async postEphemeral(): Promise<SlackWebApiMessageResult> {
    throw new Error("Unexpected Slack postEphemeral call.");
  }

  async listChannels(): Promise<
    Awaited<ReturnType<SlackWebApiClient["listChannels"]>>
  > {
    throw new Error("Unexpected Slack listChannels call.");
  }
}

function signedSlackHeaders(
  rawBody: string,
  timestamp = Math.floor(Date.now() / 1000).toString(),
  contentType = "application/json",
) {
  const secret = "test-slack-secret";
  process.env.SLACK_SIGNING_SECRET = secret;
  return {
    "content-type": contentType,
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": createSlackSignature(secret, timestamp, rawBody),
  };
}

function signedGitHubHeaders(
  rawBody: string,
  input: {
    eventName?: string | undefined;
    deliveryId?: string | undefined;
    secret?: string | undefined;
  } = {},
) {
  const secret = input.secret ?? "test-github-webhook-secret";
  process.env.GITHUB_APP_WEBHOOK_SECRET = secret;
  return {
    "content-type": "application/json",
    "x-github-event": input.eventName ?? "ping",
    "x-github-delivery": input.deliveryId ?? "delivery-123",
    "x-hub-signature-256": createGitHubWebhookSignature(secret, rawBody),
  };
}

function slackRetryHeaders(retryNum = "1", retryReason = "http_timeout") {
  return {
    "x-slack-retry-num": retryNum,
    "x-slack-retry-reason": retryReason,
  };
}

function slackForm(input: Record<string, string>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    params.set(key, value);
  }
  return params.toString();
}

function configureFakeSlackOAuth() {
  process.env.SLACK_CLIENT_ID = "1234567890.987654321";
  process.env.SLACK_CLIENT_SECRET = "fake-client-secret";
  process.env.SLACK_REDIRECT_URI =
    "http://localhost:4317/api/slack/oauth/callback";
  process.env.SLACK_STATE_SECRET = "fake-state-secret";
}

function signedSlackOAuthState(payload: Record<string, unknown>) {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
    "base64url",
  );
  const signature = createHmac("sha256", process.env.SLACK_STATE_SECRET!)
    .update(encodedPayload)
    .digest("base64url");
  return `v1.${encodedPayload}.${signature}`;
}

function mapSlackTestUser(
  slackUserId = "U123",
  principalId = "principal_bryson",
) {
  mapSlackTestUsers({ [slackUserId]: principalId });
}

function mapSlackTestUsers(map: Record<string, unknown>) {
  process.env.BEK_SLACK_USER_PRINCIPAL_MAP = JSON.stringify(map);
}

function installActiveSlackApp(
  store: BekStore,
  input: {
    teamId?: string | undefined;
    botUserId?: string | undefined;
  } = {},
) {
  const teamId = input.teamId ?? "T123";
  return store.upsertConnectorInstall({
    id: `connector_slack_${teamId}`,
    kind: "slack",
    provider: "slack",
    externalId: teamId,
    displayName: "Redo",
    status: "active",
    metadata: {
      teamId,
      teamName: "Redo",
      ...(input.botUserId ? { botUserId: input.botUserId } : {}),
    },
  });
}

function storeActiveSlackCredential(
  store: BekStore,
  input: {
    install: ReturnType<typeof installActiveSlackApp>;
    teamId?: string | undefined;
  },
) {
  const teamId = input.teamId ?? input.install.externalId ?? "T123";
  return store.upsertCredential({
    id: `credential_slack_bot_${teamId}`,
    connectorInstallId: input.install.id,
    name: "Redo Slack bot token",
    provider: "slack",
    externalAccountId: teamId,
    secretRef: `bek-local-vault:slack:org_demo:${teamId}:bot`,
    status: "active",
    scopeSummary:
      "app_mentions:read,reactions:read,commands,chat:write,channels:read,groups:read,im:history",
    metadata: {
      source: "test",
    },
  });
}

function clearGitHubEnv() {
  delete process.env.BEK_GITHUB_EXECUTION;
  delete process.env.GITHUB_API_BASE_URL;
  delete process.env.GITHUB_APP_CLIENT_ID;
  delete process.env.GITHUB_APP_CLIENT_SECRET;
  delete process.env.GITHUB_APP_ID;
  delete process.env.GITHUB_APP_INSTALLATION_ID;
  delete process.env.GITHUB_APP_PRIVATE_KEY;
  delete process.env.GITHUB_APP_WEBHOOK_SECRET;
  delete process.env.GITHUB_WEBHOOK_SECRET;
}

async function createPrApproval(
  app: ReturnType<typeof createApp>,
  prompt = "@bek open a PR",
) {
  const res = await app.request("/api/runs", {
    method: "POST",
    body: JSON.stringify({
      prompt,
      placeScopeId: "place_checkout",
      capability: "github.pr",
      resource: "github:redohq/checkout",
    }),
    headers: { "content-type": "application/json" },
  });
  const run = (await res.json()) as { id: string; status: string };
  const detail = await app.request(`/api/runs/${run.id}`);
  const json = (await detail.json()) as { approvals: ApprovalSummary[] };
  return { run, approval: json.approvals[0]! };
}

async function expectJson<T = unknown>(
  app: ReturnType<typeof createApp>,
  path: string,
): Promise<T> {
  const res = await app.request(path);
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

describe("Bek API", () => {
  it("requires an explicit local bypass when no admin token is configured", async () => {
    delete process.env.BEK_ADMIN_API_TOKEN;
    delete process.env.BEK_ALLOW_UNAUTHENTICATED_LOCAL;

    const denied = await createApp().request("/api/bootstrap");
    expect(denied.status).toBe(500);
    await expect(denied.json()).resolves.toMatchObject({
      error: expect.stringContaining("BEK_ALLOW_UNAUTHENTICATED_LOCAL"),
    });

    process.env.BEK_ALLOW_UNAUTHENTICATED_LOCAL = "true";
    const allowed = await createApp().request("/api/bootstrap");
    expect(allowed.status).toBe(200);
  });

  it("does not let the local unauthenticated bypass override required admin auth", async () => {
    process.env.BEK_REQUIRE_ADMIN_AUTH = "true";
    delete process.env.BEK_ADMIN_API_TOKEN;
    process.env.BEK_ALLOW_UNAUTHENTICATED_LOCAL = "true";

    const denied = await createApp().request("/api/bootstrap");
    expect(denied.status).toBe(500);
    await expect(denied.json()).resolves.toMatchObject({
      error: expect.stringContaining("BEK_ADMIN_API_TOKEN"),
    });
  });

  it("protects admin API routes when an admin token is configured", async () => {
    const previousToken = process.env.BEK_ADMIN_API_TOKEN;
    process.env.BEK_ADMIN_API_TOKEN = "test-admin-token";
    try {
      const app = createApp();
      const denied = await app.request("/api/bootstrap");
      expect(denied.status).toBe(401);

      const allowed = await app.request("/api/bootstrap", {
        headers: { authorization: "Bearer test-admin-token" },
      });
      expect(allowed.status).toBe(200);
    } finally {
      if (previousToken === undefined) {
        delete process.env.BEK_ADMIN_API_TOKEN;
      } else {
        process.env.BEK_ADMIN_API_TOKEN = previousToken;
      }
    }
  });

  it("rejects placeholder admin tokens in production admin routes", async () => {
    process.env.NODE_ENV = "production";
    process.env.BEK_ADMIN_API_TOKEN = "change-me-local-only";
    process.env.BEK_REQUIRE_ADMIN_AUTH = "true";
    process.env.BEK_ALLOW_UNAUTHENTICATED_LOCAL = "false";

    const res = await createApp().request("/api/bootstrap", {
      headers: { authorization: "Bearer change-me-local-only" },
    });

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("generated secret"),
    });
  });

  it("fails readiness for unsafe production admin tokens", async () => {
    process.env.NODE_ENV = "production";
    process.env.BEK_ADMIN_API_TOKEN = "change-me-local-only";
    process.env.BEK_REQUIRE_ADMIN_AUTH = "true";

    const res = await createApp().request("/ready");

    expect(res.status).toBe(503);
    const json = (await res.json()) as {
      ok: boolean;
      checks: { adminAuth: { ok: boolean; error: string } };
    };
    expect(json.ok).toBe(false);
    expect(json.checks.adminAuth).toMatchObject({
      ok: false,
      error: expect.stringContaining("generated secret"),
    });
  });

  it("keeps Slack callbacks public when admin auth is configured", async () => {
    process.env.BEK_ADMIN_API_TOKEN = "test-admin-token";
    mapSlackTestUser();
    const rawBody = JSON.stringify({
      event_id: "EvAdminAuthBypass",
      event: {
        type: "app_mention",
        channel: "C_CHECKOUT",
        user: "U123",
        text: "@bek hello",
      },
    });

    const denied = await createApp().request("/api/bootstrap", {
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(denied.status).toBe(401);

    const slack = await createApp().request("/api/slack/events", {
      method: "POST",
      body: rawBody,
      headers: signedSlackHeaders(rawBody),
    });
    expect(slack.status).toBe(200);
    await expect(slack.json()).resolves.toMatchObject({
      ok: true,
      runId: expect.any(String),
    });
  });

  it("keeps signed GitHub webhooks public when admin auth is configured", async () => {
    process.env.BEK_ADMIN_API_TOKEN = "test-admin-token";
    const app = createApp();
    const setup = await app.request("/api/setup/github", {
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(setup.status).toBe(401);

    const rawBody = JSON.stringify({ zen: "Approachable automation." });
    const webhook = await app.request("/api/github/webhooks", {
      method: "POST",
      body: rawBody,
      headers: signedGitHubHeaders(rawBody, {
        eventName: "ping",
        deliveryId: "delivery-public-github",
      }),
    });

    expect(webhook.status).toBe(200);
    await expect(webhook.json()).resolves.toMatchObject({
      ok: true,
      provider: "github",
      eventName: "ping",
      deliveryId: "delivery-public-github",
      ignored: true,
    });
  });

  it("rejects missing or tampered GitHub webhook signatures", async () => {
    const rawBody = JSON.stringify({ zen: "No unsigned webhooks." });
    const missing = await createApp().request("/api/github/webhooks", {
      method: "POST",
      body: rawBody,
      headers: {
        "content-type": "application/json",
        "x-github-event": "ping",
        "x-github-delivery": "delivery-missing-signature",
      },
    });
    expect(missing.status).toBe(401);

    const tampered = await createApp().request("/api/github/webhooks", {
      method: "POST",
      body: rawBody,
      headers: {
        ...signedGitHubHeaders(rawBody, {
          eventName: "ping",
          deliveryId: "delivery-tampered-signature",
        }),
        "x-hub-signature-256": createGitHubWebhookSignature(
          "wrong-secret",
          rawBody,
        ),
      },
    });
    expect(tampered.status).toBe(401);
    await expect(tampered.json()).resolves.toMatchObject({
      error: "Invalid GitHub webhook signature.",
    });
  });

  it("rejects signed GitHub webhooks with malformed JSON", async () => {
    const rawBody = "{not-json";
    const res = await createApp().request("/api/github/webhooks", {
      method: "POST",
      body: rawBody,
      headers: signedGitHubHeaders(rawBody, {
        eventName: "ping",
        deliveryId: "delivery-malformed-json",
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "GitHub webhook payload must be valid JSON.",
    });
  });

  it("dedupes signed GitHub webhook deliveries", async () => {
    const store = new BekStore();
    const app = createApp(store);
    const rawBody = JSON.stringify({ zen: "Deduped." });
    const headers = signedGitHubHeaders(rawBody, {
      eventName: "ping",
      deliveryId: "delivery-dedupe",
    });

    const first = await app.request("/api/github/webhooks", {
      method: "POST",
      body: rawBody,
      headers,
    });
    const second = await app.request("/api/github/webhooks", {
      method: "POST",
      body: rawBody,
      headers,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({
      deliveryId: "delivery-dedupe",
      bodyHash: expect.any(String),
      deduped: true,
    });
    expect(
      store
        .read()
        .ingressDeliveries.filter(
          (delivery) => delivery.key === "github:webhook:ping:delivery-dedupe",
        ),
    ).toHaveLength(1);
    expect(
      store
        .read()
        .ingressDeliveries.filter((delivery) =>
          delivery.key.startsWith("github:webhook-body:"),
        ),
    ).toHaveLength(1);
  });

  it("dedupes GitHub webhook replays even when delivery headers change", async () => {
    const store = new BekStore();
    const app = createApp(store);
    const rawBody = JSON.stringify({ zen: "Same signed body." });
    const first = await app.request("/api/github/webhooks", {
      method: "POST",
      body: rawBody,
      headers: signedGitHubHeaders(rawBody, {
        eventName: "ping",
        deliveryId: "delivery-body-replay-one",
      }),
    });
    const second = await app.request("/api/github/webhooks", {
      method: "POST",
      body: rawBody,
      headers: signedGitHubHeaders(rawBody, {
        eventName: "ping",
        deliveryId: "delivery-body-replay-two",
      }),
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({
      deliveryId: "delivery-body-replay-one",
      bodyHash: expect.any(String),
      deduped: true,
    });
    expect(
      store
        .read()
        .ingressDeliveries.filter((delivery) => delivery.provider === "github"),
    ).toHaveLength(2);
  });

  it("rolls back GitHub webhook dedupe records when persistence fails", async () => {
    const store = new BekStore(undefined, {
      onSnapshotChanged: async () => {
        throw new Error("database unavailable");
      },
    });
    const rawBody = JSON.stringify({ zen: "Persist me." });
    const res = await createApp(store).request("/api/github/webhooks", {
      method: "POST",
      body: rawBody,
      headers: signedGitHubHeaders(rawBody, {
        eventName: "ping",
        deliveryId: "delivery-persistence-failure",
      }),
    });

    expect(res.status).toBe(400);
    expect(
      store.findIngressDelivery(
        "github:webhook:ping:delivery-persistence-failure",
      ),
    ).toBeUndefined();
    expect(
      store
        .read()
        .ingressDeliveries.some((delivery) =>
          delivery.key.startsWith("github:webhook-body:"),
        ),
    ).toBe(false);
  });

  it("normalizes and persists supported GitHub pull request webhooks", async () => {
    const store = new BekStore();
    const payload = {
      action: "opened",
      number: 42,
      installation: { id: 12345 },
      sender: { login: "octocat" },
      repository: { full_name: "redohq/checkout" },
      pull_request: {
        id: 987,
        number: 42,
        title: "Ship Bek",
        state: "open",
        draft: false,
        html_url: "https://github.com/redohq/checkout/pull/42",
        user: { login: "octocat" },
        head: {
          ref: "bek/ship",
          sha: "abc123",
          repo: { full_name: "octocat/checkout" },
        },
        base: {
          ref: "main",
          sha: "def456",
          repo: { full_name: "redohq/checkout" },
        },
      },
    };
    const rawBody = JSON.stringify(payload);

    const res = await createApp(store).request("/api/github/webhooks", {
      method: "POST",
      body: rawBody,
      headers: signedGitHubHeaders(rawBody, {
        eventName: "pull_request",
        deliveryId: "delivery-pr-opened",
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({
      ok: true,
      provider: "github",
      type: "github.pull_request",
      eventName: "pull_request",
      action: "opened",
      deliveryId: "delivery-pr-opened",
      bodyHash: expect.any(String),
      installationId: "12345",
      pullRequest: {
        number: 42,
        state: "open",
        draft: false,
      },
    });
    expect(JSON.stringify(json)).not.toContain("redohq/checkout");
    expect(JSON.stringify(json)).not.toContain("Ship Bek");
    const delivery = store
      .read()
      .ingressDeliveries.find(
        (candidate) =>
          candidate.key === "github:webhook:pull_request:delivery-pr-opened",
      );
    expect(delivery).toMatchObject({
      provider: "github",
      kind: "github.webhook",
      key: "github:webhook:pull_request:delivery-pr-opened",
      status: "processed",
      response: {
        eventName: "pull_request",
        action: "opened",
        bodyHash: expect.any(String),
      },
    });
    expect(JSON.stringify(delivery)).not.toContain("redohq/checkout");
    expect(JSON.stringify(delivery)).not.toContain("Ship Bek");
  });

  it("persists GitHub installation webhooks as connector installs and repo places", async () => {
    const store = new BekStore();
    const payload = {
      action: "created",
      installation: {
        id: 12345,
        account: { login: "RedoHQ" },
        repository_selection: "selected",
      },
      repositories: [
        { id: 112233, full_name: "RedoHQ/Checkout" },
        { id: 445566, full_name: "RedoHQ/Warehouse" },
      ],
      sender: { login: "octocat" },
    };
    const rawBody = JSON.stringify(payload);

    const res = await createApp(store).request("/api/github/webhooks", {
      method: "POST",
      body: rawBody,
      headers: signedGitHubHeaders(rawBody, {
        eventName: "installation",
        deliveryId: "delivery-install-created",
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({
      ok: true,
      type: "github.installation",
      eventName: "installation",
      action: "created",
      installationId: "12345",
      installation: {
        repositorySelection: "selected",
        repositoryCount: 2,
      },
      persistence: {
        installStatus: "active",
        upsertedRepositories: 2,
      },
    });
    expect(JSON.stringify(json)).not.toContain("redohq/checkout");
    const snapshot = store.read();
    expect(snapshot.connectorInstalls[0]).toMatchObject({
      id: "connector_github_installation_12345",
      kind: "github",
      provider: "github",
      externalId: "12345",
      displayName: "RedoHQ",
      status: "active",
      metadata: expect.objectContaining({
        accountLogin: "RedoHQ",
        repositorySelection: "selected",
        installationId: "12345",
        source: "installation",
      }),
    });
    expect(
      snapshot.places
        .filter((place) => place.kind === "github_repo")
        .map((place) => ({
          externalId: place.externalId,
          name: place.name,
          sensitivity: place.sensitivity,
          metadata: place.metadata,
        })),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          externalId: "112233",
          name: "redohq/checkout",
          sensitivity: "restricted",
          metadata: expect.objectContaining({
            connectorInstallId: "connector_github_installation_12345",
            installationId: "12345",
            resource: "github:redohq/checkout",
            repositoryId: 112233,
            status: "active",
          }),
        }),
        expect.objectContaining({
          externalId: "445566",
          name: "redohq/warehouse",
          sensitivity: "restricted",
          metadata: expect.objectContaining({
            resource: "github:redohq/warehouse",
            repositoryId: 445566,
            status: "active",
          }),
        }),
      ]),
    );
    const delivery = snapshot.ingressDeliveries.find(
      (candidate) =>
        candidate.key ===
        "github:webhook:installation:delivery-install-created",
    );
    expect(JSON.stringify(delivery)).not.toContain("redohq/checkout");
  });

  it("marks removed GitHub installation repositories inactive without deleting places", async () => {
    const store = new BekStore();
    const app = createApp(store);
    const installBody = JSON.stringify({
      action: "created",
      installation: {
        id: 12345,
        account: { login: "RedoHQ" },
        repository_selection: "selected",
      },
      repositories: [{ id: 112233, full_name: "RedoHQ/Checkout" }],
    });
    const removeBody = JSON.stringify({
      action: "removed",
      installation: {
        id: 12345,
        account: { login: "RedoHQ" },
        repository_selection: "selected",
      },
      repositories_removed: [{ id: 112233, full_name: "RedoHQ/Checkout" }],
    });

    await app.request("/api/github/webhooks", {
      method: "POST",
      body: installBody,
      headers: signedGitHubHeaders(installBody, {
        eventName: "installation",
        deliveryId: "delivery-install-before-remove",
      }),
    });
    const res = await app.request("/api/github/webhooks", {
      method: "POST",
      body: removeBody,
      headers: signedGitHubHeaders(removeBody, {
        eventName: "installation_repositories",
        deliveryId: "delivery-install-repo-removed",
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      persistence: {
        removedRepositories: 1,
      },
    });
    const checkoutPlaces = store
      .read()
      .places.filter(
        (place) =>
          place.kind === "github_repo" && place.externalId === "112233",
      );
    expect(checkoutPlaces).toHaveLength(1);
    expect(checkoutPlaces[0]).toMatchObject({
      metadata: expect.objectContaining({
        status: "removed",
        removedAt: expect.any(String),
      }),
    });
  });

  it("revokes GitHub repo places when an installation is deleted", async () => {
    const store = new BekStore();
    const app = createApp(store);
    const installBody = JSON.stringify({
      action: "created",
      installation: {
        id: 12345,
        account: { login: "RedoHQ" },
        repository_selection: "selected",
      },
      repositories: [{ id: 112233, full_name: "RedoHQ/Checkout" }],
    });
    const deleteBody = JSON.stringify({
      action: "deleted",
      installation: {
        id: 12345,
        account: { login: "RedoHQ" },
        repository_selection: "selected",
      },
      repositories: [{ id: 112233, full_name: "RedoHQ/Checkout" }],
    });

    await app.request("/api/github/webhooks", {
      method: "POST",
      body: installBody,
      headers: signedGitHubHeaders(installBody, {
        eventName: "installation",
        deliveryId: "delivery-install-before-delete",
      }),
    });
    const res = await app.request("/api/github/webhooks", {
      method: "POST",
      body: deleteBody,
      headers: signedGitHubHeaders(deleteBody, {
        eventName: "installation",
        deliveryId: "delivery-install-deleted",
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      persistence: {
        installStatus: "revoked",
        revokedRepositories: 1,
      },
    });
    expect(store.read().connectorInstalls[0]).toMatchObject({
      externalId: "12345",
      status: "revoked",
    });
    expect(
      store.read().places.find((place) => place.externalId === "112233"),
    ).toMatchObject({
      metadata: expect.objectContaining({
        status: "revoked",
        revokedAt: expect.any(String),
      }),
    });
  });

  it("keeps Slack and GitHub webhook signatures isolated", async () => {
    process.env.SLACK_SIGNING_SECRET = "test-slack-secret";
    const slackBody = JSON.stringify({
      event_id: "EvGithubSignatureNotSlack",
      event: {
        type: "app_mention",
        channel: "C_CHECKOUT",
        user: "U123",
        text: "@bek hello",
      },
    });
    const slackRes = await createApp().request("/api/slack/events", {
      method: "POST",
      body: slackBody,
      headers: signedGitHubHeaders(slackBody, {
        eventName: "ping",
        deliveryId: "delivery-github-signature-not-slack",
      }),
    });
    expect(slackRes.status).toBe(401);

    const githubBody = JSON.stringify({ zen: "Slack signatures do not pass." });
    const githubRes = await createApp().request("/api/github/webhooks", {
      method: "POST",
      body: githubBody,
      headers: {
        ...signedSlackHeaders(githubBody),
        "x-github-event": "ping",
        "x-github-delivery": "delivery-slack-signature-not-github",
      },
    });
    expect(githubRes.status).toBe(401);
  });

  it("rejects admin API request bodies over the configured limit", async () => {
    process.env.BEK_MAX_REQUEST_BODY_BYTES = "64";
    const store = new BekStore();
    const beforeRuns = store.read().runs.length;
    const body = JSON.stringify({
      prompt: `open a PR ${"x".repeat(128)}`,
      placeScopeId: "place_checkout",
      capability: "github.pr",
      resource: "github:redohq/checkout",
    });

    const res = await createApp(store).request("/api/runs", {
      method: "POST",
      body,
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toMatchObject({
      error: "Request body too large.",
      maxBytes: 64,
    });
    expect(store.read().runs).toHaveLength(beforeRuns);
  });

  it("rejects oversized Slack callbacks before creating work", async () => {
    process.env.BEK_MAX_REQUEST_BODY_BYTES = "64";
    mapSlackTestUser();
    const store = new BekStore();
    const beforeRuns = store.read().runs.length;
    const rawBody = JSON.stringify({
      event_id: "EvOversizedSlackBody",
      event: {
        type: "app_mention",
        channel: "C_CHECKOUT",
        user: "U123",
        text: `@bek ${"x".repeat(128)}`,
      },
    });

    const res = await createApp(store).request("/api/slack/events", {
      method: "POST",
      body: rawBody,
      headers: signedSlackHeaders(rawBody),
    });

    expect(res.status).toBe(413);
    expect(res.headers.get("x-slack-no-retry")).toBe("1");
    await expect(res.json()).resolves.toMatchObject({
      error: "Request body too large.",
      maxBytes: 64,
    });
    expect(store.read().runs).toHaveLength(beforeRuns);
  });

  it("rate limits repeated admin API requests from the same peer", async () => {
    process.env.BEK_RATE_LIMIT_MAX_REQUESTS = "2";
    process.env.BEK_RATE_LIMIT_WINDOW_MS = "60000";
    const app = createApp();

    const first = await app.request("/api/bootstrap");
    const second = await app.request("/api/bootstrap");
    const limited = await app.request("/api/bootstrap");

    expect(first.status).toBe(200);
    expect(first.headers.get("x-ratelimit-remaining")).toBe("1");
    expect(second.status).toBe(200);
    expect(second.headers.get("x-ratelimit-remaining")).toBe("0");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    await expect(limited.json()).resolves.toMatchObject({
      error: "Too many requests.",
      limit: 2,
      retryAfterSeconds: 60,
      windowMs: 60000,
    });
  });

  it("rate limits Slack callbacks without asking Slack to retry", async () => {
    process.env.BEK_RATE_LIMIT_MAX_REQUESTS = "1";
    process.env.BEK_RATE_LIMIT_WINDOW_MS = "60000";
    mapSlackTestUser();
    const store = new BekStore();
    const app = createApp(store);
    const firstBody = JSON.stringify({
      event_id: "EvRateLimitedFirst",
      event: {
        type: "app_mention",
        channel: "C_CHECKOUT",
        user: "U123",
        text: "@bek first",
      },
    });
    const secondBody = JSON.stringify({
      event_id: "EvRateLimitedSecond",
      event: {
        type: "app_mention",
        channel: "C_CHECKOUT",
        user: "U123",
        text: "@bek second",
      },
    });

    const first = await app.request("/api/slack/events", {
      method: "POST",
      body: firstBody,
      headers: signedSlackHeaders(firstBody),
    });
    const limited = await app.request("/api/slack/events", {
      method: "POST",
      body: secondBody,
      headers: signedSlackHeaders(secondBody),
    });

    expect(first.status).toBe(200);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("x-slack-no-retry")).toBe("1");
    await expect(limited.json()).resolves.toMatchObject({
      error: "Too many requests.",
      limit: 1,
      retryAfterSeconds: 60,
    });
    expect(store.read().runs.map((run) => run.prompt)).not.toContain(
      "@bek second",
    );
  });

  it("allows local dev admin origins when Vite falls back to another port", async () => {
    const res = await createApp().request("/api/bootstrap", {
      headers: { origin: "http://localhost:5174" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:5174",
    );
  });

  it("returns health", async () => {
    const res = await createApp().request("/health");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      name: "bek-api",
    });
  });

  it("returns readiness with persistence checks", async () => {
    const res = await createApp(new BekStore(), {
      readinessCheck: async () => ({
        storageMode: "memory",
        workerQueueBackend: "memory",
      }),
    }).request("/ready");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      name: "bek-api",
      checks: {
        store: { ok: true },
        modelUsage: { ok: true },
        workerQueue: { ok: true, skipped: true },
        persistence: {
          ok: true,
          details: {
            storageMode: "memory",
            workerQueueBackend: "memory",
          },
        },
      },
    });
  });

  it("fails readiness and redacts secret-shaped check errors", async () => {
    const res = await createApp(new BekStore(), {
      readinessCheck: async () => {
        throw new Error(
          "database unavailable for xoxb-secret-token-value12345",
        );
      },
    }).request("/ready");

    expect(res.status).toBe(503);
    const json = (await res.json()) as {
      ok: boolean;
      checks: { persistence: { ok: boolean; error: string } };
    };
    expect(json.ok).toBe(false);
    expect(json.checks.persistence).toMatchObject({
      ok: false,
      error: "database unavailable for [redacted:slack-token]",
    });
    expect(json.checks.persistence.error).not.toContain("secret-token");
  });

  it("reports setup status for the local product spine", async () => {
    const res = await createApp().request("/api/setup/status");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      visibleHandle: "@bek",
      singleVisibleAgent: true,
      modelGatewayMode: "local",
      modelPricingReady: true,
      missingPricedModels: [],
      modelPricingError: null,
      runtimeProfiles: 2,
      runtimeExecutableProfiles: 1,
      runtimeExecutionReady: false,
      runtimeExecutionErrors: [
        "Runtime profile runtime_code uses opencode-sandbox, but BEK_SANDBOX_PROVIDER is not configured.",
      ],
      sandboxedRuntimeProfiles: 1,
      sandboxProviderMode: "none",
      sandboxProviderEnabled: false,
      sandboxProviderReady: false,
      sandboxProviderNetworkCalls: "none",
      sandboxProviderErrors: [],
      githubExecutionMode: "disabled",
      githubExecutionReady: true,
      githubExecutionNetworkCalls: "none",
      readyForLocalDemo: true,
      readyForWorkspace: false,
    });
  });

  it("skips GitHub execution readiness by default", async () => {
    clearGitHubEnv();

    const res = await createApp().request("/ready");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      checks: {
        githubExecution: {
          ok: true,
          skipped: true,
          details: {
            mode: "disabled",
            networkCalls: "none",
          },
        },
      },
    });
  });

  it("fails GitHub execution readiness only when real execution is explicitly enabled with invalid config", async () => {
    clearGitHubEnv();
    process.env.BEK_GITHUB_EXECUTION = "real";
    process.env.GITHUB_APP_PRIVATE_KEY = "definitely-secret";

    const res = await createApp().request("/ready");

    expect(res.status).toBe(503);
    const json = (await res.json()) as {
      ok: boolean;
      checks: { githubExecution: { ok: boolean; error: string } };
    };
    expect(json.ok).toBe(false);
    expect(json.checks.githubExecution.ok).toBe(false);
    expect(json.checks.githubExecution.error).toContain(
      "GITHUB_APP_ID is required.",
    );
    expect(json.checks.githubExecution.error).not.toContain(
      "GITHUB_APP_INSTALLATION_ID",
    );
    expect(JSON.stringify(json)).not.toContain("definitely-secret");
  });

  it("reports real GitHub execution readiness without minting tokens", async () => {
    clearGitHubEnv();
    process.env.BEK_GITHUB_EXECUTION = "real";
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY = testGitHubPrivateKey;
    process.env.GITHUB_APP_WEBHOOK_SECRET = "a-webhook-secret-with-length";
    process.env.GITHUB_API_BASE_URL = "https://api.github.test";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("fetch should not be called"));
    const app = createApp();

    const ready = await app.request("/ready");
    const status = await app.request("/api/setup/status");

    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toMatchObject({
      checks: {
        githubExecution: {
          ok: true,
          details: {
            mode: "real",
            networkCalls: "github_on_approved_worker_run",
          },
        },
      },
    });
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({
      githubExecutionMode: "real",
      githubExecutionReady: true,
      githubExecutionNetworkCalls: "github_on_approved_worker_run",
      githubRepoBindingsReady: false,
      missingGithubRepoBindings: ["github:redohq/checkout"],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports unpriced model policies in setup status", async () => {
    process.env.BEK_MODEL_PROVIDER_REGISTRY_JSON = JSON.stringify([
      {
        id: "openai",
        displayName: "OpenAI",
        kind: "openai",
        models: [{ id: "openai/gpt-5.4" }],
      },
    ]);

    const res = await createApp().request("/api/setup/status");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      modelPricingReady: false,
      missingPricedModels: [
        "anthropic/claude-sonnet-4.8",
        "openai-compatible/local",
        "openai/gpt-5.4",
      ],
      readyForLocalDemo: false,
    });
  });

  it("requires installed Slack token scopes before workspace readiness", async () => {
    const store = new BekStore();
    const install = store.upsertConnectorInstall({
      id: "connector_slack_T123",
      kind: "slack",
      provider: "slack",
      externalId: "T123",
      displayName: "Redo",
      status: "active",
      metadata: {
        teamId: "T123",
        teamName: "Redo",
        botUserId: "U_BEK",
        scopes: ["app_mentions:read", "commands", "chat:write"],
      },
    });
    store.upsertCredential({
      id: "credential_slack_bot_T123",
      connectorInstallId: install.id,
      name: "Redo Slack bot token",
      provider: "slack",
      externalAccountId: "T123",
      secretRef: "bek-local-vault:slack:org_demo:T123:bot",
      status: "active",
      scopeSummary: "app_mentions:read,commands,chat:write",
    });

    const res = await createApp(store).request("/api/setup/status");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      slackInstalled: true,
      slackTokenStored: true,
      slackRequiredScopes: expect.arrayContaining([
        "app_mentions:read",
        "commands",
        "chat:write",
        "channels:read",
        "groups:read",
        "im:history",
      ]),
      slackGrantedScopes: expect.arrayContaining([
        "app_mentions:read",
        "commands",
        "chat:write",
      ]),
      missingSlackScopes: expect.arrayContaining([
        "reactions:read",
        "channels:read",
        "groups:read",
        "im:history",
      ]),
      readyForWorkspace: false,
    });
  });

  it("uses configured Slack bot scopes for setup readiness", async () => {
    process.env.SLACK_BOT_SCOPES = "chat:write,users:read";
    const store = new BekStore();
    const install = store.upsertConnectorInstall({
      id: "connector_slack_T123",
      kind: "slack",
      provider: "slack",
      externalId: "T123",
      displayName: "Redo",
      status: "active",
      metadata: {
        teamId: "T123",
        teamName: "Redo",
        botUserId: "U_BEK",
        scopes: ["chat:write"],
      },
    });
    store.upsertCredential({
      id: "credential_slack_bot_T123",
      connectorInstallId: install.id,
      name: "Redo Slack bot token",
      provider: "slack",
      externalAccountId: "T123",
      secretRef: "bek-local-vault:slack:org_demo:T123:bot",
      status: "active",
      scopeSummary: "chat:write",
    });

    const res = await createApp(store).request("/api/setup/status");
    const json = (await res.json()) as {
      slackRequiredScopes: string[];
      missingSlackScopes: string[];
    };

    expect(res.status).toBe(200);
    expect(json.slackRequiredScopes).toEqual(["chat:write", "users:read"]);
    expect(json.missingSlackScopes).toEqual(["users:read"]);
  });

  it("marks the seed workspace ready when Slack scopes and GitHub execution are complete", async () => {
    process.env.BEK_GITHUB_EXECUTION = "fake";
    process.env.BEK_SANDBOX_PROVIDER = "docker-local";
    const store = new BekStore();
    const scopes = [
      "app_mentions:read",
      "reactions:read",
      "commands",
      "chat:write",
      "channels:read",
      "groups:read",
      "im:history",
    ];
    const install = store.upsertConnectorInstall({
      id: "connector_slack_T123",
      kind: "slack",
      provider: "slack",
      externalId: "T123",
      displayName: "Redo",
      status: "active",
      metadata: {
        teamId: "T123",
        teamName: "Redo",
        botUserId: "U_BEK",
        scopes,
      },
    });
    store.upsertCredential({
      id: "credential_slack_bot_T123",
      connectorInstallId: install.id,
      name: "Redo Slack bot token",
      provider: "slack",
      externalAccountId: "T123",
      secretRef: "bek-local-vault:slack:org_demo:T123:bot",
      status: "active",
      scopeSummary: scopes.join(","),
    });

    const res = await createApp(store).request("/api/setup/status");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      slackInstalled: true,
      slackTokenStored: true,
      missingSlackScopes: [],
      githubExecutionMode: "fake",
      githubExecutionEnabled: true,
      githubExecutionReady: true,
      githubExecutionNetworkCalls: "none",
      runtimeProfiles: 2,
      runtimeExecutableProfiles: 2,
      runtimeExecutionReady: true,
      runtimeExecutionErrors: [],
      sandboxedRuntimeProfiles: 1,
      sandboxProviderMode: "docker-local",
      sandboxProviderEnabled: true,
      sandboxProviderReady: true,
      sandboxProviderNetworkCalls: "docker_on_worker_run",
      sandboxProviderErrors: [],
      readyForLocalDemo: true,
      readyForWorkspace: true,
    });
  });

  it("keeps the seed workspace unready when opencode-sandbox has no sandbox provider", async () => {
    process.env.BEK_GITHUB_EXECUTION = "fake";
    const store = new BekStore();
    const scopes = [
      "app_mentions:read",
      "reactions:read",
      "commands",
      "chat:write",
      "channels:read",
      "groups:read",
      "im:history",
    ];
    const install = store.upsertConnectorInstall({
      id: "connector_slack_T123",
      kind: "slack",
      provider: "slack",
      externalId: "T123",
      displayName: "Redo",
      status: "active",
      metadata: {
        teamId: "T123",
        teamName: "Redo",
        botUserId: "U_BEK",
        scopes,
      },
    });
    store.upsertCredential({
      id: "credential_slack_bot_T123",
      connectorInstallId: install.id,
      name: "Redo Slack bot token",
      provider: "slack",
      externalAccountId: "T123",
      secretRef: "bek-local-vault:slack:org_demo:T123:bot",
      status: "active",
      scopeSummary: scopes.join(","),
    });

    const res = await createApp(store).request("/api/setup/status");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      missingSlackScopes: [],
      githubExecutionMode: "fake",
      githubExecutionEnabled: true,
      githubExecutionReady: true,
      runtimeProfiles: 2,
      runtimeExecutableProfiles: 1,
      runtimeExecutionReady: false,
      runtimeExecutionErrors: [
        "Runtime profile runtime_code uses opencode-sandbox, but BEK_SANDBOX_PROVIDER is not configured.",
      ],
      sandboxedRuntimeProfiles: 1,
      sandboxProviderMode: "none",
      sandboxProviderEnabled: false,
      sandboxProviderReady: false,
      readyForLocalDemo: true,
      readyForWorkspace: false,
    });
  });

  it("keeps the seed workspace unready when GitHub execution is disabled", async () => {
    const store = new BekStore();
    const scopes = [
      "app_mentions:read",
      "reactions:read",
      "commands",
      "chat:write",
      "channels:read",
      "groups:read",
      "im:history",
    ];
    const install = store.upsertConnectorInstall({
      id: "connector_slack_T123",
      kind: "slack",
      provider: "slack",
      externalId: "T123",
      displayName: "Redo",
      status: "active",
      metadata: {
        teamId: "T123",
        teamName: "Redo",
        botUserId: "U_BEK",
        scopes,
      },
    });
    store.upsertCredential({
      id: "credential_slack_bot_T123",
      connectorInstallId: install.id,
      name: "Redo Slack bot token",
      provider: "slack",
      externalAccountId: "T123",
      secretRef: "bek-local-vault:slack:org_demo:T123:bot",
      status: "active",
      scopeSummary: scopes.join(","),
    });

    const res = await createApp(store).request("/api/setup/status");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      missingSlackScopes: [],
      githubGrantCount: 2,
      githubExecutionMode: "disabled",
      githubExecutionEnabled: false,
      githubExecutionReady: true,
      readyForLocalDemo: true,
      readyForWorkspace: false,
    });
  });

  it("reports GitHub setup gaps without leaking configured secret values", async () => {
    clearGitHubEnv();
    process.env.GITHUB_APP_ID = "not-a-number";
    process.env.GITHUB_APP_PRIVATE_KEY = "definitely-secret";

    const res = await createApp().request("/api/setup/github");

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      appConfig: {
        ok: boolean;
        privateKeyConfigured: boolean;
        errors: string[];
      };
      installation: { configured: boolean; errors: string[] };
      githubGrantCount: number;
      validRepoGrantCount: number;
      repositories: Array<{
        repository: { resource: string };
        requiredPermissions: Record<string, string>;
        installationTokenRequestPreview: unknown;
      }>;
      networkCalls: string;
    };

    expect(json.ok).toBe(false);
    expect(json.appConfig).toMatchObject({
      ok: false,
      privateKeyConfigured: true,
      errors: expect.arrayContaining([
        "GITHUB_APP_ID must be a positive integer string.",
        "GITHUB_APP_PRIVATE_KEY must be a PEM private key.",
        "GITHUB_APP_WEBHOOK_SECRET is required.",
      ]),
    });
    expect(json.installation).toMatchObject({
      configured: false,
      errors: [
        "GITHUB_APP_INSTALLATION_ID or installationId query parameter is required for installation-token previews.",
      ],
    });
    expect(json.githubGrantCount).toBe(2);
    expect(json.validRepoGrantCount).toBe(2);
    expect(json.repositories).toHaveLength(1);
    expect(json.repositories[0]).toMatchObject({
      repository: { resource: "github:redohq/checkout" },
      requiredPermissions: {
        contents: "write",
        metadata: "read",
        pull_requests: "write",
      },
      installationTokenRequestPreview: null,
    });
    expect(json.networkCalls).toBe("none");
    expect(JSON.stringify(json)).not.toContain("definitely-secret");
  });

  it("previews GitHub repo grants and installation token requests without network calls", async () => {
    clearGitHubEnv();
    process.env.BEK_GITHUB_EXECUTION = "real";
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_INSTALLATION_ID = "999";
    process.env.GITHUB_APP_PRIVATE_KEY = testGitHubPrivateKey;
    process.env.GITHUB_APP_WEBHOOK_SECRET = "a-webhook-secret-with-length";
    process.env.GITHUB_API_BASE_URL = "https://api.github.test";
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await createApp().request(
      "/api/setup/github?installationId=456",
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      appConfig: { ok: boolean; appId: string | null };
      installation: {
        configured: boolean;
        source: "query" | "env" | null;
        installationId: string | null;
      };
      repositories: Array<{
        repository: { resource: string; fullName: string };
        grants: Array<{ capability: string }>;
        requiredPermissions: Record<string, string>;
        installationTokenRequestPreview: {
          installationId: string;
          repository: { resource: string };
          permissions: Record<string, string>;
        };
        draftPullRequestWorkflowPreview: {
          steps: string[];
          pullRequestProposal: {
            capability: string;
            approval: { action: string; risk: string; required: boolean };
          };
          approvalHashInput: {
            action: string;
            installationId: string | null;
          };
        };
      }>;
    };

    expect(json).toMatchObject({
      ok: true,
      appConfig: { ok: true, appId: "12345" },
      installation: {
        configured: true,
        source: "query",
        installationId: "456",
      },
    });
    expect(json.repositories).toHaveLength(1);
    expect(json.repositories[0]).toMatchObject({
      repository: {
        resource: "github:redohq/checkout",
        fullName: "redohq/checkout",
      },
      requiredPermissions: {
        contents: "write",
        metadata: "read",
        pull_requests: "write",
      },
      installationTokenRequestPreview: {
        installationId: "456",
        repository: { resource: "github:redohq/checkout" },
        permissions: {
          contents: "write",
          metadata: "read",
          pull_requests: "write",
        },
      },
      draftPullRequestWorkflowPreview: {
        steps: [
          "mint_installation_token",
          "create_branch",
          "commit_changes",
          "open_draft_pull_request",
        ],
        pullRequestProposal: {
          capability: "github.pr",
          approval: {
            action: "github.pr",
            risk: "write_external",
            required: true,
          },
        },
        approvalHashInput: {
          action: "github.pr",
          installationId: "456",
        },
      },
    });
    expect(
      json.repositories[0]!.grants.map((grant) => grant.capability),
    ).toEqual(expect.arrayContaining(["github.read", "github.pr"]));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(json)).not.toContain("abc123");
    expect(JSON.stringify(json)).not.toContain("a-webhook-secret-with-length");
  });

  it("separates GitHub grants that cannot become repo-scoped token requests", async () => {
    clearGitHubEnv();
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_INSTALLATION_ID = "456";
    process.env.GITHUB_APP_PRIVATE_KEY = testGitHubPrivateKey;
    process.env.GITHUB_APP_WEBHOOK_SECRET = "a-webhook-secret-with-length";
    const snapshot = createSeedSnapshot();
    snapshot.accessBundles.unshift({
      id: "bundle_org_wide_github",
      orgId: snapshot.org.id,
      name: "Org-wide GitHub",
      description: "Wildcard policy grant that is not repo-scoped.",
      budgetPolicyId: "budget_checkout",
      attachedPlaceIds: [],
      grants: [],
    });
    snapshot.accessBundles[0]!.grants.push({
      id: "grant_org_wide_github",
      capability: "github.read",
      resource: "github:redohq/*",
      decision: "allow",
      risk: "read_internal",
      requiresApproval: false,
    });

    const res = await createApp(new BekStore(snapshot)).request(
      "/api/setup/github",
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      invalidGrantCount: 1,
      invalidGrants: [
        expect.objectContaining({
          resource: "github:redohq/*",
          errors: ["GitHub repo must be a valid repository name."],
        }),
      ],
    });
  });

  it("serves every read-only admin resource", async () => {
    const app = createApp();

    const bootstrap = await expectJson<{
      org: { id: string };
      agent: { handle: string };
    }>(app, "/api/bootstrap");
    expect(bootstrap).toMatchObject({
      org: { id: "org_demo" },
      agent: { handle: "@bek" },
    });
    expect(bootstrap).not.toHaveProperty("ingressDeliveries");
    expect(bootstrap).not.toHaveProperty("outboundDeliveries");

    await expect(expectJson(app, "/api/org")).resolves.toMatchObject({
      id: "org_demo",
    });
    await expect(expectJson(app, "/api/agent")).resolves.toMatchObject({
      handle: "@bek",
    });
    await expect(expectJson(app, "/api/principals")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "principal_bryson", kind: "human" }),
      ]),
    );
    await expect(expectJson(app, "/api/capabilities")).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "cap_answer" })]),
    );
    await expect(expectJson(app, "/api/channels")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "place_checkout" }),
      ]),
    );
    await expect(
      expectJson(app, "/api/channels/C_CHECKOUT"),
    ).resolves.toMatchObject({
      channel: { id: "place_checkout" },
      bundles: [expect.objectContaining({ id: "bundle_checkout" })],
      runs: [expect.objectContaining({ id: "run_demo" })],
    });
    await expect(expectJson(app, "/api/access-bundles")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "bundle_checkout" }),
      ]),
    );
    await expect(expectJson(app, "/api/model-policies")).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "model_auto" })]),
    );
    await expect(expectJson(app, "/api/runtime-profiles")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "runtime_answer" }),
      ]),
    );
    await expect(expectJson(app, "/api/runs")).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "run_demo" })]),
    );
    await expect(expectJson(app, "/api/approvals")).resolves.toEqual([]);
    await expect(expectJson(app, "/api/audit-events")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "run.completed" }),
      ]),
    );
    await expect(expectJson(app, "/api/model-usage")).resolves.toMatchObject({
      runs: 1,
      totalEstimatedCents: 4,
      totalActualCents: 3,
    });
    await expect(expectJson(app, "/api/runs/run_demo")).resolves.toMatchObject({
      run: { id: "run_demo" },
      events: expect.any(Array),
      approvals: [],
    });
    await expect(expectJson(app, "/api/runs/run_demo/events")).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ runId: "run_demo" })]),
    );
  });

  it("does not expose delivery ledgers through bootstrap", async () => {
    process.env.BEK_SLACK_BACKGROUND_DRAIN = "false";
    mapSlackTestUser();
    const store = new BekStore();
    const app = createApp(store);
    const rawBody = JSON.stringify({
      team_id: "T123",
      event_id: "EvBootstrapLedgerHidden",
      event: {
        type: "app_mention",
        channel: "C_CHECKOUT",
        user: "U123",
        text: "@bek keep delivery ledgers internal",
        ts: "1710000000.000090",
      },
    });

    const slack = await app.request("/api/slack/events", {
      method: "POST",
      body: rawBody,
      headers: signedSlackHeaders(rawBody),
    });
    expect(slack.status).toBe(200);
    expect(store.read().ingressDeliveries.length).toBeGreaterThan(0);
    expect(store.read().outboundDeliveries.length).toBeGreaterThan(0);

    const bootstrap = (await (
      await app.request("/api/bootstrap")
    ).json()) as Record<string, unknown>;
    expect(bootstrap.ingressDeliveries).toBeUndefined();
    expect(bootstrap.outboundDeliveries).toBeUndefined();
  });

  it("prefers model usage repository totals when they are available", async () => {
    const app = createApp(new BekStore(), {
      modelUsageRepository: {
        readModelUsageTotals: (orgId) => {
          expect(orgId).toBe("org_demo");
          return {
            runs: 2,
            totalEstimatedCents: 11,
            totalActualCents: 9,
            modelCalls: 3,
            inputTokens: 2400,
            outputTokens: 600,
            totalTokens: 3000,
          };
        },
      },
    });

    await expect(expectJson(app, "/api/model-usage")).resolves.toEqual({
      runs: 2,
      totalEstimatedCents: 11,
      totalActualCents: 9,
      modelCalls: 3,
      inputTokens: 2400,
      outputTokens: 600,
      totalTokens: 3000,
      source: "model_usage",
    });
  });

  it("updates the agent while preserving the single visible handle", async () => {
    const res = await createApp().request("/api/agent", {
      method: "PATCH",
      body: JSON.stringify({
        name: "Bek Teammate",
        status: "paused",
      }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      name: "Bek Teammate",
      handle: "@bek",
      status: "paused",
    });
  });

  it("links external identities to principals for Slack workspace mapping", async () => {
    const app = createApp();

    const linked = await app.request(
      "/api/principals/principal_bryson/external-identity",
      {
        method: "PATCH",
        body: JSON.stringify({
          externalProvider: "slack",
          externalId: "T123:U123",
          metadata: { teamId: "T123" },
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(linked.status).toBe(200);
    await expect(linked.json()).resolves.toMatchObject({
      id: "principal_bryson",
      externalProvider: "slack",
      externalId: "T123:U123",
      metadata: { teamId: "T123" },
    });

    await expect(expectJson(app, "/api/bootstrap")).resolves.toMatchObject({
      principals: expect.arrayContaining([
        expect.objectContaining({
          id: "principal_bryson",
          externalProvider: "slack",
          externalId: "T123:U123",
        }),
      ]),
    });

    const duplicate = await app.request(
      "/api/principals/principal_admin/external-identity",
      {
        method: "PATCH",
        body: JSON.stringify({
          externalProvider: "slack",
          externalId: "T123:U123",
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(duplicate.status).toBe(409);
  });

  it("rejects invalid agent control-plane mutations", async () => {
    const app = createApp();

    const unknownField = await app.request("/api/agent", {
      method: "PATCH",
      body: JSON.stringify({ handle: "@not-bek" }),
      headers: { "content-type": "application/json" },
    });
    expect(unknownField.status).toBe(400);
    await expect(expectJson(app, "/api/agent")).resolves.toMatchObject({
      handle: "@bek",
    });

    const empty = await app.request("/api/agent", {
      method: "PATCH",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });
    expect(empty.status).toBe(400);

    const missingPolicy = await app.request("/api/agent", {
      method: "PATCH",
      body: JSON.stringify({ defaultModelPolicyId: "model_missing" }),
      headers: { "content-type": "application/json" },
    });
    expect(missingPolicy.status).toBe(404);
  });

  it("creates, updates, and protects channel scopes", async () => {
    const app = createApp();
    const created = await app.request("/api/channels", {
      method: "POST",
      body: JSON.stringify({
        externalId: "C_PRODUCT",
        name: "#product",
        sensitivity: "confidential",
      }),
      headers: { "content-type": "application/json" },
    });

    expect(created.status).toBe(201);
    const channel = (await created.json()) as { id: string };
    const bootstrapAfterCreate = await expectJson<{
      accessBundles: Array<{
        attachedPlaceIds: string[];
        grants: Array<{
          capability: string;
          resource: string;
          decision: string;
          requiresApproval: boolean;
        }>;
      }>;
    }>(app, "/api/bootstrap");
    expect(
      bootstrapAfterCreate.accessBundles.find(
        (bundle) =>
          bundle.attachedPlaceIds.includes(channel.id) &&
          bundle.grants.some(
            (grant) =>
              grant.capability === "slack.read" &&
              grant.resource === "slack:C_PRODUCT" &&
              grant.decision === "allow" &&
              grant.requiresApproval === false,
          ),
      ),
    ).toBeDefined();

    const importedChannelRun = await app.request("/api/runs", {
      method: "POST",
      body: JSON.stringify({
        prompt: "@bek summarize product channel",
        placeScopeId: channel.id,
        capability: "slack.read",
        resource: "slack:C_PRODUCT",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(importedChannelRun.status).toBe(201);

    const updated = await app.request(`/api/channels/${channel.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: "#product-ai",
        sensitivity: "restricted",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      id: channel.id,
      name: "#product-ai",
      sensitivity: "restricted",
    });

    const duplicate = await app.request("/api/channels", {
      method: "POST",
      body: JSON.stringify({
        externalId: "C_PRODUCT",
        name: "#dup",
        sensitivity: "internal",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(duplicate.status).toBe(409);

    const externalIdUpdate = await app.request(`/api/channels/${channel.id}`, {
      method: "PATCH",
      body: JSON.stringify({ externalId: "C_PRODUCT_AI" }),
      headers: { "content-type": "application/json" },
    });
    expect(externalIdUpdate.status).toBe(200);
    const bootstrapAfterExternalIdUpdate = await expectJson<{
      accessBundles: Array<{
        attachedPlaceIds: string[];
        grants: Array<{ capability: string; resource: string }>;
      }>;
    }>(app, "/api/bootstrap");
    expect(
      bootstrapAfterExternalIdUpdate.accessBundles.find(
        (bundle) =>
          bundle.attachedPlaceIds.includes(channel.id) &&
          bundle.grants.some(
            (grant) =>
              grant.capability === "slack.read" &&
              grant.resource === "slack:C_PRODUCT_AI",
          ),
      ),
    ).toBeDefined();
  });

  it("rejects invalid channel payloads and protects channel deletion edges", async () => {
    const app = createApp();

    const invalidCreate = await app.request("/api/channels", {
      method: "POST",
      body: JSON.stringify({
        externalId: "C_INVALID",
        name: "#invalid",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(invalidCreate.status).toBe(400);

    const emptyPatch = await app.request("/api/channels/place_checkout", {
      method: "PATCH",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });
    expect(emptyPatch.status).toBe(400);

    const duplicateExternalId = await app.request(
      "/api/channels/place_general",
      {
        method: "PATCH",
        body: JSON.stringify({ externalId: "C_CHECKOUT" }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(duplicateExternalId.status).toBe(409);

    const protectedDelete = await app.request("/api/channels/place_checkout", {
      method: "DELETE",
    });
    expect(protectedDelete.status).toBe(400);

    const created = await app.request("/api/channels", {
      method: "POST",
      body: JSON.stringify({
        externalId: "C_TEMP_DELETE",
        name: "#temp-delete",
        sensitivity: "internal",
      }),
      headers: { "content-type": "application/json" },
    });
    const channel = (await created.json()) as { id: string };
    const deleted = await app.request(`/api/channels/${channel.id}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({ id: channel.id });

    const deletedAgain = await app.request(`/api/channels/${channel.id}`, {
      method: "DELETE",
    });
    expect(deletedAgain.status).toBe(404);
  });

  it("creates access bundles, attaches places, and manages grants", async () => {
    const app = createApp();
    const channel = (await (
      await app.request("/api/channels", {
        method: "POST",
        body: JSON.stringify({
          externalId: "C_SUPPORT",
          name: "#support",
          sensitivity: "internal",
        }),
        headers: { "content-type": "application/json" },
      })
    ).json()) as { id: string };

    const bundleRes = await app.request("/api/access-bundles", {
      method: "POST",
      body: JSON.stringify({
        name: "Support",
        description: "Support grants",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(bundleRes.status).toBe(201);
    const bundle = (await bundleRes.json()) as { id: string };

    const attached = await app.request(
      `/api/access-bundles/${bundle.id}/places`,
      {
        method: "POST",
        body: JSON.stringify({ placeId: channel.id }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(attached.status).toBe(200);
    await expect(attached.json()).resolves.toMatchObject({
      attachedPlaceIds: [channel.id],
    });

    const mcpRegistration = await app.request("/api/connectors/mcp", {
      method: "POST",
      body: JSON.stringify({
        serverId: "linear",
        displayName: "Linear",
        transport: "stdio",
        origin: "npx @linear/mcp-server",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(mcpRegistration.status).toBe(201);

    const grantRes = await app.request(
      `/api/access-bundles/${bundle.id}/grants`,
      {
        method: "POST",
        body: JSON.stringify({
          capability: "mcp.tool",
          resource: "mcp:linear/create_issue",
          decision: "ask",
          risk: "write_external",
          requiresApproval: true,
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(grantRes.status).toBe(201);
    const grant = (await grantRes.json()) as { id: string };

    const patched = await app.request(
      `/api/access-bundles/${bundle.id}/grants/${grant.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          decision: "deny",
          requiresApproval: false,
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(patched.status).toBe(200);
    await expect(patched.json()).resolves.toMatchObject({
      decision: "deny",
      requiresApproval: false,
    });
    await expect(expectJson(app, "/api/audit-events")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "access_bundle.place_attached",
          actorPrincipalId: "principal_admin",
          resourceId: bundle.id,
          data: expect.objectContaining({
            placeId: channel.id,
            adminAuthMethod: "local_bypass",
          }),
        }),
        expect.objectContaining({
          action: "access_grant.created",
          actorPrincipalId: "principal_admin",
          resourceId: grant.id,
          decision: "ask",
          risk: "write_external",
          data: expect.objectContaining({
            after: expect.objectContaining({
              resource: "mcp:linear/create_issue",
            }),
          }),
        }),
        expect.objectContaining({
          action: "access_grant.updated",
          actorPrincipalId: "principal_admin",
          resourceId: grant.id,
          decision: "deny",
          data: expect.objectContaining({
            before: expect.objectContaining({ decision: "ask" }),
            after: expect.objectContaining({ decision: "deny" }),
          }),
        }),
      ]),
    );
  });

  it("registers, updates, lists, and audits MCP connector servers", async () => {
    const app = createApp();
    const created = await app.request("/api/connectors/mcp", {
      method: "POST",
      body: JSON.stringify({
        serverId: "linear",
        displayName: "Linear",
        transport: "stdio",
        origin: "npx @linear/mcp-server",
        tags: ["issues"],
      }),
      headers: { "content-type": "application/json" },
    });
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({
      id: "connector_mcp_linear",
      kind: "mcp",
      provider: "mcp",
      externalId: "linear",
      displayName: "Linear",
      status: "pending",
      installedByPrincipalId: "principal_admin",
      metadata: {
        serverId: "linear",
        transport: "stdio",
        origin: "npx @linear/mcp-server",
        tags: ["issues"],
        source: "admin",
      },
    });

    const updated = await app.request("/api/connectors/mcp/linear", {
      method: "PATCH",
      body: JSON.stringify({
        status: "active",
        transport: "http",
        origin: "https://linear.example.test/mcp",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      id: "connector_mcp_linear",
      status: "active",
      metadata: {
        transport: "http",
        origin: "https://linear.example.test/mcp",
        tags: ["issues"],
      },
    });

    const reregistered = await app.request("/api/connectors/mcp", {
      method: "POST",
      body: JSON.stringify({
        serverId: "linear",
        displayName: "Linear Updated",
        transport: "stdio",
        origin: "npx @linear/mcp-server",
        tags: ["issues", "triage"],
      }),
      headers: { "content-type": "application/json" },
    });
    expect(reregistered.status).toBe(200);
    await expect(reregistered.json()).resolves.toMatchObject({
      id: "connector_mcp_linear",
      displayName: "Linear Updated",
      status: "active",
      metadata: {
        transport: "stdio",
        origin: "npx @linear/mcp-server",
        tags: ["issues", "triage"],
      },
    });

    await expect(expectJson(app, "/api/connectors/mcp")).resolves.toEqual([
      expect.objectContaining({
        id: "connector_mcp_linear",
        kind: "mcp",
        provider: "mcp",
        status: "active",
      }),
    ]);

    await expect(expectJson(app, "/api/audit-events")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "mcp_server.registered",
          actorPrincipalId: "principal_admin",
          resourceType: "mcp_server",
          resourceId: "linear",
          data: expect.objectContaining({
            adminAuthMethod: "local_bypass",
            after: expect.objectContaining({
              id: "connector_mcp_linear",
              status: "pending",
            }),
          }),
        }),
        expect.objectContaining({
          action: "mcp_server.updated",
          resourceType: "mcp_server",
          resourceId: "linear",
          data: expect.objectContaining({
            before: expect.objectContaining({ status: "pending" }),
            after: expect.objectContaining({ status: "active" }),
          }),
        }),
      ]),
    );

    const invalid = await app.request("/api/connectors/mcp", {
      method: "POST",
      body: JSON.stringify({
        serverId: "bad/server",
        displayName: "Bad",
        transport: "stdio",
        origin: "local:bad",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(invalid.status).toBe(400);

    const activeOnCreate = await app.request("/api/connectors/mcp", {
      method: "POST",
      body: JSON.stringify({
        serverId: "badstatus",
        displayName: "Bad Status",
        transport: "stdio",
        origin: "npx @bad/mcp-server",
        status: "active",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(activeOnCreate.status).toBe(400);

    const credentialOrigin = await app.request("/api/connectors/mcp", {
      method: "POST",
      body: JSON.stringify({
        serverId: "secretorigin",
        displayName: "Secret Origin",
        transport: "http",
        origin: "https://token:secret@example.test/mcp",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(credentialOrigin.status).toBe(400);

    const incompatibleTransport = await app.request(
      "/api/connectors/mcp/linear",
      {
        method: "PATCH",
        body: JSON.stringify({ transport: "http" }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(incompatibleTransport.status).toBe(400);

    const emptyPatch = await app.request("/api/connectors/mcp/linear", {
      method: "PATCH",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });
    expect(emptyPatch.status).toBe(400);

    const missing = await app.request("/api/connectors/mcp/missing", {
      method: "PATCH",
      body: JSON.stringify({ status: "paused" }),
      headers: { "content-type": "application/json" },
    });
    expect(missing.status).toBe(404);

    const invalidPatchId = await app.request("/api/connectors/mcp/bad%20id", {
      method: "PATCH",
      body: JSON.stringify({ status: "paused" }),
      headers: { "content-type": "application/json" },
    });
    expect(invalidPatchId.status).toBe(400);
  });

  it("handles access bundle idempotency and invalid grant mutations", async () => {
    const app = createApp();
    const bundleRes = await app.request("/api/access-bundles", {
      method: "POST",
      body: JSON.stringify({
        name: "QA",
        description: "QA grants",
        attachedPlaceIds: ["place_checkout", "place_checkout"],
      }),
      headers: { "content-type": "application/json" },
    });
    expect(bundleRes.status).toBe(201);
    const bundle = (await bundleRes.json()) as {
      id: string;
      attachedPlaceIds: string[];
    };
    expect(bundle.attachedPlaceIds).toEqual(["place_checkout"]);

    const firstAttach = await app.request(
      `/api/access-bundles/${bundle.id}/places`,
      {
        method: "POST",
        body: JSON.stringify({ placeId: "place_general" }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(firstAttach.status).toBe(200);

    const secondAttach = await app.request(
      `/api/access-bundles/${bundle.id}/places`,
      {
        method: "POST",
        body: JSON.stringify({ placeId: "place_general" }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(secondAttach.status).toBe(200);
    const attached = (await secondAttach.json()) as {
      attachedPlaceIds: string[];
    };
    expect(
      attached.attachedPlaceIds.filter((id) => id === "place_general"),
    ).toHaveLength(1);

    const firstDetach = await app.request(
      `/api/access-bundles/${bundle.id}/places/place_general`,
      { method: "DELETE" },
    );
    expect(firstDetach.status).toBe(200);

    const secondDetach = await app.request(
      `/api/access-bundles/${bundle.id}/places/place_general`,
      { method: "DELETE" },
    );
    expect(secondDetach.status).toBe(200);
    await expect(secondDetach.json()).resolves.toMatchObject({
      attachedPlaceIds: ["place_checkout"],
    });

    const missingPlace = await app.request(
      `/api/access-bundles/${bundle.id}/places/place_missing`,
      { method: "DELETE" },
    );
    expect(missingPlace.status).toBe(404);

    const invalidBundle = await app.request("/api/access-bundles", {
      method: "POST",
      body: JSON.stringify({
        name: "Invalid",
        description: "Invalid budget",
        budgetPolicyId: "budget_missing",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(invalidBundle.status).toBe(404);

    const emptyPatch = await app.request(`/api/access-bundles/${bundle.id}`, {
      method: "PATCH",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });
    expect(emptyPatch.status).toBe(400);

    const invalidGrant = await app.request(
      `/api/access-bundles/${bundle.id}/grants`,
      {
        method: "POST",
        body: JSON.stringify({
          capability: "mcp.tool",
          resource: "mcp:linear/create_issue",
          decision: "maybe",
          risk: "write_external",
          requiresApproval: true,
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(invalidGrant.status).toBe(400);

    const unregisteredMcpGrant = await app.request(
      `/api/access-bundles/${bundle.id}/grants`,
      {
        method: "POST",
        body: JSON.stringify({
          capability: "mcp.tool",
          resource: "mcp:missing/create_issue",
          decision: "ask",
          risk: "write_external",
          requiresApproval: true,
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(unregisteredMcpGrant.status).toBe(400);
    await expect(unregisteredMcpGrant.json()).resolves.toMatchObject({
      error: "MCP grants must reference a registered MCP server (missing).",
    });

    const malformedMcpGrant = await app.request(
      `/api/access-bundles/${bundle.id}/grants`,
      {
        method: "POST",
        body: JSON.stringify({
          capability: "mcp.tool",
          resource: "mcp:missing",
          decision: "ask",
          risk: "write_external",
          requiresApproval: true,
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(malformedMcpGrant.status).toBe(400);
    await expect(malformedMcpGrant.json()).resolves.toMatchObject({
      error: "MCP grants must use mcp:<server>/<tool> resources.",
    });

    const wildcardGitHubGrant = await app.request(
      `/api/access-bundles/${bundle.id}/grants`,
      {
        method: "POST",
        body: JSON.stringify({
          capability: "github.pr",
          resource: "github:redohq/*",
          decision: "ask",
          risk: "write_external",
          requiresApproval: true,
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(wildcardGitHubGrant.status).toBe(400);
    await expect(wildcardGitHubGrant.json()).resolves.toMatchObject({
      error: "GitHub grants must use github:owner/repo resources.",
    });

    const grantRes = await app.request(
      `/api/access-bundles/${bundle.id}/grants`,
      {
        method: "POST",
        body: JSON.stringify({
          capability: "github.read",
          resource: "github:redohq/checkout",
          decision: "allow",
          risk: "read_internal",
          requiresApproval: false,
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(grantRes.status).toBe(201);
    const grant = (await grantRes.json()) as { id: string };

    const patchToUnregisteredMcp = await app.request(
      `/api/access-bundles/${bundle.id}/grants/${grant.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          capability: "mcp.tool",
          resource: "mcp:missing/create_issue",
          decision: "ask",
          risk: "write_external",
          requiresApproval: true,
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(patchToUnregisteredMcp.status).toBe(400);

    const duplicateGrant = await app.request(
      `/api/access-bundles/${bundle.id}/grants`,
      {
        method: "POST",
        body: JSON.stringify({
          capability: "github.read",
          resource: " github:RedoHQ/checkout ",
          decision: "allow",
          risk: "read_internal",
          requiresApproval: false,
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(duplicateGrant.status).toBe(409);
    await expect(duplicateGrant.json()).resolves.toMatchObject({
      error: expect.stringContaining("Duplicate grant already exists"),
    });

    const emptyGrantPatch = await app.request(
      `/api/access-bundles/${bundle.id}/grants/${grant.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
      },
    );
    expect(emptyGrantPatch.status).toBe(400);

    const deletedGrant = await app.request(
      `/api/access-bundles/${bundle.id}/grants/${grant.id}`,
      { method: "DELETE" },
    );
    expect(deletedGrant.status).toBe(200);

    const deletedAgain = await app.request(
      `/api/access-bundles/${bundle.id}/grants/${grant.id}`,
      { method: "DELETE" },
    );
    expect(deletedAgain.status).toBe(404);
  });

  it("updates model and runtime policies through admin endpoints", async () => {
    const app = createApp();
    const model = await app.request("/api/model-policies/model_auto", {
      method: "PATCH",
      body: JSON.stringify({
        defaultModel: "openai/gpt-5.5",
        fallbackModels: ["openai-compatible/local"],
        perRunBudgetCents: 500,
      }),
      headers: { "content-type": "application/json" },
    });
    expect(model.status).toBe(200);
    await expect(model.json()).resolves.toMatchObject({
      defaultModel: "openai/gpt-5.5",
      fallbackModels: ["openai-compatible/local"],
      perRunBudgetCents: 500,
    });

    const runtime = await app.request("/api/runtime-profiles/runtime_answer", {
      method: "PATCH",
      body: JSON.stringify({
        runtimeKind: "external",
        adapter: "customer-runner",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(runtime.status).toBe(200);
    await expect(runtime.json()).resolves.toMatchObject({
      runtimeKind: "external",
      adapter: "customer-runner",
    });
  });

  it("rejects invalid model and runtime profile mutations", async () => {
    const app = createApp();

    const emptyModelPatch = await app.request(
      "/api/model-policies/model_auto",
      {
        method: "PATCH",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
      },
    );
    expect(emptyModelPatch.status).toBe(400);

    const invalidBudget = await app.request("/api/model-policies/model_auto", {
      method: "PATCH",
      body: JSON.stringify({ perRunBudgetCents: 0 }),
      headers: { "content-type": "application/json" },
    });
    expect(invalidBudget.status).toBe(400);

    const missingModel = await app.request(
      "/api/model-policies/model_missing",
      {
        method: "PATCH",
        body: JSON.stringify({ defaultModel: "openai/gpt-5.5" }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(missingModel.status).toBe(404);

    const emptyRuntimePatch = await app.request(
      "/api/runtime-profiles/runtime_answer",
      {
        method: "PATCH",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
      },
    );
    expect(emptyRuntimePatch.status).toBe(400);

    const invalidRuntimeKind = await app.request(
      "/api/runtime-profiles/runtime_answer",
      {
        method: "PATCH",
        body: JSON.stringify({ runtimeKind: "shell" }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(invalidRuntimeKind.status).toBe(400);

    const missingRuntime = await app.request(
      "/api/runtime-profiles/runtime_missing",
      {
        method: "PATCH",
        body: JSON.stringify({ adapter: "missing" }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(missingRuntime.status).toBe(404);
  });

  it("creates a run and approval for PR capability", async () => {
    const app = createApp();
    const res = await app.request("/api/runs", {
      method: "POST",
      body: JSON.stringify({
        prompt: "@bek open a PR",
        placeScopeId: "place_checkout",
        capability: "github.pr",
        resource: "github:redohq/checkout",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(201);
    const run = (await res.json()) as { id: string; status: string };
    expect(run.status).toBe("awaiting_approval");

    const detail = await app.request(`/api/runs/${run.id}`);
    const json = (await detail.json()) as {
      approvals: Array<{ status: string; id: string; payloadHash: string }>;
    };
    expect(json.approvals).toHaveLength(1);
    expect(json.approvals[0]!.status).toBe("pending");

    const approved = await app.request(
      `/api/approvals/${json.approvals[0]!.id}/approve`,
      {
        method: "POST",
        body: JSON.stringify({
          payloadHash: json.approvals[0]!.payloadHash,
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(approved.status).toBe(200);
    await expect(approved.json()).resolves.toMatchObject({
      status: "approved",
      decidedByPrincipalId: "principal_admin",
    });
  });

  it("derives admin approval actors from BEK_ADMIN_PRINCIPAL_ID", async () => {
    process.env.BEK_ADMIN_PRINCIPAL_ID = "principal_bryson";
    const app = createApp();
    const res = await app.request("/api/runs", {
      method: "POST",
      body: JSON.stringify({
        prompt: "@bek open a PR for admin-context validation",
        placeScopeId: "place_checkout",
        requesterPrincipalId: "principal_admin",
        capability: "github.pr",
        resource: "github:redohq/checkout",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(201);
    const run = (await res.json()) as { id: string };
    const detail = (await (
      await app.request(`/api/runs/${run.id}`)
    ).json()) as {
      approvals: Array<{ id: string; payloadHash: string }>;
    };
    const approval = detail.approvals[0]!;

    const approved = await app.request(
      `/api/approvals/${approval.id}/approve`,
      {
        method: "POST",
        body: JSON.stringify({ payloadHash: approval.payloadHash }),
        headers: { "content-type": "application/json" },
      },
    );

    expect(approved.status).toBe(200);
    await expect(approved.json()).resolves.toMatchObject({
      status: "approved",
      decidedByPrincipalId: "principal_bryson",
    });
  });

  it("dedupes API run creation when Idempotency-Key is reused with the same body", async () => {
    const store = new BekStore();
    const app = createApp(store);
    const beforeRunCount = store.read().runs.length;
    const body = JSON.stringify({
      prompt: "@bek open a PR idempotently",
      placeScopeId: "place_checkout",
      capability: "github.pr",
      resource: "github:redohq/checkout",
    });
    const request = {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "idempotency-key": "run-create-123",
      },
    };

    const first = await app.request("/api/runs", request);
    const firstJson = (await first.json()) as { id: string; status: string };
    const second = await app.request("/api/runs", request);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({
      id: firstJson.id,
      status: firstJson.status,
      deduped: true,
    });
    expect(store.read().runs).toHaveLength(beforeRunCount + 1);
    expect(store.read().ingressDeliveries[0]).toMatchObject({
      provider: "api",
      kind: "api.run",
      key: "api:runs:run-create-123",
      runId: firstJson.id,
      status: "processed",
    });
  });

  it("rejects reused API run idempotency keys with a different body", async () => {
    const store = new BekStore();
    const app = createApp(store);
    const firstBody = JSON.stringify({
      prompt: "@bek first request",
      placeScopeId: "place_checkout",
      capability: "slack.read",
      resource: "slack:C_CHECKOUT",
    });
    const secondBody = JSON.stringify({
      prompt: "@bek second request",
      placeScopeId: "place_checkout",
      capability: "slack.read",
      resource: "slack:C_CHECKOUT",
    });

    const first = await app.request("/api/runs", {
      method: "POST",
      body: firstBody,
      headers: {
        "content-type": "application/json",
        "idempotency-key": "same-key-different-body",
      },
    });
    const beforeConflictRunCount = store.read().runs.length;
    const conflict = await app.request("/api/runs", {
      method: "POST",
      body: secondBody,
      headers: {
        "content-type": "application/json",
        "idempotency-key": "same-key-different-body",
      },
    });

    expect(first.status).toBe(201);
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: "Idempotency-Key was already used with a different request body.",
    });
    expect(store.read().runs).toHaveLength(beforeConflictRunCount);
  });

  it("redacts secret-shaped prompt text from public run responses", async () => {
    const app = createApp();
    const secret = "xoxb-this-secret-token-should-redact";
    const res = await app.request("/api/runs", {
      method: "POST",
      body: JSON.stringify({
        prompt: `@bek investigate ${secret}`,
        placeScopeId: "place_checkout",
        capability: "slack.read",
        resource: "slack:C_CHECKOUT",
      }),
      headers: { "content-type": "application/json" },
    });
    const run = (await res.json()) as { id: string; prompt: string };

    expect(res.status).toBe(201);
    expect(run.prompt).not.toContain(secret);
    expect(run.prompt).toContain("[redacted:slack-token]");

    const listText = JSON.stringify(
      await (await app.request("/api/runs")).json(),
    );
    const detailText = JSON.stringify(
      await (await app.request(`/api/runs/${run.id}`)).json(),
    );
    const bootstrapText = JSON.stringify(
      await (await app.request("/api/bootstrap")).json(),
    );

    expect(listText).not.toContain(secret);
    expect(detailText).not.toContain(secret);
    expect(bootstrapText).not.toContain(secret);
  });

  it("defensively redacts contaminated snapshot metadata from bootstrap", async () => {
    const secret = "xoxb-contaminated-token-should-redact";
    const snapshot = createSeedSnapshot();
    snapshot.runs.unshift({
      ...snapshot.runs[0]!,
      id: "run_contaminated",
      prompt: `@bek leaked ${secret}`,
    });
    snapshot.places[0]!.metadata = {
      teamId: "T123",
      botToken: secret,
    };
    snapshot.connectorInstalls.push({
      id: "connector_contaminated",
      orgId: snapshot.org.id,
      kind: "slack",
      provider: "slack",
      externalId: "T123",
      displayName: "Redo",
      status: "active",
      metadata: {
        botToken: secret,
        vaultEnvelope: { ciphertext: secret },
      },
      createdAt: "2026-01-02T03:04:05.000Z",
      updatedAt: "2026-01-02T03:04:05.000Z",
    });
    snapshot.credentials.push({
      id: "credential_contaminated",
      orgId: snapshot.org.id,
      connectorInstallId: "connector_contaminated",
      name: "Slack bot token",
      provider: "slack",
      externalAccountId: "T123",
      secretRef: secret,
      status: "active",
      scopeSummary: "chat:write",
      metadata: {
        rawToken: secret,
        vaultEnvelope: { ciphertext: secret },
      },
      createdAt: "2026-01-02T03:04:05.000Z",
      updatedAt: "2026-01-02T03:04:05.000Z",
    });

    const bootstrapText = JSON.stringify(
      await (
        await createApp(new BekStore(snapshot)).request("/api/bootstrap")
      ).json(),
    );

    expect(bootstrapText).not.toContain(secret);
    expect(bootstrapText).not.toContain('"vaultEnvelope":');
    expect(bootstrapText).toContain("[redacted:slack-token]");
    expect(bootstrapText).toContain("[redacted:secret-ref]");
  });

  it("advances allowed API runs through the local worker when enabled", async () => {
    const app = createApp(new BekStore(), {
      runAdvancement: "worker_local",
    });
    const res = await app.request("/api/runs", {
      method: "POST",
      body: JSON.stringify({
        prompt: "@bek summarize checkout",
        placeScopeId: "place_checkout",
        capability: "slack.read",
        resource: "slack:C_CHECKOUT",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(201);
    const run = (await res.json()) as {
      id: string;
      status: string;
      actualCostCents: number;
    };
    expect(run.status).toBe("completed");
    expect(run.actualCostCents).toBeGreaterThan(0);

    const detail = (await (
      await app.request(`/api/runs/${run.id}`)
    ).json()) as {
      events: Array<{
        type: string;
        data?: { workerEventType?: string };
      }>;
    };
    expect(
      detail.events.some(
        (event) => event.data?.workerEventType === "worker.completed",
      ),
    ).toBe(true);

    const queue = (await (await app.request("/api/worker/queue")).json()) as {
      enabled: boolean;
      queue: {
        records: Array<{ status: string; result?: { status: string } }>;
      };
    };
    expect(queue.enabled).toBe(true);
    expect(queue.queue.records[0]).toMatchObject({
      status: "completed",
      result: { status: "completed" },
    });
  });

  it("hydrates persisted local worker queue state after app restart", async () => {
    let persistedWorkerQueue: WorkerSnapshot = {
      records: [],
      deadLetters: [],
      events: [],
    };
    const store = new BekStore();
    const app = createApp(store, {
      runAdvancement: "worker_local",
      workerQueuePersistence: {
        initialSnapshot: persistedWorkerQueue,
        onSnapshotChanged: (snapshot) => {
          persistedWorkerQueue = snapshot;
        },
      },
    });

    const created = await app.request("/api/runs", {
      method: "POST",
      body: JSON.stringify({
        prompt: "@bek summarize checkout after restart",
        placeScopeId: "place_checkout",
        capability: "slack.read",
        resource: "slack:C_CHECKOUT",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(created.status).toBe(201);
    const run = (await created.json()) as { id: string; status: string };
    expect(run.status).toBe("completed");
    expect(persistedWorkerQueue.records[0]).toMatchObject({
      item: { runId: run.id },
      status: "completed",
    });

    const restarted = createApp(new BekStore(store.read()), {
      runAdvancement: "worker_local",
      workerQueuePersistence: {
        initialSnapshot: persistedWorkerQueue,
        onSnapshotChanged: (snapshot) => {
          persistedWorkerQueue = snapshot;
        },
      },
    });
    const queue = (await (
      await restarted.request("/api/worker/queue")
    ).json()) as {
      enabled: boolean;
      queue: WorkerSnapshot;
    };

    expect(queue.enabled).toBe(true);
    expect(queue.queue.records).toEqual(persistedWorkerQueue.records);
    expect(queue.queue.events.length).toBeGreaterThan(0);
  });

  it("cancels non-terminal worker runs through the admin API", async () => {
    const app = createApp(new BekStore(), {
      runAdvancement: "worker_local",
    });
    const { run } = await createPrApproval(app, "@bek pause then cancel");
    expect(run.status).toBe("awaiting_approval");

    const cancelled = await app.request(`/api/runs/${run.id}/cancel`, {
      method: "POST",
      body: JSON.stringify({ reason: "No longer needed." }),
      headers: { "content-type": "application/json" },
    });

    expect(cancelled.status).toBe(200);
    await expect(cancelled.json()).resolves.toMatchObject({
      decision: { decision: "not_found" },
      run: { status: "cancelled" },
    });
    await expect(expectJson(app, `/api/runs/${run.id}`)).resolves.toMatchObject(
      {
        run: { status: "cancelled" },
        events: expect.arrayContaining([
          expect.objectContaining({
            type: "run.status_changed",
            message: "No longer needed.",
          }),
        ]),
      },
    );
  });

  it("does not cancel worker runs when local worker mode is disabled", async () => {
    const app = createApp(new BekStore(), {
      runAdvancement: "inline_stub",
    });
    const created = await app.request("/api/runs", {
      method: "POST",
      body: JSON.stringify({
        prompt: "@bek open a PR",
        placeScopeId: "place_checkout",
        capability: "github.pr",
        resource: "github:redohq/checkout",
      }),
      headers: { "content-type": "application/json" },
    });
    const run = (await created.json()) as { id: string };

    const cancelled = await app.request(`/api/runs/${run.id}/cancel`, {
      method: "POST",
      body: JSON.stringify({ reason: "No longer needed." }),
      headers: { "content-type": "application/json" },
    });

    expect(cancelled.status).toBe(409);
  });

  it("reports already-terminal worker run cancellation as a no-op", async () => {
    const app = createApp(new BekStore(), {
      runAdvancement: "worker_local",
    });
    const created = await app.request("/api/runs", {
      method: "POST",
      body: JSON.stringify({
        prompt: "@bek summarize checkout",
        placeScopeId: "place_checkout",
        capability: "slack.read",
        resource: "slack:C_CHECKOUT",
      }),
      headers: { "content-type": "application/json" },
    });
    const run = (await created.json()) as { id: string; status: string };
    expect(run.status).toBe("completed");

    const cancelled = await app.request(`/api/runs/${run.id}/cancel`, {
      method: "POST",
      body: JSON.stringify({ reason: "No longer needed." }),
      headers: { "content-type": "application/json" },
    });

    expect(cancelled.status).toBe(200);
    await expect(cancelled.json()).resolves.toMatchObject({
      decision: { decision: "already_terminal" },
      run: { status: "completed" },
    });
  });

  it("redrives dead-lettered worker runs through the admin API", async () => {
    const now = "2026-06-24T18:00:00.000Z";
    const snapshot = createSeedSnapshot(now);
    const templateRun = snapshot.runs[0]!;
    const failedRun = {
      ...templateRun,
      id: "run_dead",
      prompt: "@bek retry this failed run",
      status: "failed" as const,
      actualCostCents: 3,
      createdAt: now,
      updatedAt: now,
    };
    snapshot.runs.unshift(failedRun);
    const failedItem: WorkerSnapshot["records"][number]["item"] = {
      orgId: snapshot.org.id,
      runId: failedRun.id,
      attempt: 3,
      reason: "retry",
      traceId: "trace_dead",
      enqueuedAt: now,
    };
    const failedResult: WorkerSnapshot["records"][number]["result"] = {
      status: "failed",
      artifactRefs: [],
      actualCostCents: 3,
      error: "still broken",
    };
    let persistedWorkerQueue: WorkerSnapshot = {
      records: [
        {
          id: "work_dead",
          sequence: 1,
          idempotencyKey: "run_attempt:org_demo:run_dead:3",
          item: failedItem,
          status: "dead",
          attemptState: "dead_lettered",
          availableAt: now,
          createdAt: now,
          updatedAt: now,
          terminalReason: "still broken",
          result: failedResult,
        },
      ],
      deadLetters: [
        {
          id: "dead_1",
          sequence: 2,
          workId: "work_dead",
          idempotencyKey: "run_attempt:org_demo:run_dead:3",
          item: failedItem,
          reason: "still broken",
          failedAt: now,
          result: failedResult!,
          retryPolicy: {
            maxAttempts: 3,
            baseDelayMs: 1_000,
            maxDelayMs: 30_000,
          },
        },
      ],
      events: [],
    };
    const app = createApp(new BekStore(snapshot), {
      runAdvancement: "worker_local",
      workerQueuePersistence: {
        initialSnapshot: persistedWorkerQueue,
        onSnapshotChanged: (queue) => {
          persistedWorkerQueue = queue;
        },
      },
    });

    const redrive = await app.request(
      "/api/worker/dead-letters/dead_1/redrive",
      {
        method: "POST",
        body: JSON.stringify({ reason: "Retry after dependency fix." }),
        headers: { "content-type": "application/json" },
      },
    );

    expect(redrive.status).toBe(200);
    await expect(redrive.json()).resolves.toMatchObject({
      decision: {
        decision: "redrive_enqueued",
        record: {
          retryOf: "work_dead",
          status: "queued",
          item: { attempt: 1, reason: "resume", runId: "run_dead" },
        },
      },
      run: { status: "queued" },
      queue: {
        deadLetters: [{ id: "dead_1" }],
      },
    });
    expect(persistedWorkerQueue.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          retryOf: "work_dead",
          status: "queued",
          item: expect.objectContaining({ runId: "run_dead" }),
        }),
      ]),
    );
    await expect(expectJson(app, "/api/runs/run_dead")).resolves.toMatchObject({
      run: { status: "queued" },
      events: expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            workerEventType: "worker.redrive_enqueued",
          }),
        }),
        expect.objectContaining({
          message: "Retry after dependency fix.",
        }),
      ]),
    });

    const duplicate = await app.request(
      "/api/worker/dead-letters/dead_1/redrive",
      {
        method: "POST",
        body: JSON.stringify({ reason: "Try again." }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(duplicate.status).toBe(409);
  });

  it("resumes policy approvals through the local worker", async () => {
    const app = createApp(new BekStore(), {
      runAdvancement: "worker_local",
    });
    const { run, approval } = await createPrApproval(
      app,
      "@bek open a worker PR",
    );
    expect(run.status).toBe("awaiting_approval");

    const approved = await app.request(
      `/api/approvals/${approval.id}/approve`,
      {
        method: "POST",
        body: JSON.stringify({
          principalId: "principal_admin",
          payloadHash: approval.payloadHash,
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(approved.status).toBe(200);
    await expect(approved.json()).resolves.toMatchObject({
      status: "approved",
    });

    await expect(expectJson(app, `/api/runs/${run.id}`)).resolves.toMatchObject(
      {
        run: {
          status: "completed",
        },
      },
    );
  });

  it("executes hash-bound GitHub PR approvals through fake worker execution", async () => {
    clearGitHubEnv();
    process.env.BEK_GITHUB_EXECUTION = "fake";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const app = createApp(new BekStore(), {
      runAdvancement: "worker_local",
    });
    const { run, approval } = await createPrApproval(
      app,
      "@bek open a fake GitHub PR",
    );
    expect(run.status).toBe("awaiting_approval");

    const approved = await app.request(
      `/api/approvals/${approval.id}/approve`,
      {
        method: "POST",
        body: JSON.stringify({
          principalId: "principal_admin",
          payloadHash: approval.payloadHash,
        }),
        headers: { "content-type": "application/json" },
      },
    );

    expect(approved.status).toBe(200);
    await expect(expectJson(app, `/api/runs/${run.id}`)).resolves.toMatchObject(
      {
        run: {
          status: "completed",
        },
        approvals: [
          expect.objectContaining({
            payloadMetadata: expect.objectContaining({
              type: "github.draft_pull_request_workflow_approval_payload",
              resource: "github:redohq/checkout",
            }),
          }),
        ],
        events: expect.arrayContaining([
          expect.objectContaining({
            data: expect.objectContaining({
              workerEventType: "tool.completed",
              pullRequestUrl: "https://github.com/redohq/checkout/pull/1",
            }),
          }),
        ]),
      },
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("plans real GitHub PR approvals from persisted repo installation bindings", async () => {
    clearGitHubEnv();
    process.env.BEK_GITHUB_EXECUTION = "real";
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY = testGitHubPrivateKey;
    process.env.GITHUB_APP_WEBHOOK_SECRET = "a-webhook-secret-with-length";
    process.env.GITHUB_API_BASE_URL = "https://api.github.test";
    const store = new BekStore();
    const app = createApp(store, {
      runAdvancement: "worker_local",
    });
    const webhookBody = JSON.stringify({
      action: "created",
      installation: {
        id: 12345,
        account: { login: "RedoHQ" },
        repository_selection: "selected",
      },
      repositories: [{ id: 112233, full_name: "RedoHQ/Checkout" }],
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const webhook = await app.request("/api/github/webhooks", {
      method: "POST",
      body: webhookBody,
      headers: signedGitHubHeaders(webhookBody, {
        eventName: "installation",
        deliveryId: "delivery-real-plan-install",
      }),
    });
    expect(webhook.status).toBe(200);

    const { run, approval } = await createPrApproval(
      app,
      "@bek open a real bound GitHub PR",
    );

    expect(run.status).toBe("awaiting_approval");
    expect(fetchSpy).not.toHaveBeenCalled();
    const detail = (await (
      await app.request(`/api/runs/${run.id}`)
    ).json()) as {
      approvals: Array<{
        id: string;
        payloadMetadata?: {
          installationId?: string;
          repositoryId?: number;
          approvalHashInput?: { repositoryId?: number };
        };
      }>;
    };
    expect(detail.approvals.find((item) => item.id === approval.id)).toEqual(
      expect.objectContaining({
        payloadMetadata: expect.objectContaining({
          installationId: "12345",
          repositoryId: 112233,
          approvalHashInput: expect.objectContaining({
            repositoryId: 112233,
          }),
        }),
      }),
    );
  });

  it("fails real GitHub PR planning without an active persisted repo binding", async () => {
    clearGitHubEnv();
    process.env.BEK_GITHUB_EXECUTION = "real";
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY = testGitHubPrivateKey;
    process.env.GITHUB_APP_WEBHOOK_SECRET = "a-webhook-secret-with-length";
    const app = createApp(new BekStore(), {
      runAdvancement: "worker_local",
    });

    const created = await app.request("/api/runs", {
      method: "POST",
      body: JSON.stringify({
        prompt: "@bek open a real PR without install binding",
        placeScopeId: "place_checkout",
        capability: "github.pr",
        resource: "github:redohq/checkout",
      }),
      headers: { "content-type": "application/json" },
    });

    expect(created.status).toBe(201);
    const run = (await created.json()) as { id: string; status: string };
    expect(run.status).toBe("queued");
    await expect(expectJson(app, `/api/runs/${run.id}`)).resolves.toMatchObject(
      {
        approvals: [],
      },
    );
    await expect(expectJson(app, "/api/worker/queue")).resolves.toMatchObject({
      queue: {
        records: expect.arrayContaining([
          expect.objectContaining({
            item: expect.objectContaining({
              runId: run.id,
            }),
            result: expect.objectContaining({
              status: "failed",
              error: expect.stringContaining(
                "not bound to an active GitHub App installation",
              ),
            }),
          }),
        ]),
      },
    });
  });

  it("persists and resumes runtime-requested local worker approvals", async () => {
    const app = createApp(new BekStore(), {
      runAdvancement: "worker_local",
    });
    const res = await app.request("/api/runs", {
      method: "POST",
      body: JSON.stringify({
        prompt: "@bek ask for approval before touching anything",
        placeScopeId: "place_checkout",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(201);
    const run = (await res.json()) as { id: string; status: string };
    expect(run.status).toBe("awaiting_approval");

    const detail = (await (
      await app.request(`/api/runs/${run.id}`)
    ).json()) as {
      approvals: Array<{ id: string; payloadHash: string; status: string }>;
    };
    expect(detail.approvals).toHaveLength(1);
    expect(detail.approvals[0]).toMatchObject({ status: "pending" });

    const approved = await app.request(
      `/api/approvals/${detail.approvals[0]!.id}/approve`,
      {
        method: "POST",
        body: JSON.stringify({
          principalId: "principal_admin",
          payloadHash: detail.approvals[0]!.payloadHash,
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(approved.status).toBe(200);

    await expect(expectJson(app, `/api/runs/${run.id}`)).resolves.toMatchObject(
      {
        run: {
          status: "completed",
        },
      },
    );
  });

  it("cancels paused local worker work when approval is denied", async () => {
    const app = createApp(new BekStore(), {
      runAdvancement: "worker_local",
    });
    const res = await app.request("/api/runs", {
      method: "POST",
      body: JSON.stringify({
        prompt: "@bek ask for approval and then stop",
        placeScopeId: "place_checkout",
      }),
      headers: { "content-type": "application/json" },
    });
    const run = (await res.json()) as { id: string; status: string };
    expect(run.status).toBe("awaiting_approval");

    const detail = (await (
      await app.request(`/api/runs/${run.id}`)
    ).json()) as {
      approvals: Array<{ id: string; payloadHash: string }>;
    };

    const denied = await app.request(
      `/api/approvals/${detail.approvals[0]!.id}/deny`,
      {
        method: "POST",
        body: JSON.stringify({
          principalId: "principal_admin",
          payloadHash: detail.approvals[0]!.payloadHash,
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(denied.status).toBe(200);

    await expect(expectJson(app, `/api/runs/${run.id}`)).resolves.toMatchObject(
      {
        run: {
          status: "cancelled",
        },
      },
    );
    const queue = (await (await app.request("/api/worker/queue")).json()) as {
      queue: { records: Array<{ status: string }> };
    };
    expect(queue.queue.records[0]).toMatchObject({ status: "cancelled" });
  });

  it("rejects approval tampering and risky self-approval", async () => {
    const app = createApp();
    const res = await app.request("/api/runs", {
      method: "POST",
      body: JSON.stringify({
        prompt: "@bek open a PR",
        placeScopeId: "place_checkout",
        capability: "github.pr",
        resource: "github:redohq/checkout",
      }),
      headers: { "content-type": "application/json" },
    });
    const run = (await res.json()) as { id: string };
    const detail = await app.request(`/api/runs/${run.id}`);
    const json = (await detail.json()) as {
      approvals: Array<{ id: string; payloadHash: string }>;
    };
    const approval = json.approvals[0]!;

    const tampered = await app.request(
      `/api/approvals/${approval.id}/approve`,
      {
        method: "POST",
        body: JSON.stringify({
          principalId: "principal_admin",
          payloadHash: "bad-hash-bad-hash",
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(tampered.status).toBe(400);

    const selfApproved = await app.request(
      `/api/approvals/${approval.id}/approve`,
      {
        method: "POST",
        body: JSON.stringify({
          principalId: "principal_bryson",
          payloadHash: approval.payloadHash,
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(selfApproved.status).toBe(400);
    await expect(selfApproved.json()).resolves.toMatchObject({
      error: expect.stringContaining("authenticated admin"),
    });
  });

  it("rejects stale approval hashes, agent approvals, and double approval over HTTP", async () => {
    const app = createApp();
    const stale = await createPrApproval(app, "@bek open stale PR");
    const current = await createPrApproval(app, "@bek open current PR");

    expect(stale.approval.payloadHash).not.toBe(current.approval.payloadHash);
    const staleHash = await app.request(
      `/api/approvals/${current.approval.id}/approve`,
      {
        method: "POST",
        body: JSON.stringify({
          principalId: "principal_admin",
          payloadHash: stale.approval.payloadHash,
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(staleHash.status).toBe(400);

    const agent = await createPrApproval(app, "@bek open agent-approved PR");
    const agentApproved = await app.request(
      `/api/approvals/${agent.approval.id}/approve`,
      {
        method: "POST",
        body: JSON.stringify({
          principalId: "principal_bek",
          payloadHash: agent.approval.payloadHash,
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(agentApproved.status).toBe(400);

    const double = await createPrApproval(app, "@bek open double-approved PR");
    const approved = await app.request(
      `/api/approvals/${double.approval.id}/approve`,
      {
        method: "POST",
        body: JSON.stringify({
          principalId: "principal_admin",
          payloadHash: double.approval.payloadHash,
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(approved.status).toBe(200);

    const approvedAgain = await app.request(
      `/api/approvals/${double.approval.id}/approve`,
      {
        method: "POST",
        body: JSON.stringify({
          principalId: "principal_admin",
          payloadHash: double.approval.payloadHash,
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(approvedAgain.status).toBe(400);
  });

  it("denies approvals and validates approval decision payloads", async () => {
    const app = createApp();
    const { run, approval } = await createPrApproval(
      app,
      "@bek open a denied PR",
    );

    const invalidBody = await app.request(
      `/api/approvals/${approval.id}/deny`,
      {
        method: "POST",
        body: JSON.stringify({ principalId: "principal_admin" }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(invalidBody.status).toBe(400);

    const missingApproval = await app.request(
      "/api/approvals/approval_missing/deny",
      {
        method: "POST",
        body: JSON.stringify({
          principalId: "principal_admin",
          payloadHash: approval.payloadHash,
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(missingApproval.status).toBe(404);

    const denied = await app.request(`/api/approvals/${approval.id}/deny`, {
      method: "POST",
      body: JSON.stringify({
        principalId: "principal_admin",
        payloadHash: approval.payloadHash,
      }),
      headers: { "content-type": "application/json" },
    });
    expect(denied.status).toBe(200);
    await expect(denied.json()).resolves.toMatchObject({
      status: "denied",
      decidedByPrincipalId: "principal_admin",
    });

    await expect(expectJson(app, `/api/runs/${run.id}`)).resolves.toMatchObject(
      {
        run: { status: "cancelled" },
      },
    );
  });

  it("validates run creation and run detail lookups", async () => {
    const app = createApp();

    const invalidRun = await app.request("/api/runs", {
      method: "POST",
      body: JSON.stringify({
        prompt: "",
        placeScopeId: "place_checkout",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(invalidRun.status).toBe(400);

    const unknownPlace = await app.request("/api/runs", {
      method: "POST",
      body: JSON.stringify({
        prompt: "@bek hello",
        placeScopeId: "place_missing",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(unknownPlace.status).toBe(400);

    const missingRun = await app.request("/api/runs/run_missing");
    expect(missingRun.status).toBe(404);

    const missingRunEvents = await app.request("/api/runs/run_missing/events");
    expect(missingRunEvents.status).toBe(200);
    await expect(missingRunEvents.json()).resolves.toEqual([]);
  });

  it("evaluates policy decisions and rejects malformed policy requests", async () => {
    const app = createApp();

    const allowed = await app.request("/api/policy/evaluate", {
      method: "POST",
      body: JSON.stringify({
        placeScopeId: "place_checkout",
        capability: "github.read",
        resource: "github:redohq/checkout",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(allowed.status).toBe(200);
    await expect(allowed.json()).resolves.toMatchObject({
      decision: "allow",
      requiresApproval: false,
    });

    const denied = await app.request("/api/policy/evaluate", {
      method: "POST",
      body: JSON.stringify({
        placeScopeId: "place_general",
        capability: "github.read",
        resource: "github:redohq/checkout",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(denied.status).toBe(200);
    await expect(denied.json()).resolves.toMatchObject({
      decision: "deny",
    });

    const unknownPlace = await app.request("/api/policy/evaluate", {
      method: "POST",
      body: JSON.stringify({
        placeScopeId: "place_missing",
        capability: "github.read",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(unknownPlace.status).toBe(404);

    const malformed = await app.request("/api/policy/evaluate", {
      method: "POST",
      body: JSON.stringify({
        placeScopeId: "place_checkout",
        capability: "github.admin",
      }),
      headers: { "content-type": "application/json" },
    });
    expect(malformed.status).toBe(400);
  });

  it("fails Slack event requests closed when a signing secret is configured", async () => {
    process.env.SLACK_SIGNING_SECRET = "test-slack-secret";
    const res = await createApp().request("/api/slack/events", {
      method: "POST",
      body: JSON.stringify({
        event_id: "EvUnsigned",
        event: {
          type: "app_mention",
          channel: "C_CHECKOUT",
          user: "U123",
          text: "@bek hello",
        },
      }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(401);
  });

  it("fails Slack interactivity and command requests closed when a signing secret is configured", async () => {
    process.env.SLACK_SIGNING_SECRET = "test-slack-secret";
    const app = createApp();

    const interaction = await app.request("/api/slack/interactivity", {
      method: "POST",
      body: slackForm({ payload: JSON.stringify({ type: "block_actions" }) }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(interaction.status).toBe(401);

    const command = await app.request("/api/slack/commands", {
      method: "POST",
      body: slackForm({
        command: "/bek",
        channel_id: "C_CHECKOUT",
        text: "hello",
      }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(command.status).toBe(401);
  });

  it("rejects replayed Slack event signatures", async () => {
    const rawBody = JSON.stringify({
      event_id: "EvReplay",
      event: {
        type: "app_mention",
        channel: "C_CHECKOUT",
        user: "U123",
        text: "@bek hello",
      },
    });
    const res = await createApp().request("/api/slack/events", {
      method: "POST",
      body: rawBody,
      headers: signedSlackHeaders(rawBody, "100"),
    });

    expect(res.status).toBe(401);
  });

  it("rejects Slack event body tampering after signing", async () => {
    const signedBody = JSON.stringify({
      event_id: "EvSigned",
      event: {
        type: "app_mention",
        channel: "C_CHECKOUT",
        user: "U123",
        text: "@bek hello",
      },
    });
    const tamperedBody = JSON.stringify({
      event_id: "EvSigned",
      event: {
        type: "app_mention",
        channel: "C_CHECKOUT",
        user: "U123",
        text: "@bek run a different command",
      },
    });
    const res = await createApp().request("/api/slack/events", {
      method: "POST",
      body: tamperedBody,
      headers: signedSlackHeaders(signedBody),
    });

    expect(res.status).toBe(401);
  });

  it("handles Slack URL verification and malformed event payloads", async () => {
    const app = createApp();
    const challenge = await app.request("/api/slack/events", {
      method: "POST",
      body: JSON.stringify({
        type: "url_verification",
        challenge: "challenge-token",
      }),
    });
    expect(challenge.status).toBe(200);
    await expect(challenge.json()).resolves.toEqual({
      challenge: "challenge-token",
    });

    const rawBody = "{not-json";
    const malformed = await app.request("/api/slack/events", {
      method: "POST",
      body: rawBody,
      headers: {
        ...signedSlackHeaders(rawBody),
        ...slackRetryHeaders("2", "http_error"),
      },
    });
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get("x-slack-no-retry")).toBe("1");
    await expect(malformed.json()).resolves.toMatchObject({
      ok: false,
      error: "Slack event payload must be valid JSON.",
      slackRetry: {
        retryNum: 2,
        reason: "http_error",
      },
    });
  });

  it("does not silently admit unknown Slack channels", async () => {
    const app = createApp();
    const res = await app.request("/api/slack/events", {
      method: "POST",
      body: JSON.stringify({
        event_id: "EvUnknown",
        event: {
          type: "app_mention",
          channel: "C_UNKNOWN",
          user: "U123",
          text: "@bek hello",
        },
      }),
    });

    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      ignored: true,
    });
  });

  it("ignores configured Slack events from unmapped users without creating runs", async () => {
    const store = new BekStore();
    const app = createApp(store);
    const initialRunCount = store.read().runs.length;
    const rawBody = JSON.stringify({
      event_id: "EvUnmappedUser",
      event: {
        type: "app_mention",
        channel: "C_CHECKOUT",
        user: "U_UNMAPPED",
        text: "@bek hello",
      },
    });

    const res = await app.request("/api/slack/events", {
      method: "POST",
      body: rawBody,
      headers: signedSlackHeaders(rawBody),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-slack-no-retry")).toBe("1");
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      ignored: true,
      reason: "Slack user U_UNMAPPED is not mapped to a Bek principal.",
    });
    expect(store.read().runs).toHaveLength(initialRunCount);
  });

  it("maps Slack event users with team-scoped principal keys", async () => {
    mapSlackTestUsers({ "T123:U123": "principal_bryson" });
    const store = new BekStore();
    const app = createApp(store);
    const rawBody = JSON.stringify({
      team_id: "T123",
      event_id: "EvScopedUserMap",
      event: {
        type: "app_mention",
        channel: "C_CHECKOUT",
        user: "U123",
        text: "@bek hello from a scoped workspace",
      },
    });

    const res = await app.request("/api/slack/events", {
      method: "POST",
      body: rawBody,
      headers: signedSlackHeaders(rawBody),
    });
    const json = (await res.json()) as { runId: string };

    expect(res.status).toBe(200);
    expect(json.runId).toBeTruthy();
    expect(
      store.read().runs.find((candidate) => candidate.id === json.runId),
    ).toMatchObject({
      requesterPrincipalId: "principal_bryson",
    });
  });

  it("maps Slack event users through persisted principal external identities", async () => {
    delete process.env.BEK_SLACK_USER_PRINCIPAL_MAP;
    const store = new BekStore();
    store.linkPrincipalExternalIdentity("principal_bryson", {
      externalProvider: "slack",
      externalId: "T123:U123",
    });
    const app = createApp(store);
    const rawBody = JSON.stringify({
      team_id: "T123",
      event_id: "EvPersistedPrincipalMap",
      event: {
        type: "app_mention",
        channel: "C_CHECKOUT",
        user: "U123",
        text: "@bek use the persisted Slack identity",
      },
    });

    const res = await app.request("/api/slack/events", {
      method: "POST",
      body: rawBody,
      headers: signedSlackHeaders(rawBody),
    });
    const json = (await res.json()) as { runId: string };

    expect(res.status).toBe(200);
    expect(
      store.read().runs.find((candidate) => candidate.id === json.runId),
    ).toMatchObject({
      requesterPrincipalId: "principal_bryson",
    });
  });

  it("prefers team-scoped Slack user mappings over legacy global keys", async () => {
    mapSlackTestUsers({
      U123: "principal_admin",
      "T123:U123": "principal_bryson",
    });
    const store = new BekStore();
    const app = createApp(store);
    const rawBody = JSON.stringify({
      team_id: "T123",
      event_id: "EvScopedUserMapPrecedence",
      event: {
        type: "app_mention",
        channel: "C_CHECKOUT",
        user: "U123",
        text: "@bek use the workspace-specific actor",
      },
    });

    const res = await app.request("/api/slack/events", {
      method: "POST",
      body: rawBody,
      headers: signedSlackHeaders(rawBody),
    });
    const json = (await res.json()) as { runId: string };

    expect(res.status).toBe(200);
    expect(
      store.read().runs.find((candidate) => candidate.id === json.runId),
    ).toMatchObject({
      requesterPrincipalId: "principal_bryson",
    });
  });

  it("does not use legacy Slack user mappings for team callbacks unless explicitly allowed", async () => {
    process.env.BEK_ALLOW_LEGACY_SLACK_USER_MAP = "false";
    mapSlackTestUsers({ U123: "principal_bryson" });
    const store = new BekStore();
    const app = createApp(store);
    const initialRunCount = store.read().runs.length;
    const rawBody = JSON.stringify({
      team_id: "T123",
      event_id: "EvLegacyUserMapDisabled",
      event: {
        type: "app_mention",
        channel: "C_CHECKOUT",
        user: "U123",
        text: "@bek do not use the legacy unscoped identity",
      },
    });

    const res = await app.request("/api/slack/events", {
      method: "POST",
      body: rawBody,
      headers: signedSlackHeaders(rawBody),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      ignored: true,
      reason: "Slack user U123 is not mapped to a Bek principal.",
    });
    expect(store.read().runs).toHaveLength(initialRunCount);

    process.env.BEK_ALLOW_LEGACY_SLACK_USER_MAP = "true";
    const allowedBody = JSON.stringify({
      team_id: "T123",
      event_id: "EvLegacyUserMapEnabled",
      event: {
        type: "app_mention",
        channel: "C_CHECKOUT",
        user: "U123",
        text: "@bek allow the explicit legacy local mapping",
      },
    });

    const allowed = await app.request("/api/slack/events", {
      method: "POST",
      body: allowedBody,
      headers: signedSlackHeaders(allowedBody),
    });
    const json = (await allowed.json()) as { runId: string };

    expect(allowed.status).toBe(200);
    expect(
      store.read().runs.find((candidate) => candidate.id === json.runId),
    ).toMatchObject({
      requesterPrincipalId: "principal_bryson",
    });
  });

  it("fails closed when a team-scoped Slack mapping is present but blank", async () => {
    mapSlackTestUsers({
      U123: "principal_admin",
      "T123:U123": "",
    });
    const store = new BekStore();
    const app = createApp(store);
    const initialRunCount = store.read().runs.length;
    const rawBody = JSON.stringify({
      team_id: "T123",
      event_id: "EvBlankScopedUserMap",
      event: {
        type: "app_mention",
        channel: "C_CHECKOUT",
        user: "U123",
        text: "@bek do not fall back from a blank scoped identity",
      },
    });

    const res = await app.request("/api/slack/events", {
      method: "POST",
      body: rawBody,
      headers: signedSlackHeaders(rawBody),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      ignored: true,
      reason: "Slack user U123 is not mapped to a Bek principal.",
    });
    expect(store.read().runs).toHaveLength(initialRunCount);
  });

  it("does not use another team's scoped Slack user mapping", async () => {
    mapSlackTestUsers({ "T_OTHER:U123": "principal_bryson" });
    const store = new BekStore();
    const app = createApp(store);
    const initialRunCount = store.read().runs.length;
    const rawBody = JSON.stringify({
      team_id: "T123",
      event_id: "EvWrongScopedUserMap",
      event: {
        type: "app_mention",
        channel: "C_CHECKOUT",
        user: "U123",
        text: "@bek do not borrow identity from another workspace",
      },
    });

    const res = await app.request("/api/slack/events", {
      method: "POST",
      body: rawBody,
      headers: signedSlackHeaders(rawBody),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      ignored: true,
      reason: "Slack user U123 is not mapped to a Bek principal.",
    });
    expect(store.read().runs).toHaveLength(initialRunCount);
  });

  it("rejects Slack callbacks whose team does not match the channel scope", async () => {
    const store = new BekStore();
    const app = createApp(store);
    const initialRunCount = store.read().runs.length;
    const eventBody = JSON.stringify({
      team_id: "T_OTHER",
      event_id: "EvWrongTeam",
      event: {
        type: "app_mention",
        channel: "C_CHECKOUT",
        user: "U123",
        text: "@bek hello from another workspace",
      },
    });

    const eventRes = await app.request("/api/slack/events", {
      method: "POST",
      body: eventBody,
      headers: signedSlackHeaders(eventBody),
    });

    expect(eventRes.status).toBe(200);
    await expect(eventRes.json()).resolves.toMatchObject({
      ok: false,
      ignored: true,
    });

    const commandBody = slackForm({
      command: "/bek",
      channel_id: "C_CHECKOUT",
      user_id: "U123",
      text: "hello from another workspace",
      team_id: "T_OTHER",
    });
    const commandRes = await app.request("/api/slack/commands", {
      method: "POST",
      body: commandBody,
      headers: signedSlackHeaders(
        commandBody,
        Math.floor(Date.now() / 1000).toString(),
        "application/x-www-form-urlencoded",
      ),
    });

    expect(commandRes.status).toBe(200);
    await expect(commandRes.json()).resolves.toMatchObject({
      ok: false,
      ignored: true,
    });
    expect(store.read().runs).toHaveLength(initialRunCount);
  });

  it("fails Slack install clearly when OAuth env is missing", async () => {
    delete process.env.BEK_ADMIN_API_TOKEN;
    delete process.env.SLACK_CLIENT_ID;
    delete process.env.SLACK_REDIRECT_URI;
    delete process.env.SLACK_STATE_SECRET;

    const res = await createApp().request("/api/slack/install");
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("SLACK_CLIENT_ID"),
    });
  });

  it("protects Slack install behind admin auth when configured", async () => {
    process.env.BEK_ADMIN_API_TOKEN = "test-admin-token";
    configureFakeSlackOAuth();

    const denied = await createApp().request("/api/slack/install");
    expect(denied.status).toBe(401);

    const deniedInstallUrl = await createApp().request(
      "/api/slack/install-url?return_to=/connectors",
    );
    expect(deniedInstallUrl.status).toBe(401);

    const allowed = await createApp().request("/api/slack/install", {
      headers: { authorization: "Bearer test-admin-token" },
    });
    expect(allowed.status).toBe(302);
  });

  it("discovers Slack channels through a protected admin endpoint", async () => {
    process.env.BEK_ADMIN_API_TOKEN = "test-admin-token";
    process.env.SLACK_BOT_TOKEN = "xoxb-raw-env-token-should-not-leak";
    const slackClient = new FakeSlackWebApiClient({
      channels: [
        {
          id: "C_CHECKOUT",
          name: "checkout-eng",
          isPrivate: false,
          isArchived: false,
          isMember: true,
          numMembers: 12,
        },
        {
          id: "G_PRIVATE",
          name: "leadership",
          isPrivate: true,
          isArchived: false,
          isMember: false,
        },
      ],
      nextCursor: "next-page",
    });
    const app = createApp(new BekStore(), { slackClient });

    const denied = await app.request("/api/slack/channels/discover");
    expect(denied.status).toBe(401);

    const allowed = await app.request("/api/slack/channels/discover?limit=25", {
      headers: { authorization: "Bearer test-admin-token" },
    });
    const text = await allowed.text();
    const json = JSON.parse(text) as {
      ok: boolean;
      source: string;
      channels: Array<{
        id: string;
        name: string;
        botIsMember: boolean;
        configured: boolean;
        configuredPlaceId: string | null;
      }>;
      nextCursor: string | null;
    };

    expect(allowed.status).toBe(200);
    expect(text).not.toContain("xoxb-raw-env-token-should-not-leak");
    expect(slackClient.listChannelsCalls).toEqual([
      {
        limit: 25,
        types: "public_channel,private_channel",
        excludeArchived: true,
      },
    ]);
    expect(json).toMatchObject({
      ok: true,
      source: "injected",
      nextCursor: "next-page",
      channels: [
        {
          id: "C_CHECKOUT",
          name: "#checkout-eng",
          botIsMember: true,
          configured: true,
          configuredPlaceId: "place_checkout",
        },
        {
          id: "G_PRIVATE",
          name: "#leadership",
          botIsMember: false,
          configured: false,
          configuredPlaceId: null,
        },
      ],
    });
  });

  it("redacts Slack channel discovery provider errors", async () => {
    const rawToken = "xoxb-discovery-secret-token-12345";
    const slackClient = new FakeSlackWebApiClient({
      failWith: `invalid_auth for Bearer ${rawToken}`,
    });
    const res = await createApp(new BekStore(), { slackClient }).request(
      "/api/slack/channels/discover",
    );
    const text = await res.text();
    const json = JSON.parse(text) as { error: string };

    expect(res.status).toBe(502);
    expect(text).not.toContain(rawToken);
    expect(json.error).toBe("invalid_auth for Bearer [redacted:slack-token]");
  });

  it("uses the fallback Slack bot token for channel discovery without returning it", async () => {
    const rawToken = "xoxb-fallback-discovery-token-12345";
    process.env.SLACK_BOT_TOKEN = rawToken;
    let usedFallbackToken = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      expect(String(url)).toContain(
        "https://slack.com/api/conversations.list?",
      );
      usedFallbackToken =
        (init?.headers as Record<string, string> | undefined)?.authorization ===
        `Bearer ${rawToken}`;
      return Response.json({
        ok: true,
        channels: [
          {
            id: "C_DISCOVERED",
            name: "discovered",
            is_private: false,
            is_archived: false,
            is_member: true,
          },
        ],
        response_metadata: { next_cursor: "" },
      });
    });

    const res = await createApp().request("/api/slack/channels/discover");
    const text = await res.text();
    const json = JSON.parse(text) as {
      source: string;
      channels: Array<{ id: string; botIsMember: boolean }>;
    };

    expect(res.status).toBe(200);
    expect(usedFallbackToken).toBe(true);
    expect(text).not.toContain(rawToken);
    expect(json).toMatchObject({
      source: "env",
      channels: [{ id: "C_DISCOVERED", botIsMember: true }],
    });
  });

  it("uses stored Slack OAuth bot tokens for channel discovery", async () => {
    configureFakeSlackOAuth();
    process.env.BEK_SLACK_OAUTH_EXCHANGE = "true";
    process.env.BEK_CREDENTIAL_MASTER_KEY = testCredentialMasterKey;
    const storedToken = "xoxb-stored-discovery-token-12345";
    let usedStoredToken = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const urlText = String(url);
      if (urlText === "https://slack.com/api/oauth.v2.access") {
        return Response.json({
          ok: true,
          app_id: "A123",
          access_token: storedToken,
          scope: "app_mentions:read,commands,chat:write,channels:read",
          bot_user_id: "U_BEK",
          team: { id: "T123", name: "Redo" },
          authed_user: { id: "U_ADMIN" },
        });
      }
      if (urlText.startsWith("https://slack.com/api/conversations.list?")) {
        usedStoredToken =
          (init?.headers as Record<string, string> | undefined)
            ?.authorization === `Bearer ${storedToken}`;
        return Response.json({
          ok: true,
          channels: [
            {
              id: "C_STORED",
              name: "stored-token-channel",
              is_private: false,
              is_archived: false,
              is_member: true,
            },
          ],
        });
      }
      return Response.json({ ok: false, error: "unexpected_url" });
    });
    const app = createApp(new BekStore());
    const state = createSlackOAuthState({
      stateSecret: process.env.SLACK_STATE_SECRET!,
      nonce: "test-nonce",
      nowSeconds: Math.floor(Date.now() / 1000),
    });

    const install = await app.request(
      `/api/slack/oauth/callback?code=fake-code&state=${encodeURIComponent(
        state,
      )}`,
    );
    expect(install.status).toBe(200);

    const res = await app.request("/api/slack/channels/discover");
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(usedStoredToken).toBe(true);
    expect(text).not.toContain(storedToken);
    expect(JSON.parse(text)).toMatchObject({
      source: "stored_oauth",
      teamId: "T123",
      workspaceName: "Redo",
      channels: [{ id: "C_STORED", botIsMember: true }],
    });
  });

  it("returns a protected Slack install URL for the admin console", async () => {
    process.env.BEK_ADMIN_API_TOKEN = "test-admin-token";
    configureFakeSlackOAuth();

    const res = await createApp().request(
      "/api/slack/install-url?return_to=%2Fconnectors",
      {
        headers: { authorization: "Bearer test-admin-token" },
      },
    );
    const json = (await res.json()) as {
      url: string;
      scopes: string[];
      redirectUri: string;
      exchangeEnabled: boolean;
      tokenStorageConfigured: boolean;
    };

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(json.scopes).toEqual(
      expect.arrayContaining([
        "app_mentions:read",
        "commands",
        "chat:write",
        "channels:read",
        "groups:read",
        "im:history",
      ]),
    );
    expect(json.redirectUri).toBe(process.env.SLACK_REDIRECT_URI);
    expect(json.exchangeEnabled).toBe(false);
    expect(json.tokenStorageConfigured).toBe(false);

    const url = new URL(json.url);
    expect(url.origin).toBe("https://slack.com");
    const state = verifySlackOAuthState({
      stateSecret: process.env.SLACK_STATE_SECRET,
      state: url.searchParams.get("state") ?? undefined,
    });
    expect(state).toMatchObject({
      ok: true,
      payload: {
        returnTo: "/connectors",
        callbackMode: "redirect",
      },
    });
  });

  it("returns a protected Slack app manifest for fast workspace setup", async () => {
    process.env.BEK_ADMIN_API_TOKEN = "test-admin-token";
    process.env.BEK_PUBLIC_URL = "https://bek-public.example.com///";
    process.env.SLACK_REDIRECT_URI =
      "https://slack-oauth.example.com/api/slack/oauth/callback";
    process.env.SLACK_BOT_SCOPES =
      "app_mentions:read,reactions:read,commands,chat:write,channels:read,groups:read,im:history";

    const denied = await createApp().request("/api/slack/manifest");
    expect(denied.status).toBe(401);

    const allowed = await createApp().request("/api/slack/manifest", {
      headers: { authorization: "Bearer test-admin-token" },
    });
    const text = await allowed.text();
    const json = JSON.parse(text) as {
      ok: true;
      baseUrl: string;
      scopes: string[];
      botEvents: string[];
      urls: {
        events: string;
        interactivity: string;
        command: string;
        redirect: string;
      };
      manifest: {
        features: {
          app_home: { messages_tab_enabled: boolean };
          bot_user: { display_name: string };
          slash_commands: Array<{ command: string; url: string }>;
        };
        oauth_config: { redirect_urls: string[]; scopes: { bot: string[] } };
        settings: {
          event_subscriptions: {
            request_url: string;
            bot_events: string[];
          };
          interactivity: { request_url: string };
        };
      };
    };

    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("cache-control")).toBe("no-store");
    expect(text).not.toContain("xoxb-");
    expect(json).toMatchObject({
      ok: true,
      baseUrl: "https://bek-public.example.com",
      scopes: expect.arrayContaining([
        "commands",
        "channels:read",
        "im:history",
      ]),
      botEvents: expect.arrayContaining([
        "app_mention",
        "message.im",
        "reaction_added",
        "member_joined_channel",
      ]),
      urls: {
        events: "https://bek-public.example.com/api/slack/events",
        interactivity: "https://bek-public.example.com/api/slack/interactivity",
        command: "https://bek-public.example.com/api/slack/commands",
        redirect: "https://slack-oauth.example.com/api/slack/oauth/callback",
      },
    });
    expect(json.manifest.features.app_home.messages_tab_enabled).toBe(true);
    expect(json.manifest.features.bot_user.display_name).toBe("bek");
    expect(json.manifest.features.slash_commands[0]).toMatchObject({
      command: "/bek",
      url: "https://bek-public.example.com/api/slack/commands",
    });
    expect(json.manifest.oauth_config.redirect_urls).toEqual([
      "https://slack-oauth.example.com/api/slack/oauth/callback",
    ]);
    expect(json.manifest.settings.event_subscriptions.request_url).toBe(
      "https://bek-public.example.com/api/slack/events",
    );
  });

  it("drops unsafe Slack install return targets before signing OAuth state", async () => {
    process.env.BEK_ADMIN_API_TOKEN = "test-admin-token";
    configureFakeSlackOAuth();

    const res = await createApp().request(
      "/api/slack/install-url?return_to=https%3A%2F%2Fevil.example%2Fsteal",
      {
        headers: { authorization: "Bearer test-admin-token" },
      },
    );
    const json = (await res.json()) as { url: string };

    expect(res.status).toBe(200);
    const url = new URL(json.url);
    const state = verifySlackOAuthState({
      stateSecret: process.env.SLACK_STATE_SECRET,
      state: url.searchParams.get("state") ?? undefined,
    });
    expect(state).toMatchObject({
      ok: true,
      payload: {
        callbackMode: "redirect",
      },
    });
    if (state.ok) {
      expect(state.payload.returnTo).toBeUndefined();
    }
  });

  it("redirects Slack install with signed OAuth state", async () => {
    configureFakeSlackOAuth();

    const res = await createApp().request(
      "/api/slack/install?return_to=%2Fsettings%2Fslack",
    );
    expect(res.status).toBe(302);

    const location = res.headers.get("location");
    expect(location).toBeTruthy();
    const url = new URL(location!);
    expect(url.origin).toBe("https://slack.com");
    expect(url.pathname).toBe("/oauth/v2/authorize");
    expect(url.searchParams.get("client_id")).toBe(process.env.SLACK_CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(
      process.env.SLACK_REDIRECT_URI,
    );
    expect(url.searchParams.get("scope")).toContain("app_mentions:read");
    expect(url.searchParams.get("scope")).toContain("commands");

    const state = verifySlackOAuthState({
      stateSecret: process.env.SLACK_STATE_SECRET,
      state: url.searchParams.get("state") ?? undefined,
    });
    expect(state.ok).toBe(true);
    if (state.ok) {
      expect(state.payload.returnTo).toBe("/settings/slack");
      expect(state.payload.callbackMode).toBeUndefined();
    }
  });

  it("pins Slack OAuth callback redirects to configured admin origins", async () => {
    configureFakeSlackOAuth();
    process.env.BEK_ADMIN_ORIGINS = "http://localhost:5173";
    const state = signedSlackOAuthState({
      nonce: "unsafe-return",
      issuedAt: Math.floor(Date.now() / 1000),
      returnTo: "https://evil.example/phish",
      callbackMode: "redirect",
    });

    const res = await createApp().request(
      `/api/slack/oauth/callback?code=fake-code&state=${encodeURIComponent(
        state,
      )}`,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "http://localhost:5173/connectors?slack_install=validated",
    );
  });

  it("handles Slack OAuth callback errors before token exchange", async () => {
    const slackError = await createApp().request(
      "/api/slack/oauth/callback?error=access_denied",
    );
    expect(slackError.status).toBe(400);
    await expect(slackError.json()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("access_denied"),
    });

    const missingCode = await createApp().request(
      "/api/slack/oauth/callback?state=unused",
    );
    expect(missingCode.status).toBe(400);
    await expect(missingCode.json()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("missing code"),
    });
  });

  it("validates Slack OAuth callback state before token exchange", async () => {
    configureFakeSlackOAuth();
    const state = createSlackOAuthState({
      stateSecret: process.env.SLACK_STATE_SECRET!,
      nonce: "test-nonce",
      nowSeconds: Math.floor(Date.now() / 1000),
    });

    const res = await createApp().request(
      `/api/slack/oauth/callback?code=fake-code&state=${encodeURIComponent(
        state,
      )}`,
    );

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      status: "state_validated",
      codeReceived: true,
    });
  });

  it("exchanges Slack OAuth callbacks in explicit exchange mode", async () => {
    configureFakeSlackOAuth();
    process.env.BEK_SLACK_OAUTH_EXCHANGE = "true";
    process.env.BEK_CREDENTIAL_MASTER_KEY = testCredentialMasterKey;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        ok: true,
        app_id: "A123",
        access_token: "xoxb-super-secret-token",
        scope: "app_mentions:read,commands,chat:write",
        bot_user_id: "U_BEK",
        team: { id: "T123", name: "Redo" },
        authed_user: { id: "U_ADMIN" },
      }),
    );
    const state = createSlackOAuthState({
      stateSecret: process.env.SLACK_STATE_SECRET!,
      nonce: "test-nonce",
      nowSeconds: Math.floor(Date.now() / 1000),
      returnTo: "/settings/slack",
    });
    const store = new BekStore();
    const app = createApp(store);

    const res = await app.request(
      `/api/slack/oauth/callback?code=fake-code&state=${encodeURIComponent(
        state,
      )}`,
    );
    const json = (await res.json()) as {
      status: string;
      install: Record<string, unknown>;
      connectorInstall: Record<string, unknown>;
      credential: Record<string, unknown>;
      tokenStored: boolean;
      returnTo: string;
    };

    expect(res.status).toBe(200);
    expect(json).toMatchObject({
      status: "installed",
      returnTo: "/settings/slack",
      install: {
        teamId: "T123",
        teamName: "Redo",
        botTokenRedacted: "xoxb...oken",
      },
      connectorInstall: {
        externalId: "T123",
        displayName: "Redo",
        status: "active",
      },
      credential: {
        provider: "slack",
        externalAccountId: "T123",
        secretRef: "[redacted:secret-ref]",
        metadata: {
          vaultEnvelopeStored: true,
        },
      },
      tokenStored: true,
    });
    expect(json.install.botToken).toBeUndefined();
    expect(JSON.stringify(json)).not.toContain("xoxb-super-secret-token");

    const snapshotText = JSON.stringify(store.read());
    expect(snapshotText).not.toContain("xoxb-super-secret-token");
    expect(store.read().connectorInstalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "slack",
          provider: "slack",
          externalId: "T123",
        }),
      ]),
    );
    expect(store.read().credentials).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "slack",
          externalAccountId: "T123",
          secretRef: "bek-local-vault:slack:org_demo:T123:bot",
          metadata: expect.objectContaining({
            vaultEnvelope: expect.any(Object),
          }),
        }),
      ]),
    );

    const bootstrap = await app.request("/api/bootstrap");
    const bootstrapText = JSON.stringify(await bootstrap.json());
    expect(bootstrapText).not.toContain("xoxb-super-secret-token");
    expect(bootstrapText).not.toContain('"vaultEnvelope":');
    expect(bootstrapText).toContain("vaultEnvelopeStored");

    await expect(
      (await app.request("/api/setup/status")).json(),
    ).resolves.toMatchObject({
      slackInstalled: true,
      slackInstallStatus: "active",
      slackWorkspaceName: "Redo",
      slackWorkspaceId: "T123",
      slackBotUserId: "U_BEK",
      slackTokenStored: true,
    });

    const connectorSummaryText = JSON.stringify(
      await (await app.request("/api/connectors/slack")).json(),
    );
    expect(connectorSummaryText).toContain('"tokenPresent":true');
    expect(connectorSummaryText).toContain('"credentialStatus":"active"');
    expect(connectorSummaryText).toContain('"scopeSummary"');
    expect(connectorSummaryText).not.toContain("xoxb-super-secret-token");
    expect(connectorSummaryText).not.toContain("vaultEnvelope");
    expect(fetch).toHaveBeenCalledWith(
      "https://slack.com/api/oauth.v2.access",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });

  it("redirects web-started Slack OAuth callbacks back to the admin console", async () => {
    configureFakeSlackOAuth();
    process.env.BEK_SLACK_OAUTH_EXCHANGE = "true";
    process.env.BEK_CREDENTIAL_MASTER_KEY = testCredentialMasterKey;
    process.env.BEK_ADMIN_ORIGINS = "http://localhost:5173";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        ok: true,
        app_id: "A123",
        access_token: "xoxb-web-started-token",
        scope: "app_mentions:read,commands,chat:write",
        bot_user_id: "U_BEK",
        team: { id: "T123", name: "Redo" },
        authed_user: { id: "U_ADMIN" },
      }),
    );
    const state = createSlackOAuthState({
      stateSecret: process.env.SLACK_STATE_SECRET!,
      nonce: "web-started",
      nowSeconds: Math.floor(Date.now() / 1000),
      returnTo: "/connectors",
      callbackMode: "redirect",
    });
    const store = new BekStore();

    const res = await createApp(store).request(
      `/api/slack/oauth/callback?code=fake-code&state=${encodeURIComponent(
        state,
      )}`,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "http://localhost:5173/connectors?slack_install=installed&slack_workspace=T123",
    );
    expect(JSON.stringify(store.read())).not.toContain(
      "xoxb-web-started-token",
    );
    expect(store.read().connectorInstalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "slack",
          externalId: "T123",
          status: "active",
        }),
      ]),
    );
  });

  it("requires a credential master key before consuming Slack OAuth codes", async () => {
    configureFakeSlackOAuth();
    process.env.BEK_SLACK_OAUTH_EXCHANGE = "true";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const state = createSlackOAuthState({
      stateSecret: process.env.SLACK_STATE_SECRET!,
      nonce: "test-nonce",
      nowSeconds: Math.floor(Date.now() / 1000),
    });

    const res = await createApp().request(
      `/api/slack/oauth/callback?code=fake-code&state=${encodeURIComponent(
        state,
      )}`,
    );

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("BEK_CREDENTIAL_MASTER_KEY"),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps revoked Slack installs token-not-ready in setup status", async () => {
    const store = new BekStore();
    const install = store.upsertConnectorInstall({
      id: "connector_slack_T123",
      kind: "slack",
      provider: "slack",
      externalId: "T123",
      displayName: "Redo",
      status: "revoked",
      metadata: {
        teamId: "T123",
        botUserId: "U_BEK",
      },
    });
    store.upsertCredential({
      id: "credential_slack_bot_T123",
      connectorInstallId: install.id,
      name: "Redo Slack bot token",
      provider: "slack",
      externalAccountId: "T123",
      secretRef: "bek-local-vault:slack:org_demo:T123:bot",
      status: "active",
      scopeSummary: "chat:write",
    });

    const status = await createApp(store).request("/api/setup/status");

    await expect(status.json()).resolves.toMatchObject({
      slackInstalled: true,
      slackInstallStatus: "revoked",
      slackWorkspaceName: "Redo",
      slackWorkspaceId: "T123",
      slackBotUserId: "U_BEK",
      slackTokenStored: false,
    });
  });

  it("rejects invalid Slack OAuth callback state", async () => {
    process.env.SLACK_STATE_SECRET = "fake-state-secret";

    const res = await createApp().request(
      "/api/slack/oauth/callback?code=fake-code&state=bad-state",
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("malformed"),
    });
  });

  it("fails denied runs instead of marking them completed", async () => {
    const app = createApp();
    const res = await app.request("/api/runs", {
      method: "POST",
      body: JSON.stringify({
        prompt: "@bek read repo from general",
        placeScopeId: "place_general",
        capability: "github.read",
        resource: "github:redohq/checkout",
      }),
      headers: { "content-type": "application/json" },
    });

    const run = (await res.json()) as { status: string };
    expect(run.status).toBe("failed");
  });

  it("dedupes Slack event IDs", async () => {
    const app = createApp();
    const payload = {
      event_id: "Ev123",
      event: {
        type: "app_mention",
        channel: "C_CHECKOUT",
        user: "U123",
        text: "@bek hello",
      },
    };

    const first = await app.request("/api/slack/events", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const second = await app.request("/api/slack/events", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    expect(first.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({ deduped: true });
  });

  it("auto-imports a Slack channel when Bek joins it", async () => {
    const store = new BekStore();
    installActiveSlackApp(store, { botUserId: "U_BEK" });
    const app = createApp(store);
    const payload = {
      team_id: "T123",
      event_id: "EvBekJoinedChannel",
      event: {
        type: "member_joined_channel",
        user: "U_BEK",
        channel: "C_NEW",
        channel_type: "C",
        event_ts: "1710000000.000010",
      },
    };
    const rawBody = JSON.stringify(payload);

    const first = await app.request("/api/slack/events", {
      method: "POST",
      body: rawBody,
      headers: signedSlackHeaders(rawBody),
    });

    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      ok: true,
      imported: true,
      configured: true,
      channelId: "C_NEW",
    });
    const snapshot = store.read();
    const channel = snapshot.places.find(
      (place) => place.provider === "slack" && place.externalId === "C_NEW",
    );
    expect(channel).toMatchObject({
      kind: "slack_channel",
      name: "#C_NEW",
      sensitivity: "internal",
      metadata: expect.objectContaining({
        teamId: "T123",
        source: "slack_join_event",
        joinedUserId: "U_BEK",
      }),
    });
    expect(snapshot.runs).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ placeScopeId: channel?.id }),
      ]),
    );
    expect(snapshot.accessBundles.flatMap((bundle) => bundle.grants)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capability: "slack.read",
          resource: "slack:C_NEW",
          decision: "allow",
          requiresApproval: false,
        }),
      ]),
    );

    const retry = await app.request("/api/slack/events", {
      method: "POST",
      body: rawBody,
      headers: signedSlackHeaders(rawBody),
    });
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({
      deduped: true,
      imported: true,
      channelId: "C_NEW",
    });
    expect(
      store
        .read()
        .places.filter(
          (place) => place.provider === "slack" && place.externalId === "C_NEW",
        ),
    ).toHaveLength(1);
  });

  it("repairs Slack channel grants when Bek joins an already imported channel", async () => {
    const store = new BekStore();
    installActiveSlackApp(store, { botUserId: "U_BEK" });
    const channel = store.createPlace({
      kind: "slack_channel",
      provider: "slack",
      externalId: "C_EXISTING",
      name: "#existing",
      sensitivity: "internal",
      metadata: { teamId: "T123" },
    });
    const payload = {
      team_id: "T123",
      event_id: "EvBekJoinedExistingChannel",
      event: {
        type: "member_joined_channel",
        user: "U_BEK",
        channel: "C_EXISTING",
        event_ts: "1710000000.000012",
      },
    };
    const rawBody = JSON.stringify(payload);

    const res = await createApp(store).request("/api/slack/events", {
      method: "POST",
      body: rawBody,
      headers: signedSlackHeaders(rawBody),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      imported: false,
      configured: true,
      placeId: channel.id,
      channelId: "C_EXISTING",
    });
    expect(store.read().places).toHaveLength(3);
    expect(
      store.read().accessBundles.flatMap((bundle) => bundle.grants),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capability: "slack.read",
          resource: "slack:C_EXISTING",
          decision: "allow",
          requiresApproval: false,
        }),
      ]),
    );
  });

  it("requires the installed Slack bot user ID before importing member join events", async () => {
    const store = new BekStore();
    installActiveSlackApp(store);
    const payload = {
      team_id: "T123",
      event_id: "EvBekJoinedMissingBotUser",
      event: {
        type: "member_joined_channel",
        user: "U_BEK",
        channel: "C_UNKNOWN_BOT",
        event_ts: "1710000000.000013",
      },
    };
    const rawBody = JSON.stringify(payload);

    const res = await createApp(store).request("/api/slack/events", {
      method: "POST",
      body: rawBody,
      headers: signedSlackHeaders(rawBody),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-slack-no-retry")).toBe("1");
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      ignored: true,
      reason: "Slack channel join did not add Bek's bot user.",
    });
    expect(
      store.read().places.some((place) => place.externalId === "C_UNKNOWN_BOT"),
    ).toBe(false);
  });

  it("ignores Slack channel joins that are not Bek's bot user", async () => {
    const store = new BekStore();
    installActiveSlackApp(store, { botUserId: "U_BEK" });
    const payload = {
      team_id: "T123",
      event_id: "EvHumanJoinedChannel",
      event: {
        type: "member_joined_channel",
        user: "U_HUMAN",
        channel: "C_HUMAN_JOIN",
        event_ts: "1710000000.000011",
      },
    };
    const rawBody = JSON.stringify(payload);

    const res = await createApp(store).request("/api/slack/events", {
      method: "POST",
      body: rawBody,
      headers: signedSlackHeaders(rawBody),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-slack-no-retry")).toBe("1");
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      ignored: true,
      reason: "Slack channel join did not add Bek's bot user.",
    });
    expect(
      store.read().places.some((place) => place.externalId === "C_HUMAN_JOIN"),
    ).toBe(false);
  });

  it("revokes Slack installs and stored bot credentials on app_uninstalled", async () => {
    const store = new BekStore();
    const install = installActiveSlackApp(store, { botUserId: "U_BEK" });
    storeActiveSlackCredential(store, { install });
    const payload = {
      team_id: "T123",
      event_id: "EvAppUninstalled",
      event_time: 1710000000,
      event: {
        type: "app_uninstalled",
      },
    };
    const rawBody = JSON.stringify(payload);

    const res = await createApp(store).request("/api/slack/events", {
      method: "POST",
      body: rawBody,
      headers: signedSlackHeaders(rawBody),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      revoked: true,
      installId: install.id,
      status: "revoked",
      credentialsRevoked: 1,
      reason: "app_uninstalled",
    });
    expect(store.read().connectorInstalls[0]).toMatchObject({
      id: install.id,
      status: "revoked",
      metadata: expect.objectContaining({
        revokedReason: "app_uninstalled",
        revokedAt: expect.any(String),
      }),
    });
    expect(store.read().credentials[0]).toMatchObject({
      status: "revoked",
      metadata: expect.objectContaining({
        revokedReason: "app_uninstalled",
        revokedAt: expect.any(String),
      }),
    });
    await expect(
      (await createApp(store).request("/api/setup/status")).json(),
    ).resolves.toMatchObject({
      slackInstalled: true,
      slackInstallStatus: "revoked",
      slackWorkspaceId: "T123",
      slackBotUserId: "U_BEK",
      slackTokenStored: false,
    });
  });

  it("revokes stored Slack bot credentials on tokens_revoked", async () => {
    const store = new BekStore();
    const install = installActiveSlackApp(store, { botUserId: "U_BEK" });
    storeActiveSlackCredential(store, { install });
    const payload = {
      team_id: "T123",
      event_id: "EvTokensRevoked",
      event: {
        type: "tokens_revoked",
        tokens: {
          bot: ["U_BEK"],
        },
      },
    };
    const rawBody = JSON.stringify(payload);

    const res = await createApp(store).request("/api/slack/events", {
      method: "POST",
      body: rawBody,
      headers: signedSlackHeaders(rawBody),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      revoked: true,
      installId: install.id,
      status: "active",
      credentialsRevoked: 1,
      reason: "tokens_revoked",
    });
    expect(store.read().connectorInstalls[0]).toMatchObject({
      id: install.id,
      status: "active",
    });
    expect(store.read().credentials[0]).toMatchObject({
      status: "revoked",
      metadata: expect.objectContaining({
        revokedReason: "tokens_revoked",
      }),
    });
    await expect(
      (await createApp(store).request("/api/setup/status")).json(),
    ).resolves.toMatchObject({
      slackInstallStatus: "active",
      slackTokenStored: false,
    });
  });

  it("ignores tokens_revoked for another bot user", async () => {
    const store = new BekStore();
    const install = installActiveSlackApp(store, { botUserId: "U_BEK" });
    storeActiveSlackCredential(store, { install });
    const payload = {
      team_id: "T123",
      event_id: "EvOtherTokensRevoked",
      event: {
        type: "tokens_revoked",
        tokens: {
          bot: ["U_OTHER"],
        },
      },
    };
    const rawBody = JSON.stringify(payload);

    const res = await createApp(store).request("/api/slack/events", {
      method: "POST",
      body: rawBody,
      headers: signedSlackHeaders(rawBody),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      ignored: true,
      revoked: false,
      installId: install.id,
      reason: "No Bek bot token was revoked.",
    });
    expect(store.read().credentials[0]).toMatchObject({
      status: "active",
    });
  });

  it("marks Slack channels unavailable when Bek leaves and blocks future runs", async () => {
    mapSlackTestUser();
    const store = new BekStore();
    installActiveSlackApp(store, { botUserId: "U_BEK" });
    const checkout = store
      .read()
      .places.find((place) => place.id === "place_checkout")!;
    store.updatePlace(checkout.id, {
      metadata: { ...(checkout.metadata ?? {}), botIsMember: true },
    });
    const payload = {
      team_id: "T123",
      event_id: "EvBekLeftCheckout",
      event: {
        type: "member_left_channel",
        user: "U_BEK",
        channel: "C_CHECKOUT",
        channel_type: "C",
        event_ts: "1710000000.000014",
      },
    };
    const rawBody = JSON.stringify(payload);
    const app = createApp(store);

    const res = await app.request("/api/slack/events", {
      method: "POST",
      body: rawBody,
      headers: signedSlackHeaders(rawBody),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      configured: false,
      placeId: "place_checkout",
      channelId: "C_CHECKOUT",
      botIsMember: false,
    });
    expect(
      store.read().places.find((place) => place.id === "place_checkout"),
    ).toMatchObject({
      metadata: expect.objectContaining({
        teamId: "T123",
        botIsMember: false,
        botLeftReason: "slack_channel_left",
        botLeftUserId: "U_BEK",
      }),
    });

    const runsBeforeMention = store.read().runs.length;
    const mentionPayload = {
      team_id: "T123",
      event_id: "EvMentionAfterBekLeft",
      event: {
        type: "app_mention",
        channel: "C_CHECKOUT",
        user: "U123",
        text: "@bek can you still work here?",
      },
    };
    const mentionRawBody = JSON.stringify(mentionPayload);
    const mention = await app.request("/api/slack/events", {
      method: "POST",
      body: mentionRawBody,
      headers: signedSlackHeaders(mentionRawBody),
    });

    expect(mention.status).toBe(200);
    await expect(mention.json()).resolves.toMatchObject({
      ok: false,
      ignored: true,
      reason: "Bek is not configured for this Slack channel.",
    });
    expect(store.read().runs).toHaveLength(runsBeforeMention);
  });

  it("ignores Slack channel leave events for humans", async () => {
    const store = new BekStore();
    installActiveSlackApp(store, { botUserId: "U_BEK" });
    const checkout = store
      .read()
      .places.find((place) => place.id === "place_checkout")!;
    store.updatePlace(checkout.id, {
      metadata: { ...(checkout.metadata ?? {}), botIsMember: true },
    });
    const payload = {
      team_id: "T123",
      event_id: "EvHumanLeftCheckout",
      event: {
        type: "member_left_channel",
        user: "U_HUMAN",
        channel: "C_CHECKOUT",
        event_ts: "1710000000.000015",
      },
    };
    const rawBody = JSON.stringify(payload);

    const res = await createApp(store).request("/api/slack/events", {
      method: "POST",
      body: rawBody,
      headers: signedSlackHeaders(rawBody),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-slack-no-retry")).toBe("1");
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      ignored: true,
      reason: "Slack channel leave did not remove Bek's bot user.",
    });
    expect(
      store.read().places.find((place) => place.id === "place_checkout"),
    ).toMatchObject({
      metadata: expect.objectContaining({
        botIsMember: true,
      }),
    });
  });

  it("returns the original ignored Slack event response on retries", async () => {
    const app = createApp();
    const payload = {
      event_id: "EvIgnoredRetry",
      event: {
        type: "app_mention",
        channel: "C_UNKNOWN",
        user: "U123",
        text: "@bek hello",
      },
    };
    const rawBody = JSON.stringify(payload);

    const first = await app.request("/api/slack/events", {
      method: "POST",
      body: rawBody,
      headers: signedSlackHeaders(rawBody),
    });
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      ok: false,
      ignored: true,
      reason: "Bek is not configured for this Slack channel.",
    });

    const retry = await app.request("/api/slack/events", {
      method: "POST",
      body: rawBody,
      headers: {
        ...signedSlackHeaders(rawBody),
        ...slackRetryHeaders("1", "http_timeout"),
      },
    });

    expect(retry.status).toBe(200);
    expect(retry.headers.get("x-slack-no-retry")).toBe("1");
    await expect(retry.json()).resolves.toMatchObject({
      ok: false,
      ignored: true,
      deduped: true,
      reason: "Bek is not configured for this Slack channel.",
      slackRetry: {
        retryNum: 1,
        reason: "http_timeout",
      },
    });
  });

  it("dedupes Slack event IDs across API app instances sharing persisted state", async () => {
    mapSlackTestUser();
    const store = new BekStore();
    const payload = {
      event_id: "EvRestart",
      event: {
        type: "app_mention",
        channel: "C_CHECKOUT",
        user: "U123",
        text: "@bek hello after restart",
      },
    };

    const first = await createApp(store).request("/api/slack/events", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as { runId: string };

    const second = await createApp(store).request("/api/slack/events", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({
      deduped: true,
      runId: firstJson.runId,
    });
  });

  it("posts final Slack replies for app mentions without reposting retries", async () => {
    mapSlackTestUser();
    const slackClient = new FakeSlackWebApiClient();
    const app = createApp(new BekStore(), { slackClient });
    const payload = {
      event_id: "EvOutboundFinal",
      event: {
        type: "app_mention",
        channel: "C_CHECKOUT",
        user: "U123",
        text: "@bek hello from Slack",
        ts: "1710000000.000001",
      },
    };

    const first = await app.request("/api/slack/events", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as { runId: string };

    expect(slackClient.postMessageCalls).toHaveLength(1);
    expect(slackClient.postMessageCalls[0]).toMatchObject({
      channel: "C_CHECKOUT",
      thread_ts: "1710000000.000001",
      text: expect.stringContaining("Bek finished."),
    });
    expect(JSON.stringify(slackClient.postMessageCalls[0]!.blocks)).toContain(
      firstJson.runId,
    );

    const retry = await app.request("/api/slack/events", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({
      deduped: true,
      runId: firstJson.runId,
    });
    expect(slackClient.postMessageCalls).toHaveLength(1);
  });

  it("acknowledges Slack events before outbound Slack delivery", async () => {
    process.env.BEK_SLACK_BACKGROUND_DRAIN = "false";
    mapSlackTestUser();
    const slackClient = new BlockingSlackWebApiClient();
    const app = createApp(new BekStore(), { slackClient });
    const payload = {
      event_id: "EvFastAck",
      event: {
        type: "app_mention",
        channel: "C_CHECKOUT",
        user: "U123",
        text: "@bek do not wait on Slack posting",
        ts: "1710000000.000009",
      },
    };

    const res = await Promise.race([
      app.request("/api/slack/events", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 50),
      ),
    ]);

    expect(res).not.toBe("timeout");
    expect((res as Response).status).toBe(200);
    await expect((res as Response).json()).resolves.toMatchObject({
      ok: true,
      runId: expect.any(String),
    });
    expect(slackClient.postMessageCalls).toHaveLength(0);
    const outbox = await expectJson<{
      deliveries: Array<Record<string, unknown>>;
    }>(app, "/api/outbound/slack");
    expect(outbox).toMatchObject({
      deliveries: [
        expect.objectContaining({
          status: "queued",
          kind: "slack.run_outcome",
          attempts: 0,
          maxAttempts: expect.any(Number),
        }),
      ],
    });
    expect(outbox.deliveries[0]).not.toHaveProperty("payload");
    expect(outbox.deliveries[0]).not.toHaveProperty("target");
    expect(JSON.stringify(outbox)).not.toContain(
      "@bek do not wait on Slack posting",
    );
    await expect(
      expectJson(app, "/api/outbound/slack?include=details"),
    ).resolves.toMatchObject({
      deliveries: [
        {
          payload: expect.any(Object),
          target: expect.any(Object),
        },
      ],
    });
  });

  it("answers Slack access summary prompts without creating a run", async () => {
    process.env.BEK_SLACK_BACKGROUND_DRAIN = "false";
    mapSlackTestUser();
    const store = new BekStore();
    const slackClient = new FakeSlackWebApiClient();
    const app = createApp(store, { slackClient });
    const initialRunCount = store.read().runs.length;
    const rawBody = JSON.stringify({
      team_id: "T123",
      event_id: "EvAccessSummary",
      event: {
        type: "app_mention",
        channel: "C_CHECKOUT",
        user: "U123",
        text: "@bek what can you access here?",
        ts: "1710000000.000011",
      },
    });

    const res = await app.request("/api/slack/events", {
      method: "POST",
      body: rawBody,
      headers: signedSlackHeaders(rawBody),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      accessSummary: true,
      grantCount: 4,
    });
    expect(store.read().runs).toHaveLength(initialRunCount);
    const delivery = store.read().outboundDeliveries[0];
    expect(delivery).toMatchObject({
      kind: "slack.run_outcome",
      status: "queued",
      target: expect.objectContaining({
        channelId: "C_CHECKOUT",
        threadTs: "1710000000.000011",
        messageKind: "access_summary",
      }),
    });
    expect(delivery?.runId).toBeUndefined();
    expect(JSON.stringify(delivery?.payload)).toContain("github.pr");

    const drain = await app.request("/api/outbound/slack/drain", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });
    expect(drain.status).toBe(200);
    expect(slackClient.postMessageCalls).toHaveLength(1);
    expect(slackClient.postMessageCalls[0]).toMatchObject({
      channel: "C_CHECKOUT",
      thread_ts: "1710000000.000011",
      text: expect.stringContaining("governed grants"),
    });
    expect(JSON.stringify(slackClient.postMessageCalls[0]!.blocks)).toContain(
      "sandbox.exec",
    );
  });

  it("posts worker completion output for Slack-created runs", async () => {
    process.env.BEK_SLACK_BACKGROUND_DRAIN = "false";
    mapSlackTestUser();
    const slackClient = new FakeSlackWebApiClient();
    const app = createApp(new BekStore(), {
      runAdvancement: "worker_local",
      slackClient,
    });
    const payload = {
      event_id: "EvWorkerOutboundFinal",
      event: {
        type: "app_mention",
        channel: "C_CHECKOUT",
        user: "U123",
        text: "@bek summarize the rollout",
        ts: "1710000000.000010",
      },
    };

    const res = await app.request("/api/slack/events", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const json = (await res.json()) as { runId: string };

    expect(res.status).toBe(200);
    expect(slackClient.postMessageCalls).toHaveLength(0);

    const drain = await app.request("/api/worker/drain", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });
    expect(drain.status).toBe(200);
    expect(slackClient.postMessageCalls).toHaveLength(2);
    expect(slackClient.postMessageCalls[1]).toMatchObject({
      channel: "C_CHECKOUT",
      thread_ts: "1710000000.000010",
      text: expect.stringContaining("Bek local worker completed"),
    });
    expect(JSON.stringify(slackClient.postMessageCalls[1]!.blocks)).toContain(
      json.runId,
    );
  });

  it("posts Slack replies using the stored OAuth bot token", async () => {
    configureFakeSlackOAuth();
    process.env.BEK_SLACK_OAUTH_EXCHANGE = "true";
    process.env.BEK_CREDENTIAL_MASTER_KEY = testCredentialMasterKey;
    mapSlackTestUser();
    const storedToken = "xoxb-stored-bot-token-123456";
    let usedStoredToken = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const urlText = String(url);
      if (urlText === "https://slack.com/api/oauth.v2.access") {
        return Response.json({
          ok: true,
          app_id: "A123",
          access_token: storedToken,
          scope: "app_mentions:read,commands,chat:write",
          bot_user_id: "U_BEK",
          team: { id: "T123", name: "Redo" },
          authed_user: { id: "U_ADMIN" },
        });
      }
      if (urlText === "https://slack.com/api/chat.postMessage") {
        usedStoredToken =
          (init?.headers as Record<string, string> | undefined)
            ?.authorization === `Bearer ${storedToken}`;
        return Response.json({
          ok: true,
          channel: "C_CHECKOUT",
          ts: "1710000000.000050",
        });
      }
      return Response.json(
        { ok: false, error: "unexpected_url" },
        { status: 500 },
      );
    });

    const app = createApp(new BekStore());
    const state = createSlackOAuthState({
      stateSecret: process.env.SLACK_STATE_SECRET!,
      nonce: "test-nonce",
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    const install = await app.request(
      `/api/slack/oauth/callback?code=fake-code&state=${encodeURIComponent(
        state,
      )}`,
    );
    expect(install.status).toBe(200);

    const res = await app.request("/api/slack/events", {
      method: "POST",
      body: JSON.stringify({
        team_id: "T123",
        event_id: "EvStoredTokenOutbound",
        event: {
          type: "app_mention",
          channel: "C_CHECKOUT",
          user: "U123",
          text: "@bek hello with stored token",
          ts: "1710000000.000051",
        },
      }),
    });
    const json = (await res.json()) as { runId: string };

    expect(res.status).toBe(200);
    expect(usedStoredToken).toBe(true);
    await expect(
      expectJson(app, `/api/runs/${json.runId}`),
    ).resolves.toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({
          message: "Slack final_answer message posted.",
          data: expect.objectContaining({
            slackOutbound: expect.objectContaining({
              ok: true,
              channel: "C_CHECKOUT",
              ts: "1710000000.000050",
            }),
          }),
        }),
      ]),
    });
    const bootstrapText = JSON.stringify(
      await (await app.request("/api/bootstrap")).json(),
    );
    expect(bootstrapText).not.toContain(storedToken);
  });

  it("posts approval-needed Slack buttons for paused worker runs", async () => {
    process.env.BEK_SLACK_BACKGROUND_DRAIN = "false";
    mapSlackTestUser();
    const slackClient = new FakeSlackWebApiClient();
    const store = new BekStore();
    const app = createApp(store, {
      runAdvancement: "worker_local",
      slackClient,
    });
    const payload = {
      event_id: "EvApprovalOutbound",
      event: {
        type: "app_mention",
        channel: "C_CHECKOUT",
        user: "U123",
        text: "@bek ask for approval before touching anything",
        ts: "1710000000.000020",
      },
    };

    const res = await app.request("/api/slack/events", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const json = (await res.json()) as { runId: string };

    expect(res.status).toBe(200);
    expect(slackClient.postMessageCalls).toHaveLength(0);

    const drain = await app.request("/api/worker/drain", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });
    expect(drain.status).toBe(200);
    expect(slackClient.postMessageCalls).toHaveLength(2);
    const approvalMessage = slackClient.postMessageCalls.find(
      (message) => message.text === "Bek needs approval for local.approval.",
    );
    if (!approvalMessage) {
      throw new Error("Expected an approval-needed Slack message.");
    }
    expect(approvalMessage).toMatchObject({
      channel: "C_CHECKOUT",
      thread_ts: "1710000000.000020",
      text: "Bek needs approval for local.approval.",
    });
    const actions = approvalMessage.blocks?.find(
      (block) => block.type === "actions",
    ) as SlackActionsBlock | undefined;
    expect(actions).toBeTruthy();
    expect(
      parseSlackApprovalActionValue(actions!.elements[0]!.value),
    ).toMatchObject({
      runId: json.runId,
      action: "local.approval",
      approvalId: expect.any(String),
      payloadHash: expect.any(String),
    });
    const approvalId = parseSlackApprovalActionValue(
      actions!.elements[0]!.value,
    ).approvalId;
    expect(
      store
        .read()
        .outboundDeliveries.find(
          (delivery) =>
            delivery.runId === json.runId &&
            delivery.target.messageKind === "approval_needed",
        ),
    ).toMatchObject({
      approvalId,
    });
  });

  it("records permanent Slack outbound failures without failing accepted events", async () => {
    mapSlackTestUser();
    const slackClient = new FakeSlackWebApiClient({ failWith: "invalid_auth" });
    const app = createApp(new BekStore(), { slackClient });
    const payload = {
      event_id: "EvOutboundFailure",
      event: {
        type: "app_mention",
        channel: "C_CHECKOUT",
        user: "U123",
        text: "@bek hello while Slack is flaky",
        ts: "1710000000.000030",
      },
    };

    const res = await app.request("/api/slack/events", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const json = (await res.json()) as { runId: string };

    expect(res.status).toBe(200);
    expect(slackClient.postMessageCalls).toHaveLength(1);
    await expect(
      expectJson(app, `/api/runs/${json.runId}`),
    ).resolves.toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining(
            "Slack final_answer message failed: invalid_auth.",
          ),
          data: expect.objectContaining({
            slackOutbound: expect.objectContaining({
              ok: false,
              error: "invalid_auth",
              channel: "C_CHECKOUT",
              failureCategory: "auth",
              retryable: false,
            }),
          }),
        }),
      ]),
    });
  });

  it("reschedules Slack outbox deliveries after rate limits", async () => {
    process.env.BEK_SLACK_BACKGROUND_DRAIN = "false";
    mapSlackTestUser();
    const store = new BekStore();
    const slackClient = new RateLimitedSlackWebApiClient();
    const app = createApp(store, { slackClient });
    const payload = {
      event_id: "EvOutboundRateLimitReschedule",
      event: {
        type: "app_mention",
        channel: "C_CHECKOUT",
        user: "U123",
        text: "@bek hello while Slack is rate limited",
        ts: "1710000000.000031",
      },
    };

    const accepted = await app.request("/api/slack/events", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    expect(accepted.status).toBe(200);
    expect(slackClient.postMessageCalls).toHaveLength(0);

    const beforeDrain = Date.now();
    const drain = await app.request("/api/outbound/slack/drain", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });
    expect(drain.status).toBe(200);
    expect(slackClient.postMessageCalls).toHaveLength(1);
    const delivery = store.read().outboundDeliveries[0];
    expect(delivery).toMatchObject({
      provider: "slack",
      status: "queued",
      attempts: 1,
      lastError: "ratelimited",
    });
    expect(Date.parse(delivery!.nextAttemptAt!)).toBeGreaterThanOrEqual(
      beforeDrain + 1_500,
    );
    await expect(drain.json()).resolves.toMatchObject({
      outbound: {
        deliveries: [
          expect.objectContaining({
            status: "queued",
            lastError: "ratelimited",
          }),
        ],
      },
    });
  });

  it("does not dedupe Slack event retries before persistence succeeds", async () => {
    mapSlackTestUser();
    let flushes = 0;
    const store = new BekStore(undefined, {
      onSnapshotChanged: async () => {
        flushes += 1;
        if (flushes === 1) {
          throw new Error("database unavailable");
        }
      },
    });
    const app = createApp(store);
    const payload = {
      event_id: "EvRetryAfterFlushFailure",
      event: {
        type: "app_mention",
        channel: "C_CHECKOUT",
        user: "U123",
        text: "@bek hello",
      },
    };
    const rawBody = JSON.stringify(payload);

    const first = await app.request("/api/slack/events", {
      method: "POST",
      body: rawBody,
      headers: signedSlackHeaders(rawBody),
    });
    expect(first.status).toBe(400);

    const second = await app.request("/api/slack/events", {
      method: "POST",
      body: rawBody,
      headers: signedSlackHeaders(rawBody),
    });

    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({
      ok: true,
      runId: expect.any(String),
    });
    expect(flushes).toBeGreaterThanOrEqual(2);
  });

  it("rejects Slack approval interactions without an approver mapping", async () => {
    const app = createApp();
    const { run, approval } = await createPrApproval(
      app,
      "@bek open an unmapped Slack PR",
    );
    const approvalAction = {
      action_id: "bek.approval.approve",
      value: JSON.stringify({
        approvalId: approval.id,
        payloadHash: approval.payloadHash,
        runId: run.id,
        action: approval.action,
      }),
    };

    const missingUserBody = slackForm({
      payload: JSON.stringify({
        type: "block_actions",
        channel: { id: "C_CHECKOUT" },
        team: { id: "T123" },
        actions: [approvalAction],
      }),
    });
    const missingUser = await app.request("/api/slack/interactivity", {
      method: "POST",
      body: missingUserBody,
      headers: signedSlackHeaders(
        missingUserBody,
        Math.floor(Date.now() / 1000).toString(),
        "application/x-www-form-urlencoded",
      ),
    });
    expect(missingUser.status).toBe(400);

    const unmappedUserBody = slackForm({
      payload: JSON.stringify({
        type: "block_actions",
        user: { id: "U_UNMAPPED" },
        channel: { id: "C_CHECKOUT" },
        team: { id: "T123" },
        actions: [approvalAction],
      }),
    });
    const unmappedUser = await app.request("/api/slack/interactivity", {
      method: "POST",
      body: unmappedUserBody,
      headers: signedSlackHeaders(
        unmappedUserBody,
        Math.floor(Date.now() / 1000).toString(),
        "application/x-www-form-urlencoded",
      ),
    });
    expect(unmappedUser.status).toBe(400);
  });

  it("rejects Slack approval actions whose run or channel context does not match", async () => {
    mapSlackTestUsers({ "T123:U_APPROVER": "principal_admin" });
    const app = createApp();
    const { run, approval } = await createPrApproval(
      app,
      "@bek open a context-bound Slack PR",
    );

    const wrongRunBody = slackForm({
      payload: JSON.stringify({
        type: "block_actions",
        user: { id: "U_APPROVER" },
        channel: { id: "C_CHECKOUT" },
        team: { id: "T123" },
        actions: [
          {
            action_id: "bek.approval.approve",
            action_ts: "1710000000.000101",
            value: JSON.stringify({
              approvalId: approval.id,
              payloadHash: approval.payloadHash,
              runId: "run_forged",
              action: approval.action,
            }),
          },
        ],
      }),
    });
    const wrongRun = await app.request("/api/slack/interactivity", {
      method: "POST",
      body: wrongRunBody,
      headers: signedSlackHeaders(
        wrongRunBody,
        Math.floor(Date.now() / 1000).toString(),
        "application/x-www-form-urlencoded",
      ),
    });
    expect(wrongRun.status).toBe(400);
    expect(wrongRun.headers.get("x-slack-no-retry")).toBe("1");
    await expect(wrongRun.json()).resolves.toMatchObject({
      ok: false,
      error: "Slack approval run does not match the pending approval.",
    });

    const wrongChannelBody = slackForm({
      payload: JSON.stringify({
        type: "block_actions",
        user: { id: "U_APPROVER" },
        channel: { id: "C_GENERAL" },
        team: { id: "T123" },
        actions: [
          {
            action_id: "bek.approval.approve",
            action_ts: "1710000000.000102",
            value: JSON.stringify({
              approvalId: approval.id,
              payloadHash: approval.payloadHash,
              runId: run.id,
              action: approval.action,
            }),
          },
        ],
      }),
    });
    const wrongChannel = await app.request("/api/slack/interactivity", {
      method: "POST",
      body: wrongChannelBody,
      headers: signedSlackHeaders(
        wrongChannelBody,
        Math.floor(Date.now() / 1000).toString(),
        "application/x-www-form-urlencoded",
      ),
    });
    expect(wrongChannel.status).toBe(400);
    expect(wrongChannel.headers.get("x-slack-no-retry")).toBe("1");
    await expect(wrongChannel.json()).resolves.toMatchObject({
      ok: false,
      error: "Slack approval channel does not match the run scope.",
    });

    const detail = (await (
      await app.request(`/api/runs/${run.id}`)
    ).json()) as { approvals: ApprovalSummary[] };
    expect(detail.approvals[0]).toMatchObject({
      id: approval.id,
      status: "pending",
    });
  });

  it("applies mapped Slack approval button decisions", async () => {
    process.env.BEK_SLACK_BACKGROUND_DRAIN = "false";
    mapSlackTestUsers({ "T123:U_APPROVER": "principal_admin" });
    const slackClient = new FakeSlackWebApiClient();
    const store = new BekStore();
    const app = createApp(store, { slackClient });
    const { run, approval } = await createPrApproval(
      app,
      "@bek open a Slack PR",
    );
    const payload = {
      type: "block_actions",
      user: { id: "U_APPROVER" },
      channel: { id: "C_CHECKOUT" },
      team: { id: "T123" },
      container: { message_ts: "1710000000.000040" },
      actions: [
        {
          action_id: "bek.approval.approve",
          action_ts: "1710000000.000100",
          value: JSON.stringify({
            approvalId: approval.id,
            payloadHash: approval.payloadHash,
            runId: run.id,
            action: approval.action,
          }),
        },
      ],
    };
    const rawBody = slackForm({ payload: JSON.stringify(payload) });

    const res = await app.request("/api/slack/interactivity", {
      method: "POST",
      body: rawBody,
      headers: signedSlackHeaders(
        rawBody,
        Math.floor(Date.now() / 1000).toString(),
        "application/x-www-form-urlencoded",
      ),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      approval: {
        id: approval.id,
        status: "approved",
        decidedByPrincipalId: "principal_admin",
      },
    });
    expect(slackClient.postMessageCalls).toHaveLength(0);

    const drain = await app.request("/api/outbound/slack/drain", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });
    expect(drain.status).toBe(200);
    expect(slackClient.postMessageCalls).toHaveLength(2);
    expect(slackClient.postMessageCalls[0]).toMatchObject({
      channel: "C_CHECKOUT",
      thread_ts: "1710000000.000040",
      text: `Bek approved the request for ${run.id}.`,
    });
    expect(slackClient.postMessageCalls[1]).toMatchObject({
      channel: "C_CHECKOUT",
      thread_ts: "1710000000.000040",
      text: expect.stringContaining("Bek finished."),
    });

    const retry = await app.request("/api/slack/interactivity", {
      method: "POST",
      body: rawBody,
      headers: signedSlackHeaders(
        rawBody,
        Math.floor(Date.now() / 1000).toString(),
        "application/x-www-form-urlencoded",
      ),
    });
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({
      ok: true,
      deduped: true,
    });
    expect(slackClient.postMessageCalls).toHaveLength(2);

    const stalePayload = {
      ...payload,
      actions: [
        {
          ...payload.actions[0],
          action_ts: "1710000000.000101",
        },
      ],
    };
    const staleBody = slackForm({ payload: JSON.stringify(stalePayload) });
    const stale = await app.request("/api/slack/interactivity", {
      method: "POST",
      body: staleBody,
      headers: signedSlackHeaders(
        staleBody,
        Math.floor(Date.now() / 1000).toString(),
        "application/x-www-form-urlencoded",
      ),
    });
    expect(stale.status).toBe(200);
    expect(stale.headers.get("x-slack-no-retry")).toBe("1");
    await expect(stale.json()).resolves.toMatchObject({
      ok: true,
      ignored: true,
      stale: true,
      text: "Bek already approved this request.",
      approval: {
        id: approval.id,
        status: "approved",
        decidedByPrincipalId: "principal_admin",
      },
    });
    expect(slackClient.postMessageCalls).toHaveLength(2);
    expect(store.read().ingressDeliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "slack.interaction",
          status: "ignored",
          approvalId: approval.id,
          response: expect.objectContaining({
            approvalId: approval.id,
            status: "approved",
            stale: true,
            requestedDecision: "approved",
          }),
        }),
      ]),
    );
  });

  it("applies Slack approval decisions through persisted principal identities", async () => {
    delete process.env.BEK_SLACK_USER_PRINCIPAL_MAP;
    const store = new BekStore();
    store.linkPrincipalExternalIdentity("principal_admin", {
      externalProvider: "slack",
      externalId: "T123:U_APPROVER",
    });
    const app = createApp(store);
    const { run, approval } = await createPrApproval(
      app,
      "@bek open a persisted-identity Slack PR",
    );
    const rawBody = slackForm({
      payload: JSON.stringify({
        type: "block_actions",
        user: { id: "U_APPROVER" },
        channel: { id: "C_CHECKOUT" },
        team: { id: "T123" },
        actions: [
          {
            action_id: "bek.approval.approve",
            action_ts: "1710000000.000120",
            value: JSON.stringify({
              approvalId: approval.id,
              payloadHash: approval.payloadHash,
              runId: run.id,
              action: approval.action,
            }),
          },
        ],
      }),
    });

    const res = await app.request("/api/slack/interactivity", {
      method: "POST",
      body: rawBody,
      headers: signedSlackHeaders(
        rawBody,
        Math.floor(Date.now() / 1000).toString(),
        "application/x-www-form-urlencoded",
      ),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      approval: {
        id: approval.id,
        status: "approved",
        decidedByPrincipalId: "principal_admin",
      },
    });
  });

  it("creates a confidential Slack DM place and run for mapped DM users", async () => {
    process.env.BEK_SLACK_BACKGROUND_DRAIN = "false";
    mapSlackTestUsers({ "T123:U123": "principal_bryson" });
    const store = new BekStore();
    installActiveSlackApp(store, { botUserId: "U_BEK" });
    const slackClient = new FakeSlackWebApiClient();
    const app = createApp(store, { slackClient });
    const payload = {
      team_id: "T123",
      event_id: "EvDmMessage",
      event: {
        type: "message",
        channel: "D123",
        user: "U123",
        text: "can you summarize my open work?",
        ts: "1710000000.000200",
        event_ts: "1710000000.000200",
        channel_type: "im",
      },
    };
    const rawBody = JSON.stringify(payload);
    const initialRunCount = store.read().runs.length;

    const res = await app.request("/api/slack/events", {
      method: "POST",
      body: rawBody,
      headers: signedSlackHeaders(rawBody),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      runId: string;
      placeId: string;
      channelId: string;
    };
    expect(json).toMatchObject({
      ok: true,
      runId: expect.any(String),
      placeId: expect.any(String),
      channelId: "D123",
    });
    const snapshot = store.read();
    const dm = snapshot.places.find(
      (place) => place.id === json.placeId && place.externalId === "D123",
    );
    expect(dm).toMatchObject({
      kind: "slack_dm",
      provider: "slack",
      name: "DM with U123",
      sensitivity: "confidential",
      metadata: expect.objectContaining({
        teamId: "T123",
        slackUserId: "U123",
        channelType: "im",
        source: "slack_dm_event",
        firstSeenAt: expect.any(String),
        lastSeenAt: expect.any(String),
      }),
    });
    expect(snapshot.runs).toHaveLength(initialRunCount + 1);
    expect(snapshot.runs.find((run) => run.id === json.runId)).toMatchObject({
      placeScopeId: dm?.id,
      requesterPrincipalId: "principal_bryson",
      trigger: "dm",
      status: "completed",
    });
    const dmBundles = snapshot.accessBundles.filter((bundle) =>
      bundle.attachedPlaceIds.includes(dm!.id),
    );
    expect(dmBundles.flatMap((bundle) => bundle.grants)).toEqual([
      expect.objectContaining({
        capability: "slack.read",
        resource: "slack:D123",
        decision: "allow",
        requiresApproval: false,
      }),
    ]);
    expect(
      dmBundles
        .flatMap((bundle) => bundle.grants)
        .some((grant) => grant.capability.startsWith("github.")),
    ).toBe(false);

    const retry = await app.request("/api/slack/events", {
      method: "POST",
      body: rawBody,
      headers: signedSlackHeaders(rawBody),
    });
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({
      deduped: true,
      runId: json.runId,
    });
    expect(
      store.read().places.filter((place) => place.externalId === "D123"),
    ).toHaveLength(1);
    expect(store.read().runs).toHaveLength(initialRunCount + 1);

    const drain = await app.request("/api/outbound/slack/drain", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });
    expect(drain.status).toBe(200);
    expect(slackClient.postMessageCalls).toHaveLength(1);
    expect(slackClient.postMessageCalls[0]).toMatchObject({
      channel: "D123",
      thread_ts: "1710000000.000200",
      text: expect.stringContaining("Bek finished."),
    });
  });

  it("ignores Slack DMs from unmapped users without creating places or runs", async () => {
    const store = new BekStore();
    installActiveSlackApp(store, { botUserId: "U_BEK" });
    const app = createApp(store);
    const initialRunCount = store.read().runs.length;
    const payload = {
      team_id: "T123",
      event_id: "EvDmUnmapped",
      event: {
        type: "message",
        channel: "D_UNMAPPED",
        user: "U_UNMAPPED",
        text: "hello",
        ts: "1710000000.000201",
        channel_type: "im",
      },
    };
    const rawBody = JSON.stringify(payload);

    const res = await app.request("/api/slack/events", {
      method: "POST",
      body: rawBody,
      headers: signedSlackHeaders(rawBody),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-slack-no-retry")).toBe("1");
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      ignored: true,
      reason: "Slack user U_UNMAPPED is not mapped to a Bek principal.",
    });
    expect(store.read().runs).toHaveLength(initialRunCount);
    expect(
      store.read().places.some((place) => place.externalId === "D_UNMAPPED"),
    ).toBe(false);
  });

  it("ignores Slack DMs from workspaces without an active install", async () => {
    mapSlackTestUsers({ "T123:U123": "principal_bryson" });
    const store = new BekStore();
    installActiveSlackApp(store, { teamId: "T999", botUserId: "U_BEK" });
    const app = createApp(store);
    const initialRunCount = store.read().runs.length;
    const payload = {
      team_id: "T123",
      event_id: "EvDmWrongWorkspace",
      event: {
        type: "message",
        channel: "D_WRONG_TEAM",
        user: "U123",
        text: "hello",
        ts: "1710000000.000202",
        channel_type: "im",
      },
    };
    const rawBody = JSON.stringify(payload);

    const res = await app.request("/api/slack/events", {
      method: "POST",
      body: rawBody,
      headers: signedSlackHeaders(rawBody),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-slack-no-retry")).toBe("1");
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      ignored: true,
      reason: "Bek does not have an active Slack install for this workspace.",
    });
    expect(store.read().runs).toHaveLength(initialRunCount);
    expect(
      store.read().places.some((place) => place.externalId === "D_WRONG_TEAM"),
    ).toBe(false);
  });

  it("returns a friendly stale response for expired Slack approval buttons", async () => {
    process.env.BEK_SLACK_BACKGROUND_DRAIN = "false";
    mapSlackTestUsers({ "T123:U_APPROVER": "principal_admin" });
    const store = new BekStore();
    const slackClient = new FakeSlackWebApiClient();
    const app = createApp(store, { slackClient });
    const { run, approval } = await createPrApproval(
      app,
      "@bek open an expired Slack PR",
    );
    store.upsertApprovalRequest({
      ...approval,
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
    const rawBody = slackForm({
      payload: JSON.stringify({
        type: "block_actions",
        user: { id: "U_APPROVER" },
        channel: { id: "C_CHECKOUT" },
        team: { id: "T123" },
        actions: [
          {
            action_id: "bek.approval.approve",
            action_ts: "1710000000.000130",
            value: JSON.stringify({
              approvalId: approval.id,
              payloadHash: approval.payloadHash,
              runId: run.id,
              action: approval.action,
            }),
          },
        ],
      }),
    });

    const res = await app.request("/api/slack/interactivity", {
      method: "POST",
      body: rawBody,
      headers: signedSlackHeaders(
        rawBody,
        Math.floor(Date.now() / 1000).toString(),
        "application/x-www-form-urlencoded",
      ),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-slack-no-retry")).toBe("1");
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      ignored: true,
      stale: true,
      text: "This Bek approval has expired.",
      approval: {
        id: approval.id,
        status: "expired",
      },
    });
    expect(
      store.read().approvals.find((candidate) => candidate.id === approval.id),
    ).toMatchObject({
      status: "expired",
      decidedAt: expect.any(String),
    });
    expect(slackClient.postMessageCalls).toHaveLength(0);
  });

  it("validates slash commands and dedupes Slack command retries", async () => {
    mapSlackTestUser();
    const app = createApp();

    const missingChannelBody = slackForm({
      command: "/bek",
      user_id: "U123",
      text: "hello",
      team_id: "T123",
    });
    const missingChannel = await app.request("/api/slack/commands", {
      method: "POST",
      body: missingChannelBody,
      headers: {
        ...signedSlackHeaders(
          missingChannelBody,
          Math.floor(Date.now() / 1000).toString(),
          "application/x-www-form-urlencoded",
        ),
        ...slackRetryHeaders("1", "http_error"),
      },
    });
    expect(missingChannel.status).toBe(400);
    expect(missingChannel.headers.get("x-slack-no-retry")).toBe("1");
    await expect(missingChannel.json()).resolves.toMatchObject({
      ok: false,
      error: "Slack command payload is missing channel_id.",
      slackRetry: {
        retryNum: 1,
        reason: "http_error",
      },
    });

    const unknownChannelBody = slackForm({
      command: "/bek",
      channel_id: "C_UNKNOWN",
      user_id: "U123",
      text: "hello",
      team_id: "T123",
    });
    const unknownChannel = await app.request("/api/slack/commands", {
      method: "POST",
      body: unknownChannelBody,
      headers: signedSlackHeaders(
        unknownChannelBody,
        Math.floor(Date.now() / 1000).toString(),
        "application/x-www-form-urlencoded",
      ),
    });
    expect(unknownChannel.status).toBe(200);
    await expect(unknownChannel.json()).resolves.toMatchObject({
      ok: false,
      ignored: true,
    });

    const retryBody = slackForm({
      command: "/bek",
      channel_id: "C_CHECKOUT",
      user_id: "U123",
      text: "summarize the rollout",
      team_id: "T123",
      trigger_id: "1337.42",
    });
    const retryHeaders = signedSlackHeaders(
      retryBody,
      Math.floor(Date.now() / 1000).toString(),
      "application/x-www-form-urlencoded",
    );
    const first = await app.request("/api/slack/commands", {
      method: "POST",
      body: retryBody,
      headers: retryHeaders,
    });
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as { runId: string };

    const second = await app.request("/api/slack/commands", {
      method: "POST",
      body: retryBody,
      headers: retryHeaders,
    });
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({
      runId: firstJson.runId,
      deduped: true,
    });
  });

  it("ignores configured Slack slash commands from unmapped users without creating runs", async () => {
    const store = new BekStore();
    const app = createApp(store);
    const initialRunCount = store.read().runs.length;
    const rawBody = slackForm({
      command: "/bek",
      channel_id: "C_CHECKOUT",
      user_id: "U_UNMAPPED",
      text: "summarize the rollout",
      team_id: "T123",
    });

    const res = await app.request("/api/slack/commands", {
      method: "POST",
      body: rawBody,
      headers: signedSlackHeaders(
        rawBody,
        Math.floor(Date.now() / 1000).toString(),
        "application/x-www-form-urlencoded",
      ),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      ignored: true,
      reason: "Slack user U_UNMAPPED is not mapped to a Bek principal.",
    });
    expect(store.read().runs).toHaveLength(initialRunCount);
  });

  it("maps Slack slash command users with team-scoped principal keys", async () => {
    mapSlackTestUsers({ "T123:U123": "principal_bryson" });
    const store = new BekStore();
    const app = createApp(store);
    const rawBody = slackForm({
      command: "/bek",
      channel_id: "C_CHECKOUT",
      user_id: "U123",
      text: "summarize the scoped rollout",
      team_id: "T123",
    });

    const res = await app.request("/api/slack/commands", {
      method: "POST",
      body: rawBody,
      headers: signedSlackHeaders(
        rawBody,
        Math.floor(Date.now() / 1000).toString(),
        "application/x-www-form-urlencoded",
      ),
    });
    const json = (await res.json()) as { runId: string };

    expect(res.status).toBe(200);
    expect(
      store.read().runs.find((candidate) => candidate.id === json.runId),
    ).toMatchObject({
      requesterPrincipalId: "principal_bryson",
      trigger: "slash_command",
    });
  });

  it("maps Slack slash command users through persisted principal external identities", async () => {
    delete process.env.BEK_SLACK_USER_PRINCIPAL_MAP;
    const store = new BekStore();
    store.linkPrincipalExternalIdentity("principal_bryson", {
      externalProvider: "slack",
      externalId: "T123:U123",
    });
    const app = createApp(store);
    const rawBody = slackForm({
      command: "/bek",
      channel_id: "C_CHECKOUT",
      user_id: "U123",
      text: "summarize the persisted identity rollout",
      team_id: "T123",
    });

    const res = await app.request("/api/slack/commands", {
      method: "POST",
      body: rawBody,
      headers: signedSlackHeaders(
        rawBody,
        Math.floor(Date.now() / 1000).toString(),
        "application/x-www-form-urlencoded",
      ),
    });
    const json = (await res.json()) as { runId: string };

    expect(res.status).toBe(200);
    expect(
      store.read().runs.find((candidate) => candidate.id === json.runId),
    ).toMatchObject({
      requesterPrincipalId: "principal_bryson",
      trigger: "slash_command",
    });
  });

  it("dedupes Slack slash commands across API app instances", async () => {
    mapSlackTestUser();
    const store = new BekStore();
    const retryBody = slackForm({
      command: "/bek",
      channel_id: "C_CHECKOUT",
      user_id: "U123",
      text: "summarize the restart",
      team_id: "T123",
      trigger_id: "restart.42",
    });

    const first = await createApp(store).request("/api/slack/commands", {
      method: "POST",
      body: retryBody,
      headers: signedSlackHeaders(
        retryBody,
        Math.floor(Date.now() / 1000).toString(),
        "application/x-www-form-urlencoded",
      ),
    });
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as { runId: string };

    const second = await createApp(store).request("/api/slack/commands", {
      method: "POST",
      body: retryBody,
      headers: signedSlackHeaders(
        retryBody,
        Math.floor(Date.now() / 1000).toString(),
        "application/x-www-form-urlencoded",
      ),
    });
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({
      runId: firstJson.runId,
      deduped: true,
    });
  });

  it("creates a local run for configured Slack slash commands", async () => {
    mapSlackTestUser();
    const slackClient = new FakeSlackWebApiClient();
    const app = createApp(new BekStore(), { slackClient });
    const rawBody = slackForm({
      command: "/bek",
      channel_id: "C_CHECKOUT",
      user_id: "U123",
      text: "summarize the rollout",
      team_id: "T123",
    });

    const res = await app.request("/api/slack/commands", {
      method: "POST",
      body: rawBody,
      headers: signedSlackHeaders(
        rawBody,
        Math.floor(Date.now() / 1000).toString(),
        "application/x-www-form-urlencoded",
      ),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { runId: string };
    expect(json.runId).toBeTruthy();

    const detail = await app.request(`/api/runs/${json.runId}`);
    await expect(detail.json()).resolves.toMatchObject({
      run: {
        id: json.runId,
        trigger: "slash_command",
        prompt: "summarize the rollout",
      },
    });
    expect(slackClient.postMessageCalls).toHaveLength(1);
    expect(slackClient.postMessageCalls[0]).toMatchObject({
      channel: "C_CHECKOUT",
      text: expect.stringContaining("Bek finished."),
    });
  });

  it("ignores Slack bot self messages", async () => {
    const app = createApp();
    const payload = {
      event_id: "EvBot",
      event: {
        type: "app_mention",
        subtype: "bot_message",
        bot_id: "B123",
        channel: "C_CHECKOUT",
        text: "@bek loop",
      },
    };

    const res = await app.request("/api/slack/events", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    await expect(res.json()).resolves.toMatchObject({ ignored: true });
  });
});
