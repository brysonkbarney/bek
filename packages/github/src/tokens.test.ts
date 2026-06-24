import { describe, expect, it } from "vitest";
import {
  FakeGitHubInstallationTokenProvider,
  createGitHubInstallationTokenRequest,
  normalizeGitHubInstallationId,
  normalizeGitHubInstallationTokenPermissions,
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
});
