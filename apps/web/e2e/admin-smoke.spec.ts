import { expect, test, type Page } from "@playwright/test";
import type {
  AuditLogEntry,
  Bootstrap,
  GitHubSetupPreview,
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
      runtimeKind: "ai_sdk",
      adapter: "ai-sdk-local-stub",
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
  runtimeExecutableProfiles: 1,
  runtimeExecutionReady: true,
  runtimeExecutionErrors: [],
  sandboxedRuntimeProfiles: 1,
  sandboxProviderMode: "docker-local",
  sandboxProviderEnabled: true,
  sandboxProviderReady: true,
  sandboxProviderNetworkCalls: "docker_on_worker_run",
  sandboxProviderErrors: [],
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

const githubSetupFixture = {
  ok: true,
  appConfig: {
    ok: true,
    appId: "12345",
    privateKeyConfigured: true,
    webhookSecretConfigured: true,
    legacyWebhookSecretConfigured: false,
    clientIdConfigured: false,
    clientSecretConfigured: false,
    errors: [],
    warnings: [],
  },
  installation: {
    configured: true,
    source: "env",
    installationId: "456",
    errors: [],
  },
  githubGrantCount: 1,
  validRepoGrantCount: 1,
  invalidGrantCount: 0,
  repositories: [
    {
      repository: {
        provider: "github",
        owner: "redohq",
        repo: "checkout",
        fullName: "redohq/checkout",
        resource: "github:redohq/checkout",
        url: "https://github.com/redohq/checkout",
        repositoryId: 112233,
      },
      grants: [
        {
          bundleId: "bundle_checkout",
          bundleName: "Checkout Engineering",
          grantId: "grant_checkout_pr",
          capability: "github.pr",
          resource: "github:redohq/checkout",
          decision: "ask",
          risk: "write_external",
          requiresApproval: true,
        },
      ],
      requiredPermissions: {
        contents: "write",
        metadata: "read",
        pull_requests: "write",
      },
      installationTokenRequestPreview: {
        installationId: "456",
        repository: {
          provider: "github",
          owner: "redohq",
          repo: "checkout",
          fullName: "redohq/checkout",
          resource: "github:redohq/checkout",
          url: "https://github.com/redohq/checkout",
          repositoryId: 112233,
        },
        repositoryIds: [112233],
        permissions: {
          contents: "write",
          metadata: "read",
          pull_requests: "write",
        },
      },
      draftPullRequestWorkflowPreview: {
        type: "github.draft_pull_request_workflow_plan",
        visibleAgentHandle: "@bek",
        resource: "github:redohq/checkout",
        steps: [
          "mint_installation_token",
          "create_branch",
          "commit_changes",
          "open_draft_pull_request",
        ],
        tokenRequestPermissions: {
          contents: "write",
          metadata: "read",
          pull_requests: "write",
        },
        pullRequestProposal: {
          type: "github.pull_request_proposal",
          capability: "github.pr",
          resource: "github:redohq/checkout",
          draft: true,
          baseBranch: "main",
          headBranch: "bek/setup-preview",
          approval: {
            action: "github.pr",
            risk: "write_external",
            required: true,
          },
        },
        approvalHashInput: {
          type: "github.pull_request_write_approval",
          version: 1,
          action: "github.pr",
          resource: "github:redohq/checkout",
          repository: {
            provider: "github",
            owner: "redohq",
            repo: "checkout",
            fullName: "redohq/checkout",
            resource: "github:redohq/checkout",
            url: "https://github.com/redohq/checkout",
            repositoryId: 112233,
          },
          installationId: "456",
        },
      },
    },
  ],
  invalidGrants: [],
  errors: [],
  networkCalls: "none",
} satisfies GitHubSetupPreview;

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

const auditEventsFixture = [
  {
    id: "audit_access_grant",
    orgId: "org_demo",
    actorPrincipalId: "principal_admin",
    action: "access_grant.updated",
    resourceType: "access_grant",
    resourceId: "grant_checkout_pr",
    decision: "ask",
    risk: "write_external",
    message: "Access grant updated.",
    createdAt: now,
  },
  ...bootstrapFixture.events,
] satisfies AuditLogEntry[];

test("loads the admin overview and navigates representative routes", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const api = await installMockAdminApi(page);
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
  await page.getByRole("link", { name: "Details" }).click();
  await expect(page.locator("h1")).toHaveText("Checkout Engineering");
  await expect(page.getByLabel("Bundle name")).toHaveValue(
    "Checkout Engineering",
  );
  await expect(
    page.locator(".grant-editor").getByLabel("Resource"),
  ).toHaveValue("github:redohq/checkout");
  await expect(page.getByRole("button", { name: "Save Bundle" })).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Delete github.pr grant for github:redohq/checkout",
    }),
  ).toBeVisible();

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
      name: "Slack, repos, MCP registries, sandboxes, and model providers are governed behind one agent.",
    }),
  ).toBeVisible();
  await expect(page.getByText("Redo", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "GitHub App setup" }),
  ).toBeVisible();
  await expect(
    page.getByText("redohq/checkout", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("contents: write")).toBeVisible();

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
  await expect(page.getByText("access grant.updated")).toBeVisible();
  await expect(page.getByText("Access grant updated.")).toBeVisible();
  await expect(
    page.getByText("access_grant · grant_checkout_pr · actor principal_admin"),
  ).toBeVisible();
  await page.getByLabel("Search").fill("grant");
  await expect
    .poll(() =>
      api.requests.some((request) =>
        request.path.includes("/api/audit-events?source=all&q=grant"),
      ),
    )
    .toBe(true);
  const csvDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "CSV" }).click();
  const csvDownload = await csvDownloadPromise;
  expect(csvDownload.suggestedFilename()).toBe("bek-audit-demo.csv");

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

    if (path.startsWith("/api/audit-events/export?")) {
      const isCsv = path.includes("format=csv");
      await route.fulfill({
        headers: {
          "content-disposition": `attachment; filename="bek-audit-demo.${isCsv ? "csv" : "ndjson"}"`,
          "access-control-expose-headers": "content-disposition",
        },
        contentType: isCsv ? "text/csv" : "application/x-ndjson",
        body: isCsv
          ? "id,action\naudit_access_grant,access_grant.updated"
          : '{"recordType":"audit_export","eventCount":1}\n{"recordType":"audit_event","action":"access_grant.updated"}',
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
  if (path === "/api/setup/github") return githubSetupFixture;
  if (path === "/api/model-usage") return modelUsageFixture;
  if (path === "/api/audit-events" || path.startsWith("/api/audit-events?")) {
    return auditEventsFixture;
  }
  if (path === "/api/runs/run_123") return runDetailFixture;
  if (path === "/api/worker/queue") return workerQueueFixture;
  if (path === "/api/outbound/slack") return slackOutboxFixture;
  return undefined;
}
