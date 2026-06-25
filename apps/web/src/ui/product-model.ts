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
        status.slackTokenStored,
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
      detail: `${status.modelPolicies} model polic${
        status.modelPolicies === 1 ? "y" : "ies"
      } configured`,
      complete: status.modelPolicies > 0,
      route: "/models",
    },
    {
      id: "runtime-profile",
      label: "Register a runtime profile for tool execution",
      detail: `${status.runtimeProfiles} runtime profile${
        status.runtimeProfiles === 1 ? "" : "s"
      } configured`,
      complete: status.runtimeProfiles > 0,
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
    status.slackTokenStored,
  );
  const channelReady = status.slackChannels > 0;
  const accessReady = status.accessBundles > 0;
  const modelReady = status.modelPolicies > 0;
  const runtimeReady = status.runtimeProfiles > 0;
  const githubReady = status.githubGrantCount > 0;
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
          ? "Model routing and runtime execution are configured."
          : "Configure both model routing and a runtime profile before workspace use.",
      status: modelReady && runtimeReady ? "ready" : "needs action",
      complete: modelReady && runtimeReady,
      facts: [
        `${status.modelPolicies} model polic${
          status.modelPolicies === 1 ? "y" : "ies"
        }`,
        `${status.runtimeProfiles} runtime profile${
          status.runtimeProfiles === 1 ? "" : "s"
        }`,
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

  if (githubReady) {
    operations.push({
      id: "github-preview",
      phase: "Preview",
      title: "GitHub policy preview",
      detail: "Repo work is visible through existing access-bundle grants.",
      status: "visible",
      complete: true,
      facts: [
        `${status.githubGrantCount} GitHub grant${
          status.githubGrantCount === 1 ? "" : "s"
        }`,
        "Governed through access policy",
      ],
      primaryAction: { label: "Review grants", route: "/access-bundles" },
    });
  }

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
      status: hasGitHub ? "connected" : "not connected",
      detail: hasGitHub
        ? "Selected repo grants are attached to access bundles."
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
        ? "Code execution is gated by policy."
        : "Connect Docker, E2B, or Vercel Sandbox.",
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
      status: data.runtimeProfiles.length > 0 ? "ready" : "not configured",
      detail:
        data.runtimeProfiles[0]?.adapter ??
        "Add a local, hosted, or sandboxed runtime adapter.",
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
  return `${workspace} is active with a stored bot token.`;
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
