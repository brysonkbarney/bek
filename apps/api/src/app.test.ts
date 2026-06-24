import {
  createSlackOAuthState,
  createSlackSignature,
  verifySlackOAuthState,
} from "@bek/slack";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app";

const managedEnvKeys = [
  "BEK_ADMIN_API_TOKEN",
  "BEK_SLACK_USER_PRINCIPAL_MAP",
  "SLACK_BOT_SCOPES",
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

afterEach(() => {
  for (const key of managedEnvKeys) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }
});

type ApprovalSummary = { id: string; payloadHash: string; status: string };

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

describe("Bek API", () => {
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
    }
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

  it("applies mapped Slack approval button decisions", async () => {
    process.env.BEK_SLACK_USER_PRINCIPAL_MAP = JSON.stringify({
      U_APPROVER: "principal_admin",
    });
    const app = createApp();
    const { approval } = await createPrApproval(app, "@bek open a Slack PR");
    const payload = {
      type: "block_actions",
      user: { id: "U_APPROVER" },
      channel: { id: "C_CHECKOUT" },
      team: { id: "T_DEMO" },
      actions: [
        {
          action_id: "bek.approval.approve",
          value: JSON.stringify({
            approvalId: approval.id,
            payloadHash: approval.payloadHash,
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
  });

  it("creates a local run for configured Slack slash commands", async () => {
    const app = createApp();
    const rawBody = slackForm({
      command: "/bek",
      channel_id: "C_CHECKOUT",
      user_id: "U123",
      text: "summarize the rollout",
      team_id: "T_DEMO",
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
