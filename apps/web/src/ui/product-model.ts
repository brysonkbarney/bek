import {
  Activity,
  Bot,
  Boxes,
  Brain,
  ClipboardCheck,
  ClipboardList,
  Cpu,
  Database,
  GitBranch,
  KeyRound,
  LayoutDashboard,
  Route,
  Settings,
  ShieldCheck,
  Slack,
} from "lucide-react";
import type {
  AccessBundle,
  ApprovalRequest,
  Bootstrap,
  CapabilityGrant,
  GitHubSetupPreview,
  PlaceScope,
  Run,
  SetupStatus,
  WorkerSnapshot,
} from "../api";

type AdminRoute =
  | "/"
  | "/channels"
  | "/access-bundles"
  | "/connectors"
  | "/models"
  | "/runs"
  | "/settings";

export interface SetupAction {
  label: string;
  route: AdminRoute;
}

export interface SetupOperation {
  id: string;
  phase: string;
  title: string;
  detail: string;
  status: string;
  complete: boolean;
  facts: string[];
  primaryAction: SetupAction;
  secondaryAction?: SetupAction;
}

export const navigationItems = [
  { to: "/", label: "Overview", icon: LayoutDashboard },
  { to: "/setup", label: "Setup", icon: ClipboardCheck },
  { to: "/channels", label: "Channels", icon: Slack },
  { to: "/access-bundles", label: "Access", icon: ShieldCheck },
  { to: "/runs", label: "Runs", icon: ClipboardList },
  { to: "/worker", label: "Worker", icon: Cpu },
  { to: "/approvals", label: "Approvals", icon: KeyRound },
  { to: "/connectors", label: "Connectors", icon: Boxes },
  { to: "/models", label: "Models", icon: Route },
  { to: "/memory", label: "Memory", icon: Brain },
  { to: "/audit", label: "Audit", icon: Activity },
  { to: "/settings", label: "Settings", icon: Settings },
] as const;

export function formatMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function formatDateTime(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function bundlesForPlace(
  accessBundles: AccessBundle[],
  placeId: string,
): AccessBundle[] {
  return accessBundles.filter((bundle) =>
    bundle.attachedPlaceIds.includes(placeId),
  );
}

export function grantsForPlace(
  accessBundles: AccessBundle[],
  placeId: string,
): CapabilityGrant[] {
  return bundlesForPlace(accessBundles, placeId).flatMap(
    (bundle) => bundle.grants,
  );
}

export function grantsByDecision(
  grants: CapabilityGrant[],
): Record<CapabilityGrant["decision"], CapabilityGrant[]> {
  return {
    allow: grants.filter((grant) => grant.decision === "allow"),
    ask: grants.filter((grant) => grant.decision === "ask"),
    deny: grants.filter((grant) => grant.decision === "deny"),
  };
}

export function runsForPlace(runs: Run[], placeId: string): Run[] {
  return runs.filter((run) => run.placeScopeId === placeId);
}

export function pendingApprovals(
  approvals: ApprovalRequest[],
): ApprovalRequest[] {
  return approvals.filter((approval) => approval.status === "pending");
}

export function workerQueueSummary(queue: WorkerSnapshot) {
  const queued = queue.records.filter((record) => record.status === "queued");
  const claimed = queue.records.filter((record) => record.status === "claimed");
  const awaitingApproval = queue.records.filter(
    (record) => record.status === "awaiting_approval",
  );
  const retryScheduled = queue.records.filter(
    (record) => record.attemptState === "retry_scheduled",
  );
  const completed = queue.records.filter(
    (record) => record.status === "completed",
  );
  const cancelled = queue.records.filter(
    (record) => record.status === "cancelled",
  );

  return {
    active: queued.length + claimed.length + awaitingApproval.length,
    queued: queued.length,
    claimed: claimed.length,
    awaitingApproval: awaitingApproval.length,
    retryScheduled: retryScheduled.length,
    completed: completed.length,
    cancelled: cancelled.length,
    deadLetters: queue.deadLetters.length,
    events: queue.events.length,
  };
}

export function setupChecklistFromStatus(status: SetupStatus): Array<{
  id: string;
  label: string;
  detail: string;
  complete: boolean;
  route: AdminRoute;
}> {
  return [
    {
      id: "visible-handle",
      label: "Expose @bek as the only visible Slack teammate",
      detail: status.singleVisibleAgent
        ? `Locked to ${status.visibleHandle}`
        : `Current handle is ${status.visibleHandle || "missing"}`,
      complete: status.singleVisibleAgent && status.visibleHandle === "@bek",
      route: "/settings",
    },
    {
      id: "slack-install",
      label: "Connect the Slack workspace",
      detail: slackInstallSetupDetail(status),
      complete: Boolean(
        status.slackInstalled &&
        status.slackInstallStatus === "active" &&
        status.slackTokenStored &&
        !hasMissingSlackScopes(status),
      ),
      route: "/connectors",
    },
    {
      id: "slack-channels",
      label: "Choose at least one pilot Slack channel",
      detail: `${status.slackChannels} channel scope${
        status.slackChannels === 1 ? "" : "s"
      } configured`,
      complete: status.slackChannels > 0,
      route: "/channels",
    },
    {
      id: "access-bundles",
      label: "Attach an access bundle to govern what @bek can do",
      detail: `${status.accessBundles} access bundle${
        status.accessBundles === 1 ? "" : "s"
      } configured`,
      complete: status.accessBundles > 0,
      route: "/access-bundles",
    },
    {
      id: "model-policy",
      label: "Configure model routing and per-run budget",
      detail: modelPricingSetupDetail(status),
      complete: modelPricingReady(status),
      route: "/models",
    },
    {
      id: "runtime-profile",
      label: "Register executable runtime profiles",
      detail: runtimeSetupDetail(status),
      complete: runtimeExecutionReady(status),
      route: "/connectors",
    },
    {
      id: "github-grants",
      label: "Grant GitHub access only through policy",
      detail: `${status.githubGrantCount} GitHub grant${
        status.githubGrantCount === 1 ? "" : "s"
      } attached`,
      complete: status.githubGrantCount > 0,
      route: "/access-bundles",
    },
  ];
}

export function setupProgress(status: SetupStatus): {
  complete: number;
  total: number;
} {
  const steps = setupChecklistFromStatus(status);
  return {
    complete: steps.filter((step) => step.complete).length,
    total: steps.length,
  };
}

export function setupReadyForWorkspace(status: SetupStatus): boolean {
  const progress = setupProgress(status);
  return status.readyForWorkspace && progress.complete === progress.total;
}

export function setupOperationsFromStatus(
  status: SetupStatus,
  input: { adminAuthDetail: string; adminAuthenticated: boolean },
): SetupOperation[] {
  const slackReady = Boolean(
    status.slackInstalled &&
    status.slackInstallStatus === "active" &&
    status.slackTokenStored &&
    !hasMissingSlackScopes(status),
  );
  const channelReady = status.slackChannels > 0;
  const accessReady = status.accessBundles > 0;
  const modelReady = modelPricingReady(status);
  const runtimeReady = runtimeExecutionReady(status);
  const githubPolicyReady = status.githubGrantCount > 0;
  const githubExecutionReady = Boolean(
    status.githubExecutionEnabled && status.githubExecutionReady,
  );
  const githubBindingsReady = githubRepoBindingsReady(status);
  const githubReady =
    githubPolicyReady && githubExecutionReady && githubBindingsReady;
  const workspace = status.slackWorkspaceName ?? status.slackWorkspaceId;
  const operations: SetupOperation[] = [
    {
      id: "admin-auth",
      phase: "1",
      title: "Unlock the admin console",
      detail: input.adminAuthenticated
        ? input.adminAuthDetail
        : "Add an admin token before changing workspace setup.",
      status: input.adminAuthenticated ? "ready" : "needs action",
      complete: input.adminAuthenticated,
      facts: [
        "Bootstrap API reachable",
        `${status.pendingApprovals} pending approval${
          status.pendingApprovals === 1 ? "" : "s"
        }`,
      ],
      primaryAction: { label: "Open settings", route: "/settings" },
    },
    {
      id: "local-demo",
      phase: "2",
      title: "Confirm local demo readiness",
      detail: status.readyForLocalDemo
        ? "Seed data is ready for a local run-through."
        : "Seed the local demo before relying on the workspace flow.",
      status: status.readyForLocalDemo ? "ready" : "needs action",
      complete: status.readyForLocalDemo,
      facts: [
        `${status.slackChannels} channel scope${
          status.slackChannels === 1 ? "" : "s"
        }`,
        `${status.accessBundles} access bundle${
          status.accessBundles === 1 ? "" : "s"
        }`,
      ],
      primaryAction: { label: "Open runs", route: "/runs" },
      secondaryAction: { label: "Review channels", route: "/channels" },
    },
    {
      id: "slack-install",
      phase: "3",
      title: "Install Bek in Slack",
      detail: slackInstallSetupDetail(status),
      status: slackReady ? "ready" : "needs action",
      complete: slackReady,
      facts: [
        workspace ? `Workspace: ${workspace}` : "Workspace: not installed",
        `Install: ${status.slackInstallStatus ?? "missing"}`,
        `Token: ${status.slackTokenStored ? "stored" : "missing"}`,
        missingSlackScopesFact(status),
      ],
      primaryAction: {
        label: slackReady ? "Review Slack" : "Connect Slack",
        route: "/connectors",
      },
      secondaryAction: { label: "Manage channels", route: "/channels" },
    },
    {
      id: "place-access",
      phase: "4",
      title: "Scope channels and access",
      detail:
        channelReady && accessReady
          ? "@bek has a governed place to work from."
          : "Add at least one pilot channel and attach an access bundle.",
      status: channelReady && accessReady ? "ready" : "needs action",
      complete: channelReady && accessReady,
      facts: [
        `${status.slackChannels} Slack channel${
          status.slackChannels === 1 ? "" : "s"
        }`,
        `${status.accessBundles} access bundle${
          status.accessBundles === 1 ? "" : "s"
        }`,
      ],
      primaryAction: {
        label: channelReady ? "Review access" : "Add channel",
        route: channelReady ? "/access-bundles" : "/channels",
      },
      secondaryAction: {
        label: channelReady ? "Review channels" : "Open access",
        route: channelReady ? "/channels" : "/access-bundles",
      },
    },
    {
      id: "model-runtime",
      phase: "5",
      title: "Choose model and runtime policy",
      detail:
        modelReady && runtimeReady
          ? "Model routing, pricing, and runtime execution are configured."
          : modelReady
            ? runtimeSetupDetail(status)
            : "Configure both model routing and executable runtime profiles before workspace use.",
      status: modelReady && runtimeReady ? "ready" : "needs action",
      complete: modelReady && runtimeReady,
      facts: [
        `${status.modelPolicies} model polic${
          status.modelPolicies === 1 ? "y" : "ies"
        }`,
        `${status.runtimeProfiles} runtime profile${
          status.runtimeProfiles === 1 ? "" : "s"
        }`,
        runtimeExecutionFact(status),
        sandboxProviderFact(status),
        modelPricingFact(status),
      ],
      primaryAction: {
        label: modelReady ? "Review runtime" : "Tune models",
        route: modelReady ? "/connectors" : "/models",
      },
      secondaryAction: {
        label: modelReady ? "Tune models" : "Review runtime",
        route: modelReady ? "/models" : "/connectors",
      },
    },
  ];

  operations.push({
    id: "github-policy",
    phase: "6",
    title: "Govern repo access",
    detail: githubPolicyReady
      ? githubExecutionSetupDetail(status)
      : "Add at least one GitHub repo or organization grant before workspace use.",
    status: githubReady
      ? "ready"
      : githubPolicyReady
        ? "policy configured"
        : "needs action",
    complete: githubReady,
    facts: [
      `${status.githubGrantCount} GitHub grant${
        status.githubGrantCount === 1 ? "" : "s"
      }`,
      githubExecutionFact(status),
      githubRepoBindingFact(status),
      "Governed through access policy",
    ],
    primaryAction: {
      label: githubPolicyReady ? "Open GitHub setup" : "Add repo grant",
      route: githubPolicyReady ? "/connectors" : "/access-bundles",
    },
    secondaryAction: { label: "Review grants", route: "/access-bundles" },
  });

  return operations;
}

export function findPlace(
  data: Bootstrap,
  placeId: string,
): PlaceScope | undefined {
  return data.places.find(
    (place) => place.id === placeId || place.externalId === placeId,
  );
}

export function findRunPlace(
  data: Bootstrap,
  run: Run,
): PlaceScope | undefined {
  return findPlace(data, run.placeScopeId);
}

export function assertOneVisibleHandle(data: Pick<Bootstrap, "agent">): string {
  if (!data.agent.handle || data.agent.handle !== "@bek") {
    throw new Error("Bek v1 must expose one visible Slack handle: @bek.");
  }
  return data.agent.handle;
}

export interface GitHubConnectorSetupModel {
  status: string;
  execution: {
    mode: string;
    state: string;
    detail: string;
    networkCalls: string;
    errors: string[];
  };
  appConfig: {
    status: string;
    appId: string;
    detail: string;
    errors: string[];
    warnings: string[];
  };
  installation: {
    status: string;
    source: string;
    installationId: string;
    detail: string;
    errors: string[];
  };
  grants: {
    total: number;
    valid: number;
    invalid: number;
    detail: string;
  };
  repoBindings: {
    status: string;
    detail: string;
    missing: string[];
  };
  repositories: Array<{
    resource: string;
    fullName: string;
    grantCount: number;
    grantCapabilities: string[];
    requiredPermissions: string[];
    installationTokenInstallationId: string;
    workflowSteps: string[];
  }>;
  invalidGrants: Array<{
    grantId: string;
    bundleName: string;
    capability: string;
    resource: string;
    errors: string[];
  }>;
  errors: string[];
}

export function githubConnectorSetupModel(
  status: SetupStatus,
  setup: GitHubSetupPreview | undefined,
): GitHubConnectorSetupModel {
  const mode = status.githubExecutionMode ?? "disabled";
  const executionErrors = status.githubExecutionErrors?.filter(Boolean) ?? [];
  const executionState = status.githubExecutionEnabled
    ? status.githubExecutionReady
      ? "ready"
      : "blocked"
    : "disabled";
  const missingRepoBindings =
    status.missingGithubRepoBindings?.filter(Boolean) ?? [];
  const repoBindingsMissing = githubRepoBindingsMissing(status);
  const appErrors = setup?.appConfig.errors.filter(Boolean) ?? [];
  const appWarnings = setup?.appConfig.warnings.filter(Boolean) ?? [];
  const installationErrors = setup?.installation.errors.filter(Boolean) ?? [];
  const invalidGrantCount = setup?.invalidGrantCount ?? 0;
  const totalGrantCount = setup?.githubGrantCount ?? status.githubGrantCount;
  const validGrantCount =
    setup?.validRepoGrantCount ??
    Math.max(totalGrantCount - invalidGrantCount, 0);
  const setupErrors = setup?.errors.filter(Boolean) ?? [];
  const previewHasProblems = Boolean(
    setup &&
    (!setup.ok ||
      appErrors.length > 0 ||
      installationErrors.length > 0 ||
      invalidGrantCount > 0),
  );

  return {
    status: repoBindingsMissing
      ? "needs binding"
      : previewHasProblems
        ? "needs setup"
        : executionState,
    execution: {
      mode,
      state: executionState,
      detail: githubExecutionDetail(status),
      networkCalls:
        status.githubExecutionNetworkCalls ?? setup?.networkCalls ?? "unknown",
      errors: executionErrors,
    },
    appConfig: {
      status: setup
        ? setup.appConfig.ok
          ? "ready"
          : "needs setup"
        : "loading",
      appId: setup?.appConfig.appId ?? "missing",
      detail: setup
        ? [
            setup.appConfig.privateKeyConfigured
              ? "private key configured"
              : "private key missing",
            setup.appConfig.webhookSecretConfigured
              ? setup.appConfig.legacyWebhookSecretConfigured
                ? "legacy webhook secret configured"
                : "webhook secret configured"
              : "webhook secret missing",
          ].join(", ")
        : "Loading GitHub App config preview.",
      errors: appErrors,
      warnings: appWarnings,
    },
    installation: {
      status: setup
        ? setup.installation.configured && setup.installation.installationId
          ? "configured"
          : "missing"
        : "loading",
      source: setup?.installation.source ?? "missing",
      installationId: setup?.installation.installationId ?? "missing",
      detail: setup
        ? setup.installation.source
          ? `Preview source: ${setup.installation.source}`
          : "No installation preview source configured."
        : "Loading installation preview.",
      errors: installationErrors,
    },
    grants: {
      total: totalGrantCount,
      valid: validGrantCount,
      invalid: invalidGrantCount,
      detail:
        invalidGrantCount > 0
          ? `${validGrantCount} valid repo grant${
              validGrantCount === 1 ? "" : "s"
            }, ${invalidGrantCount} invalid grant${
              invalidGrantCount === 1 ? "" : "s"
            }`
          : `${validGrantCount} valid repo grant${
              validGrantCount === 1 ? "" : "s"
            }`,
    },
    repoBindings: {
      status:
        mode !== "real"
          ? "not required"
          : repoBindingsMissing
            ? "missing"
            : "ready",
      detail:
        mode !== "real"
          ? "Repo installation bindings are only required in real execution mode."
          : repoBindingsMissing
            ? `Missing bindings for ${formatGithubRepoBindings(
                missingRepoBindings,
              )}.`
            : "All repo grants have installation bindings.",
      missing: missingRepoBindings,
    },
    repositories:
      setup?.repositories.map((repository) => ({
        resource: repository.repository.resource,
        fullName: repository.repository.fullName,
        grantCount: repository.grants.length,
        grantCapabilities: repository.grants.map((grant) => grant.capability),
        requiredPermissions: formatGitHubPermissions(
          repository.requiredPermissions,
        ),
        installationTokenInstallationId:
          repository.installationTokenRequestPreview?.installationId ??
          "missing",
        workflowSteps: repository.draftPullRequestWorkflowPreview?.steps ?? [],
      })) ?? [],
    invalidGrants:
      setup?.invalidGrants.map((grant) => ({
        grantId: grant.grantId,
        bundleName: grant.bundleName,
        capability: grant.capability,
        resource: grant.resource,
        errors: grant.errors,
      })) ?? [],
    errors: setupErrors,
  };
}

export function connectorSummaries(data: Bootstrap): Array<{
  id: string;
  name: string;
  status: string;
  detail: string;
  metric: string;
  route: AdminRoute;
  actionLabel: string;
}> {
  const grantResources = data.accessBundles.flatMap((bundle) =>
    bundle.grants.map((grant) => grant.resource),
  );
  const hasGitHub = grantResources.some((resource) =>
    resource.startsWith("github:"),
  );
  const slackInstall = data.connectorInstalls.find(
    (install) => install.kind === "slack" && install.provider === "slack",
  );
  const slackInstallActive = slackInstall?.status === "active";
  const slackCredential = data.credentials.find(
    (credential) =>
      slackInstallActive &&
      credential.provider === "slack" &&
      credential.status === "active" &&
      (credential.connectorInstallId === slackInstall?.id ||
        credential.externalAccountId === slackInstall?.externalId),
  );
  const hasSandbox = grantResources.some((resource) =>
    resource.startsWith("sandbox:"),
  );
  const slackPlaceCount = data.places.filter(
    (place) => place.provider === "slack",
  ).length;
  const githubGrantCount = grantResources.filter((resource) =>
    resource.startsWith("github:"),
  ).length;
  const mcpGrantCount = grantResources.filter((resource) =>
    resource.startsWith("mcp:"),
  ).length;
  const sandboxGrantCount = grantResources.filter((resource) =>
    resource.startsWith("sandbox:"),
  ).length;

  return [
    {
      id: "slack",
      name: "Slack",
      status: slackInstall
        ? !slackInstallActive
          ? slackInstall.status
          : slackCredential
            ? "connected"
            : "needs token"
        : slackPlaceCount > 0
          ? "scopes only"
          : "not connected",
      detail: slackInstall
        ? slackInstallActive
          ? slackCredential
            ? `${slackInstall.displayName} workspace, ${slackPlaceCount} channel scopes`
            : `${slackInstall.displayName} workspace is active, but no Slack bot token is stored.`
          : `${slackInstall.displayName} workspace install is ${slackInstall.status}.`
        : slackPlaceCount > 0
          ? "Channel scopes are seeded, but no Slack workspace install is stored."
          : "Install Bek in Slack to create runs.",
      metric: slackInstall?.externalId ?? `${slackPlaceCount} scopes`,
      route:
        slackInstallActive && slackCredential ? "/channels" : "/connectors",
      actionLabel:
        slackInstallActive && slackCredential
          ? "Manage channels"
          : slackInstall
            ? "Review install"
            : "Install Slack",
    },
    {
      id: "github",
      name: "GitHub",
      status: hasGitHub ? "policy configured" : "not connected",
      detail: hasGitHub
        ? "Selected repo grants are attached; execution readiness is shown in setup."
        : "Install the GitHub App to enable repo work.",
      metric: `${githubGrantCount} grants`,
      route: "/access-bundles",
      actionLabel: "Review grants",
    },
    {
      id: "mcp",
      name: "MCP Gateway",
      status: mcpGrantCount > 0 ? "configured" : "ready",
      detail: "Tool grants are mediated through access bundles and approvals.",
      metric: `${mcpGrantCount} tool grants`,
      route: "/access-bundles",
      actionLabel: "Open access",
    },
    {
      id: "sandbox",
      name: "Sandbox",
      status: hasSandbox ? "approval required" : "not configured",
      detail: hasSandbox
        ? "Code execution is gated by policy; provider readiness is shown in setup."
        : "Set BEK_SANDBOX_PROVIDER=docker-local before executable sandbox work.",
      metric: `${sandboxGrantCount} grants`,
      route: "/access-bundles",
      actionLabel: "Review policy",
    },
    {
      id: "model",
      name: "Model Providers",
      status: data.modelPolicies.length > 0 ? "configured" : "not configured",
      detail:
        data.modelPolicies[0]?.defaultModel ??
        "Add OpenAI, Anthropic, OpenRouter, LiteLLM, or a gateway.",
      metric: `${data.modelPolicies.length} policies`,
      route: "/models",
      actionLabel: "Tune routing",
    },
    {
      id: "runtime",
      name: "Runtime Profiles",
      status: data.runtimeProfiles.length > 0 ? "configured" : "not configured",
      detail: data.runtimeProfiles[0]
        ? `${data.runtimeProfiles[0].adapter}; execution readiness is shown in setup.`
        : "Add a local, hosted, or sandboxed runtime adapter.",
      metric: `${data.runtimeProfiles.length} profiles`,
      route: "/connectors",
      actionLabel: "Review runtime",
    },
  ];
}

function slackInstallSetupDetail(status: SetupStatus): string {
  if (!status.slackInstalled) {
    return "Install Bek and store a Slack bot token before real workspace use.";
  }
  const workspace =
    status.slackWorkspaceName ?? status.slackWorkspaceId ?? "Slack";
  const installStatus = status.slackInstallStatus ?? "connected";
  if (installStatus !== "active") {
    return `${workspace} install is ${installStatus}.`;
  }
  if (!status.slackTokenStored) {
    return `${workspace} is active, but no Slack bot token is stored.`;
  }
  if (hasMissingSlackScopes(status)) {
    return `${workspace} token is missing required Slack scopes: ${formatSlackScopes(
      status.missingSlackScopes,
    )}.`;
  }
  return `${workspace} is active with a stored bot token.`;
}

function modelPricingReady(status: SetupStatus): boolean {
  return Boolean(status.modelPolicies > 0 && status.modelPricingReady);
}

function modelPricingSetupDetail(status: SetupStatus): string {
  if (status.modelPolicies === 0) {
    return "No model policies configured.";
  }
  if (status.modelPricingError) {
    return `Model pricing registry error: ${status.modelPricingError}`;
  }
  if (!status.modelPricingReady) {
    return `Missing pricing for ${formatPricedModels(
      status.missingPricedModels,
    )}.`;
  }
  const mode = status.modelGatewayMode ?? "local";
  return `${status.modelPolicies} model polic${
    status.modelPolicies === 1 ? "y" : "ies"
  } configured with pricing for ${mode}.`;
}

function modelPricingFact(status: SetupStatus): string {
  if (status.modelPricingError) {
    return "Pricing registry: invalid";
  }
  return status.modelPricingReady
    ? "Pricing registry: ready"
    : `Missing pricing: ${formatPricedModels(status.missingPricedModels)}`;
}

function runtimeExecutionReady(status: SetupStatus): boolean {
  if (typeof status.runtimeExecutionReady === "boolean") {
    return status.runtimeExecutionReady;
  }
  return status.runtimeProfiles > 0;
}

function runtimeSetupDetail(status: SetupStatus): string {
  if (status.runtimeProfiles === 0) {
    return "No runtime profiles configured.";
  }
  if (runtimeExecutionReady(status)) {
    const executable =
      status.runtimeExecutableProfiles ?? status.runtimeProfiles;
    return `${executable} executable runtime profile${
      executable === 1 ? "" : "s"
    } configured.`;
  }
  if (
    (status.sandboxedRuntimeProfiles ?? 0) > 0 &&
    !status.sandboxProviderReady
  ) {
    return `${status.runtimeProfiles} runtime profile${
      status.runtimeProfiles === 1 ? "" : "s"
    } configured, but sandboxed execution needs BEK_SANDBOX_PROVIDER.`;
  }
  return runtimeExecutionErrorSummary(status);
}

function runtimeExecutionFact(status: SetupStatus): string {
  if (status.runtimeProfiles === 0) {
    return "Execution: no profiles";
  }
  if (runtimeExecutionReady(status)) {
    return "Execution: ready";
  }
  const executable = status.runtimeExecutableProfiles ?? 0;
  return `Execution: blocked (${executable}/${status.runtimeProfiles} executable)`;
}

function sandboxProviderFact(status: SetupStatus): string {
  const mode = status.sandboxProviderMode ?? "none";
  if ((status.sandboxedRuntimeProfiles ?? 0) === 0) {
    return "Sandbox provider: not required";
  }
  if (status.sandboxProviderReady) {
    return `Sandbox provider: ready (${mode})`;
  }
  if (status.sandboxProviderEnabled) {
    return `Sandbox provider: blocked (${mode})`;
  }
  return `Sandbox provider: disabled (${mode})`;
}

function runtimeExecutionErrorSummary(status: SetupStatus): string {
  const errors = [
    ...(status.runtimeExecutionErrors ?? []),
    ...(status.sandboxProviderErrors ?? []),
  ].filter(Boolean);
  return errors.length > 0
    ? errors.join("; ")
    : "Runtime execution readiness is blocked.";
}

function githubExecutionSetupDetail(status: SetupStatus): string {
  if (!githubRepoBindingsReady(status)) {
    return `Repo grants are attached, but real GitHub execution is missing installation bindings for ${formatGithubRepoBindings(
      status.missingGithubRepoBindings,
    )}.`;
  }
  if (status.githubExecutionEnabled && status.githubExecutionReady) {
    return "Repo grants are attached and GitHub App execution is ready.";
  }
  if (status.githubExecutionEnabled) {
    return `Repo grants are attached, but GitHub App execution needs repair: ${githubExecutionErrorSummary(
      status,
    )}.`;
  }
  return "Repo grants are attached; real GitHub execution is disabled until App credentials are configured.";
}

function githubExecutionFact(status: SetupStatus): string {
  const mode = status.githubExecutionMode ?? "disabled";
  if (status.githubExecutionEnabled && status.githubExecutionReady) {
    return `Execution: ready (${mode})`;
  }
  if (status.githubExecutionEnabled) {
    return `Execution: blocked (${mode})`;
  }
  return `Execution: disabled (${mode})`;
}

function githubRepoBindingsReady(status: SetupStatus): boolean {
  return (
    status.githubExecutionMode !== "real" ||
    status.githubRepoBindingsReady === true ||
    (status.missingGithubRepoBindings?.length ?? 0) === 0
  );
}

function githubRepoBindingFact(status: SetupStatus): string {
  if (status.githubExecutionMode !== "real") {
    return "Repo bindings: not required";
  }
  const missing = status.missingGithubRepoBindings?.length ?? 0;
  return missing === 0
    ? "Repo bindings: ready"
    : `Repo bindings: missing ${missing}`;
}

function formatGithubRepoBindings(resources: string[] | undefined): string {
  return resources?.length ? resources.join(", ") : "configured repo grants";
}

function githubExecutionErrorSummary(status: SetupStatus): string {
  const errors = status.githubExecutionErrors?.filter(Boolean) ?? [];
  return errors.length > 0 ? errors.join("; ") : "missing ready checks";
}

function githubExecutionDetail(status: SetupStatus): string {
  if (status.githubExecutionEnabled && status.githubExecutionReady) {
    return "GitHub App execution is ready for approved worker runs.";
  }
  if (status.githubExecutionEnabled) {
    return `GitHub App execution needs repair: ${githubExecutionErrorSummary(
      status,
    )}.`;
  }
  return "Real GitHub execution is disabled until App credentials are configured.";
}

function githubRepoBindingsMissing(status: SetupStatus): boolean {
  return Boolean(
    status.githubExecutionMode === "real" &&
    (status.githubRepoBindingsReady === false ||
      (status.missingGithubRepoBindings?.length ?? 0) > 0),
  );
}

function formatGitHubPermissions(
  permissions: Record<string, string | undefined>,
): string[] {
  return Object.entries(permissions)
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, access]) => `${name}: ${access}`);
}

function formatPricedModels(models: string[] | undefined): string {
  return models?.length ? models.join(", ") : "configured models";
}

function hasMissingSlackScopes(status: SetupStatus): boolean {
  return Boolean(status.missingSlackScopes?.length);
}

function missingSlackScopesFact(status: SetupStatus): string {
  if (!status.slackInstalled || !status.slackTokenStored) {
    return "Scopes: waiting for install";
  }
  return hasMissingSlackScopes(status)
    ? `Missing scopes: ${formatSlackScopes(status.missingSlackScopes)}`
    : "Scopes: ready";
}

function formatSlackScopes(scopes: string[] | undefined): string {
  return scopes?.length ? scopes.join(", ") : "none";
}

export const setupSteps = [
  "Name the single visible teammate",
  "Connect Slack",
  "Choose one pilot channel",
  "Attach the starter access bundle",
  "Connect a model provider",
  "Set budget and approval defaults",
  "Run @bek what can you access here?",
];

export const visibleHandleAntiPatterns = [
  "Agent directory",
  "Specialist bot picker",
  "Per-workflow Slack bot",
];

export const capabilityIcons = {
  answer: Bot,
  coding: GitBranch,
  incident: Activity,
  support: ClipboardList,
  data: Database,
  workflow: Route,
} as const;
