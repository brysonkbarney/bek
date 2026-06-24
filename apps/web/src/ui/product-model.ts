import {
  Activity,
  Bot,
  Boxes,
  Brain,
  ClipboardCheck,
  ClipboardList,
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
} from "../api";

export const navigationItems = [
  { to: "/", label: "Overview", icon: LayoutDashboard },
  { to: "/setup", label: "Setup", icon: ClipboardCheck },
  { to: "/channels", label: "Channels", icon: Slack },
  { to: "/access-bundles", label: "Access", icon: ShieldCheck },
  { to: "/runs", label: "Runs", icon: ClipboardList },
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

export function connectorSummaries(data: Bootstrap) {
  const grantResources = data.accessBundles.flatMap((bundle) =>
    bundle.grants.map((grant) => grant.resource),
  );
  const hasGitHub = grantResources.some((resource) =>
    resource.startsWith("github:"),
  );
  const hasSlack = data.places.some((place) => place.provider === "slack");
  const hasSandbox = grantResources.some((resource) =>
    resource.startsWith("sandbox:"),
  );

  return [
    {
      id: "slack",
      name: "Slack",
      status: hasSlack ? "connected" : "not connected",
      detail: hasSlack
        ? `${data.places.length} channel scopes`
        : "Install Bek in Slack to create runs.",
    },
    {
      id: "github",
      name: "GitHub",
      status: hasGitHub ? "connected" : "not connected",
      detail: hasGitHub
        ? "Selected repo grants are attached to access bundles."
        : "Install the GitHub App to enable repo work.",
    },
    {
      id: "mcp",
      name: "MCP Gateway",
      status: "ready",
      detail: "Tool grants are mediated through access bundles and approvals.",
    },
    {
      id: "sandbox",
      name: "Sandbox",
      status: hasSandbox ? "approval required" : "not configured",
      detail: hasSandbox
        ? "Code execution is gated by policy."
        : "Connect Docker, E2B, or Vercel Sandbox.",
    },
    {
      id: "model",
      name: "Model Providers",
      status: data.modelPolicies.length > 0 ? "configured" : "not configured",
      detail:
        data.modelPolicies[0]?.defaultModel ??
        "Add OpenAI, Anthropic, OpenRouter, LiteLLM, or a gateway.",
    },
  ];
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
