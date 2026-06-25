import {
  BEK_VISIBLE_AGENT_HANDLE,
  createGitHubPullRequestProposal,
  type CreateGitHubPullRequestProposalInput,
  type GitHubPullRequestProposal,
} from "./proposals";
import { normalizeGitHubInstallationId } from "./tokens";

export interface CreateGitHubPullRequestWriteApprovalHashInputInput extends CreateGitHubPullRequestProposalInput {
  installationId?: string | number | undefined;
  repositoryId?: string | number | undefined;
  existingPullRequestNumber?: number | undefined;
  headCommitSha?: string | undefined;
}

export interface GitHubPullRequestWriteApprovalHashInput {
  type: "github.pr.write.approval_hash_input";
  version: 1;
  visibleAgentHandle: typeof BEK_VISIBLE_AGENT_HANDLE;
  action: "github.pr";
  resource: string;
  repository: {
    provider: "github";
    owner: string;
    repo: string;
    fullName: string;
    resource: string;
  };
  title: string;
  body: string;
  baseBranch: string;
  headBranch: string;
  draft: boolean;
  maintainerCanModify: boolean;
  labels: string[];
  reviewers: string[];
  installationId?: string | undefined;
  repositoryId?: number | undefined;
  existingPullRequestNumber?: number | undefined;
  headCommitSha?: string | undefined;
}

export function createGitHubPullRequestWriteApprovalHashInput(
  input:
    | GitHubPullRequestProposal
    | CreateGitHubPullRequestWriteApprovalHashInputInput,
): GitHubPullRequestWriteApprovalHashInput {
  const proposal = isGitHubPullRequestProposal(input)
    ? input
    : createGitHubPullRequestProposal(input);
  const hashInput: GitHubPullRequestWriteApprovalHashInput = {
    type: "github.pr.write.approval_hash_input",
    version: 1,
    visibleAgentHandle: BEK_VISIBLE_AGENT_HANDLE,
    action: "github.pr",
    resource: proposal.resource,
    repository: {
      provider: "github",
      owner: proposal.repository.owner,
      repo: proposal.repository.repo,
      fullName: proposal.repository.fullName,
      resource: proposal.repository.resource,
    },
    title: proposal.title,
    body: proposal.body,
    baseBranch: proposal.baseBranch,
    headBranch: proposal.headBranch,
    draft: proposal.draft,
    maintainerCanModify: proposal.maintainerCanModify,
    labels: normalizeHashList(proposal.labels),
    reviewers: normalizeHashList(proposal.reviewers),
  };

  if (!isGitHubPullRequestProposal(input)) {
    if (input.installationId !== undefined) {
      hashInput.installationId = normalizeGitHubInstallationId(
        input.installationId,
      );
    }
    if (input.repositoryId !== undefined) {
      hashInput.repositoryId = normalizeRepositoryId(input.repositoryId);
    }
    if (input.existingPullRequestNumber !== undefined) {
      hashInput.existingPullRequestNumber = normalizePullRequestNumber(
        input.existingPullRequestNumber,
      );
    }
    if (input.headCommitSha !== undefined) {
      hashInput.headCommitSha = normalizeSha(input.headCommitSha);
    }
  }

  return hashInput;
}

function isGitHubPullRequestProposal(
  input: unknown,
): input is GitHubPullRequestProposal {
  return (
    typeof input === "object" &&
    input !== null &&
    "type" in input &&
    input.type === "github.pull_request_proposal"
  );
}

function normalizeHashList(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort(
    (left, right) => left.localeCompare(right),
  );
}

function normalizePullRequestNumber(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("GitHub pull request number must be a positive integer.");
  }
  return value;
}

function normalizeRepositoryId(value: string | number): number {
  const normalized = typeof value === "number" ? value : Number(value.trim());
  if (
    !Number.isSafeInteger(normalized) ||
    normalized <= 0 ||
    (typeof value === "string" && !/^\d+$/.test(value.trim()))
  ) {
    throw new Error("GitHub repository id must be a positive safe integer.");
  }
  return normalized;
}

function normalizeSha(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(normalized)) {
    throw new Error("GitHub commit SHA must be a 40 character hex string.");
  }
  return normalized;
}
