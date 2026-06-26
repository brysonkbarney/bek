import { describe, expect, it } from "vitest";
import { createApprovalRequest, hashPayload } from "./runs";

/**
 * Approval hash drift coverage for the high-risk approval step types Bek gates:
 *  - budget step-ups (run/day budget increases)
 *  - sandbox grants (command/resource/risk)
 *  - MCP tool invocations (tool name, input hash, identity)
 *  - runtime writes (action, resource, files)
 *
 * These tests pin the contract that the approval payload hash:
 *   1. is STABLE for semantically identical payloads (key-order independent),
 *   2. is SENSITIVE to drift in any meaningful field,
 *   3. binds approver/requester/identity context, and
 *   4. does not leak secrets into the redacted approval metadata.
 *
 * GitHub PR plan drift is covered separately in @bek/github.
 */

// Representative, secret-free payloads for each gated approval step type.
const budgetStepUpPayload = {
  kind: "budget.step_up",
  scope: "day",
  fromCents: 5_000,
  toCents: 25_000,
  amountCents: 20_000,
  currency: "USD",
  expiresAt: "2026-06-26T00:00:00.000Z",
};

const sandboxGrantPayload = {
  kind: "sandbox.grant",
  command: "rm -rf ./build",
  resource: "fs:/workspace/build",
  risk: "privileged",
  ttlSeconds: 900,
};

const mcpToolPayload = {
  kind: "mcp.tool",
  tool: "github.create_pull_request",
  inputHash: hashPayload({ title: "Ship it", base: "main", head: "feature" }),
  identity: {
    principalId: "prin_agent_1",
    connectorId: "conn_github_1",
  },
};

const runtimeWritePayload = {
  kind: "runtime.write",
  action: "write",
  resource: "fs:/workspace/src",
  files: ["src/index.ts", "src/runs.ts"],
};

/**
 * Mutate one field of a base payload and assert the hash changes. `mutate`
 * receives a structured clone so callers never accidentally share references.
 */
function expectFieldDrift<T extends Record<string, unknown>>(
  base: T,
  field: string,
  mutate: (clone: T) => void,
): void {
  const baseHash = hashPayload(base);
  const drifted = structuredClone(base);
  mutate(drifted);
  expect(
    hashPayload(drifted),
    `changing "${field}" should change the approval hash`,
  ).not.toBe(baseHash);
}

describe("approval hash drift", () => {
  describe("stability", () => {
    it("produces the same hash for key-order-independent identical payloads", () => {
      const reordered = {
        expiresAt: budgetStepUpPayload.expiresAt,
        currency: budgetStepUpPayload.currency,
        amountCents: budgetStepUpPayload.amountCents,
        toCents: budgetStepUpPayload.toCents,
        fromCents: budgetStepUpPayload.fromCents,
        scope: budgetStepUpPayload.scope,
        kind: budgetStepUpPayload.kind,
      };
      expect(hashPayload(reordered)).toBe(hashPayload(budgetStepUpPayload));
    });

    it("is order-independent for nested objects and stable for arrays", () => {
      const mcpReordered = {
        identity: {
          connectorId: mcpToolPayload.identity.connectorId,
          principalId: mcpToolPayload.identity.principalId,
        },
        inputHash: mcpToolPayload.inputHash,
        tool: mcpToolPayload.tool,
        kind: mcpToolPayload.kind,
      };
      expect(hashPayload(mcpReordered)).toBe(hashPayload(mcpToolPayload));

      // Same files in the same order hash identically (array order is meaningful).
      const runtimeClone = structuredClone(runtimeWritePayload);
      expect(hashPayload(runtimeClone)).toBe(hashPayload(runtimeWritePayload));
    });

    it("treats explicit undefined fields as absent", () => {
      expect(hashPayload({ ...budgetStepUpPayload, note: undefined })).toBe(
        hashPayload(budgetStepUpPayload),
      );
    });
  });

  describe("budget step-up drift", () => {
    it("changes the hash when the increase amount drifts", () => {
      expectFieldDrift(budgetStepUpPayload, "amountCents", (clone) => {
        clone.amountCents = 20_001;
      });
    });

    it("changes the hash when the resulting ceiling drifts", () => {
      expectFieldDrift(budgetStepUpPayload, "toCents", (clone) => {
        clone.toCents = 25_001;
      });
    });

    it("changes the hash when the budget scope drifts (run vs day)", () => {
      expectFieldDrift(budgetStepUpPayload, "scope", (clone) => {
        clone.scope = "run";
      });
    });

    it("changes the hash when the expiry drifts", () => {
      expectFieldDrift(budgetStepUpPayload, "expiresAt", (clone) => {
        clone.expiresAt = "2026-06-27T00:00:00.000Z";
      });
    });
  });

  describe("sandbox grant drift", () => {
    it("changes the hash when the command drifts", () => {
      expectFieldDrift(sandboxGrantPayload, "command", (clone) => {
        clone.command = "rm -rf /";
      });
    });

    it("changes the hash when the granted resource drifts", () => {
      expectFieldDrift(sandboxGrantPayload, "resource", (clone) => {
        clone.resource = "fs:/workspace";
      });
    });

    it("changes the hash when the risk level drifts", () => {
      expectFieldDrift(sandboxGrantPayload, "risk", (clone) => {
        clone.risk = "standard";
      });
    });
  });

  describe("MCP tool invocation drift", () => {
    it("changes the hash when the tool name drifts", () => {
      expectFieldDrift(mcpToolPayload, "tool", (clone) => {
        clone.tool = "github.merge_pull_request";
      });
    });

    it("changes the hash when the tool input hash drifts", () => {
      expectFieldDrift(mcpToolPayload, "inputHash", (clone) => {
        clone.inputHash = hashPayload({
          title: "Ship it",
          base: "main",
          head: "other",
        });
      });
    });

    it("binds identity: changing the principal changes the hash", () => {
      expectFieldDrift(mcpToolPayload, "identity.principalId", (clone) => {
        clone.identity.principalId = "prin_agent_2";
      });
    });

    it("binds identity: changing the connector changes the hash", () => {
      expectFieldDrift(mcpToolPayload, "identity.connectorId", (clone) => {
        clone.identity.connectorId = "conn_github_2";
      });
    });
  });

  describe("runtime write drift", () => {
    it("changes the hash when the action drifts", () => {
      expectFieldDrift(runtimeWritePayload, "action", (clone) => {
        clone.action = "delete";
      });
    });

    it("changes the hash when the resource drifts", () => {
      expectFieldDrift(runtimeWritePayload, "resource", (clone) => {
        clone.resource = "fs:/workspace/dist";
      });
    });

    it("changes the hash when a written file is added", () => {
      expectFieldDrift(runtimeWritePayload, "files[+]", (clone) => {
        clone.files = [...runtimeWritePayload.files, "src/secret.ts"];
      });
    });

    it("changes the hash when a written file path drifts", () => {
      expectFieldDrift(runtimeWritePayload, "files[0]", (clone) => {
        clone.files = ["src/index.tsx", "src/runs.ts"];
      });
    });

    it("changes the hash when the file order drifts", () => {
      expectFieldDrift(runtimeWritePayload, "files order", (clone) => {
        clone.files = ["src/runs.ts", "src/index.ts"];
      });
    });
  });

  describe("approver / requester context binding", () => {
    const base = {
      orgId: "org_demo",
      runId: "run_1",
      action: "budget.step_up",
      payload: budgetStepUpPayload,
      risk: "privileged" as const,
      now: "2026-06-25T00:00:00.000Z",
      expiresAt: "2026-06-25T00:30:00.000Z",
    };

    function approvalFor(requestedByPrincipalId: string) {
      return createApprovalRequest(
        base.orgId,
        base.runId,
        requestedByPrincipalId,
        base.action,
        base.payload,
        base.risk,
        base.now,
        base.expiresAt,
      );
    }

    it("produces an identical payloadHash for identical payloads regardless of requester", () => {
      // payloadHash binds the payload only; requester identity lives in a
      // dedicated field so the same action by two principals stays comparable.
      const a = approvalFor("prin_requester_1");
      const b = approvalFor("prin_requester_2");
      expect(a.payloadHash).toBe(b.payloadHash);
      expect(a.requestedByPrincipalId).toBe("prin_requester_1");
      expect(b.requestedByPrincipalId).toBe("prin_requester_2");
    });

    it("binds requester/identity when it is part of the hashed payload", () => {
      // For step types that fold identity into the payload (e.g. MCP tool
      // invocations), the requester/identity drift IS hashed.
      expectFieldDrift(mcpToolPayload, "identity.principalId", (clone) => {
        clone.identity.principalId = "prin_agent_other";
      });
    });

    it("changes payloadHash when the underlying action payload drifts", () => {
      const original = createApprovalRequest(
        base.orgId,
        base.runId,
        "prin_requester_1",
        base.action,
        budgetStepUpPayload,
        base.risk,
        base.now,
        base.expiresAt,
      );
      const drifted = createApprovalRequest(
        base.orgId,
        base.runId,
        "prin_requester_1",
        base.action,
        { ...budgetStepUpPayload, toCents: 99_999 },
        base.risk,
        base.now,
        base.expiresAt,
      );
      expect(drifted.payloadHash).not.toBe(original.payloadHash);
    });
  });

  describe("secret redaction in approval metadata", () => {
    it("redacts secret-shaped fields from payloadMetadata", () => {
      const approval = createApprovalRequest(
        "org_demo",
        "run_1",
        "prin_requester_1",
        "mcp.tool",
        {
          ...mcpToolPayload,
          botToken: "xoxb-EXAMPLETOKEN-secret",
          identity: {
            ...mcpToolPayload.identity,
            accessToken: "Bearer abcdefghijklmnop123456",
          },
        },
        "privileged",
      );

      const serialized = JSON.stringify(approval.payloadMetadata);
      expect(serialized).not.toContain("xoxb-EXAMPLETOKEN-secret");
      expect(serialized).not.toContain("abcdefghijklmnop123456");
      expect(approval.payloadMetadata).toMatchObject({
        botToken: "[redacted:field]",
        identity: { accessToken: "[redacted:field]" },
      });
      // Non-secret context survives redaction so reviewers can still see it.
      expect(approval.payloadMetadata).toMatchObject({
        tool: "github.create_pull_request",
        identity: { principalId: "prin_agent_1" },
      });
    });
  });
});
