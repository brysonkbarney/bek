import { describe, expect, it } from "vitest";

import type { ApprovalRequest, CapabilityGrant } from "@bek/core";

import {
  bekToolContextSchema,
  buildBekToolSet,
  runBekAgentLoop,
  type BekAgentGenerateFn,
} from "./agent-loop";
import type {
  RuntimeObservabilityEvent,
  RuntimeStartInput,
  RuntimeToolProxy,
  RuntimeToolRequest,
  RuntimeToolResult,
} from "./index";

function grant(overrides: Partial<CapabilityGrant> = {}): CapabilityGrant {
  return {
    id: "grant_read",
    capability: "github.read",
    resource: "repo:acme/widgets",
    decision: "allow",
    risk: "read_internal",
    requiresApproval: false,
    ...overrides,
  };
}

interface ProxyHarness {
  proxy: RuntimeToolProxy;
  calls: RuntimeToolRequest[];
}

function fakeProxy(result?: Partial<RuntimeToolResult>): ProxyHarness {
  const calls: RuntimeToolRequest[] = [];
  return {
    calls,
    proxy: {
      async call(request) {
        calls.push(request);
        return { ok: true, output: { echoed: request.input }, ...result };
      },
    },
  };
}

function makeInput(
  overrides: {
    grants?: CapabilityGrant[];
    proxy?: RuntimeToolProxy;
    events?: RuntimeObservabilityEvent[];
    approvals?: ApprovalRequest[];
    prompt?: string;
  } = {},
): RuntimeStartInput {
  const events = overrides.events ?? [];
  const approvals = overrides.approvals ?? [];
  return {
    workItem: {
      orgId: "org_demo",
      runId: "run_1",
      attempt: 1,
      reason: "new_run",
      traceId: "trace_1",
      enqueuedAt: "2026-06-25T00:00:00.000Z",
    },
    run: {
      id: "run_1",
      orgId: "org_demo",
      agentId: "agent_bek",
      requesterPrincipalId: "principal_human",
      placeScopeId: "place_chan",
      trigger: "mention",
      prompt: overrides.prompt ?? "@bek summarize the incident",
      status: "running_tools",
      modelPolicyId: "policy_default",
      runtimeProfileId: "runtime_ai_sdk",
      estimatedCostCents: 5,
      actualCostCents: 0,
      createdAt: "2026-06-25T00:00:00.000Z",
      updatedAt: "2026-06-25T00:00:00.000Z",
    },
    requester: {
      id: "principal_human",
      orgId: "org_demo",
      kind: "human",
      displayName: "Ada",
    },
    place: {
      id: "place_chan",
      orgId: "org_demo",
      kind: "slack_channel",
      provider: "slack",
      externalId: "C123",
      name: "incidents",
      sensitivity: "internal",
    },
    accessBundles: [],
    modelPolicy: {
      id: "policy_default",
      orgId: "org_demo",
      name: "Default",
      defaultModel: "openai/gpt-5.4",
      fallbackModels: [],
      perRunBudgetCents: 50,
    },
    modelRoute: {
      provider: "openai",
      model: "openai/gpt-5.4",
      reason: "test",
      estimatedCostCents: 5,
    },
    runtimeProfile: {
      id: "runtime_ai_sdk",
      orgId: "org_demo",
      name: "AI SDK",
      runtimeKind: "ai_sdk",
      adapter: "ai-sdk-agent",
    },
    grants: overrides.grants ?? [grant()],
    tools: overrides.proxy ?? fakeProxy().proxy,
    async requestApproval(checkpoint): Promise<ApprovalRequest> {
      const approval: ApprovalRequest = {
        id: `approval_${approvals.length + 1}`,
        orgId: "org_demo",
        runId: "run_1",
        action: checkpoint.action,
        risk: checkpoint.risk,
        status: "pending",
        payloadHash: "hash",
        requestedByPrincipalId: "principal_human",
        createdAt: "2026-06-25T00:00:00.000Z",
        expiresAt: "2026-06-25T01:00:00.000Z",
      };
      approvals.push(approval);
      return approval;
    },
    emit(event) {
      events.push(event);
    },
  };
}

describe("buildBekToolSet", () => {
  it("routes a tool call through the governed proxy and emits events", async () => {
    const harness = fakeProxy();
    const events: RuntimeObservabilityEvent[] = [];
    const { tools, grantByToolName } = buildBekToolSet({
      proxy: harness.proxy,
      grants: [grant()],
      emit: (event) => {
        events.push(event);
      },
    });

    const name = [...grantByToolName.keys()][0]!;
    expect(name).toBe("github_read");
    const execute = tools[name]!.execute!;
    const output = (await execute({ path: "README.md" }, {
      toolCallId: "t1",
      messages: [],
    } as never)) as RuntimeToolResult;

    expect(output.ok).toBe(true);
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]).toMatchObject({
      name: "github_read",
      input: { path: "README.md" },
      risk: "read_internal",
    });
    expect(events.map((event) => event.type)).toEqual([
      "tool.requested",
      "tool.completed",
    ]);
  });

  it("blocks an approval-required grant until it is approved", async () => {
    const harness = fakeProxy();
    const required: CapabilityGrant[] = [];
    const { tools } = buildBekToolSet({
      proxy: harness.proxy,
      grants: [
        grant({
          id: "g_pr",
          capability: "github.pr",
          risk: "write_external",
          requiresApproval: true,
        }),
      ],
      emit: () => {},
      onApprovalRequired: (g) => required.push(g),
    });
    const execute = tools.github_pr!.execute!;
    const output = (await execute({}, {
      toolCallId: "t1",
      messages: [],
    } as never)) as RuntimeToolResult;

    expect(output).toMatchObject({ ok: false, error: "approval_required" });
    expect(harness.calls).toHaveLength(0);
    expect(required.map((g) => g.id)).toEqual(["g_pr"]);
  });

  it("executes an approval-required grant once approved", async () => {
    const harness = fakeProxy();
    const { tools } = buildBekToolSet({
      proxy: harness.proxy,
      grants: [
        grant({
          id: "g_pr",
          capability: "github.pr",
          risk: "write_external",
          requiresApproval: true,
        }),
      ],
      emit: () => {},
      isApproved: () => true,
    });
    const output = (await tools.github_pr!.execute!({}, {
      toolCallId: "t1",
      messages: [],
    } as never)) as RuntimeToolResult;

    expect(output.ok).toBe(true);
    expect(harness.calls).toHaveLength(1);
  });

  it("denies a policy-denied grant without calling the proxy", async () => {
    const harness = fakeProxy();
    const { tools } = buildBekToolSet({
      proxy: harness.proxy,
      grants: [grant({ id: "g_deny", decision: "deny" })],
      emit: () => {},
    });
    const output = (await tools.github_read!.execute!({}, {
      toolCallId: "t1",
      messages: [],
    } as never)) as RuntimeToolResult;

    expect(output).toMatchObject({ ok: false, error: "policy_denied" });
    expect(harness.calls).toHaveLength(0);
  });

  it("gives colliding capabilities unique tool names", () => {
    const harness = fakeProxy();
    const { tools, grantByToolName } = buildBekToolSet({
      proxy: harness.proxy,
      grants: [
        grant({ id: "g1", capability: "github.read" }),
        grant({ id: "g2", capability: "github.read" }),
        grant({ id: "g3", capability: "github.read" }),
      ],
      emit: () => {},
    });

    const names = Object.keys(tools);
    expect(names).toEqual(["github_read", "github_read_2", "github_read_3"]);
    // Each unique name maps back to a distinct grant.
    expect(grantByToolName.get("github_read")?.id).toBe("g1");
    expect(grantByToolName.get("github_read_2")?.id).toBe("g2");
    expect(grantByToolName.get("github_read_3")?.id).toBe("g3");
  });

  it("maps a proxy ok:false result to a tool.denied event", async () => {
    const harness = fakeProxy({ ok: false, error: "upstream_unavailable" });
    const events: RuntimeObservabilityEvent[] = [];
    const { tools } = buildBekToolSet({
      proxy: harness.proxy,
      grants: [grant()],
      emit: (event) => {
        events.push(event);
      },
    });

    const output = (await tools.github_read!.execute!({}, {
      toolCallId: "t1",
      messages: [],
    } as never)) as RuntimeToolResult;

    expect(output).toMatchObject({ ok: false, error: "upstream_unavailable" });
    expect(harness.calls).toHaveLength(1);
    expect(events.map((event) => event.type)).toEqual([
      "tool.requested",
      "tool.denied",
    ]);
    const denied = events.find((event) => event.type === "tool.denied");
    expect(denied?.data).toMatchObject({
      tool: "github_read",
      ok: false,
      error: "upstream_unavailable",
    });
  });

  it("uses a secret-free identity context schema", () => {
    const parsed = bekToolContextSchema.safeParse({
      orgId: "org_demo",
      identityId: "id_1",
      placeId: "place_chan",
      requesterId: "principal_human",
      token: "super-secret",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // The schema strips unknown (secret-shaped) keys; only identity remains.
      expect(parsed.data).not.toHaveProperty("token");
      expect(Object.keys(parsed.data).sort()).toEqual([
        "identityId",
        "orgId",
        "placeId",
        "requesterId",
      ]);
    }
  });
});

describe("runBekAgentLoop", () => {
  it("completes and prices usage into the run cost", async () => {
    const events: RuntimeObservabilityEvent[] = [];
    const input = makeInput({ events });
    const generate: BekAgentGenerateFn = async () => ({
      text: "Investigation complete.",
      usage: { inputTokens: 1000, outputTokens: 200 },
      finishReason: "stop",
      toolCallCount: 1,
    });

    const result = await runBekAgentLoop(input, {
      model: "openai/gpt-5.4",
      generate,
      priceUsageCents: (usage) =>
        Math.ceil(
          ((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)) / 100,
        ),
    });

    expect(result).toMatchObject({
      status: "completed",
      finalText: "Investigation complete.",
      actualCostCents: 12,
    });
    expect(events.map((e) => e.type)).toEqual([
      "runtime.started",
      "model.requested",
      "model.completed",
      "runtime.completed",
    ]);
  });

  it("passes a secret-free identity context to every tool", async () => {
    const input = makeInput({});
    let capturedContext: Record<string, unknown> | undefined;
    const generate: BekAgentGenerateFn = async (params) => {
      capturedContext = params.toolsContext;
      return { text: "ok" };
    };
    await runBekAgentLoop(input, { model: "openai/gpt-5.4", generate });

    const contexts = Object.values(capturedContext ?? {});
    expect(contexts.length).toBeGreaterThan(0);
    for (const ctx of contexts) {
      expect(ctx).not.toHaveProperty("token");
      expect(ctx).toMatchObject({
        orgId: "org_demo",
        placeId: "place_chan",
        requesterId: "principal_human",
      });
    }
  });

  it("suspends with awaiting_approval when a tool needs approval", async () => {
    const approvals: ApprovalRequest[] = [];
    const events: RuntimeObservabilityEvent[] = [];
    const input = makeInput({
      events,
      approvals,
      grants: [
        grant({
          id: "g_pr",
          capability: "github.pr",
          risk: "write_external",
          requiresApproval: true,
        }),
      ],
    });
    // Fake model "invokes" the approval-gated tool, which records a pending
    // approval without calling the proxy.
    const generate: BekAgentGenerateFn = async (params) => {
      const toolName = Object.keys(params.tools)[0]!;
      await params.tools[toolName]!.execute!({}, {
        toolCallId: "t1",
        messages: [],
      } as never);
      return { text: "I need approval to open a PR." };
    };

    const result = await runBekAgentLoop(input, {
      model: "openai/gpt-5.4",
      generate,
    });

    expect(result.status).toBe("awaiting_approval");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      action: "github.pr",
      risk: "write_external",
    });
  });

  it("carries the generated text into the awaiting_approval result", async () => {
    const input = makeInput({
      grants: [
        grant({
          id: "g_pr",
          capability: "github.pr",
          risk: "write_external",
          requiresApproval: true,
        }),
      ],
    });
    const generate: BekAgentGenerateFn = async (params) => {
      const toolName = Object.keys(params.tools)[0]!;
      await params.tools[toolName]!.execute!({}, {
        toolCallId: "t1",
        messages: [],
      } as never);
      return { text: "I need approval to open a PR." };
    };

    const result = await runBekAgentLoop(input, {
      model: "openai/gpt-5.4",
      generate,
    });

    expect(result).toMatchObject({
      status: "awaiting_approval",
      finalText: "I need approval to open a PR.",
    });
  });

  it("falls back to the route/run estimate when priceUsageCents returns 0", async () => {
    const input = makeInput({});
    // The route estimate (5) and run estimate (5) are both 5; the priced value
    // of 0 must be ignored in favor of the estimate ceiling.
    const generate: BekAgentGenerateFn = async () => ({
      text: "done",
      usage: { inputTokens: 0, outputTokens: 0 },
    });

    const result = await runBekAgentLoop(input, {
      model: "openai/gpt-5.4",
      generate,
      priceUsageCents: () => 0,
    });

    expect(result).toMatchObject({
      status: "completed",
      actualCostCents: 5,
    });
  });

  it("uses at least 1 cent when every cost source is zero", async () => {
    const input = makeInput({});
    input.run.estimatedCostCents = 0;
    input.modelRoute.estimatedCostCents = 0;
    const generate: BekAgentGenerateFn = async () => ({ text: "done" });

    const result = await runBekAgentLoop(input, {
      model: "openai/gpt-5.4",
      generate,
      priceUsageCents: () => 0,
    });

    expect(result.actualCostCents).toBe(1);
  });

  it("returns failed when the model call throws", async () => {
    const input = makeInput({});
    const generate: BekAgentGenerateFn = async () => {
      throw new Error("provider outage");
    };
    const result = await runBekAgentLoop(input, {
      model: "openai/gpt-5.4",
      generate,
    });
    expect(result).toMatchObject({
      status: "failed",
      error: "provider outage",
    });
  });
});
