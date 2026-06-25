import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertGitHubAppConfig,
  createGitHubInstallationTokenProviderFromEnv,
  normalizeGitHubPrivateKey,
  validateGitHubAppConfig,
} from "./config";
import { createGitHubInstallationTokenRequest } from "./tokens";

const privateKey =
  "-----BEGIN RSA PRIVATE KEY-----\\nabc123\\n-----END RSA PRIVATE KEY-----";
const realPrivateKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
}).privateKey.export({ type: "pkcs1", format: "pem" });

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

  it("creates an installation token provider from validated env", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const provider = createGitHubInstallationTokenProviderFromEnv(
      {
        GITHUB_APP_ID: "12345",
        GITHUB_APP_PRIVATE_KEY: realPrivateKey,
        GITHUB_APP_WEBHOOK_SECRET: "a-webhook-secret-with-length",
        GITHUB_API_BASE_URL: "https://api.github.test",
      },
      {
        now: () => new Date("2026-01-02T03:04:05.000Z"),
        fetch: async (input, init) => {
          calls.push({
            url: String(input),
            method: init?.method ?? "GET",
          });
          return new Response(
            JSON.stringify({
              token: "ghs_installation_token",
              expires_at: "2026-01-02T04:04:05.000Z",
              repository_selection: "selected",
              permissions: {
                contents: "write",
                metadata: "read",
                pull_requests: "write",
              },
            }),
            {
              status: 201,
              headers: { "content-type": "application/json" },
            },
          );
        },
      },
    );

    await expect(
      provider.getInstallationToken(
        createGitHubInstallationTokenRequest({
          installationId: 98765,
          repository: "github:redohq/checkout",
          permissions: {
            contents: "write",
            metadata: "read",
            pull_requests: "write",
          },
        }),
      ),
    ).resolves.toMatchObject({
      installationId: "98765",
      token: "ghs_installation_token",
    });
    expect(calls).toEqual([
      {
        url: "https://api.github.test/app/installations/98765/access_tokens",
        method: "POST",
      },
    ]);
  });
});
