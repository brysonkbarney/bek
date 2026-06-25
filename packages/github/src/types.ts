import type { GitHubRepoResource } from "./resources";
import type { GitHubCommitFileChange } from "./workflows";

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
