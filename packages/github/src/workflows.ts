import {
  createGitHubPullRequestWriteApprovalHashInput,
  type GitHubPullRequestWriteApprovalHashInput,
} from "./approvals";
import {
  BEK_VISIBLE_AGENT_HANDLE,
  createGitHubPullRequestProposal,
  normalizeGitHubBranchName,
  type GitHubPullRequestProposal,
} from "./proposals";
import {
  parseGitHubRepoResource,
  type GitHubRepoRef,
  type GitHubRepoResource,
} from "./resources";
import {
  createGitHubInstallationTokenRequest,
  normalizeGitHubInstallationId,
  type GitHubInstallationTokenRequest,
} from "./tokens";

export interface CreateGitHubBranchWorkflowPlanInput {
  repository: string | GitHubRepoRef;
  installationId: string | number;
  baseBranch?: string | undefined;
  headBranch: string;
  runId?: string | undefined;
  requesterPrincipalId?: string | undefined;
}

export interface GitHubBranchWorkflowPlan {
  type: "github.branch_workflow_plan";
  visibleAgentHandle: typeof BEK_VISIBLE_AGENT_HANDLE;
  capability: "github.branch";
  resource: string;
  repository: GitHubRepoResource;
  installationId: string;
  baseBranch: string;
  headBranch: string;
  approval: {
    required: true;
    action: "github.branch";
    risk: "write_draft";
    resource: string;
    reason: string;
  };
  runId?: string | undefined;
  requesterPrincipalId?: string | undefined;
}

export interface GitHubCommitFileChange {
  path: string;
  content?: string | undefined;
  deletion?: boolean | undefined;
  executable?: boolean | undefined;
}

export interface CreateGitHubCommitWorkflowPlanInput {
  repository: string | GitHubRepoRef;
  installationId: string | number;
  branch: string;
  message: string;
  changes: GitHubCommitFileChange[];
  expectedHeadSha?: string | undefined;
  runId?: string | undefined;
  requesterPrincipalId?: string | undefined;
}

export interface GitHubCommitWorkflowPlan {
  type: "github.commit_workflow_plan";
  visibleAgentHandle: typeof BEK_VISIBLE_AGENT_HANDLE;
  capability: "github.branch";
  resource: string;
  repository: GitHubRepoResource;
  installationId: string;
  branch: string;
  message: string;
  changes: GitHubCommitFileChange[];
  approval: {
    required: true;
    action: "github.branch";
    risk: "write_draft";
    resource: string;
    reason: string;
  };
  expectedHeadSha?: string | undefined;
  runId?: string | undefined;
  requesterPrincipalId?: string | undefined;
}

export interface CreateGitHubDraftPullRequestWorkflowPlanInput {
  repository: string | GitHubRepoRef;
  installationId: string | number;
  title: string;
  headBranch: string;
  baseBranch?: string | undefined;
  body?: string | undefined;
  commitMessage: string;
  changes: GitHubCommitFileChange[];
  draft?: boolean | undefined;
  maintainerCanModify?: boolean | undefined;
  labels?: string[] | undefined;
  reviewers?: string[] | undefined;
  runId?: string | undefined;
  requesterPrincipalId?: string | undefined;
}

export type GitHubDraftPullRequestWorkflowStep =
  | "mint_installation_token"
  | "create_branch"
  | "commit_changes"
  | "open_draft_pull_request";

export interface GitHubDraftPullRequestWorkflowPlan {
  type: "github.draft_pull_request_workflow_plan";
  visibleAgentHandle: typeof BEK_VISIBLE_AGENT_HANDLE;
  resource: string;
  repository: GitHubRepoResource;
  installationId: string;
  tokenRequest: GitHubInstallationTokenRequest;
  branch: GitHubBranchWorkflowPlan;
  commit: GitHubCommitWorkflowPlan;
  pullRequest: GitHubPullRequestProposal;
  approvalHashInput: GitHubPullRequestWriteApprovalHashInput;
  steps: GitHubDraftPullRequestWorkflowStep[];
  runId?: string | undefined;
  requesterPrincipalId?: string | undefined;
}

export function createGitHubBranchWorkflowPlan(
  input: CreateGitHubBranchWorkflowPlanInput,
): GitHubBranchWorkflowPlan {
  const repository = parseGitHubRepoResource(input.repository);
  const baseBranch = normalizeGitHubBranchName(input.baseBranch ?? "main");
  const headBranch = normalizeGitHubBranchName(input.headBranch);
  if (baseBranch === headBranch) {
    throw new Error("GitHub branch workflow base and head must be different.");
  }

  const plan: GitHubBranchWorkflowPlan = {
    type: "github.branch_workflow_plan",
    visibleAgentHandle: BEK_VISIBLE_AGENT_HANDLE,
    capability: "github.branch",
    resource: repository.resource,
    repository,
    installationId: normalizeGitHubInstallationId(input.installationId),
    baseBranch,
    headBranch,
    approval: {
      required: true,
      action: "github.branch",
      risk: "write_draft",
      resource: repository.resource,
      reason:
        "Creating or updating a GitHub branch is a draft write and must pass bundle policy.",
    },
  };
  addRunMetadata(plan, input);
  return plan;
}

export function createGitHubCommitWorkflowPlan(
  input: CreateGitHubCommitWorkflowPlanInput,
): GitHubCommitWorkflowPlan {
  const repository = parseGitHubRepoResource(input.repository);
  const branch = normalizeGitHubBranchName(input.branch);
  const message = normalizeRequiredText(input.message, "GitHub commit message");
  const changes = normalizeCommitChanges(input.changes);

  const plan: GitHubCommitWorkflowPlan = {
    type: "github.commit_workflow_plan",
    visibleAgentHandle: BEK_VISIBLE_AGENT_HANDLE,
    capability: "github.branch",
    resource: repository.resource,
    repository,
    installationId: normalizeGitHubInstallationId(input.installationId),
    branch,
    message,
    changes,
    approval: {
      required: true,
      action: "github.branch",
      risk: "write_draft",
      resource: repository.resource,
      reason:
        "Committing to a GitHub branch is a draft write and must pass bundle policy.",
    },
  };
  if (input.expectedHeadSha) {
    plan.expectedHeadSha = normalizeGitHubCommitSha(input.expectedHeadSha);
  }
  addRunMetadata(plan, input);
  return plan;
}

export function createGitHubDraftPullRequestWorkflowPlan(
  input: CreateGitHubDraftPullRequestWorkflowPlanInput,
): GitHubDraftPullRequestWorkflowPlan {
  const repository = parseGitHubRepoResource(input.repository);
  const installationId = normalizeGitHubInstallationId(input.installationId);
  const branch = createGitHubBranchWorkflowPlan({
    repository,
    installationId,
    baseBranch: input.baseBranch,
    headBranch: input.headBranch,
    runId: input.runId,
    requesterPrincipalId: input.requesterPrincipalId,
  });
  const commit = createGitHubCommitWorkflowPlan({
    repository,
    installationId,
    branch: branch.headBranch,
    message: input.commitMessage,
    changes: input.changes,
    runId: input.runId,
    requesterPrincipalId: input.requesterPrincipalId,
  });
  const pullRequest = createGitHubPullRequestProposal({
    repository,
    title: input.title,
    headBranch: branch.headBranch,
    baseBranch: branch.baseBranch,
    body: input.body,
    draft: input.draft ?? true,
    maintainerCanModify: input.maintainerCanModify,
    labels: input.labels,
    reviewers: input.reviewers,
    runId: input.runId,
    requesterPrincipalId: input.requesterPrincipalId,
  });

  const plan: GitHubDraftPullRequestWorkflowPlan = {
    type: "github.draft_pull_request_workflow_plan",
    visibleAgentHandle: BEK_VISIBLE_AGENT_HANDLE,
    resource: repository.resource,
    repository,
    installationId,
    tokenRequest: createGitHubInstallationTokenRequest({
      installationId,
      repository,
      permissions: {
        contents: "write",
        metadata: "read",
        pull_requests: "write",
      },
    }),
    branch,
    commit,
    pullRequest,
    approvalHashInput: createGitHubPullRequestWriteApprovalHashInput({
      repository,
      title: pullRequest.title,
      body: pullRequest.body,
      baseBranch: pullRequest.baseBranch,
      headBranch: pullRequest.headBranch,
      draft: pullRequest.draft,
      maintainerCanModify: pullRequest.maintainerCanModify,
      labels: pullRequest.labels,
      reviewers: pullRequest.reviewers,
      installationId,
    }),
    steps: [
      "mint_installation_token",
      "create_branch",
      "commit_changes",
      "open_draft_pull_request",
    ],
  };
  addRunMetadata(plan, input);
  return plan;
}

export function normalizeCommitChanges(
  changes: GitHubCommitFileChange[],
): GitHubCommitFileChange[] {
  if (changes.length === 0) {
    throw new Error(
      "GitHub commit workflow requires at least one file change.",
    );
  }
  const normalized = changes.map(normalizeCommitChange);
  const paths = new Set<string>();
  for (const change of normalized) {
    if (paths.has(change.path)) {
      throw new Error(
        `GitHub commit workflow has duplicate path: ${change.path}`,
      );
    }
    paths.add(change.path);
  }
  return normalized;
}

export function normalizeGitHubCommitSha(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(normalized)) {
    throw new Error("GitHub commit SHA must be a 40 character hex string.");
  }
  return normalized;
}

function normalizeCommitChange(
  change: GitHubCommitFileChange,
): GitHubCommitFileChange {
  const path = normalizeGitHubFilePath(change.path);
  const deletion = change.deletion === true;
  if (deletion && change.content !== undefined) {
    throw new Error("GitHub deleted file changes cannot include content.");
  }
  if (!deletion && change.content === undefined) {
    throw new Error("GitHub file changes require content unless deleted.");
  }
  const normalized: GitHubCommitFileChange = { path };
  if (deletion) {
    normalized.deletion = true;
  } else {
    normalized.content = change.content;
  }
  if (change.executable === true) {
    normalized.executable = true;
  }
  return normalized;
}

function normalizeGitHubFilePath(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.includes("\0") ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("GitHub file path must be a safe relative path.");
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

function addRunMetadata(
  plan:
    | GitHubBranchWorkflowPlan
    | GitHubCommitWorkflowPlan
    | GitHubDraftPullRequestWorkflowPlan,
  input: {
    runId?: string | undefined;
    requesterPrincipalId?: string | undefined;
  },
): void {
  const runId = input.runId?.trim();
  if (runId) {
    plan.runId = runId;
  }
  const requesterPrincipalId = input.requesterPrincipalId?.trim();
  if (requesterPrincipalId) {
    plan.requesterPrincipalId = requesterPrincipalId;
  }
}
