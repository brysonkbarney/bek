import { createHash } from "node:crypto";
import type { GitHubPullRequestProposal } from "./proposals";
import {
  parseGitHubRepoResource,
  type GitHubRepoRef,
  type GitHubRepoResource,
} from "./resources";
import type {
  GitHubBranchWorkflowPlan,
  GitHubCommitFileChange,
  GitHubCommitWorkflowPlan,
  GitHubDraftPullRequestWorkflowPlan,
} from "./workflows";

export interface GitHubClient {
  createBranch(plan: GitHubBranchWorkflowPlan): Promise<GitHubBranchResult>;
  commitFiles(plan: GitHubCommitWorkflowPlan): Promise<GitHubCommitResult>;
  createDraftPullRequest(
    input: GitHubPullRequestProposal | GitHubDraftPullRequestWorkflowPlan,
  ): Promise<GitHubDraftPullRequestResult>;
}

export interface FakeGitHubRepositorySeed {
  repository: string | GitHubRepoRef;
  defaultBranch?: string | undefined;
  branches?: Record<string, string> | undefined;
}

export interface GitHubBranchResult {
  repository: GitHubRepoResource;
  branch: string;
  commitSha: string;
  createdFrom: string;
}

export interface GitHubCommitResult {
  repository: GitHubRepoResource;
  branch: string;
  commitSha: string;
  parentSha: string;
  message: string;
  changes: GitHubCommitFileChange[];
}

export interface GitHubDraftPullRequestResult {
  repository: GitHubRepoResource;
  number: number;
  id: number;
  title: string;
  body: string;
  baseBranch: string;
  headBranch: string;
  draft: boolean;
  maintainerCanModify: boolean;
  labels: string[];
  reviewers: string[];
  htmlUrl: string;
}

export interface GitHubFakeRepositoryState {
  repository: GitHubRepoResource;
  defaultBranch: string;
  branches: Record<string, string>;
  commits: GitHubCommitResult[];
  pullRequests: GitHubDraftPullRequestResult[];
}

interface MutableRepositoryState {
  repository: GitHubRepoResource;
  defaultBranch: string;
  branches: Map<string, string>;
  commits: GitHubCommitResult[];
  pullRequests: GitHubDraftPullRequestResult[];
  nextPullRequestNumber: number;
}

const EMPTY_TREE_SHA = "0000000000000000000000000000000000000000";

export class FakeGitHubClient implements GitHubClient {
  private readonly repositories = new Map<string, MutableRepositoryState>();

  constructor(seeds: FakeGitHubRepositorySeed[] = []) {
    for (const seed of seeds) {
      this.seedRepository(seed);
    }
  }

  seedRepository(seed: FakeGitHubRepositorySeed): GitHubFakeRepositoryState {
    const repository = parseGitHubRepoResource(seed.repository);
    const defaultBranch = seed.defaultBranch?.trim() || "main";
    const branches = new Map<string, string>(
      Object.entries(seed.branches ?? { [defaultBranch]: EMPTY_TREE_SHA }),
    );
    if (!branches.has(defaultBranch)) {
      branches.set(defaultBranch, EMPTY_TREE_SHA);
    }
    const state: MutableRepositoryState = {
      repository,
      defaultBranch,
      branches,
      commits: [],
      pullRequests: [],
      nextPullRequestNumber: 1,
    };
    this.repositories.set(repository.resource, state);
    return this.readRepositoryState(repository);
  }

  async createBranch(
    plan: GitHubBranchWorkflowPlan,
  ): Promise<GitHubBranchResult> {
    const state = this.getRepository(plan.repository);
    const baseSha = state.branches.get(plan.baseBranch);
    if (!baseSha) {
      throw new Error(`GitHub base branch does not exist: ${plan.baseBranch}`);
    }
    if (state.branches.has(plan.headBranch)) {
      throw new Error(`GitHub branch already exists: ${plan.headBranch}`);
    }
    state.branches.set(plan.headBranch, baseSha);
    return {
      repository: { ...state.repository },
      branch: plan.headBranch,
      commitSha: baseSha,
      createdFrom: plan.baseBranch,
    };
  }

  async commitFiles(
    plan: GitHubCommitWorkflowPlan,
  ): Promise<GitHubCommitResult> {
    const state = this.getRepository(plan.repository);
    const parentSha = state.branches.get(plan.branch);
    if (!parentSha) {
      throw new Error(`GitHub branch does not exist: ${plan.branch}`);
    }
    if (plan.expectedHeadSha && plan.expectedHeadSha !== parentSha) {
      throw new Error("GitHub branch head did not match expected commit SHA.");
    }

    const commitSha = createFakeCommitSha({
      repository: state.repository.resource,
      branch: plan.branch,
      parentSha,
      message: plan.message,
      changes: plan.changes,
    });
    const commit: GitHubCommitResult = {
      repository: { ...state.repository },
      branch: plan.branch,
      commitSha,
      parentSha,
      message: plan.message,
      changes: plan.changes.map(cloneChange),
    };
    state.branches.set(plan.branch, commitSha);
    state.commits.push(commit);
    return cloneCommit(commit);
  }

  async createDraftPullRequest(
    input: GitHubPullRequestProposal | GitHubDraftPullRequestWorkflowPlan,
  ): Promise<GitHubDraftPullRequestResult> {
    const proposal = "pullRequest" in input ? input.pullRequest : input;
    const state = this.getRepository(proposal.repository);
    if (!state.branches.has(proposal.baseBranch)) {
      throw new Error(
        `GitHub base branch does not exist: ${proposal.baseBranch}`,
      );
    }
    if (!state.branches.has(proposal.headBranch)) {
      throw new Error(
        `GitHub head branch does not exist: ${proposal.headBranch}`,
      );
    }
    const duplicate = state.pullRequests.find(
      (pullRequest) =>
        pullRequest.baseBranch === proposal.baseBranch &&
        pullRequest.headBranch === proposal.headBranch,
    );
    if (duplicate) {
      throw new Error(
        "GitHub pull request already exists for this branch pair.",
      );
    }

    const number = state.nextPullRequestNumber;
    state.nextPullRequestNumber += 1;
    const pullRequest: GitHubDraftPullRequestResult = {
      repository: { ...state.repository },
      number,
      id: number,
      title: proposal.title,
      body: proposal.body,
      baseBranch: proposal.baseBranch,
      headBranch: proposal.headBranch,
      draft: proposal.draft,
      maintainerCanModify: proposal.maintainerCanModify,
      labels: [...proposal.labels],
      reviewers: [...proposal.reviewers],
      htmlUrl: `${state.repository.url}/pull/${number}`,
    };
    state.pullRequests.push(pullRequest);
    return clonePullRequest(pullRequest);
  }

  readRepositoryState(
    repository: string | GitHubRepoRef,
  ): GitHubFakeRepositoryState {
    const state = this.getRepository(parseGitHubRepoResource(repository));
    return {
      repository: { ...state.repository },
      defaultBranch: state.defaultBranch,
      branches: Object.fromEntries(state.branches),
      commits: state.commits.map(cloneCommit),
      pullRequests: state.pullRequests.map(clonePullRequest),
    };
  }

  private getRepository(
    repository: string | GitHubRepoRef | GitHubRepoResource,
  ): MutableRepositoryState {
    const parsed = parseGitHubRepoResource(repository);
    const state = this.repositories.get(parsed.resource);
    if (!state) {
      throw new Error(`Fake GitHub repo is not seeded: ${parsed.resource}`);
    }
    return state;
  }
}

function createFakeCommitSha(input: {
  repository: string;
  branch: string;
  parentSha: string;
  message: string;
  changes: GitHubCommitFileChange[];
}): string {
  return createHash("sha1").update(JSON.stringify(input)).digest("hex");
}

function cloneCommit(commit: GitHubCommitResult): GitHubCommitResult {
  return {
    repository: { ...commit.repository },
    branch: commit.branch,
    commitSha: commit.commitSha,
    parentSha: commit.parentSha,
    message: commit.message,
    changes: commit.changes.map(cloneChange),
  };
}

function clonePullRequest(
  pullRequest: GitHubDraftPullRequestResult,
): GitHubDraftPullRequestResult {
  return {
    repository: { ...pullRequest.repository },
    number: pullRequest.number,
    id: pullRequest.id,
    title: pullRequest.title,
    body: pullRequest.body,
    baseBranch: pullRequest.baseBranch,
    headBranch: pullRequest.headBranch,
    draft: pullRequest.draft,
    maintainerCanModify: pullRequest.maintainerCanModify,
    labels: [...pullRequest.labels],
    reviewers: [...pullRequest.reviewers],
    htmlUrl: pullRequest.htmlUrl,
  };
}

function cloneChange(change: GitHubCommitFileChange): GitHubCommitFileChange {
  const clone: GitHubCommitFileChange = { path: change.path };
  if (change.content !== undefined) {
    clone.content = change.content;
  }
  if (change.deletion === true) {
    clone.deletion = true;
  }
  if (change.executable === true) {
    clone.executable = true;
  }
  return clone;
}
