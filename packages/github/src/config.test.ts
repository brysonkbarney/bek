import { describe, expect, it } from "vitest";
import {
  assertGitHubAppConfig,
  normalizeGitHubPrivateKey,
  validateGitHubAppConfig,
} from "./config";

const privateKey =
  "-----BEGIN RSA PRIVATE KEY-----\\nabc123\\n-----END RSA PRIVATE KEY-----";

describe("GitHub App config", () => {
  it("validates and normalizes required GitHub App settings", () => {
    const result = validateGitHubAppConfig({
      GITHUB_APP_ID: "12345",
      GITHUB_APP_PRIVATE_KEY: privateKey,
      GITHUB_APP_WEBHOOK_SECRET: "a-webhook-secret-with-length",
      GITHUB_APP_CLIENT_ID: "Iv1.example",
      GITHUB_APP_CLIENT_SECRET: "client-secret",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected config to validate");
    }
    expect(result.config).toMatchObject({
      appId: "12345",
      webhookSecret: "a-webhook-secret-with-length",
      clientId: "Iv1.example",
      clientSecret: "client-secret",
    });
    expect(result.config.privateKey).toContain("\nabc123\n");
    expect(result.errors).toEqual([]);
  });

  it("reports missing and malformed required settings without exposing secrets", () => {
    const result = validateGitHubAppConfig({
      GITHUB_APP_ID: "not-a-number",
      GITHUB_APP_PRIVATE_KEY: "secret-ish",
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      "GITHUB_APP_ID must be a positive integer string.",
      "GITHUB_APP_PRIVATE_KEY must be a PEM private key.",
      "GITHUB_APP_WEBHOOK_SECRET is required.",
    ]);
    expect(result.errors.join(" ")).not.toContain("secret-ish");
  });

  it("allows the legacy webhook secret env name but warns on weak local secrets", () => {
    const result = validateGitHubAppConfig({
      GITHUB_APP_ID: "12345",
      GITHUB_APP_PRIVATE_KEY: privateKey,
      GITHUB_WEBHOOK_SECRET: "short",
    });

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([
      "GITHUB_APP_WEBHOOK_SECRET should be at least 16 characters for shared environments.",
    ]);
  });

  it("throws a compact config error when asserted", () => {
    expect(() => assertGitHubAppConfig({})).toThrow(
      "Invalid GitHub App config:",
    );
  });

  it("normalizes escaped PEM newlines", () => {
    expect(normalizeGitHubPrivateKey(privateKey)).toBe(
      "-----BEGIN RSA PRIVATE KEY-----\nabc123\n-----END RSA PRIVATE KEY-----",
    );
  });
});
