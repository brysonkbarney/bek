import type { BekSnapshot } from "./types";

export function createSeedSnapshot(
  now = new Date().toISOString(),
): BekSnapshot {
  const orgId = "org_demo";
  const agentId = "agent_bek";
  const agentPrincipalId = "principal_bek";
  const humanPrincipalId = "principal_bryson";
  const adminPrincipalId = "principal_admin";
  const modelPolicyId = "model_auto";
  const runtimeAnswerId = "runtime_answer";
  const runtimeCodeId = "runtime_code";
  const budgetPolicyId = "budget_checkout";
  const checkoutPlaceId = "place_checkout";
  const generalPlaceId = "place_general";

  return {
    org: {
      id: orgId,
      name: "Bek Demo Workspace",
      slug: "bek-demo",
      plan: "oss",
      primaryAgentId: agentId,
    },
    principals: [
      {
        id: agentPrincipalId,
        orgId,
        kind: "agent",
        displayName: "Bek",
      },
      {
        id: humanPrincipalId,
        orgId,
        kind: "human",
        displayName: "Bryson",
        email: "bryson@example.com",
      },
      {
        id: adminPrincipalId,
        orgId,
        kind: "human",
        displayName: "Admin",
        email: "admin@example.com",
      },
    ],
    agent: {
      id: agentId,
      orgId,
      principalId: agentPrincipalId,
      name: "Bek",
      handle: "@bek",
      description:
        "One open-source Slack teammate with governed tools behind it.",
      status: "active",
      defaultModelPolicyId: modelPolicyId,
      defaultRuntimeProfileId: runtimeAnswerId,
    },
    capabilityProfiles: [
      {
        id: "cap_answer",
        orgId,
        agentId,
        name: "Answer",
        capabilityKind: "answer",
        runtimeProfileId: runtimeAnswerId,
        modelPolicyId,
        enabled: true,
      },
      {
        id: "cap_code",
        orgId,
        agentId,
        name: "Code",
        capabilityKind: "coding",
        runtimeProfileId: runtimeCodeId,
        modelPolicyId,
        enabled: true,
      },
    ],
    places: [
      {
        id: checkoutPlaceId,
        orgId,
        kind: "slack_channel",
        provider: "slack",
        externalId: "C_CHECKOUT",
        name: "#checkout-eng",
        sensitivity: "internal",
      },
      {
        id: generalPlaceId,
        orgId,
        kind: "slack_channel",
        provider: "slack",
        externalId: "C_GENERAL",
        name: "#general",
        sensitivity: "public",
      },
    ],
    accessBundles: [
      {
        id: "bundle_checkout",
        orgId,
        name: "Checkout Engineering",
        description:
          "Repo, issue, and observability grants for checkout engineering.",
        attachedPlaceIds: [checkoutPlaceId],
        budgetPolicyId,
        grants: [
          {
            id: "grant_slack_read",
            capability: "slack.read",
            resource: "slack:C_CHECKOUT",
            decision: "allow",
            risk: "read_internal",
            requiresApproval: false,
          },
          {
            id: "grant_github_read",
            capability: "github.read",
            resource: "github:redohq/checkout",
            decision: "allow",
            risk: "read_internal",
            requiresApproval: false,
          },
          {
            id: "grant_github_pr",
            capability: "github.pr",
            resource: "github:redohq/checkout",
            decision: "ask",
            risk: "write_external",
            requiresApproval: true,
          },
          {
            id: "grant_sandbox",
            capability: "sandbox.exec",
            resource: "sandbox:docker-local",
            decision: "ask",
            risk: "privileged",
            requiresApproval: true,
          },
        ],
      },
      {
        id: "bundle_general",
        orgId,
        name: "General Read-Only",
        description: "Safe default for public channels.",
        attachedPlaceIds: [generalPlaceId],
        budgetPolicyId,
        grants: [
          {
            id: "grant_general_slack_read",
            capability: "slack.read",
            resource: "slack:C_GENERAL",
            decision: "allow",
            risk: "read_internal",
            requiresApproval: false,
          },
        ],
      },
    ],
    modelPolicies: [
      {
        id: modelPolicyId,
        orgId,
        name: "Auto balanced",
        defaultModel: "openai/gpt-5.4",
        fallbackModels: [
          "anthropic/claude-sonnet-4.8",
          "openai-compatible/local",
        ],
        perRunBudgetCents: 2000,
      },
    ],
    runtimeProfiles: [
      {
        id: runtimeAnswerId,
        orgId,
        name: "Answer runtime",
        runtimeKind: "ai_sdk",
        adapter: "ai-sdk-local-stub",
      },
      {
        id: runtimeCodeId,
        orgId,
        name: "Code runtime",
        runtimeKind: "opencode",
        adapter: "opencode-sandbox",
      },
    ],
    budgetPolicies: [
      {
        id: budgetPolicyId,
        orgId,
        name: "Checkout default",
        perRunCents: 2000,
        perDayCents: 50000,
      },
    ],
    runs: [
      {
        id: "run_demo",
        orgId,
        agentId,
        requesterPrincipalId: humanPrincipalId,
        placeScopeId: checkoutPlaceId,
        trigger: "mention",
        prompt: "@bek what can you access here?",
        status: "completed",
        modelPolicyId,
        runtimeProfileId: runtimeAnswerId,
        estimatedCostCents: 4,
        actualCostCents: 3,
        createdAt: now,
        updatedAt: now,
      },
    ],
    events: [
      {
        id: "event_demo_created",
        orgId,
        runId: "run_demo",
        type: "run.created",
        message: "Bek was mentioned in #checkout-eng.",
        createdAt: now,
      },
      {
        id: "event_demo_completed",
        orgId,
        runId: "run_demo",
        type: "run.completed",
        message:
          "Bek can read Slack context, read github:redohq/checkout, and ask before PR/sandbox writes.",
        createdAt: now,
      },
    ],
    approvals: [],
  };
}
