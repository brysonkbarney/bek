import {
  parseGitHubRepoResource,
  type GitHubRepoRef,
  type GitHubRepoResource,
} from "./resources";

export type GitHubInstallationPermissionAccess = "read" | "write";

export const GITHUB_INSTALLATION_PERMISSION_NAMES = [
  "checks",
  "contents",
  "metadata",
  "pull_requests",
] as const;

export type GitHubInstallationPermissionName =
  (typeof GITHUB_INSTALLATION_PERMISSION_NAMES)[number];

export type GitHubInstallationTokenPermissions = Partial<
  Record<GitHubInstallationPermissionName, GitHubInstallationPermissionAccess>
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

export interface GitHubInstallationTokenLease {
  type: "github.installation_token_lease";
  installationId: string;
  expiresAt: string;
  permissions: GitHubInstallationTokenPermissions;
  repository?: GitHubRepoResource | undefined;
}

export type GitHubInstallationTokenLeaseValidation =
  | {
      ok: true;
      lease: GitHubInstallationTokenLease;
      errors: [];
    }
  | {
      ok: false;
      errors: string[];
      lease?: undefined;
    };

export interface ValidateGitHubInstallationTokenLeaseInput {
  token: GitHubInstallationToken;
  request:
    | GitHubInstallationTokenRequest
    | CreateGitHubInstallationTokenRequestInput;
  now?: (() => Date) | undefined;
  minTtlMs?: number | undefined;
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

export function validateGitHubInstallationTokenLease(
  input: ValidateGitHubInstallationTokenLeaseInput,
): GitHubInstallationTokenLeaseValidation {
  const errors: string[] = [];
  const request = normalizeLeaseRequest(input.request, errors);
  const tokenInstallationId = normalizeLeaseInstallationId(
    input.token.installationId,
    errors,
  );
  const tokenPermissions = normalizeLeasePermissions(
    input.token.permissions,
    errors,
  );

  if (
    request &&
    tokenInstallationId &&
    tokenInstallationId !== request.installationId
  ) {
    errors.push(
      `GitHub installation token installation mismatch: expected ${request.installationId}.`,
    );
  }

  if (request?.repository) {
    const tokenRepository = input.token.repository
      ? parseGitHubRepoResource(input.token.repository)
      : undefined;
    if (!tokenRepository) {
      errors.push(
        `GitHub installation token must be scoped to ${request.repository.resource}.`,
      );
    } else if (tokenRepository.resource !== request.repository.resource) {
      errors.push(
        `GitHub installation token repository mismatch: expected ${request.repository.resource}.`,
      );
    }
  }

  if (request && tokenPermissions) {
    for (const name of GITHUB_INSTALLATION_PERMISSION_NAMES) {
      const requiredAccess = request.permissions[name];
      if (!requiredAccess) {
        continue;
      }
      const actualAccess = tokenPermissions[name];
      if (!actualAccess) {
        errors.push(
          `GitHub installation token is missing ${name}=${requiredAccess}.`,
        );
      } else if (!permissionAccessCovers(actualAccess, requiredAccess)) {
        errors.push(
          `GitHub installation token has ${name}=${actualAccess}, but ${requiredAccess} is required.`,
        );
      }
    }
  }

  const expiresAtMs = Date.parse(input.token.expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    errors.push("GitHub installation token expiresAt must be an ISO date.");
  } else {
    const minTtlMs = input.minTtlMs ?? 60_000;
    if (!Number.isFinite(minTtlMs) || minTtlMs < 0) {
      errors.push("GitHub installation token minTtlMs must be non-negative.");
    } else {
      const nowMs = (input.now?.() ?? new Date()).getTime();
      if (!Number.isFinite(nowMs)) {
        errors.push(
          "GitHub installation token validation clock must return a valid date.",
        );
      } else if (expiresAtMs <= nowMs + minTtlMs) {
        errors.push(
          "GitHub installation token expires too soon for workflow execution.",
        );
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    lease: createGitHubInstallationTokenLease(input.token),
    errors: [],
  };
}

export function assertGitHubInstallationTokenLease(
  input: ValidateGitHubInstallationTokenLeaseInput,
): GitHubInstallationTokenLease {
  const validation = validateGitHubInstallationTokenLease(input);
  if (!validation.ok) {
    throw new Error(
      `Invalid GitHub installation token lease: ${validation.errors.join(" ")}`,
    );
  }
  return validation.lease;
}

export function createGitHubInstallationTokenLease(
  token: GitHubInstallationToken,
): GitHubInstallationTokenLease {
  const lease: GitHubInstallationTokenLease = {
    type: "github.installation_token_lease",
    installationId: normalizeGitHubInstallationId(token.installationId),
    expiresAt: token.expiresAt,
    permissions: normalizeGitHubInstallationTokenPermissions(token.permissions),
  };
  if (token.repository) {
    lease.repository = parseGitHubRepoResource(token.repository);
  }
  return lease;
}

function isKnownPermissionName(
  value: string,
): value is GitHubInstallationPermissionName {
  return (GITHUB_INSTALLATION_PERMISSION_NAMES as readonly string[]).includes(
    value,
  );
}

function normalizeLeaseRequest(
  input:
    | GitHubInstallationTokenRequest
    | CreateGitHubInstallationTokenRequestInput,
  errors: string[],
): GitHubInstallationTokenRequest | undefined {
  try {
    return createGitHubInstallationTokenRequest(input);
  } catch (error) {
    errors.push(getErrorMessage(error));
    return undefined;
  }
}

function normalizeLeaseInstallationId(
  value: string | number,
  errors: string[],
): string | undefined {
  try {
    return normalizeGitHubInstallationId(value);
  } catch (error) {
    errors.push(getErrorMessage(error));
    return undefined;
  }
}

function normalizeLeasePermissions(
  permissions: GitHubInstallationTokenPermissions,
  errors: string[],
): GitHubInstallationTokenPermissions | undefined {
  try {
    return normalizeGitHubInstallationTokenPermissions(permissions);
  } catch (error) {
    errors.push(getErrorMessage(error));
    return undefined;
  }
}

function permissionAccessCovers(
  actual: GitHubInstallationPermissionAccess,
  required: GitHubInstallationPermissionAccess,
): boolean {
  return permissionAccessRank(actual) >= permissionAccessRank(required);
}

function permissionAccessRank(
  access: GitHubInstallationPermissionAccess,
): number {
  return access === "write" ? 2 : 1;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
