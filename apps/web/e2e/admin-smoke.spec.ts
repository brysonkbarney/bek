import { expect, test, type Page } from "@playwright/test";
import type {
  Bootstrap,
  ModelUsage,
  RunDetail,
  SetupStatus,
  SlackOutboxResponse,
  WorkerQueueResponse,
} from "../src/api";

const now = "2026-06-24T18:00:00.000Z";
const demoPrompt =
  "@bek inspect checkout retries and open a PR if you find the fix";

const bootstrapFixture = {
  org: { name: "Acme", plan: "oss" },
  principals: [
    {
      id: "principal_bryson",
      kind: "human",
      displayName: "Bryson",
      email: "bryson@example.test",
      externalProvider: "slack",
      externalId: "T123:U123",
      metadata: { teamId: "T123", slackUserId: "U123" },
    },
  ],
  agent: {
    name: "Bek",
    handle: "@bek",
    description: "Open teammate",
    status: "active",
    defaultModelPolicyId: "model_policy_demo",
    defaultRuntimeProfileId: "runtime_local",
  },
  capabilityProfiles: [
    {
      id: "cap_github_pr",
      name: "GitHub PRs",
      capabilityKind: "github.pr",
      enabled: true,
    },
  ],
  places: [
    {
      id: "place_checkout",
      name: "#checkout-eng",
      kind: "slack_channel",
      provider: "slack",
      externalId: "C123",
      sensitivity: "internal",
      metadata: { teamId: "T123" },
    },
  ],
  accessBundles: [
    {
      id: "bundle_checkout",
      name: "Checkout Engineering",
      description: "Draft PRs for checkout after human review.",
      attachedPlaceIds: ["place_checkout"],
      budgetPolicyId: "budget_demo",
      grants: [
        {
          id: "grant_checkout_pr",
          capability: "github.pr",
          resource: "github:redohq/checkout",
          decision: "ask",
          risk: "write_external",
          requiresApproval: true,
        },
      ],
    },
  ],
  modelPolicies: [
    {
      id: "model_policy_demo",
      name: "Default Gateway Policy",
      defaultModel: "anthropic/claude-sonnet-4-5",
      fallbackModels: ["openai/gpt-5-1"],
      perRunBudgetCents: 250,
    },
  ],
  runtimeProfiles: [
    {
      id: "runtime_local",
      name: "Local worker",
      runtimeKind: "local",
      adapter: "node",
    },
  ],
  budgetPolicies: [
    {
      id: "budget_demo",
      name: "Demo budget",
      perRunCents: 250,
      perDayCents: 2500,
    },
  ],
  connectorInstalls: [
    {
      id: "connector_slack_T123",
      kind: "slack",
      provider: "slack",
      externalId: "T123",
      displayName: "Redo",
      status: "active",
      createdAt: now,
      updatedAt: now,
    },
  ],
  credentials: [
    {
      id: "credential_slack_bot_T123",
      connectorInstallId: "connector_slack_T123",
      name: "Slack bot token",
      provider: "slack",
      externalAccountId: "T123",
      secretRef: "[redacted:slack-bot-token]",
      status: "active",
      scopeSummary: "app_mentions:read, chat:write",
      createdAt: now,
      updatedAt: now,
    },
  ],
  runs: [
    {
      id: "run_123",
      placeScopeId: "place_checkout",
      runtimeProfileId: "runtime_local",
      modelPolicyId: "model_policy_demo",
      prompt: demoPrompt,
      status: "awaiting_approval",
      trigger: "slack_mention",
      requesterPrincipalId: "principal_bryson",
      estimatedCostCents: 42,
      actualCostCents: 0,
      createdAt: now,
      updatedAt: now,
    },
  ],
  events: [
    {
      id: "event_123",
      runId: "run_123",
      type: "run.created",
      message: "Run created from Slack mention.",
      createdAt: now,
    },
  ],
  approvals: [
    {
      id: "approval_123",
      runId: "run_123",
      action: "github.pr",
      status: "pending",
      risk: "write_external",
      payloadHash: "hash_checkout_1234567890abcdef",
      requestedByPrincipalId: "principal_bryson",
      createdAt: now,
      expiresAt: "2026-06-25T18:00:00.000Z",
    },
  ],
} satisfies Bootstrap;

const setupStatusFixture = {
  visibleHandle: "@bek",
  singleVisibleAgent: true,
  slackChannels: 1,
  slackInstalled: true,
  slackInstallStatus: "active",
  slackWorkspaceName: "Redo",
  slackWorkspaceId: "T123",
  slackBotUserId: "U_BEK",
  slackTokenStored: true,
  slackRequiredScopes: ["app_mentions:read", "chat:write"],
  slackGrantedScopes: ["app_mentions:read", "chat:write"],
  missingSlackScopes: [],
  accessBundles: 1,
  modelPolicies: 1,
  modelGatewayMode: "local",
  modelPricingReady: true,
  missingPricedModels: [],
  modelPricingError: null,
  runtimeProfiles: 1,
  githubGrantCount: 1,
  githubExecutionMode: "real",
  githubExecutionEnabled: true,
  githubExecutionReady: true,
  githubExecutionNetworkCalls: "github_on_approved_worker_run",
  githubExecutionErrors: [],
  githubRepoBindingsReady: true,
  missingGithubRepoBindings: [],
  pendingApprovals: 1,
  readyForLocalDemo: true,
  readyForWorkspace: true,
} satisfies SetupStatus;

const modelUsageFixture = {
  runs: 1,
  totalEstimatedCents: 42,
  totalActualCents: 0,
  modelCalls: 2,
  inputTokens: 1200,
  outputTokens: 450,
  totalTokens: 1650,
  source: "runs",
} satisfies ModelUsage;

const workerQueueFixture = {
  mode: "worker_local",
  enabled: true,
  queue: {
    records: [
      {
        id: "work_123",
        sequence: 1,
        idempotencyKey: "run_attempt:org_demo:run_123:1",
        item: {
          orgId: "org_demo",
          runId: "run_123",
          attempt: 1,
          reason: "new_run",
          traceId: "trace_run_123",
          enqueuedAt: now,
        },
        status: "queued",
        attemptState: "queued",
        availableAt: now,
        createdAt: now,
        updatedAt: now,
      },
    ],
    deadLetters: [],
    events: [
      {
        id: "worker_event_123",
        sequence: 1,
        type: "worker.queued",
        orgId: "org_demo",
        runId: "run_123",
        attempt: 1,
        traceId: "trace_run_123",
        message: "Queued run attempt.",
        createdAt: now,
      },
    ],
  },
} satisfies WorkerQueueResponse;

const slackOutboxFixture = {
  deliveries: [
    {
      id: "outbound_123",
      provider: "slack",
      kind: "slack.run_outcome",
      status: "queued",
      attempts: 0,
      maxAttempts: 3,
      runId: "run_123",
      createdAt: now,
      updatedAt: now,
    },
  ],
} satisfies SlackOutboxResponse;

const runDetailFixture = {
  run: bootstrapFixture.runs[0],
  events: bootstrapFixture.events,
  approvals: bootstrapFixture.approvals,
} satisfies RunDetail;

test("loads the admin overview and navigates representative routes", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await installMockAdminApi(page);
  const nav = page.getByRole("navigation", { name: "Bek admin navigation" });

  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      name: "@bek is one teammate with governed capabilities.",
    }),
  ).toBeVisible();
  await expect(page.getByText("Visible Handle")).toBeVisible();
  await expect(page.getByText("Usage / Cost")).toBeVisible();

  await nav.getByRole("link", { name: "Setup", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Bring @bek online one real operation at a time.",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Operations checklist" }),
  ).toBeVisible();

  await nav.getByRole("link", { name: "Channels", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Decide what @bek can do in each place.",
    }),
  ).toBeVisible();
  await expect(page.getByText("#checkout-eng")).toBeVisible();

  await nav.getByRole("link", { name: "Access", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Bundle tools, repos, models, and approvals by place.",
    }),
  ).toBeVisible();
  await expect(page.getByText("Checkout Engineering")).toBeVisible();

  await nav.getByRole("link", { name: "Runs", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Every Bek action becomes an auditable run.",
    }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Open run run_123" }).click();
  await expect(page.getByRole("heading", { name: demoPrompt })).toBeVisible();

  await nav.getByRole("link", { name: "Worker", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Queue, leases, retries, and dead letters.",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Slack Outbox" }),
  ).toBeVisible();

  await nav.getByRole("link", { name: "Approvals", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Risky Bek actions wait for approval.",
    }),
  ).toBeVisible();
  await expect(page.getByText("github.pr")).toBeVisible();

  await nav.getByRole("link", { name: "Connectors", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Slack, repos, MCP tools, sandboxes, and model providers plug into one agent.",
    }),
  ).toBeVisible();
  await expect(page.getByText("Redo", { exact: true })).toBeVisible();

  await nav.getByRole("link", { name: "Models", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Model choice is policy, not lock-in.",
    }),
  ).toBeVisible();
  await expect(page.getByText("Default Gateway Policy")).toBeVisible();

  await nav.getByRole("link", { name: "Memory", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Team memory must be scoped, reviewable, and removable.",
    }),
  ).toBeVisible();

  await nav.getByRole("link", { name: "Audit", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Every policy decision and action should leave a trail.",
    }),
  ).toBeVisible();

  await nav.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Configure one handle. Route everything else behind it.",
    }),
  ).toBeVisible();
  await expect(page.getByLabel("Visible handle")).toHaveValue("@bek");
  expect(pageErrors).toEqual([]);
});

test("prompts for an admin token when the API requires authorization", async ({
  page,
}) => {
  const api = await installMockAdminApi(page, {
    adminToken: "secret-admin-token",
  });

  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Admin API Locked" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Unlock Admin API" }),
  ).toBeDisabled();

  await page.getByLabel("Admin token").fill(" secret-admin-token ");
  await page.getByLabel("Remember on this browser").check();
  await page.getByRole("button", { name: "Unlock Admin API" }).click();

  await expect(
    page.getByRole("heading", {
      name: "@bek is one teammate with governed capabilities.",
    }),
  ).toBeVisible();
  expect(
    api.requests.some(
      (request) =>
        request.path === "/api/bootstrap" &&
        request.authorization === "Bearer secret-admin-token",
    ),
  ).toBe(true);
  await expect
    .poll(() =>
      page.evaluate(() => window.localStorage.getItem("bek.adminApiToken")),
    )
    .toBe("secret-admin-token");
});

type ApiRequestRecord = {
  path: string;
  authorization: string | undefined;
};

async function installMockAdminApi(
  page: Page,
  options: { adminToken?: string } = {},
): Promise<{ requests: ApiRequestRecord[] }> {
  const requests: ApiRequestRecord[] = [];

  await page.route("**/bek-config.js", async (route) => {
    await route.fulfill({
      contentType: "application/javascript",
      body: 'window.__BEK_CONFIG__ = {"apiUrl":""};\n',
    });
  });

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = `${url.pathname}${url.search}`;
    const authorization = request.headers().authorization;
    requests.push({ path, authorization });

    if (
      options.adminToken &&
      authorization !== `Bearer ${options.adminToken}`
    ) {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "Admin API authorization required." }),
      });
      return;
    }

    const body = responseFor(path);
    if (!body) {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: `Unhandled smoke fixture: ${path}` }),
      });
      return;
    }

    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });

  return { requests };
}

function responseFor(path: string): unknown {
  if (path === "/api/bootstrap") return bootstrapFixture;
  if (path === "/api/setup/status") return setupStatusFixture;
  if (path === "/api/model-usage") return modelUsageFixture;
  if (path === "/api/runs/run_123") return runDetailFixture;
  if (path === "/api/worker/queue") return workerQueueFixture;
  if (path === "/api/outbound/slack") return slackOutboxFixture;
  return undefined;
}
