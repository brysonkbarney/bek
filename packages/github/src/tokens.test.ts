import { describe, expect, it } from "vitest";
import {
  FakeGitHubInstallationTokenProvider,
  assertGitHubInstallationTokenLease,
  createGitHubInstallationTokenRequest,
  normalizeGitHubInstallationId,
  normalizeGitHubInstallationTokenPermissions,
  validateGitHubInstallationTokenLease,
} from "./tokens";

describe("GitHub installation token primitives", () => {
  it("normalizes installation token requests without minting real tokens", () => {
    expect(
      createGitHubInstallationTokenRequest({
        installationId: " 123 ",
        repository: "RedoHQ/Checkout",
        permissions: {
          contents: "write",
          metadata: "read",
          pull_requests: "write",
        },
      }),
    ).toMatchObject({
      installationId: "123",
      repository: {
        resource: "github:redohq/checkout",
      },
      permissions: {
        contents: "write",
        metadata: "read",
        pull_requests: "write",
      },
    });
  });

  it("rejects malformed installation ids and unsupported permissions", () => {
    expect(() => normalizeGitHubInstallationId("0")).toThrow(
      "positive integer",
    );
    expect(() =>
      normalizeGitHubInstallationTokenPermissions({
        deployments: "write",
      } as never),
    ).toThrow("Unsupported GitHub installation permission");
  });

  it("provides deterministic fake installation tokens for local workers", async () => {
    const provider = new FakeGitHubInstallationTokenProvider({
      now: () => new Date("2026-01-02T03:04:05.000Z"),
      ttlMs: 10_000,
    });

    const token = await provider.getInstallationToken({
      installationId: 456,
      repository: "github:redohq/checkout",
      permissions: { contents: "write" },
    });

    expect(token).toMatchObject({
      type: "github.installation_token",
      installationId: "456",
      token: "fake-gh-installation-token:456:github:redohq/checkout:1",
      expiresAt: "2026-01-02T03:04:15.000Z",
      permissions: { contents: "write" },
    });
    expect(provider.issuedTokens()).toHaveLength(1);

    token.permissions.contents = "read";
    expect(provider.issuedTokens()[0]?.permissions.contents).toBe("write");
  });

  it("validates repo-scoped token leases and returns redacted metadata", async () => {
    const provider = new FakeGitHubInstallationTokenProvider({
      now: () => new Date("2026-01-02T03:04:05.000Z"),
      ttlMs: 10 * 60 * 1000,
    });
    const request = createGitHubInstallationTokenRequest({
      installationId: 456,
      repository: "github:redohq/checkout",
      permissions: { contents: "read", metadata: "read" },
    });
    const token = await provider.getInstallationToken({
      ...request,
      permissions: { contents: "write", metadata: "read" },
    });

    const lease = assertGitHubInstallationTokenLease({
      token,
      request,
      now: () => new Date("2026-01-02T03:04:15.000Z"),
      minTtlMs: 60_000,
    });

    expect(lease).toMatchObject({
      type: "github.installation_token_lease",
      installationId: "456",
      expiresAt: "2026-01-02T03:14:05.000Z",
      repository: { resource: "github:redohq/checkout" },
      permissions: { contents: "write", metadata: "read" },
    });
    expect(JSON.stringify(lease)).not.toContain(token.token);
  });

  it("rejects token leases with the wrong repo, missing access, or short TTL", () => {
    const validation = validateGitHubInstallationTokenLease({
      token: {
        type: "github.installation_token",
        installationId: "456",
        token: "secret-token",
        expiresAt: "2026-01-02T03:05:00.000Z",
        repository: createGitHubInstallationTokenRequest({
          installationId: 456,
          repository: "github:redohq/docs",
          permissions: {},
        }).repository,
        permissions: { contents: "read" },
      },
      request: {
        installationId: 456,
        repository: "github:redohq/checkout",
        permissions: { contents: "write", metadata: "read" },
      },
      now: () => new Date("2026-01-02T03:04:30.000Z"),
      minTtlMs: 60_000,
    });

    expect(validation.ok).toBe(false);
    expect(validation.errors).toEqual([
      "GitHub installation token repository mismatch: expected github:redohq/checkout.",
      "GitHub installation token has contents=read, but write is required.",
      "GitHub installation token is missing metadata=read.",
      "GitHub installation token expires too soon for workflow execution.",
    ]);
  });
});
