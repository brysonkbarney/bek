import { createVerify, generateKeyPairSync, type KeyObject } from "node:crypto";

import { describe, expect, it } from "vitest";
import {
  FakeGitHubInstallationTokenProvider,
  GitHubAppInstallationTokenProvider,
  assertGitHubInstallationTokenLease,
  createGitHubInstallationTokenLease,
  createGitHubInstallationTokenRequest,
  type GitHubFetch,
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
        repositoryIds: ["101", 202, "101"],
      }),
    ).toMatchObject({
      installationId: "123",
      repository: {
        resource: "github:redohq/checkout",
      },
      repositoryIds: [101, 202],
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
      repositoryIds: [101],
      permissions: { contents: "write" },
    });

    expect(token).toMatchObject({
      type: "github.installation_token",
      installationId: "456",
      token: "fake-gh-installation-token:456:github:redohq/checkout:1",
      expiresAt: "2026-01-02T03:04:15.000Z",
      repositoryIds: [101],
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

  it("exchanges a signed GitHub App JWT for a narrowed installation token", async () => {
    const { privateKey, publicKey } = createTestKeyPair();
    const now = new Date("2026-01-02T03:04:05.000Z");
    const fetchCalls: FetchCall[] = [];
    const fetch: GitHubFetch = async (input, init) => {
      fetchCalls.push({ input, init });
      return jsonResponse({
        token: "ghs_real_installation_token_secret",
        expires_at: "2026-01-02T04:04:05Z",
        permissions: {
          contents: "write",
          metadata: "read",
          pull_requests: "write",
        },
      });
    };
    const provider = new GitHubAppInstallationTokenProvider({
      appId: " 12345 ",
      privateKey,
      apiBaseUrl: "https://api.github.test/",
      now: () => now,
      fetch,
    });

    const token = await provider.getInstallationToken({
      installationId: "98765",
      repository: "github:RedoHQ/Checkout",
      repositoryIds: [112233, "445566", 112233],
      permissions: {
        contents: "write",
        pull_requests: "write",
      },
    });

    const call = singleFetchCall(fetchCalls);
    expect(call.input).toBe(
      "https://api.github.test/app/installations/98765/access_tokens",
    );
    expect(call.init?.method).toBe("POST");
    expect(JSON.parse(String(call.init?.body))).toEqual({
      repository_ids: [112233, 445566],
      permissions: {
        contents: "write",
        pull_requests: "write",
      },
    });

    const headers = call.init?.headers as Record<string, string>;
    expect(headers.Accept).toBe("application/vnd.github+json");
    expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
    const jwt = headers.Authorization.replace(/^Bearer /, "");
    const header = decodeJwtPart<Record<string, unknown>>(jwt, 0);
    const payload = decodeJwtPart<Record<string, unknown>>(jwt, 1);
    const nowSeconds = Math.floor(now.getTime() / 1000);
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(payload).toEqual({
      iss: "12345",
      iat: nowSeconds - 60,
      exp: nowSeconds + 10 * 60,
    });
    expect(verifyJwtSignature(jwt, publicKey)).toBe(true);

    expect(token).toMatchObject({
      type: "github.installation_token",
      installationId: "98765",
      token: "ghs_real_installation_token_secret",
      expiresAt: "2026-01-02T04:04:05.000Z",
      repository: {
        resource: "github:redohq/checkout",
      },
      repositoryIds: [112233, 445566],
      permissions: {
        contents: "write",
        metadata: "read",
        pull_requests: "write",
      },
    });
    expect(Date.parse(token.expiresAt) - now.getTime()).toBe(60 * 60 * 1000);

    const metadata = createGitHubInstallationTokenLease(token);
    expect(metadata.repositoryIds).toEqual([112233, 445566]);
    expect(JSON.stringify(metadata)).not.toContain(token.token);
  });

  it("uses GitHub response permissions when validating narrowed leases", async () => {
    const { privateKey } = createTestKeyPair();
    const provider = new GitHubAppInstallationTokenProvider({
      appId: 12345,
      privateKey,
      now: () => new Date("2026-01-02T03:04:05.000Z"),
      fetch: async () =>
        jsonResponse({
          token: "ghs_read_only_installation_token",
          expires_at: "2026-01-02T03:14:05Z",
          permissions: {
            contents: "read",
          },
        }),
    });
    const request = createGitHubInstallationTokenRequest({
      installationId: 98765,
      repositoryIds: [112233],
      permissions: {
        contents: "write",
      },
    });

    const token = await provider.getInstallationToken(request);
    const validation = validateGitHubInstallationTokenLease({
      token,
      request,
      now: () => new Date("2026-01-02T03:04:05.000Z"),
    });

    expect(validation).toMatchObject({
      ok: false,
      errors: [
        "GitHub installation token has contents=read, but write is required.",
      ],
    });
  });

  it("redacts non-ok GitHub errors without leaking tokens or private keys", async () => {
    const { privateKey } = createTestKeyPair();
    let jwt = "";
    const fetch: GitHubFetch = async (_input, init) => {
      const headers = init?.headers as Record<string, string>;
      jwt = headers.Authorization.replace(/^Bearer /, "");
      return jsonResponse(
        {
          message: `Bad credentials for ghs_response_secret and ${privateKey}`,
        },
        { status: 403, statusText: "Forbidden" },
      );
    };
    const provider = new GitHubAppInstallationTokenProvider({
      appId: 12345,
      privateKey,
      fetch,
      now: () => new Date("2026-01-02T03:04:05.000Z"),
    });

    let message = "";
    try {
      await provider.getInstallationToken({
        installationId: 98765,
        permissions: { contents: "read" },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain(
      "GitHub installation token request failed: 403 Forbidden",
    );
    expect(message).toContain("[redacted:github-token]");
    expect(message).toContain("[redacted:github-private-key]");
    expect(message).not.toContain("ghs_response_secret");
    expect(message).not.toContain(privateKey.trim());
    expect(message).not.toContain(jwt);
  });

  it("redacts response tokens when rejecting invalid token metadata", async () => {
    const { privateKey } = createTestKeyPair();
    const provider = new GitHubAppInstallationTokenProvider({
      appId: 12345,
      privateKey,
      fetch: async () =>
        jsonResponse({
          token: "ghs_invalid_metadata_secret",
          expires_at: "not a date",
          permissions: { contents: "read" },
        }),
      now: () => new Date("2026-01-02T03:04:05.000Z"),
    });

    await expect(
      provider.getInstallationToken({
        installationId: 98765,
        permissions: { contents: "read" },
      }),
    ).rejects.toThrow("Invalid GitHub installation token response");

    let message = "";
    try {
      await provider.getInstallationToken({
        installationId: 98765,
        permissions: { contents: "read" },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain("ghs_invalid_metadata_secret");
    expect(message).not.toContain(privateKey.trim());
  });
});

interface FetchCall {
  input: string | URL;
  init?: RequestInit | undefined;
}

function createTestKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  return {
    privateKey: privateKey.export({
      type: "pkcs8",
      format: "pem",
    }) as string,
    publicKey,
  };
}

function jsonResponse(
  body: unknown,
  init: ResponseInit = { status: 200, statusText: "OK" },
): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
}

function singleFetchCall(calls: FetchCall[]): FetchCall {
  expect(calls).toHaveLength(1);
  const call = calls[0];
  if (!call) {
    throw new Error("expected one fetch call");
  }
  return call;
}

function decodeJwtPart<T>(jwt: string, index: 0 | 1): T {
  const part = jwt.split(".")[index];
  if (!part) {
    throw new Error("expected JWT part");
  }
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as T;
}

function verifyJwtSignature(jwt: string, publicKey: KeyObject): boolean {
  const [header, payload, signature] = jwt.split(".");
  if (!header || !payload || !signature) {
    return false;
  }
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${header}.${payload}`);
  verifier.end();
  return verifier.verify(publicKey, Buffer.from(signature, "base64url"));
}
