import { describe, expect, it } from "vitest";

import {
  ALL_ROLES,
  ALL_SCOPES,
  authorizeScope,
  isRole,
  requiredScopeForRequest,
  roleHasScope,
  scopesForRole,
  type Role,
} from "./rbac";

describe("rbac roles and scopes", () => {
  it("grants the owner every scope", () => {
    for (const scope of ALL_SCOPES) {
      expect(roleHasScope("owner", scope)).toBe(true);
    }
  });

  it("withholds billing from admin but grants config + ops", () => {
    expect(roleHasScope("admin", "billing.manage")).toBe(false);
    expect(roleHasScope("admin", "slack.manage")).toBe(true);
    expect(roleHasScope("admin", "writes.approve")).toBe(true);
    expect(roleHasScope("admin", "audit.export")).toBe(true);
  });

  it("limits operator to running the live system, not config", () => {
    expect(roleHasScope("operator", "worker.operate")).toBe(true);
    expect(roleHasScope("operator", "runs.create")).toBe(true);
    expect(roleHasScope("operator", "writes.approve")).toBe(true);
    expect(roleHasScope("operator", "slack.manage")).toBe(false);
    expect(roleHasScope("operator", "models.manage")).toBe(false);
  });

  it("limits approver to deciding approvals", () => {
    expect(roleHasScope("approver", "writes.approve")).toBe(true);
    expect(roleHasScope("approver", "runs.create")).toBe(false);
    expect(roleHasScope("approver", "slack.manage")).toBe(false);
  });

  it("limits developer to creating runs", () => {
    expect(roleHasScope("developer", "runs.create")).toBe(true);
    expect(roleHasScope("developer", "runs.cancel")).toBe(false);
    expect(roleHasScope("developer", "writes.approve")).toBe(false);
  });

  it("gives viewer no write scopes", () => {
    const writeScopes = ALL_SCOPES.filter((scope) => scope !== "audit.view");
    for (const scope of writeScopes) {
      expect(roleHasScope("viewer", scope)).toBe(false);
    }
    expect(roleHasScope("viewer", "audit.view")).toBe(true);
  });

  it("limits billing_admin to billing", () => {
    expect(roleHasScope("billing_admin", "billing.manage")).toBe(true);
    expect(roleHasScope("billing_admin", "slack.manage")).toBe(false);
    expect(roleHasScope("billing_admin", "runs.create")).toBe(false);
  });

  it("validates role strings", () => {
    expect(isRole("owner")).toBe(true);
    expect(isRole("nope")).toBe(false);
  });

  it("returns a structured authorize decision", () => {
    expect(authorizeScope("viewer", "slack.manage")).toMatchObject({
      allowed: false,
      role: "viewer",
      scope: "slack.manage",
    });
    expect(authorizeScope("owner", "slack.manage").allowed).toBe(true);
  });

  it("exposes a stable scope list per role", () => {
    for (const role of ALL_ROLES) {
      expect(scopesForRole(role as Role).length).toBeGreaterThan(0);
    }
  });
});

describe("requiredScopeForRequest", () => {
  it("treats reads as open (null) except audit export", () => {
    expect(requiredScopeForRequest("GET", "/api/connectors/slack")).toBeNull();
    expect(requiredScopeForRequest("GET", "/api/runs")).toBeNull();
    expect(requiredScopeForRequest("GET", "/api/audit-events")).toBeNull();
    expect(requiredScopeForRequest("GET", "/api/audit-events/export")).toBe(
      "audit.export",
    );
  });

  it("maps approval decisions to writes.approve", () => {
    expect(
      requiredScopeForRequest("POST", "/api/approvals/approval_1/approve"),
    ).toBe("writes.approve");
    expect(
      requiredScopeForRequest("POST", "/api/approvals/approval_1/deny"),
    ).toBe("writes.approve");
  });

  it("maps run creation and cancellation", () => {
    expect(requiredScopeForRequest("POST", "/api/runs")).toBe("runs.create");
    expect(requiredScopeForRequest("POST", "/api/runs/run_1/cancel")).toBe(
      "runs.cancel",
    );
  });

  it("maps worker and outbox operations", () => {
    expect(requiredScopeForRequest("POST", "/api/worker/drain")).toBe(
      "worker.operate",
    );
    expect(requiredScopeForRequest("POST", "/api/outbound/slack/drain")).toBe(
      "worker.operate",
    );
    expect(
      requiredScopeForRequest("POST", "/api/worker/dead-letter/redrive"),
    ).toBe("worker.operate");
  });

  it("maps connector and config management", () => {
    expect(requiredScopeForRequest("POST", "/api/connectors/mcp")).toBe(
      "mcp.manage",
    );
    expect(
      requiredScopeForRequest("PATCH", "/api/connectors/mcp/server_1"),
    ).toBe("mcp.manage");
    expect(requiredScopeForRequest("POST", "/api/slack/manual-install")).toBe(
      "slack.manage",
    );
    expect(requiredScopeForRequest("POST", "/api/channels")).toBe(
      "channels.manage",
    );
    expect(requiredScopeForRequest("POST", "/api/access-bundles")).toBe(
      "access.manage",
    );
    expect(
      requiredScopeForRequest("PATCH", "/api/model-policies/policy_1"),
    ).toBe("models.manage");
    expect(
      requiredScopeForRequest("PATCH", "/api/runtime-profiles/runtime_1"),
    ).toBe("runtime.manage");
  });

  it("falls back to settings.manage for other writes", () => {
    expect(requiredScopeForRequest("PATCH", "/api/agent")).toBe(
      "settings.manage",
    );
    expect(
      requiredScopeForRequest(
        "PATCH",
        "/api/principals/principal_1/external-identity",
      ),
    ).toBe("settings.manage");
  });
});
