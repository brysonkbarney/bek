import { parseGitHubRepoResource, type GitHubRepoResource } from "./resources";
import { normalizeGitHubInstallationId } from "./tokens";

export type GitHubWebhookEventName =
  | "installation"
  | "installation_repositories"
  | "pull_request"
  | "check_run";

export interface GitHubWebhookDeliveryDedupeInput {
  deliveryId: string;
  eventName?: string | undefined;
}

export interface NormalizeGitHubWebhookEventInput {
  eventName: string;
  payload: unknown;
  deliveryId?: string | undefined;
}

export type NormalizedGitHubWebhookEvent =
  | NormalizedGitHubInstallationEvent
  | NormalizedGitHubPullRequestEvent
  | NormalizedGitHubCheckRunEvent;

export interface NormalizedGitHubWebhookEventBase {
  provider: "github";
  eventName: GitHubWebhookEventName;
  action: string;
  deliveryId?: string | undefined;
  dedupeKey?: string | undefined;
  senderLogin?: string | undefined;
  installationId?: string | undefined;
}

export interface NormalizedGitHubInstallationEvent extends NormalizedGitHubWebhookEventBase {
  type: "github.installation";
  eventName: "installation" | "installation_repositories";
  installationId: string;
  accountLogin?: string | undefined;
  repositorySelection?: string | undefined;
  repositories: GitHubRepoResource[];
  repositoriesAdded: GitHubRepoResource[];
  repositoriesRemoved: GitHubRepoResource[];
}

export interface NormalizedGitHubPullRequestEvent extends NormalizedGitHubWebhookEventBase {
  type: "github.pull_request";
  eventName: "pull_request";
  repository: GitHubRepoResource;
  pullRequest: {
    id: number;
    number: number;
    title: string;
    state: string;
    draft: boolean;
    htmlUrl?: string | undefined;
    authorLogin?: string | undefined;
    head: {
      branch: string;
      sha: string;
      repository?: GitHubRepoResource | undefined;
    };
    base: {
      branch: string;
      sha?: string | undefined;
      repository: GitHubRepoResource;
    };
  };
}

export interface NormalizedGitHubCheckRunEvent extends NormalizedGitHubWebhookEventBase {
  type: "github.check_run";
  eventName: "check_run";
  repository: GitHubRepoResource;
  checkRun: {
    id: number;
    name: string;
    headSha: string;
    status: string;
    conclusion?: string | undefined;
    htmlUrl?: string | undefined;
    pullRequestNumbers: number[];
  };
}

export function createGitHubWebhookDeliveryDedupeKey(
  input: GitHubWebhookDeliveryDedupeInput,
): string {
  const deliveryId = normalizeDeliveryId(input.deliveryId);
  const eventName = input.eventName?.trim().toLowerCase();
  return eventName
    ? `github:webhook:${eventName}:${deliveryId}`
    : `github:webhook:${deliveryId}`;
}

export function getGitHubWebhookDeliveryDedupeKeyFromHeaders(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const deliveryId = readHeader(headers, "x-github-delivery");
  if (!deliveryId) {
    return undefined;
  }
  return createGitHubWebhookDeliveryDedupeKey({
    deliveryId,
    eventName: readHeader(headers, "x-github-event"),
  });
}

export function normalizeGitHubWebhookEvent(
  input: NormalizeGitHubWebhookEventInput,
): NormalizedGitHubWebhookEvent {
  const eventName = normalizeEventName(input.eventName);
  const payload = asRecord(input.payload, "GitHub webhook payload");
  switch (eventName) {
    case "installation":
    case "installation_repositories":
      return normalizeInstallationEvent(eventName, payload, input.deliveryId);
    case "pull_request":
      return normalizePullRequestEvent(payload, input.deliveryId);
    case "check_run":
      return normalizeCheckRunEvent(payload, input.deliveryId);
  }
}

function normalizeInstallationEvent(
  eventName: "installation" | "installation_repositories",
  payload: Record<string, unknown>,
  deliveryId: string | undefined,
): NormalizedGitHubInstallationEvent {
  const installation = asRecord(
    payload.installation,
    "GitHub installation payload",
  );
  const event: NormalizedGitHubInstallationEvent = {
    provider: "github",
    type: "github.installation",
    eventName,
    action: normalizeAction(payload.action),
    installationId: normalizeGitHubInstallationId(
      requiredNumberOrString(installation.id, "GitHub installation id"),
    ),
    repositories: normalizeRepoList(payload.repositories),
    repositoriesAdded: normalizeRepoList(payload.repositories_added),
    repositoriesRemoved: normalizeRepoList(payload.repositories_removed),
  };
  addBaseEventFields(event, payload, deliveryId);
  const account = maybeRecord(installation.account);
  const accountLogin = account ? stringField(account, "login") : undefined;
  if (accountLogin) {
    event.accountLogin = accountLogin;
  }
  const repositorySelection = stringField(installation, "repository_selection");
  if (repositorySelection) {
    event.repositorySelection = repositorySelection;
  }
  return event;
}

function normalizePullRequestEvent(
  payload: Record<string, unknown>,
  deliveryId: string | undefined,
): NormalizedGitHubPullRequestEvent {
  const repository = repositoryFromRecord(
    asRecord(payload.repository, "GitHub repository payload"),
  );
  const pullRequest = asRecord(
    payload.pull_request,
    "GitHub pull request payload",
  );
  const head = asRecord(pullRequest.head, "GitHub pull request head payload");
  const base = asRecord(pullRequest.base, "GitHub pull request base payload");

  const event: NormalizedGitHubPullRequestEvent = {
    provider: "github",
    type: "github.pull_request",
    eventName: "pull_request",
    action: normalizeAction(payload.action),
    repository,
    pullRequest: {
      id: requiredNumber(pullRequest.id, "GitHub pull request id"),
      number: requiredNumber(
        pullRequest.number ?? payload.number,
        "GitHub pull request number",
      ),
      title: requiredString(pullRequest.title, "GitHub pull request title"),
      state: requiredString(pullRequest.state, "GitHub pull request state"),
      draft: booleanField(pullRequest, "draft") ?? false,
      head: {
        branch: requiredString(head.ref, "GitHub pull request head ref"),
        sha: requiredString(head.sha, "GitHub pull request head SHA"),
      },
      base: {
        branch: requiredString(base.ref, "GitHub pull request base ref"),
        repository,
      },
    },
  };
  addBaseEventFields(event, payload, deliveryId);

  const htmlUrl = stringField(pullRequest, "html_url");
  if (htmlUrl) {
    event.pullRequest.htmlUrl = htmlUrl;
  }
  const user = maybeRecord(pullRequest.user);
  const authorLogin = user ? stringField(user, "login") : undefined;
  if (authorLogin) {
    event.pullRequest.authorLogin = authorLogin;
  }
  const headRepo = maybeRecord(head.repo);
  if (headRepo) {
    event.pullRequest.head.repository = repositoryFromRecord(headRepo);
  }
  const baseRepo = maybeRecord(base.repo);
  if (baseRepo) {
    event.pullRequest.base.repository = repositoryFromRecord(baseRepo);
  }
  const baseSha = stringField(base, "sha");
  if (baseSha) {
    event.pullRequest.base.sha = baseSha;
  }
  return event;
}

function normalizeCheckRunEvent(
  payload: Record<string, unknown>,
  deliveryId: string | undefined,
): NormalizedGitHubCheckRunEvent {
  const repository = repositoryFromRecord(
    asRecord(payload.repository, "GitHub repository payload"),
  );
  const checkRun = asRecord(payload.check_run, "GitHub check_run payload");
  const event: NormalizedGitHubCheckRunEvent = {
    provider: "github",
    type: "github.check_run",
    eventName: "check_run",
    action: normalizeAction(payload.action),
    repository,
    checkRun: {
      id: requiredNumber(checkRun.id, "GitHub check run id"),
      name: requiredString(checkRun.name, "GitHub check run name"),
      headSha: requiredString(checkRun.head_sha, "GitHub check run head SHA"),
      status: requiredString(checkRun.status, "GitHub check run status"),
      pullRequestNumbers: normalizePullRequestNumbers(checkRun.pull_requests),
    },
  };
  addBaseEventFields(event, payload, deliveryId);
  const conclusion = stringField(checkRun, "conclusion");
  if (conclusion) {
    event.checkRun.conclusion = conclusion;
  }
  const htmlUrl = stringField(checkRun, "html_url");
  if (htmlUrl) {
    event.checkRun.htmlUrl = htmlUrl;
  }
  return event;
}

function addBaseEventFields(
  event: NormalizedGitHubWebhookEventBase,
  payload: Record<string, unknown>,
  deliveryId: string | undefined,
): void {
  if (deliveryId) {
    event.deliveryId = normalizeDeliveryId(deliveryId);
    event.dedupeKey = createGitHubWebhookDeliveryDedupeKey({
      deliveryId,
      eventName: event.eventName,
    });
  }
  const sender = maybeRecord(payload.sender);
  const senderLogin = sender ? stringField(sender, "login") : undefined;
  if (senderLogin) {
    event.senderLogin = senderLogin;
  }
  const installation = maybeRecord(payload.installation);
  if (installation?.id !== undefined) {
    event.installationId = normalizeGitHubInstallationId(
      requiredNumberOrString(installation.id, "GitHub installation id"),
    );
  }
}

function normalizeRepoList(value: unknown): GitHubRepoResource[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) =>
    repositoryFromRecord(asRecord(entry, "GitHub repository payload")),
  );
}

function normalizePullRequestNumbers(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) =>
    requiredNumber(
      asRecord(entry, "GitHub check run pull request payload").number,
      "GitHub pull request number",
    ),
  );
}

function repositoryFromRecord(
  record: Record<string, unknown>,
): GitHubRepoResource {
  const repositoryId = optionalPositiveInteger(record.id);
  const fullName = stringField(record, "full_name");
  if (fullName) {
    return assignRepositoryId(parseGitHubRepoResource(fullName), repositoryId);
  }
  const owner = maybeRecord(record.owner);
  const ownerLogin = owner ? stringField(owner, "login") : undefined;
  const name = stringField(record, "name");
  if (!ownerLogin || !name) {
    throw new Error("GitHub repository payload must include owner and name.");
  }
  return assignRepositoryId(
    parseGitHubRepoResource({ owner: ownerLogin, repo: name }),
    repositoryId,
  );
}

function assignRepositoryId(
  repository: GitHubRepoResource,
  repositoryId: number | undefined,
): GitHubRepoResource {
  return repositoryId === undefined
    ? repository
    : { ...repository, repositoryId };
}

function normalizeDeliveryId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._:-]{0,199}$/.test(normalized)) {
    throw new Error("GitHub delivery id is required for webhook dedupe.");
  }
  return normalized;
}

function normalizeEventName(value: string): GitHubWebhookEventName {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "installation" ||
    normalized === "installation_repositories" ||
    normalized === "pull_request" ||
    normalized === "check_run"
  ) {
    return normalized;
  }
  throw new Error(`Unsupported GitHub webhook event: ${value}`);
}

function normalizeAction(value: unknown): string {
  const action = requiredString(value, "GitHub webhook action").trim();
  if (!action) {
    throw new Error("GitHub webhook action is required.");
  }
  return action;
}

function readHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name,
  )?.[1];
  if (Array.isArray(entry)) {
    return entry[0];
  }
  return entry;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function maybeRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanField(
  record: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  throw new Error("GitHub repository id must be a positive integer.");
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function requiredNumberOrString(
  value: unknown,
  label: string,
): string | number {
  if (
    (typeof value === "number" && Number.isInteger(value) && value > 0) ||
    (typeof value === "string" && value.trim())
  ) {
    return value;
  }
  throw new Error(`${label} must be a positive integer.`);
}
