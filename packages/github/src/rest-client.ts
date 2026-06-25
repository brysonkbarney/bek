import type { GitHubPullRequestProposal } from "./proposals";
import type {
  GitHubBranchResult,
  GitHubCommitResult,
  GitHubDraftPullRequestResult,
} from "./types";
import type {
  GitHubDraftPullRequestWorkflowExecutionClient,
  GitHubWorkflowExecutionAuth,
} from "./execution";
import type {
  GitHubBranchWorkflowPlan,
  GitHubCommitFileChange,
  GitHubCommitWorkflowPlan,
  GitHubDraftPullRequestWorkflowPlan,
} from "./workflows";

export interface GitHubRestClientOptions {
  apiBaseUrl?: string | undefined;
  fetch?: typeof fetch | undefined;
  userAgent?: string | undefined;
}

interface GitHubRefResponse {
  object?: { sha?: unknown } | undefined;
}

interface GitHubCommitResponse {
  sha?: unknown;
  tree?: { sha?: unknown } | undefined;
}

interface GitHubTreeResponse {
  sha?: unknown;
}

interface GitHubPullRequestResponse {
  id?: unknown;
  number?: unknown;
  html_url?: unknown;
  title?: unknown;
  body?: unknown;
  base?: { ref?: unknown } | undefined;
  head?: { ref?: unknown } | undefined;
  draft?: unknown;
  maintainer_can_modify?: unknown;
  labels?: unknown;
  requested_reviewers?: unknown;
}

export class GitHubRestClient implements GitHubDraftPullRequestWorkflowExecutionClient {
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;

  constructor(options: GitHubRestClientOptions = {}) {
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://api.github.com").replace(
      /\/+$/,
      "",
    );
    this.fetchImpl = options.fetch ?? fetch;
    this.userAgent = options.userAgent ?? "bek-github-rest-client";
  }

  async createBranch(
    plan: GitHubBranchWorkflowPlan,
    auth: GitHubWorkflowExecutionAuth,
  ): Promise<GitHubBranchResult> {
    const baseRef = await this.getBranchRef(
      plan.repository.owner,
      plan.repository.repo,
      plan.baseBranch,
      auth,
    );
    const createRef = await this.tryRequestJson(
      "POST",
      `/repos/${pathPart(plan.repository.owner)}/${pathPart(
        plan.repository.repo,
      )}/git/refs`,
      auth,
      {
        ref: `refs/heads/${plan.headBranch}`,
        sha: baseRef.sha,
      },
    );
    if (!createRef.ok) {
      if (isRetryableExistingResourceStatus(createRef.status)) {
        const existingRef = await this.tryGetBranchRef(
          plan.repository.owner,
          plan.repository.repo,
          plan.headBranch,
          auth,
        );
        if (existingRef?.sha === baseRef.sha) {
          return {
            repository: { ...plan.repository },
            branch: plan.headBranch,
            commitSha: baseRef.sha,
            createdFrom: plan.baseBranch,
          };
        }
        if (existingRef) {
          throw new Error(
            `GitHub branch ${plan.headBranch} already exists at ${existingRef.sha}; expected ${baseRef.sha}.`,
          );
        }
      }
      throwGitHubRestError(createRef);
    }
    return {
      repository: { ...plan.repository },
      branch: plan.headBranch,
      commitSha: baseRef.sha,
      createdFrom: plan.baseBranch,
    };
  }

  async commitFiles(
    plan: GitHubCommitWorkflowPlan,
    auth: GitHubWorkflowExecutionAuth,
  ): Promise<GitHubCommitResult> {
    const headRef = await this.getBranchRef(
      plan.repository.owner,
      plan.repository.repo,
      plan.branch,
      auth,
    );
    if (plan.expectedHeadSha && plan.expectedHeadSha !== headRef.sha) {
      throw new Error("GitHub branch head did not match expected commit SHA.");
    }
    const baseCommit = await this.requestJson<GitHubCommitResponse>(
      "GET",
      `/repos/${pathPart(plan.repository.owner)}/${pathPart(
        plan.repository.repo,
      )}/git/commits/${pathPart(headRef.sha)}`,
      auth,
    );
    const baseTreeSha = requireString(
      baseCommit.tree?.sha,
      "GitHub commit tree SHA",
    );
    const tree = await this.requestJson<GitHubTreeResponse>(
      "POST",
      `/repos/${pathPart(plan.repository.owner)}/${pathPart(
        plan.repository.repo,
      )}/git/trees`,
      auth,
      {
        base_tree: baseTreeSha,
        tree: plan.changes.map(treeEntryForChange),
      },
    );
    const treeSha = requireString(tree.sha, "GitHub tree SHA");
    const commit = await this.requestJson<GitHubCommitResponse>(
      "POST",
      `/repos/${pathPart(plan.repository.owner)}/${pathPart(
        plan.repository.repo,
      )}/git/commits`,
      auth,
      {
        message: plan.message,
        tree: treeSha,
        parents: [headRef.sha],
      },
    );
    const commitSha = requireString(commit.sha, "GitHub commit SHA");
    await this.requestJson(
      "PATCH",
      `/repos/${pathPart(plan.repository.owner)}/${pathPart(
        plan.repository.repo,
      )}/git/refs/heads/${pathPart(plan.branch)}`,
      auth,
      {
        sha: commitSha,
        force: false,
      },
    );
    return {
      repository: { ...plan.repository },
      branch: plan.branch,
      commitSha,
      parentSha: headRef.sha,
      message: plan.message,
      changes: plan.changes.map(cloneChange),
    };
  }

  async createDraftPullRequest(
    input: GitHubPullRequestProposal | GitHubDraftPullRequestWorkflowPlan,
    auth: GitHubWorkflowExecutionAuth,
  ): Promise<GitHubDraftPullRequestResult> {
    const proposal = "pullRequest" in input ? input.pullRequest : input;
    const createResponse = await this.tryRequestJson<GitHubPullRequestResponse>(
      "POST",
      `/repos/${pathPart(proposal.repository.owner)}/${pathPart(
        proposal.repository.repo,
      )}/pulls`,
      auth,
      {
        title: proposal.title,
        body: proposal.body,
        head: proposal.headBranch,
        base: proposal.baseBranch,
        draft: proposal.draft,
        maintainer_can_modify: proposal.maintainerCanModify,
      },
    );
    let response: GitHubPullRequestResponse;
    if (createResponse.ok) {
      response = createResponse.value;
    } else if (isRetryableExistingResourceStatus(createResponse.status)) {
      response =
        (await this.findOpenPullRequestForBranchPair(proposal, auth)) ??
        throwGitHubRestError(createResponse);
    } else {
      response = throwGitHubRestError(createResponse);
    }
    const number = requireNumber(response.number, "GitHub pull request number");
    if (proposal.labels.length > 0) {
      await this.requestJson(
        "POST",
        `/repos/${pathPart(proposal.repository.owner)}/${pathPart(
          proposal.repository.repo,
        )}/issues/${number}/labels`,
        auth,
        { labels: proposal.labels },
      );
    }
    if (proposal.reviewers.length > 0) {
      await this.requestJson(
        "POST",
        `/repos/${pathPart(proposal.repository.owner)}/${pathPart(
          proposal.repository.repo,
        )}/pulls/${number}/requested_reviewers`,
        auth,
        { reviewers: proposal.reviewers },
      );
    }
    const observed = await this.getPullRequest(
      proposal.repository.owner,
      proposal.repository.repo,
      number,
      auth,
    );
    return {
      repository: { ...proposal.repository },
      number,
      id: normalizeNumber(observed.id, number),
      title: normalizeString(observed.title, proposal.title),
      body: normalizeString(observed.body, proposal.body),
      baseBranch: normalizeString(observed.base?.ref, proposal.baseBranch),
      headBranch: normalizeString(observed.head?.ref, proposal.headBranch),
      draft: normalizeBoolean(observed.draft, proposal.draft),
      maintainerCanModify: normalizeBoolean(
        observed.maintainer_can_modify,
        proposal.maintainerCanModify,
      ),
      labels: namesFromObjects(observed.labels, "name"),
      reviewers: namesFromObjects(observed.requested_reviewers, "login"),
      htmlUrl: requireString(observed.html_url, "GitHub pull request URL"),
    };
  }

  private async getBranchRef(
    owner: string,
    repo: string,
    branch: string,
    auth: GitHubWorkflowExecutionAuth,
  ): Promise<{ sha: string }> {
    const ref = await this.requestJson<GitHubRefResponse>(
      "GET",
      `/repos/${pathPart(owner)}/${pathPart(repo)}/git/ref/heads/${pathPart(
        branch,
      )}`,
      auth,
    );
    return { sha: requireString(ref.object?.sha, "GitHub branch ref SHA") };
  }

  private async tryGetBranchRef(
    owner: string,
    repo: string,
    branch: string,
    auth: GitHubWorkflowExecutionAuth,
  ): Promise<{ sha: string } | undefined> {
    const ref = await this.tryRequestJson<GitHubRefResponse>(
      "GET",
      `/repos/${pathPart(owner)}/${pathPart(repo)}/git/ref/heads/${pathPart(
        branch,
      )}`,
      auth,
    );
    if (!ref.ok) {
      if (ref.status === 404) {
        return undefined;
      }
      throwGitHubRestError(ref);
    }
    return {
      sha: requireString(ref.value.object?.sha, "GitHub branch ref SHA"),
    };
  }

  private async findOpenPullRequestForBranchPair(
    proposal: GitHubPullRequestProposal,
    auth: GitHubWorkflowExecutionAuth,
  ): Promise<GitHubPullRequestResponse | undefined> {
    const params = new URLSearchParams({
      state: "open",
      head: `${proposal.repository.owner}:${proposal.headBranch}`,
      base: proposal.baseBranch,
    });
    const responses = await this.requestJson<GitHubPullRequestResponse[]>(
      "GET",
      `/repos/${pathPart(proposal.repository.owner)}/${pathPart(
        proposal.repository.repo,
      )}/pulls?${params.toString()}`,
      auth,
    );
    if (!Array.isArray(responses)) {
      throw new Error("GitHub pull request list is missing from response.");
    }
    return responses[0];
  }

  private async getPullRequest(
    owner: string,
    repo: string,
    number: number,
    auth: GitHubWorkflowExecutionAuth,
  ): Promise<GitHubPullRequestResponse> {
    return this.requestJson<GitHubPullRequestResponse>(
      "GET",
      `/repos/${pathPart(owner)}/${pathPart(repo)}/pulls/${number}`,
      auth,
    );
  }

  private async requestJson<T>(
    method: string,
    path: string,
    auth: GitHubWorkflowExecutionAuth,
    body?: unknown,
  ): Promise<T> {
    const response = await this.tryRequestJson<T>(method, path, auth, body);
    if (!response.ok) {
      throwGitHubRestError(response);
    }
    return response.value;
  }

  private async tryRequestJson<T>(
    method: string,
    path: string,
    auth: GitHubWorkflowExecutionAuth,
    body?: unknown,
  ): Promise<GitHubRestJsonResult<T>> {
    const response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${auth.installationToken.token}`,
        "content-type": "application/json",
        "user-agent": this.userAgent,
        "x-github-api-version": "2022-11-28",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const responseText = await safeReadText(response);
      return {
        ok: false,
        status: response.status,
        statusText: response.statusText,
        message: `GitHub REST request failed: ${response.status} ${
          response.statusText
        } ${redactGitHubSecret(
          responseText,
          auth.installationToken.token,
        )}`.trim(),
      };
    }
    return { ok: true, value: (await response.json()) as T };
  }
}

type GitHubRestJsonResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; statusText: string; message: string };

function treeEntryForChange(change: GitHubCommitFileChange) {
  return {
    path: change.path,
    mode: change.executable ? "100755" : "100644",
    type: "blob",
    ...(change.deletion ? { sha: null } : { content: change.content ?? "" }),
  };
}

function cloneChange(change: GitHubCommitFileChange): GitHubCommitFileChange {
  return { ...change };
}

function pathPart(value: string): string {
  return encodeURIComponent(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is missing from GitHub response.`);
  }
  return value;
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} is missing from GitHub response.`);
  }
  return value;
}

function normalizeString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function normalizeNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function namesFromObjects(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [
    ...new Set(
      value
        .map((entry) =>
          entry &&
          typeof entry === "object" &&
          key in entry &&
          typeof entry[key as keyof typeof entry] === "string"
            ? entry[key as keyof typeof entry]
            : undefined,
        )
        .filter((entry): entry is string => Boolean(entry?.trim())),
    ),
  ];
}

function isRetryableExistingResourceStatus(status: number): boolean {
  return status === 409 || status === 422;
}

function throwGitHubRestError(error: { message: string }): never {
  throw new Error(error.message);
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function redactGitHubSecret(value: string, exactToken?: string): string {
  const exactRedacted = exactToken
    ? value.replace(
        new RegExp(escapeRegExp(exactToken), "g"),
        "[redacted:github-token]",
      )
    : value;
  return exactRedacted
    .replace(/\bgh[osurp]_[A-Za-z0-9_-]+\b/g, "[redacted:github-token]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]+\b/g, "[redacted:github-token]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted:github-token]");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
