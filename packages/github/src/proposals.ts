import {
  parseGitHubRepoResource,
  type GitHubRepoRef,
  type GitHubRepoResource,
} from "./resources";

export const BEK_VISIBLE_AGENT_HANDLE = "@bek";

export interface CreateGitHubPullRequestProposalInput {
  repository: string | GitHubRepoRef;
  title: string;
  headBranch: string;
  baseBranch?: string | undefined;
  body?: string | undefined;
  draft?: boolean | undefined;
  maintainerCanModify?: boolean | undefined;
  labels?: string[] | undefined;
  reviewers?: string[] | undefined;
  runId?: string | undefined;
  requesterPrincipalId?: string | undefined;
}

export interface GitHubPullRequestProposal {
  type: "github.pull_request_proposal";
  visibleAgentHandle: typeof BEK_VISIBLE_AGENT_HANDLE;
  capability: "github.pr";
  resource: string;
  repository: GitHubRepoResource;
  title: string;
  body: string;
  baseBranch: string;
  headBranch: string;
  draft: boolean;
  maintainerCanModify: boolean;
  labels: string[];
  reviewers: string[];
  approval: {
    required: true;
    action: "github.pr";
    risk: "write_external";
    resource: string;
    reason: string;
  };
  runId?: string | undefined;
  requesterPrincipalId?: string | undefined;
}

export function createGitHubPullRequestProposal(
  input: CreateGitHubPullRequestProposalInput,
): GitHubPullRequestProposal {
  const repository = parseGitHubRepoResource(input.repository);
  const title = normalizeRequiredText(input.title, "PR title");
  const baseBranch = normalizeGitHubBranchName(input.baseBranch ?? "main");
  const headBranch = normalizeGitHubBranchName(input.headBranch);

  if (baseBranch === headBranch) {
    throw new Error("PR base and head branches must be different.");
  }

  const proposal: GitHubPullRequestProposal = {
    type: "github.pull_request_proposal",
    visibleAgentHandle: BEK_VISIBLE_AGENT_HANDLE,
    capability: "github.pr",
    resource: repository.resource,
    repository,
    title,
    body: input.body?.trim() ?? "",
    baseBranch,
    headBranch,
    draft: input.draft ?? true,
    maintainerCanModify: input.maintainerCanModify ?? true,
    labels: normalizeStringList(input.labels ?? [], "label"),
    reviewers: normalizeStringList(input.reviewers ?? [], "reviewer"),
    approval: {
      required: true,
      action: "github.pr",
      risk: "write_external",
      resource: repository.resource,
      reason:
        "Opening a GitHub pull request is an external write and must pass bundle policy and human approval.",
    },
  };

  const runId = input.runId?.trim();
  if (runId) {
    proposal.runId = runId;
  }
  const requesterPrincipalId = input.requesterPrincipalId?.trim();
  if (requesterPrincipalId) {
    proposal.requesterPrincipalId = requesterPrincipalId;
  }

  return proposal;
}

export function normalizeGitHubBranchName(branch: string): string {
  const normalized = branch.trim();
  if (!normalized) {
    throw new Error("GitHub branch name is required.");
  }
  if (normalized.length > 255) {
    throw new Error("GitHub branch name must be 255 characters or fewer.");
  }
  if (
    normalized.startsWith("/") ||
    normalized.endsWith("/") ||
    normalized.endsWith(".") ||
    normalized.includes("//") ||
    normalized.includes("..") ||
    normalized.includes("@{") ||
    /[\u0000-\u001f\u007f ~^:?*[\\]/.test(normalized) ||
    normalized.split("/").some((part) => part.startsWith("."))
  ) {
    throw new Error("GitHub branch name is not a valid git ref name.");
  }
  if (normalized.split("/").some((part) => part.endsWith(".lock"))) {
    throw new Error("GitHub branch name cannot contain .lock ref segments.");
  }
  return normalized;
}

function normalizeRequiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}

function normalizeStringList(values: string[], label: string): string[] {
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  if (normalized.some((value) => value.length > 100)) {
    throw new Error(`GitHub ${label}s must be 100 characters or fewer.`);
  }
  return [...new Set(normalized)];
}
