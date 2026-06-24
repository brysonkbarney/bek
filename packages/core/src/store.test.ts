import { describe, expect, it } from "vitest";
import { BekStore } from "./store";
import { createSeedSnapshot } from "./seed";

function createPendingApproval(store: BekStore, prompt = "@bek open a PR") {
  const run = store.createRun({
    prompt,
    placeScopeId: "place_checkout",
    capability: "github.pr",
    resource: "github:redohq/checkout",
  });
  const snapshot = store.read();
  const approval = snapshot.approvals.find(
    (candidate) => candidate.runId === run.id,
  );
  if (!approval) {
    throw new Error("Expected approval.");
  }
  return approval;
}

describe("Bek approvals", () => {
  it("requires another human to approve risky writes with the original payload hash", () => {
    const store = new BekStore();
    const approval = createPendingApproval(store);

    expect(() =>
      store.decideApproval(approval.id, "approved", {
        principalId: "principal_admin",
        payloadHash: approval.payloadHash,
      }),
    ).not.toThrow();
  });

  it("rejects hash tampering and self-approval for risky writes", () => {
    const store = new BekStore();
    const approval = createPendingApproval(store);

    expect(() =>
      store.decideApproval(approval.id, "approved", {
        principalId: "principal_admin",
        payloadHash: "bad-hash-bad-hash",
      }),
    ).toThrow(/hash/i);

    expect(() =>
      store.decideApproval(approval.id, "approved", {
        principalId: "principal_bryson",
        payloadHash: approval.payloadHash,
      }),
    ).toThrow(/self-approve/i);
  });

  it("rejects stale approval hashes from a different pending request", () => {
    const store = new BekStore();
    const staleApproval = createPendingApproval(
      store,
      "@bek open the first PR",
    );
    const currentApproval = createPendingApproval(
      store,
      "@bek open the second PR",
    );

    expect(staleApproval.payloadHash).not.toBe(currentApproval.payloadHash);
    expect(() =>
      store.decideApproval(currentApproval.id, "approved", {
        principalId: "principal_admin",
        payloadHash: staleApproval.payloadHash,
      }),
    ).toThrow(/hash/i);
    expect(
      store
        .read()
        .approvals.find((candidate) => candidate.id === currentApproval.id)
        ?.status,
    ).toBe("pending");
  });

  it("rejects agent approval actors", () => {
    const store = new BekStore();
    const approval = createPendingApproval(store);

    expect(() =>
      store.decideApproval(approval.id, "approved", {
        principalId: "principal_bek",
        payloadHash: approval.payloadHash,
      }),
    ).toThrow(/human principal/i);
    expect(
      store.read().approvals.find((candidate) => candidate.id === approval.id)
        ?.status,
    ).toBe("pending");
  });

  it("does not allow an approval to be decided twice", () => {
    const store = new BekStore();
    const approval = createPendingApproval(store);

    expect(
      store.decideApproval(approval.id, "approved", {
        principalId: "principal_admin",
        payloadHash: approval.payloadHash,
      }).status,
    ).toBe("approved");

    expect(() =>
      store.decideApproval(approval.id, "approved", {
        principalId: "principal_admin",
        payloadHash: approval.payloadHash,
      }),
    ).toThrow(/no longer pending/i);
  });

  it("expires approvals after the approval window", () => {
    const store = new BekStore();
    const approval = createPendingApproval(store);

    expect(() =>
      store.decideApproval(approval.id, "approved", {
        principalId: "principal_admin",
        payloadHash: approval.payloadHash,
        now: "2099-01-01T00:00:00.000Z",
      }),
    ).toThrow(/expired/i);
    expect(
      store.read().approvals.find((candidate) => candidate.id === approval.id)
        ?.status,
    ).toBe("expired");
  });

  it("queues approved risky work when the worker owns advancement", () => {
    const store = new BekStore();
    const approval = createPendingApproval(store);

    const decided = store.decideApproval(approval.id, "approved", {
      principalId: "principal_admin",
      payloadHash: approval.payloadHash,
      advanceMode: "worker",
    });

    const run = store
      .read()
      .runs.find((candidate) => candidate.id === decided.runId);
    expect(run).toMatchObject({
      status: "queued",
      actualCostCents: 0,
    });
  });
});

describe("Bek worker advancement state", () => {
  it("uses the answer capability profile instead of the first model policy", () => {
    const snapshot = createSeedSnapshot();
    snapshot.modelPolicies.unshift({
      id: "model_wrong_first",
      orgId: snapshot.org.id,
      name: "Wrong first",
      defaultModel: "anthropic/too-expensive-demo",
      fallbackModels: [],
      perRunBudgetCents: 99_999,
    });
    const store = new BekStore(snapshot);

    const run = store.createRun({
      prompt: "@bek summarize checkout",
      placeScopeId: "place_checkout",
      capability: "slack.read",
      resource: "slack:C_CHECKOUT",
      advanceMode: "worker",
    });

    expect(run).toMatchObject({
      modelPolicyId: "model_auto",
      runtimeProfileId: "runtime_answer",
    });
  });

  it("uses the coding capability profile for repo and sandbox work", () => {
    const snapshot = createSeedSnapshot();
    snapshot.modelPolicies.unshift({
      id: "model_wrong_first",
      orgId: snapshot.org.id,
      name: "Wrong first",
      defaultModel: "anthropic/too-expensive-demo",
      fallbackModels: [],
      perRunBudgetCents: 99_999,
    });
    snapshot.modelPolicies.push({
      id: "model_code",
      orgId: snapshot.org.id,
      name: "Code model",
      defaultModel: "openai/gpt-5.5-code-demo",
      fallbackModels: [],
      perRunBudgetCents: 5000,
    });
    const codeProfile = snapshot.capabilityProfiles.find(
      (profile) => profile.id === "cap_code",
    );
    if (!codeProfile) {
      throw new Error("Expected code capability profile.");
    }
    codeProfile.modelPolicyId = "model_code";
    const store = new BekStore(snapshot);

    const run = store.createRun({
      prompt: "@bek open a PR",
      placeScopeId: "place_checkout",
      capability: "github.pr",
      resource: "github:redohq/checkout",
      advanceMode: "worker",
    });

    expect(run).toMatchObject({
      modelPolicyId: "model_code",
      runtimeProfileId: "runtime_code",
      status: "awaiting_approval",
    });
  });

  it("uses the answer capability profile when no capability is supplied", () => {
    const snapshot = createSeedSnapshot();
    const answerProfile = snapshot.capabilityProfiles.find(
      (profile) => profile.id === "cap_answer",
    );
    if (!answerProfile) {
      throw new Error("Expected answer capability profile.");
    }
    snapshot.modelPolicies.push({
      id: "model_answer",
      orgId: snapshot.org.id,
      name: "Answer model",
      defaultModel: "openai/answer-demo",
      fallbackModels: [],
      perRunBudgetCents: 1200,
    });
    answerProfile.modelPolicyId = "model_answer";
    const store = new BekStore(snapshot);

    const run = store.createRun({
      prompt: "@bek think through this",
      placeScopeId: "place_checkout",
      advanceMode: "worker",
    });

    expect(run).toMatchObject({
      modelPolicyId: "model_answer",
      runtimeProfileId: "runtime_answer",
    });
  });

  it("ignores disabled matching capability profiles and falls back to agent defaults", () => {
    const snapshot = createSeedSnapshot();
    const codeProfile = snapshot.capabilityProfiles.find(
      (profile) => profile.id === "cap_code",
    );
    if (!codeProfile) {
      throw new Error("Expected code capability profile.");
    }
    codeProfile.enabled = false;
    const store = new BekStore(snapshot);

    const run = store.createRun({
      prompt: "@bek open a PR",
      placeScopeId: "place_checkout",
      capability: "github.pr",
      resource: "github:redohq/checkout",
      advanceMode: "worker",
    });

    expect(run).toMatchObject({
      modelPolicyId: "model_auto",
      runtimeProfileId: "runtime_answer",
      status: "awaiting_approval",
    });
  });

  it("falls back to agent defaults when no matching capability profile exists", () => {
    const snapshot = createSeedSnapshot();
    snapshot.modelPolicies.push({
      id: "model_agent_default",
      orgId: snapshot.org.id,
      name: "Agent default",
      defaultModel: "openai/default-demo",
      fallbackModels: [],
      perRunBudgetCents: 1500,
    });
    snapshot.agent.defaultModelPolicyId = "model_agent_default";
    const store = new BekStore(snapshot);

    const run = store.createRun({
      prompt: "@bek update a Linear issue",
      placeScopeId: "place_checkout",
      capability: "linear.write",
      resource: "linear:ISSUE-123",
      advanceMode: "worker",
    });

    expect(run).toMatchObject({
      modelPolicyId: "model_agent_default",
      runtimeProfileId: "runtime_answer",
    });
  });

  it("redacts secret-shaped prompt text before storing runs", () => {
    const store = new BekStore();
    const secret = "xoxb-this-secret-token-should-redact";

    const run = store.createRun({
      prompt: `@bek investigate ${secret}`,
      placeScopeId: "place_checkout",
      capability: "slack.read",
      resource: "slack:C_CHECKOUT",
    });
    const snapshotText = JSON.stringify(store.read());

    expect(run.prompt).toContain("[redacted:slack-token]");
    expect(run.prompt).not.toContain(secret);
    expect(snapshotText).not.toContain(secret);
  });

  it("leaves allowed runs queued for worker execution", () => {
    const store = new BekStore();

    const run = store.createRun({
      prompt: "@bek summarize checkout",
      placeScopeId: "place_checkout",
      capability: "slack.read",
      resource: "slack:C_CHECKOUT",
      advanceMode: "worker",
    });

    expect(run.status).toBe("queued");
    expect(
      store
        .read()
        .events.some(
          (event) =>
            event.runId === run.id &&
            event.type === "run.status_changed" &&
            event.message.includes("worker advancement"),
        ),
    ).toBe(true);
  });

  it("persists worker approvals and terminal run status", () => {
    const store = new BekStore();
    const run = store.createRun({
      prompt: "@bek do something with approval",
      placeScopeId: "place_checkout",
      advanceMode: "worker",
    });

    const approval = store.upsertApprovalRequest({
      id: "approval_worker_test",
      orgId: run.orgId,
      runId: run.id,
      action: "local.approval",
      risk: "write_external",
      status: "pending",
      payloadHash: "hash_hash_hash_hash",
      requestedByPrincipalId: run.requesterPrincipalId,
      createdAt: run.createdAt,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    expect(approval.status).toBe("pending");

    const completed = store.setRunStatus({
      runId: run.id,
      status: "completed",
      actualCostCents: 3,
      message: "Worker completed test run.",
    });

    expect(completed).toMatchObject({
      status: "completed",
      actualCostCents: 3,
    });
  });
});

describe("Bek ingress delivery state", () => {
  it("records, redacts, finds, and removes durable Slack delivery keys", () => {
    const store = new BekStore();

    const delivery = store.recordIngressDelivery({
      key: "slack:event:T123:Ev123",
      kind: "slack.event",
      status: "processed",
      runId: "run_demo",
      response: {
        ok: true,
        token: "xoxb-this-secret-token-should-redact",
      },
    });

    expect(delivery).toMatchObject({
      provider: "slack",
      kind: "slack.event",
      key: "slack:event:T123:Ev123",
      runId: "run_demo",
      response: {
        ok: true,
        token: "[redacted:field]",
      },
    });
    expect(store.findIngressDelivery(delivery.key)).toMatchObject({
      id: delivery.id,
    });
    expect(store.removeIngressDelivery(delivery.key)).toBe(true);
    expect(store.findIngressDelivery(delivery.key)).toBeUndefined();
  });

  it("records durable GitHub webhook delivery keys", () => {
    const store = new BekStore();

    const delivery = store.recordIngressDelivery({
      provider: "github",
      key: "github:webhook:pull_request:delivery-123",
      kind: "github.webhook",
      status: "processed",
      response: {
        ok: true,
        eventName: "pull_request",
        token: "ghs_this-secret-token-should-redact",
      },
    });

    expect(delivery).toMatchObject({
      provider: "github",
      kind: "github.webhook",
      key: "github:webhook:pull_request:delivery-123",
      response: {
        ok: true,
        eventName: "pull_request",
        token: "[redacted:field]",
      },
    });
    expect(store.findIngressDelivery(delivery.key)).toMatchObject({
      provider: "github",
      kind: "github.webhook",
    });
  });
});

describe("Bek outbound delivery state", () => {
  it("queues, retries, and completes durable Slack outbound deliveries", () => {
    const store = new BekStore();
    const delivery = store.enqueueOutboundDelivery({
      key: "slack:run_outcome:run_demo:C_CHECKOUT",
      kind: "slack.run_outcome",
      runId: "run_demo",
      maxAttempts: 2,
      target: {
        channelId: "C_CHECKOUT",
        teamId: "T123",
        token: "xoxb-this-secret-token-should-redact",
      },
      payload: {
        text: "Bek queued this run with xoxb-this-secret-token-should-redact",
      },
      now: "2026-01-01T00:00:00.000Z",
    });

    expect(delivery).toMatchObject({
      provider: "slack",
      kind: "slack.run_outcome",
      key: "slack:run_outcome:run_demo:C_CHECKOUT",
      status: "queued",
      attempts: 0,
      maxAttempts: 2,
      target: {
        channelId: "C_CHECKOUT",
        token: "[redacted:field]",
      },
      payload: {
        text: "Bek queued this run with [redacted:slack-token]",
      },
    });
    expect(
      store.enqueueOutboundDelivery({
        key: delivery.key,
        kind: "slack.run_outcome",
        runId: "run_demo",
        target: { channelId: "C_CHECKOUT" },
        payload: { text: "updated stable payload" },
      }).id,
    ).toBe(delivery.id);

    expect(
      store.listDueOutboundDeliveries({
        now: "2026-01-01T00:00:00.000Z",
      }),
    ).toHaveLength(1);

    const firstAttempt = store.beginOutboundDelivery(delivery.id, {
      now: "2026-01-01T00:00:01.000Z",
    });
    expect(firstAttempt).toMatchObject({
      status: "delivering",
      attempts: 1,
    });

    const retry = store.failOutboundDelivery({
      id: delivery.id,
      error: "temporary xoxb-this-secret-token-should-redact",
      retryDelayMs: 5_000,
      now: "2026-01-01T00:00:02.000Z",
    });
    expect(retry).toMatchObject({
      status: "queued",
      attempts: 1,
      lastError: "temporary [redacted:slack-token]",
      nextAttemptAt: "2026-01-01T00:00:07.000Z",
    });
    expect(
      store.listDueOutboundDeliveries({
        now: "2026-01-01T00:00:06.000Z",
      }),
    ).toHaveLength(0);

    store.beginOutboundDelivery(delivery.id, {
      now: "2026-01-01T00:00:07.000Z",
    });
    const completed = store.completeOutboundDelivery(delivery.id, {
      now: "2026-01-01T00:00:08.000Z",
    });
    expect(completed).toMatchObject({
      status: "delivered",
      attempts: 2,
      deliveredAt: "2026-01-01T00:00:08.000Z",
    });
  });
});

describe("Bek connector and credential state", () => {
  it("upserts Slack installs and redacts credential metadata", () => {
    const store = new BekStore();
    const install = store.upsertConnectorInstall({
      kind: "slack",
      provider: "slack",
      externalId: "T_DEMO",
      displayName: "Demo Workspace",
      metadata: {
        teamId: "T_DEMO",
        teamName: "Demo Workspace",
        botToken: "xoxb-this-secret-token-should-redact",
      },
    });

    expect(install).toMatchObject({
      kind: "slack",
      provider: "slack",
      externalId: "T_DEMO",
      displayName: "Demo Workspace",
      status: "active",
      metadata: {
        teamId: "T_DEMO",
        botToken: "[redacted:field]",
      },
    });

    const updated = store.upsertConnectorInstall({
      kind: "slack",
      provider: "slack",
      externalId: "T_DEMO",
      displayName: "Renamed Workspace",
    });
    expect(updated.id).toBe(install.id);
    expect(updated.displayName).toBe("Renamed Workspace");

    const credential = store.upsertCredential({
      connectorInstallId: install.id,
      name: "Slack bot token",
      provider: "slack",
      externalAccountId: "T_DEMO",
      secretRef: "bek-local-vault:slack:T_DEMO:bot",
      scopeSummary: "app_mentions:read,chat:write",
      metadata: {
        vaultEnvelope: {
          ciphertext: "ciphertext",
        },
        rawToken: "xoxb-this-secret-token-should-redact",
      },
    });

    expect(credential).toMatchObject({
      connectorInstallId: install.id,
      provider: "slack",
      externalAccountId: "T_DEMO",
      secretRef: "bek-local-vault:slack:T_DEMO:bot",
      metadata: {
        vaultEnvelope: {
          ciphertext: "ciphertext",
        },
        rawToken: "[redacted:field]",
      },
    });
    expect(JSON.stringify(store.read())).not.toContain(
      "xoxb-this-secret-token-should-redact",
    );
  });
});

describe("Bek admin control plane store", () => {
  it("updates the single visible agent without changing the @bek handle", () => {
    const store = new BekStore();

    const agent = store.updateAgent({
      name: "Bek Teammate",
      description: "Open teammate for the whole company.",
      status: "paused",
    });

    expect(agent).toMatchObject({
      name: "Bek Teammate",
      handle: "@bek",
      status: "paused",
    });
  });

  it("creates and updates channel scopes", () => {
    const store = new BekStore();

    const channel = store.createPlace({
      kind: "slack_channel",
      provider: "slack",
      externalId: "C_PRODUCT",
      name: "#product",
      sensitivity: "confidential",
    });
    expect(channel.id).toMatch(/^place_/);

    const updated = store.updatePlace(channel.id, {
      name: "#product-ai",
      sensitivity: "restricted",
    });
    expect(updated).toMatchObject({
      externalId: "C_PRODUCT",
      name: "#product-ai",
      sensitivity: "restricted",
    });
  });

  it("manages access bundles, place attachments, and grants", () => {
    const store = new BekStore();
    const channel = store.createPlace({
      kind: "slack_channel",
      provider: "slack",
      externalId: "C_SUPPORT",
      name: "#support",
      sensitivity: "internal",
    });
    const bundle = store.createAccessBundle({
      name: "Support",
      description: "Support channel grants",
      attachedPlaceIds: [channel.id],
    });
    expect(bundle.attachedPlaceIds).toEqual([channel.id]);

    const grant = store.createGrant(bundle.id, {
      capability: "mcp.tool",
      resource: "mcp:linear/create_issue",
      decision: "ask",
      risk: "write_external",
      requiresApproval: true,
    });
    expect(grant.id).toMatch(/^grant_/);

    const updatedGrant = store.updateGrant(bundle.id, grant.id, {
      decision: "deny",
      requiresApproval: false,
    });
    expect(updatedGrant).toMatchObject({
      decision: "deny",
      requiresApproval: false,
    });

    const detached = store.detachBundleFromPlace(bundle.id, channel.id);
    expect(detached.attachedPlaceIds).toEqual([]);
  });

  it("updates model and runtime policies used by setup", () => {
    const store = new BekStore();

    expect(
      store.updateModelPolicy("model_auto", {
        defaultModel: "openai/gpt-5.5",
        fallbackModels: ["anthropic/claude-sonnet-4.8", "openai/gpt-5.5"],
        perRunBudgetCents: 500,
      }),
    ).toMatchObject({
      defaultModel: "openai/gpt-5.5",
      fallbackModels: ["anthropic/claude-sonnet-4.8", "openai/gpt-5.5"],
      perRunBudgetCents: 500,
    });

    expect(
      store.updateRuntimeProfile("runtime_answer", {
        runtimeKind: "external",
        adapter: "customer-runner",
      }),
    ).toMatchObject({ runtimeKind: "external", adapter: "customer-runner" });
  });
});

describe("Bek store persistence hook", () => {
  it("flushes changed snapshots in mutation order", async () => {
    const savedNames: string[] = [];
    const store = new BekStore(undefined, {
      onSnapshotChanged: async (snapshot) => {
        savedNames.push(snapshot.agent.name);
      },
    });

    store.updateAgent({ name: "Bek One" });
    store.updateAgent({ name: "Bek Two" });
    await store.flushChanges();

    expect(savedNames).toEqual(["Bek One", "Bek Two"]);
  });

  it("surfaces persistence failures on flush", async () => {
    const store = new BekStore(undefined, {
      onSnapshotChanged: async () => {
        throw new Error("database unavailable");
      },
    });

    store.updateAgent({ name: "Bek Persisted" });
    await expect(store.flushChanges()).rejects.toThrow(/database unavailable/i);
  });

  it("stops queued persistence writes after the first failure", async () => {
    let writes = 0;
    const store = new BekStore(undefined, {
      onSnapshotChanged: async () => {
        writes += 1;
        throw new Error("database unavailable");
      },
    });

    store.updateAgent({ name: "Bek One" });
    store.recordIngressDelivery({
      key: "slack:event:T123:EvPersistence",
      kind: "slack.event",
      status: "processed",
    });

    await expect(store.flushChanges()).rejects.toThrow(/database unavailable/i);
    expect(writes).toBe(1);
  });
});
