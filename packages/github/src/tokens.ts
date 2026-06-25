import { createSign } from "node:crypto";

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
  repositoryIds?: number[] | undefined;
  permissions: GitHubInstallationTokenPermissions;
}

export interface CreateGitHubInstallationTokenRequestInput {
  installationId: string | number;
  repository?: string | GitHubRepoRef | undefined;
  repositoryIds?: readonly (string | number)[] | undefined;
  permissions?: GitHubInstallationTokenPermissions | undefined;
}

export interface GitHubInstallationToken {
  type: "github.installation_token";
  installationId: string;
  token: string;
  expiresAt: string;
  permissions: GitHubInstallationTokenPermissions;
  repository?: GitHubRepoResource | undefined;
  repositoryIds?: number[] | undefined;
}

export interface GitHubInstallationTokenLease {
  type: "github.installation_token_lease";
  installationId: string;
  expiresAt: string;
  permissions: GitHubInstallationTokenPermissions;
  repository?: GitHubRepoResource | undefined;
  repositoryIds?: number[] | undefined;
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

export type GitHubFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface GitHubAppInstallationTokenProviderOptions {
  appId: string | number;
  privateKey: string;
  apiBaseUrl?: string | undefined;
  fetch?: GitHubFetch | undefined;
  now?: (() => Date) | undefined;
  userAgent?: string | undefined;
}

export class GitHubAppInstallationTokenProvider implements GitHubInstallationTokenProvider {
  private readonly appId: string;
  private readonly privateKey: string;
  private readonly apiBaseUrl: string;
  private readonly fetch: GitHubFetch;
  private readonly now: () => Date;
  private readonly userAgent: string;

  constructor(options: GitHubAppInstallationTokenProviderOptions) {
    this.appId = normalizeGitHubAppId(options.appId);
    this.privateKey = normalizeGitHubAppPrivateKey(options.privateKey);
    this.apiBaseUrl = normalizeGitHubApiBaseUrl(
      options.apiBaseUrl ?? "https://api.github.com",
    );
    this.fetch = options.fetch ?? getDefaultFetch();
    this.now = options.now ?? (() => new Date());
    this.userAgent =
      normalizeOptionalHeaderValue(options.userAgent) ??
      "bek-github-installation-token-provider";
  }

  async getInstallationToken(
    request: CreateGitHubInstallationTokenRequestInput,
  ): Promise<GitHubInstallationToken> {
    const normalized = createGitHubInstallationTokenRequest(request);
    const jwt = this.createAppJwt();
    const url = `${this.apiBaseUrl}/app/installations/${encodeURIComponent(
      normalized.installationId,
    )}/access_tokens`;

    let response: Response;
    try {
      response = await this.fetch(url, {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
          "User-Agent": this.userAgent,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify(createGitHubInstallationTokenApiBody(normalized)),
      });
    } catch (error) {
      throw createRedactedGitHubError(
        "GitHub installation token request failed before GitHub responded.",
        error,
        [this.privateKey, jwt],
      );
    }

    if (!response.ok) {
      throw new Error(
        `GitHub installation token request failed: ${await readGitHubErrorResponse(
          response,
          [this.privateKey, jwt],
        )}`,
      );
    }

    const raw = await readGitHubJsonResponse(response, [this.privateKey, jwt]);
    try {
      return createGitHubInstallationTokenFromApiResponse(raw, normalized);
    } catch (error) {
      throw createRedactedGitHubError(
        "Invalid GitHub installation token response.",
        error,
        [this.privateKey, jwt, getRawApiResponseToken(raw)],
      );
    }
  }

  private createAppJwt(): string {
    const nowMs = this.now().getTime();
    if (!Number.isFinite(nowMs)) {
      throw new Error("GitHub App JWT clock must return a valid date.");
    }

    const nowSeconds = Math.floor(nowMs / 1000);
    const header = { alg: "RS256", typ: "JWT" };
    const payload = {
      iss: this.appId,
      iat: nowSeconds - 60,
      exp: nowSeconds + 10 * 60,
    };
    const signingInput = `${base64UrlEncodeJson(header)}.${base64UrlEncodeJson(
      payload,
    )}`;

    try {
      const signature = createSign("RSA-SHA256")
        .update(signingInput)
        .end()
        .sign(this.privateKey);
      return `${signingInput}.${base64UrlEncode(signature)}`;
    } catch (error) {
      throw createRedactedGitHubError("Failed to sign GitHub App JWT.", error, [
        this.privateKey,
      ]);
    }
  }
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
    if (normalized.repositoryIds) {
      token.repositoryIds = [...normalized.repositoryIds];
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
  if (input.repositoryIds) {
    request.repositoryIds = normalizeGitHubRepositoryIds(input.repositoryIds);
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

export function normalizeGitHubRepositoryIds(
  repositoryIds: readonly (string | number)[],
): number[] {
  if (repositoryIds.length === 0) {
    throw new Error("GitHub repositoryIds must include at least one id.");
  }

  const normalized: number[] = [];
  const seen = new Set<number>();
  for (const repositoryId of repositoryIds) {
    const normalizedRepositoryId = normalizeGitHubRepositoryId(repositoryId);
    if (seen.has(normalizedRepositoryId)) {
      continue;
    }
    seen.add(normalizedRepositoryId);
    normalized.push(normalizedRepositoryId);
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

  if (request?.repositoryIds) {
    if (!input.token.repositoryIds) {
      errors.push(
        `GitHub installation token must be scoped to repository ids ${request.repositoryIds.join(
          ", ",
        )}.`,
      );
    } else {
      const tokenRepositoryIds = normalizeLeaseRepositoryIds(
        input.token.repositoryIds,
        errors,
      );
      if (tokenRepositoryIds) {
        const missingRepositoryIds = request.repositoryIds.filter(
          (repositoryId) => !tokenRepositoryIds.includes(repositoryId),
        );
        if (missingRepositoryIds.length > 0) {
          errors.push(
            `GitHub installation token repository id scope missing: expected ${missingRepositoryIds.join(
              ", ",
            )}.`,
          );
        }
      }
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
  if (token.repositoryIds) {
    lease.repositoryIds = normalizeGitHubRepositoryIds(token.repositoryIds);
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

function normalizeLeaseRepositoryIds(
  repositoryIds: readonly (string | number)[],
  errors: string[],
): number[] | undefined {
  try {
    return normalizeGitHubRepositoryIds(repositoryIds);
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

function normalizeGitHubAppId(appId: string | number): string {
  const normalized = String(appId).trim();
  if (!/^\d+$/.test(normalized) || Number(normalized) <= 0) {
    throw new Error("GitHub App id must be a positive integer.");
  }
  return normalized;
}

function normalizeGitHubAppPrivateKey(privateKey: string): string {
  const normalized = privateKey.trim().replace(/\\n/g, "\n");
  if (!normalized) {
    throw new Error("GitHub App private key must be a PEM private key.");
  }
  return normalized;
}

function normalizeGitHubApiBaseUrl(apiBaseUrl: string): string {
  const normalized = apiBaseUrl.trim().replace(/\/+$/, "");
  if (!normalized) {
    throw new Error("GitHub API base URL must be non-empty.");
  }
  return normalized;
}

function normalizeOptionalHeaderValue(
  value: string | undefined,
): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function getDefaultFetch(): GitHubFetch {
  if (typeof globalThis.fetch !== "function") {
    throw new Error("A fetch implementation is required for GitHub requests.");
  }
  return globalThis.fetch.bind(globalThis);
}

function normalizeGitHubRepositoryId(repositoryId: string | number): number {
  const normalized =
    typeof repositoryId === "number"
      ? repositoryId
      : Number(repositoryId.trim());
  if (
    !Number.isSafeInteger(normalized) ||
    normalized <= 0 ||
    (typeof repositoryId === "string" && !/^\d+$/.test(repositoryId.trim()))
  ) {
    throw new Error("GitHub repository id must be a positive safe integer.");
  }
  return normalized;
}

function createGitHubInstallationTokenApiBody(
  request: GitHubInstallationTokenRequest,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (request.repositoryIds) {
    body.repository_ids = [...request.repositoryIds];
  } else if (request.repository) {
    body.repositories = [request.repository.repo];
  }
  if (Object.keys(request.permissions).length > 0) {
    body.permissions = { ...request.permissions };
  }
  return body;
}

async function readGitHubErrorResponse(
  response: Response,
  secrets: readonly (string | undefined)[],
): Promise<string> {
  const status = `${response.status}${
    response.statusText ? ` ${response.statusText}` : ""
  }`;
  let detail = "";
  try {
    detail = formatGitHubErrorDetail(await response.text());
  } catch {
    detail = "";
  }
  return redactGitHubSecrets(detail ? `${status}: ${detail}` : status, secrets);
}

async function readGitHubJsonResponse(
  response: Response,
  secrets: readonly (string | undefined)[],
): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw createRedactedGitHubError(
      "GitHub installation token response was not valid JSON.",
      error,
      secrets,
    );
  }
}

function formatGitHubErrorDetail(body: string): string {
  if (!body.trim()) {
    return "";
  }
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed) && typeof parsed.message === "string") {
      return parsed.message;
    }
  } catch {
    return body;
  }
  return body;
}

function createGitHubInstallationTokenFromApiResponse(
  raw: unknown,
  request: GitHubInstallationTokenRequest,
): GitHubInstallationToken {
  if (!isRecord(raw)) {
    throw new Error("response body must be an object.");
  }
  if (typeof raw.token !== "string" || raw.token.trim() === "") {
    throw new Error("response token must be a non-empty string.");
  }

  const token: GitHubInstallationToken = {
    type: "github.installation_token",
    installationId: request.installationId,
    token: raw.token,
    expiresAt: normalizeGitHubApiExpiresAt(raw.expires_at),
    permissions: normalizeGitHubApiResponsePermissions(
      raw.permissions,
      request.permissions,
    ),
  };
  if (request.repository) {
    token.repository = request.repository;
  }
  if (request.repositoryIds) {
    token.repositoryIds = [...request.repositoryIds];
  }
  return token;
}

function normalizeGitHubApiExpiresAt(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("response expires_at must be an ISO date string.");
  }
  const expiresAtMs = Date.parse(value);
  if (!Number.isFinite(expiresAtMs)) {
    throw new Error("response expires_at must be an ISO date string.");
  }
  return new Date(expiresAtMs).toISOString();
}

function normalizeGitHubApiResponsePermissions(
  permissions: unknown,
  fallback: GitHubInstallationTokenPermissions,
): GitHubInstallationTokenPermissions {
  if (permissions === undefined || permissions === null) {
    return { ...fallback };
  }
  if (!isRecord(permissions)) {
    throw new Error("response permissions must be an object.");
  }

  const normalized: GitHubInstallationTokenPermissions = {};
  for (const [name, access] of Object.entries(permissions)) {
    if (!isKnownPermissionName(name)) {
      continue;
    }
    if (access !== "read" && access !== "write") {
      throw new Error("Unsupported GitHub installation permission access.");
    }
    normalized[name] = access;
  }
  return normalized;
}

function getRawApiResponseToken(raw: unknown): string | undefined {
  return isRecord(raw) && typeof raw.token === "string" ? raw.token : undefined;
}

function createRedactedGitHubError(
  message: string,
  error: unknown,
  secrets: readonly (string | undefined)[],
): Error {
  return new Error(
    redactGitHubSecrets(`${message} ${getErrorMessage(error)}`, secrets),
  );
}

function redactGitHubSecrets(
  message: string,
  secrets: readonly (string | undefined)[],
): string {
  let redacted = message
    .replace(
      /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g,
      "[redacted:github-private-key]",
    )
    .replace(/\bgh[osurp]_[A-Za-z0-9_]+\b/g, "[redacted:github-token]")
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      "[redacted:github-jwt]",
    )
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted:github-token]");
  for (const secret of secrets) {
    if (!secret) {
      continue;
    }
    redacted = redacted.split(secret).join("[redacted:github-secret]");
  }
  return redacted;
}

function base64UrlEncodeJson(value: unknown): string {
  return base64UrlEncode(Buffer.from(JSON.stringify(value), "utf8"));
}

function base64UrlEncode(value: Buffer): string {
  return value.toString("base64url");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createFakeTokenValue(
  request: GitHubInstallationTokenRequest,
  sequence: number,
): string {
  const repo =
    request.repository?.resource ??
    (request.repositoryIds
      ? `repository_ids:${request.repositoryIds.join(",")}`
      : "all");
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
  if (token.repositoryIds) {
    clone.repositoryIds = [...token.repositoryIds];
  }
  return clone;
}
