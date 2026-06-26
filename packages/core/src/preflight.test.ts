import { describe, expect, it } from "vitest";
import { evaluateDeploymentPreflight } from "./preflight";

function find(
  report: ReturnType<typeof evaluateDeploymentPreflight>,
  key: string,
) {
  return report.checks.find((check) => check.key === key);
}

describe("evaluateDeploymentPreflight", () => {
  it("accepts the local unauthenticated bypass in local mode", () => {
    const report = evaluateDeploymentPreflight(
      { BEK_ALLOW_UNAUTHENTICATED_LOCAL: "true" },
      "local",
    );
    expect(report.ok).toBe(true);
    expect(find(report, "admin_auth")?.severity).toBe("pass");
  });

  it("fails when the local bypass is enabled in a hosted deployment", () => {
    const report = evaluateDeploymentPreflight(
      { BEK_ALLOW_UNAUTHENTICATED_LOCAL: "true" },
      "hosted",
    );
    expect(report.ok).toBe(false);
    expect(find(report, "admin_auth")?.severity).toBe("fail");
  });

  it("fails a postgres deployment with no DATABASE_URL", () => {
    const report = evaluateDeploymentPreflight(
      {
        BEK_ADMIN_API_TOKEN: "a-strong-admin-token-value-123",
        BEK_STORAGE: "postgres",
      },
      "self_hosted",
    );
    expect(find(report, "persistence")?.severity).toBe("fail");
    expect(report.ok).toBe(false);
  });

  it("fails Slack config without a signing secret", () => {
    const report = evaluateDeploymentPreflight(
      {
        BEK_ADMIN_API_TOKEN: "a-strong-admin-token-value-123",
        BEK_STORAGE: "postgres",
        DATABASE_URL: "postgres://x",
        SLACK_BOT_TOKEN: "xoxb-1",
      },
      "self_hosted",
    );
    expect(find(report, "slack_signing")?.severity).toBe("fail");
  });

  it("passes a well-configured hosted deployment with warnings only where expected", () => {
    const report = evaluateDeploymentPreflight(
      {
        BEK_ADMIN_API_TOKEN: "a-strong-admin-token-value-123",
        BEK_REQUIRE_ADMIN_AUTH: "true",
        BEK_SESSION_SECRET: "session-secret-value",
        BEK_STORAGE: "postgres",
        DATABASE_URL: "postgres://x",
        BEK_CREDENTIAL_MASTER_KEY: "hex:abc",
        BEK_PUBLIC_URL: "https://bek.example.com",
        NODE_ENV: "production",
      },
      "hosted",
    );
    expect(report.ok).toBe(true);
    expect(find(report, "admin_auth")?.severity).toBe("pass");
    expect(find(report, "persistence")?.severity).toBe("pass");
  });

  it("warns on a weak admin token", () => {
    const report = evaluateDeploymentPreflight(
      { BEK_ADMIN_API_TOKEN: "short" },
      "local",
    );
    expect(find(report, "admin_token_strength")?.severity).toBe("warn");
  });
});
