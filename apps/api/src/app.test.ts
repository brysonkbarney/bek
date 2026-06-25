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
  "BEK_REQUIRE_ADMIN_AUTH",
  "BEK_CREDENTIAL_KEY_ID",
  "BEK_CREDENTIAL_MASTER_KEY",
  "BEK_MAX_REQUEST_BODY_BYTES",
  "BEK_RATE_LIMIT_MAX_REQUESTS",
  "BEK_RATE_LIMIT_WINDOW_MS",
  "BEK_RUN_ADVANCEMENT",
  "BEK_SANDBOX_PROVIDER",
  "BEK_SLACK_BACKGROUND_DRAIN",
  "BEK_SLACK_OAUTH_EXCHANGE",
  "BEK_SLACK_USER_PRINCIPAL_MAP",
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

function mapSlackTestUser(
  slackUserId = "U123",
  principalId = "principal_bryson",
) {
  mapSlackTestUsers({ [slackUserId]: principalId });
}

function mapSlackTestUsers(map: Record<string, unknown>) {
  process.env.BEK_SLACK_USER_PRINCIPAL_MAP = JSON.stringify(map);
}

function clearGitHubEnv() {
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
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_INSTALLATION_ID = "999";
    process.env.GITHUB_APP_PRIVATE_KEY = testGitHubPrivateKey;
    process.env.GITHUB_APP_WEBHOOK_SECRET = "a-webhook-secret-with-length";
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
    const store = new BekStore();
    const bundle = store.createAccessBundle({
      name: "Org-wide GitHub",
      description: "Wildcard policy grant that is not repo-scoped.",
    });
    store.createGrant(bundle.id, {
      capability: "github.read",
      resource: "github:redohq/*",
      decision: "allow",
      risk: "read_internal",
      requiresApproval: false,
    });

    const res = await createApp(store).request("/api/setup/github");

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
    expect(duplicate.status).toBe(400);
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
    expect(duplicateExternalId.status).toBe(400);

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
          principalId: "principal_admin",
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
      expect.arrayContaining(["app_mentions:read", "commands", "chat:write"]),
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

  it("records Slack outbound failures without failing accepted events", async () => {
    mapSlackTestUser();
    const slackClient = new FakeSlackWebApiClient({ failWith: "ratelimited" });
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
            "Slack final_answer message failed: ratelimited.",
          ),
          data: expect.objectContaining({
            slackOutbound: expect.objectContaining({
              ok: false,
              error: "ratelimited",
              channel: "C_CHECKOUT",
            }),
          }),
        }),
      ]),
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
    const app = createApp(new BekStore(), { slackClient });
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
