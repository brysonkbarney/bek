import { describe, expect, it } from "vitest";
import type { Bootstrap, GitHubSetupPreview, SetupStatus } from "../api";
import {
  connectorSummaries,
  githubConnectorSetupModel,
  setupChecklistFromStatus,
  setupOperationsFromStatus,
  setupProgress,
  setupReadyForWorkspace,
  workerQueueSummary,
} from "./product-model";

const readySetup: SetupStatus = {
  visibleHandle: "@bek",
  singleVisibleAgent: true,
  slackChannels: 1,
  slackInstalled: true,
  slackInstallStatus: "active",
  slackWorkspaceName: "Redo",
  slackWorkspaceId: "T123",
  slackBotUserId: "U_BEK",
  slackTokenStored: true,
  accessBundles: 1,
  modelPolicies: 1,
  modelGatewayMode: "local",
  modelPricingReady: true,
  missingPricedModels: [],
  modelPricingError: null,
  modelPricingBasis: "configured_benchmark",
  modelPricingSource: "bek_default",
  modelPricingNotice:
    "Model costs are Bek estimates from configured benchmark pricing, not live provider catalog data or invoice evidence.",
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
  pendingApprovals: 0,
  readyForLocalDemo: true,
  readyForWorkspace: true,
};

const readyGitHubPreview: GitHubSetupPreview = {
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
      },
      grants: [
        {
          bundleId: "bundle_repo",
          bundleName: "Repo access",
          grantId: "grant_repo",
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
        },
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
          },
          installationId: "456",
        },
      },
    },
  ],
  invalidGrants: [],
  errors: [],
  networkCalls: "none",
};

const emptyBootstrap: Bootstrap = {
  org: { name: "Acme", plan: "oss" },
  principals: [],
  agent: {
    name: "Bek",
    handle: "@bek",
    description: "Open teammate",
    status: "active",
  },
  capabilityProfiles: [],
  places: [],
  accessBundles: [],
  modelPolicies: [],
  runtimeProfiles: [],
  budgetPolicies: [],
  connectorInstalls: [],
  credentials: [],
  runs: [],
  events: [],
  approvals: [],
};

describe("admin product helpers", () => {
  it("turns setup status into actionable checklist progress", () => {
    const checklist = setupChecklistFromStatus(readySetup);
    const operations = setupOperationsFromStatus(readySetup, {
      adminAuthDetail: "Using a browser-entered admin token.",
      adminAuthenticated: true,
    });

    expect(setupProgress(readySetup)).toEqual({
      complete: checklist.length,
      total: checklist.length,
    });
    expect(setupReadyForWorkspace(readySetup)).toBe(true);
    expect(checklist[0]).toMatchObject({
      label: "Expose @bek as the only visible Slack teammate",
      complete: true,
      route: "/settings",
    });
    expect(checklist.find((step) => step.id === "model-policy")).toEqual(
      expect.objectContaining({
        complete: true,
        detail: expect.stringContaining("not live provider catalog data"),
      }),
    );
    expect(operations.find((step) => step.id === "admin-auth")).toMatchObject({
      complete: true,
      detail: "Using a browser-entered admin token.",
      primaryAction: { route: "/settings" },
    });
    expect(operations.find((step) => step.id === "model-runtime")).toEqual(
      expect.objectContaining({
        complete: true,
        facts: expect.arrayContaining([
          "Pricing estimates: configured benchmark",
        ]),
      }),
    );
    expect(operations.find((step) => step.id === "github-policy")).toEqual(
      expect.objectContaining({
        complete: true,
        status: "ready",
        facts: expect.arrayContaining([
          "1 GitHub grant",
          "Execution: ready (real)",
        ]),
      }),
    );
  });

  it("keeps setup operations tied to real incomplete API facts", () => {
    const operations = setupOperationsFromStatus(
      {
        ...readySetup,
        readyForLocalDemo: false,
        slackInstalled: false,
        slackInstallStatus: null,
        slackTokenStored: false,
        slackChannels: 0,
        accessBundles: 0,
        modelPolicies: 0,
        modelPricingReady: false,
        missingPricedModels: [],
        runtimeProfiles: 0,
        runtimeExecutableProfiles: 0,
        runtimeExecutionReady: false,
        runtimeExecutionErrors: [],
        sandboxedRuntimeProfiles: 0,
        sandboxProviderMode: "none",
        sandboxProviderEnabled: false,
        sandboxProviderReady: false,
        sandboxProviderNetworkCalls: "none",
        sandboxProviderErrors: [],
        githubGrantCount: 0,
      },
      {
        adminAuthDetail: "Admin API accepted this session.",
        adminAuthenticated: true,
      },
    );

    expect(operations.find((step) => step.id === "local-demo")).toMatchObject({
      complete: false,
      primaryAction: { label: "Open runs", route: "/runs" },
    });
    expect(
      operations.find((step) => step.id === "slack-install"),
    ).toMatchObject({
      complete: false,
      status: "needs action",
      primaryAction: { label: "Connect Slack", route: "/connectors" },
    });
    expect(operations.find((step) => step.id === "github-policy")).toEqual(
      expect.objectContaining({
        complete: false,
        status: "needs action",
        primaryAction: { label: "Add repo grant", route: "/access-bundles" },
      }),
    );
  });

  it("does not mark GitHub repo grants as executable when App execution is disabled", () => {
    const operations = setupOperationsFromStatus(
      {
        ...readySetup,
        githubExecutionMode: "disabled",
        githubExecutionEnabled: false,
        githubExecutionReady: false,
        githubExecutionNetworkCalls: "none",
        githubExecutionErrors: [],
        readyForWorkspace: false,
      },
      {
        adminAuthDetail: "Using a browser-entered admin token.",
        adminAuthenticated: true,
      },
    );

    expect(operations.find((step) => step.id === "github-policy")).toEqual(
      expect.objectContaining({
        complete: false,
        status: "policy configured",
        detail:
          "Repo grants are attached; real GitHub execution is disabled until App credentials are configured.",
        facts: expect.arrayContaining([
          "1 GitHub grant",
          "Execution: disabled (disabled)",
        ]),
        primaryAction: { label: "Open GitHub setup", route: "/connectors" },
      }),
    );
  });

  it("keeps real GitHub execution incomplete when repo installation bindings are missing", () => {
    const operations = setupOperationsFromStatus(
      {
        ...readySetup,
        githubRepoBindingsReady: false,
        missingGithubRepoBindings: ["github:redohq/checkout"],
        readyForWorkspace: false,
      },
      {
        adminAuthDetail: "Using a browser-entered admin token.",
        adminAuthenticated: true,
      },
    );

    expect(operations.find((step) => step.id === "github-policy")).toEqual(
      expect.objectContaining({
        complete: false,
        status: "policy configured",
        detail:
          "Repo grants are attached, but real GitHub execution is missing installation bindings for github:redohq/checkout.",
        facts: expect.arrayContaining(["Repo bindings: missing 1"]),
      }),
    );
  });

  it("surfaces GitHub setup preview facts for the connector panel", () => {
    const setup = githubConnectorSetupModel(readySetup, readyGitHubPreview);

    expect(setup).toMatchObject({
      status: "ready",
      execution: {
        mode: "real",
        state: "ready",
        networkCalls: "github_on_approved_worker_run",
      },
      appConfig: {
        status: "ready",
        appId: "12345",
        errors: [],
      },
      installation: {
        status: "configured",
        source: "env",
        installationId: "456",
      },
      grants: {
        total: 1,
        valid: 1,
        invalid: 0,
      },
      repoBindings: {
        status: "ready",
        missing: [],
      },
    });
    expect(setup.repositories).toEqual([
      expect.objectContaining({
        resource: "github:redohq/checkout",
        requiredPermissions: [
          "contents: write",
          "metadata: read",
          "pull_requests: write",
        ],
        installationTokenInstallationId: "456",
        workflowSteps: expect.arrayContaining(["open_draft_pull_request"]),
      }),
    ]);
  });

  it("keeps GitHub connector setup issues visible without backend changes", () => {
    const brokenPreview: GitHubSetupPreview = {
      ...readyGitHubPreview,
      ok: false,
      appConfig: {
        ...readyGitHubPreview.appConfig,
        ok: false,
        errors: ["GITHUB_APP_PRIVATE_KEY must be a PEM private key."],
      },
      installation: {
        configured: false,
        source: null,
        installationId: null,
        errors: [
          "GITHUB_APP_INSTALLATION_ID or installationId query parameter is required for installation-token previews.",
        ],
      },
      githubGrantCount: 2,
      validRepoGrantCount: 1,
      invalidGrantCount: 1,
      invalidGrants: [
        {
          bundleId: "bundle_org",
          bundleName: "Org-wide GitHub",
          grantId: "grant_org",
          capability: "github.read",
          resource: "github:redohq/*",
          decision: "allow",
          risk: "read_internal",
          requiresApproval: false,
          errors: ["GitHub repo must be a valid repository name."],
        },
      ],
      errors: [
        "GITHUB_APP_PRIVATE_KEY must be a PEM private key.",
        "GitHub repo must be a valid repository name.",
      ],
    };
    const setup = githubConnectorSetupModel(
      {
        ...readySetup,
        githubExecutionReady: false,
        githubExecutionErrors: [
          "GITHUB_APP_PRIVATE_KEY must be a PEM private key.",
        ],
        githubRepoBindingsReady: false,
        missingGithubRepoBindings: ["github:redohq/checkout"],
      },
      brokenPreview,
    );

    expect(setup.status).toBe("needs binding");
    expect(setup.appConfig.errors).toEqual([
      "GITHUB_APP_PRIVATE_KEY must be a PEM private key.",
    ]);
    expect(setup.installation).toMatchObject({
      status: "missing",
      source: "missing",
      installationId: "missing",
    });
    expect(setup.grants).toMatchObject({
      total: 2,
      valid: 1,
      invalid: 1,
    });
    expect(setup.repoBindings).toMatchObject({
      status: "missing",
      missing: ["github:redohq/checkout"],
    });
    expect(setup.invalidGrants).toEqual([
      expect.objectContaining({
        resource: "github:redohq/*",
        errors: ["GitHub repo must be a valid repository name."],
      }),
    ]);
  });

  it("does not treat opencode-sandbox profiles as executable without a sandbox provider", () => {
    const setupStatus: SetupStatus = {
      ...readySetup,
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
      readyForWorkspace: false,
    };
    const checklist = setupChecklistFromStatus(setupStatus);
    const operations = setupOperationsFromStatus(setupStatus, {
      adminAuthDetail: "Using a browser-entered admin token.",
      adminAuthenticated: true,
    });

    expect(checklist.find((step) => step.id === "runtime-profile")).toEqual(
      expect.objectContaining({
        complete: false,
        detail:
          "2 runtime profiles configured, but sandboxed execution needs BEK_SANDBOX_PROVIDER.",
      }),
    );
    expect(operations.find((step) => step.id === "model-runtime")).toEqual(
      expect.objectContaining({
        complete: false,
        status: "needs action",
        facts: expect.arrayContaining([
          "2 runtime profiles",
          "Execution: blocked (1/2 executable)",
          "Sandbox provider: disabled (none)",
        ]),
      }),
    );
    expect(setupReadyForWorkspace(setupStatus)).toBe(false);
  });

  it("explains Slack install states that are not ready yet", () => {
    const missingToken = setupChecklistFromStatus({
      ...readySetup,
      slackTokenStored: false,
    }).find((step) => step.id === "slack-install");
    const revoked = setupChecklistFromStatus({
      ...readySetup,
      slackInstallStatus: "revoked",
      slackTokenStored: false,
    }).find((step) => step.id === "slack-install");

    expect(missingToken).toMatchObject({
      complete: false,
      detail: expect.stringContaining("no Slack bot token is stored"),
    });
    expect(
      setupReadyForWorkspace({
        ...readySetup,
        slackTokenStored: false,
      }),
    ).toBe(false);
    expect(revoked).toMatchObject({
      complete: false,
      detail: "Redo install is revoked.",
    });
  });

  it("marks missing Slack installs as incomplete setup work", () => {
    const slackInstall = setupChecklistFromStatus({
      ...readySetup,
      slackInstalled: false,
      slackInstallStatus: null,
      slackWorkspaceName: null,
      slackWorkspaceId: null,
      slackBotUserId: null,
      slackTokenStored: false,
    }).find((step) => step.id === "slack-install");

    expect(slackInstall).toMatchObject({
      complete: false,
      route: "/connectors",
      detail:
        "Install Bek and store a Slack bot token before real workspace use.",
    });
  });

  it("keeps Slack setup incomplete when the stored token is missing required scopes", () => {
    const setupStatus = {
      ...readySetup,
      missingSlackScopes: ["channels:read", "groups:read"],
      readyForWorkspace: false,
    };
    const checklist = setupChecklistFromStatus(setupStatus);
    const operations = setupOperationsFromStatus(setupStatus, {
      adminAuthDetail: "Using a browser-entered admin token.",
      adminAuthenticated: true,
    });

    expect(checklist.find((step) => step.id === "slack-install")).toMatchObject(
      {
        complete: false,
        detail: expect.stringContaining("channels:read, groups:read"),
      },
    );
    expect(
      operations.find((operation) => operation.id === "slack-install"),
    ).toMatchObject({
      complete: false,
      facts: expect.arrayContaining([
        "Missing scopes: channels:read, groups:read",
      ]),
    });
    expect(setupReadyForWorkspace(setupStatus)).toBe(false);
  });

  it("keeps unconfigured connector cards actionable", () => {
    const connectors = connectorSummaries(emptyBootstrap);

    expect(
      connectors.find((connector) => connector.id === "slack"),
    ).toMatchObject({
      status: "not connected",
      route: "/connectors",
      metric: "0 scopes",
    });
    expect(
      connectors.find((connector) => connector.id === "model"),
    ).toMatchObject({
      status: "not configured",
      route: "/models",
    });
  });

  it("describes GitHub grants as policy until execution readiness is verified", () => {
    const connectors = connectorSummaries({
      ...emptyBootstrap,
      accessBundles: [
        {
          id: "bundle_repo",
          name: "Repo access",
          description: "GitHub repo policy",
          budgetPolicyId: "budget_default",
          grants: [
            {
              id: "grant_repo",
              capability: "github.pr",
              resource: "github:redohq/checkout",
              decision: "ask",
              risk: "writes_code",
              requiresApproval: true,
            },
          ],
          attachedPlaceIds: [],
        },
      ],
    });

    expect(
      connectors.find((connector) => connector.id === "github"),
    ).toMatchObject({
      status: "policy configured",
      detail:
        "Selected repo grants are attached; execution readiness is shown in setup.",
      metric: "1 grants",
      route: "/access-bundles",
    });
  });

  it("uses persisted Slack install state for connector cards", () => {
    const connectors = connectorSummaries({
      ...emptyBootstrap,
      connectorInstalls: [
        {
          id: "connector_slack_T123",
          kind: "slack",
          provider: "slack",
          externalId: "T123",
          displayName: "Redo",
          status: "active",
          createdAt: "2026-01-02T03:04:05.000Z",
          updatedAt: "2026-01-02T03:04:05.000Z",
        },
      ],
      credentials: [
        {
          id: "credential_slack_bot_T123",
          connectorInstallId: "connector_slack_T123",
          name: "Slack bot token",
          provider: "slack",
          externalAccountId: "T123",
          secretRef: "[redacted:secret-ref]",
          status: "active",
          scopeSummary: "chat:write",
          createdAt: "2026-01-02T03:04:05.000Z",
          updatedAt: "2026-01-02T03:04:05.000Z",
        },
      ],
      places: [
        {
          id: "place_checkout",
          name: "#checkout-eng",
          kind: "slack_channel",
          provider: "slack",
          externalId: "C_CHECKOUT",
          sensitivity: "internal",
        },
      ],
    });

    expect(
      connectors.find((connector) => connector.id === "slack"),
    ).toMatchObject({
      status: "connected",
      metric: "T123",
      detail: expect.stringContaining("Redo workspace"),
      route: "/channels",
    });
  });

  it("keeps non-active Slack installs visible for operator repair", () => {
    const connectors = connectorSummaries({
      ...emptyBootstrap,
      connectorInstalls: [
        {
          id: "connector_slack_T123",
          kind: "slack",
          provider: "slack",
          externalId: "T123",
          displayName: "Redo",
          status: "revoked",
          createdAt: "2026-01-02T03:04:05.000Z",
          updatedAt: "2026-01-02T03:04:05.000Z",
        },
      ],
      places: [
        {
          id: "place_checkout",
          name: "#checkout-eng",
          kind: "slack_channel",
          provider: "slack",
          externalId: "C_CHECKOUT",
          sensitivity: "internal",
        },
      ],
    });

    expect(
      connectors.find((connector) => connector.id === "slack"),
    ).toMatchObject({
      status: "revoked",
      detail: "Redo workspace install is revoked.",
      route: "/connectors",
      actionLabel: "Review install",
    });
  });

  it("shows active Slack installs without stored bot tokens as needs-token cards", () => {
    const connectors = connectorSummaries({
      ...emptyBootstrap,
      connectorInstalls: [
        {
          id: "connector_slack_T123",
          kind: "slack",
          provider: "slack",
          externalId: "T123",
          displayName: "Redo",
          status: "active",
          createdAt: "2026-01-02T03:04:05.000Z",
          updatedAt: "2026-01-02T03:04:05.000Z",
        },
      ],
    });

    expect(
      connectors.find((connector) => connector.id === "slack"),
    ).toMatchObject({
      status: "needs token",
      route: "/connectors",
      actionLabel: "Review install",
      detail: expect.stringContaining("no Slack bot token is stored"),
    });
  });

  it("summarizes worker queue states for operator cards", () => {
    expect(
      workerQueueSummary({
        records: [
          workerRecord("work_1", "queued", "queued"),
          workerRecord("work_2", "claimed", "claimed"),
          workerRecord("work_3", "failed", "retry_scheduled"),
          workerRecord("work_4", "completed", "completed"),
        ],
        deadLetters: [
          {
            id: "dead_1",
            sequence: 5,
            workId: "work_5",
            idempotencyKey: "run_attempt:org:run_dead:1",
            item: workerItem("run_dead"),
            reason: "failed",
            failedAt: "2026-06-24T18:00:00.000Z",
            result: { status: "failed" },
            retryPolicy: { maxAttempts: 3 },
          },
        ],
        events: [
          {
            id: "event_1",
            sequence: 6,
            type: "worker.completed",
            orgId: "org_demo",
            runId: "run_4",
            message: "done",
            createdAt: "2026-06-24T18:00:00.000Z",
          },
        ],
      }),
    ).toMatchObject({
      active: 2,
      retryScheduled: 1,
      completed: 1,
      deadLetters: 1,
      events: 1,
    });
  });
});

function workerItem(runId: string) {
  return {
    orgId: "org_demo",
    runId,
    attempt: 1,
    reason: "new_run",
    traceId: `trace_${runId}`,
    enqueuedAt: "2026-06-24T18:00:00.000Z",
  };
}

function workerRecord(id: string, status: string, attemptState: string) {
  return {
    id,
    sequence: Number(id.replace("work_", "")),
    idempotencyKey: `run_attempt:org_demo:run_${id}:1`,
    item: workerItem(`run_${id}`),
    status,
    attemptState,
    availableAt: "2026-06-24T18:00:00.000Z",
    createdAt: "2026-06-24T18:00:00.000Z",
    updatedAt: "2026-06-24T18:00:00.000Z",
  };
}
