import {
  parseGitHubRepoResource,
  type GitHubRepoRef,
  type GitHubRepoResource,
} from "./resources";

export type GitHubInstallationPermissionAccess = "read" | "write";

export type GitHubInstallationTokenPermissions = Partial<
  Record<
    "checks" | "contents" | "metadata" | "pull_requests",
    GitHubInstallationPermissionAccess
  >
>;

export interface GitHubInstallationTokenRequest {
  installationId: string;
  repository?: GitHubRepoResource | undefined;
  permissions: GitHubInstallationTokenPermissions;
}

export interface CreateGitHubInstallationTokenRequestInput {
  installationId: string | number;
  repository?: string | GitHubRepoRef | undefined;
  permissions?: GitHubInstallationTokenPermissions | undefined;
}

export interface GitHubInstallationToken {
  type: "github.installation_token";
  installationId: string;
  token: string;
  expiresAt: string;
  permissions: GitHubInstallationTokenPermissions;
  repository?: GitHubRepoResource | undefined;
}

export interface GitHubInstallationTokenProvider {
  getInstallationToken(
    request: CreateGitHubInstallationTokenRequestInput,
  ): Promise<GitHubInstallationToken>;
}

export interface FakeGitHubInstallationTokenProviderOptions {
  now?: () => Date;
  ttlMs?: number;
}

export class FakeGitHubInstallationTokenProvider implements GitHubInstallationTokenProvider {
  private readonly issued: GitHubInstallationToken[] = [];
  private readonly now: () => Date;
  private readonly ttlMs: number;

  constructor(options: FakeGitHubInstallationTokenProviderOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? 60 * 60 * 1000;
  }

  async getInstallationToken(
    request: CreateGitHubInstallationTokenRequestInput,
  ): Promise<GitHubInstallationToken> {
    const normalized = createGitHubInstallationTokenRequest(request);
    const token: GitHubInstallationToken = {
      type: "github.installation_token",
      installationId: normalized.installationId,
      token: createFakeTokenValue(normalized, this.issued.length + 1),
      expiresAt: new Date(this.now().getTime() + this.ttlMs).toISOString(),
      permissions: { ...normalized.permissions },
    };
    if (normalized.repository) {
      token.repository = normalized.repository;
    }
    this.issued.push(cloneToken(token));
    return cloneToken(token);
  }

  issuedTokens(): GitHubInstallationToken[] {
    return this.issued.map(cloneToken);
  }
}

export function createGitHubInstallationTokenRequest(
  input: CreateGitHubInstallationTokenRequestInput,
): GitHubInstallationTokenRequest {
  const request: GitHubInstallationTokenRequest = {
    installationId: normalizeGitHubInstallationId(input.installationId),
    permissions: normalizeGitHubInstallationTokenPermissions(
      input.permissions ?? {},
    ),
  };
  if (input.repository) {
    request.repository = parseGitHubRepoResource(input.repository);
  }
  return request;
}

export function normalizeGitHubInstallationId(
  installationId: string | number,
): string {
  const normalized = String(installationId).trim();
  if (!/^\d+$/.test(normalized) || Number(normalized) <= 0) {
    throw new Error("GitHub installation id must be a positive integer.");
  }
  return normalized;
}

export function normalizeGitHubInstallationTokenPermissions(
  permissions: GitHubInstallationTokenPermissions,
): GitHubInstallationTokenPermissions {
  const normalized: GitHubInstallationTokenPermissions = {};
  for (const [name, access] of Object.entries(permissions)) {
    if (!isKnownPermissionName(name)) {
      throw new Error(`Unsupported GitHub installation permission: ${name}.`);
    }
    if (access === undefined) {
      continue;
    }
    if (access !== "read" && access !== "write") {
      throw new Error(`Unsupported GitHub installation permission access.`);
    }
    normalized[name] = access;
  }
  return normalized;
}

function isKnownPermissionName(
  value: string,
): value is keyof GitHubInstallationTokenPermissions {
  return (
    value === "checks" ||
    value === "contents" ||
    value === "metadata" ||
    value === "pull_requests"
  );
}

function createFakeTokenValue(
  request: GitHubInstallationTokenRequest,
  sequence: number,
): string {
  const repo = request.repository?.resource ?? "all";
  return `fake-gh-installation-token:${request.installationId}:${repo}:${sequence}`;
}

function cloneToken(token: GitHubInstallationToken): GitHubInstallationToken {
  const clone: GitHubInstallationToken = {
    type: token.type,
    installationId: token.installationId,
    token: token.token,
    expiresAt: token.expiresAt,
    permissions: { ...token.permissions },
  };
  if (token.repository) {
    clone.repository = { ...token.repository };
  }
  return clone;
}
