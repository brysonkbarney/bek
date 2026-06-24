import type {
  GitHubBranchResult,
  GitHubCommitResult,
  GitHubDraftPullRequestResult,
} from "./fake-client";
import {
  assertGitHubInstallationTokenLease,
  type GitHubInstallationToken,
  type GitHubInstallationTokenLease,
  type GitHubInstallationTokenProvider,
} from "./tokens";
import type {
  GitHubBranchWorkflowPlan,
  GitHubCommitWorkflowPlan,
  GitHubDraftPullRequestWorkflowPlan,
  GitHubDraftPullRequestWorkflowStep,
} from "./workflows";

export interface GitHubWorkflowExecutionAuth {
  installationToken: GitHubInstallationToken;
  tokenLease: GitHubInstallationTokenLease;
}

export interface GitHubDraftPullRequestWorkflowExecutionClient {
  createBranch(
    plan: GitHubBranchWorkflowPlan,
    auth: GitHubWorkflowExecutionAuth,
  ): Promise<GitHubBranchResult>;
  commitFiles(
    plan: GitHubCommitWorkflowPlan,
    auth: GitHubWorkflowExecutionAuth,
  ): Promise<GitHubCommitResult>;
  createDraftPullRequest(
    plan: GitHubDraftPullRequestWorkflowPlan,
    auth: GitHubWorkflowExecutionAuth,
  ): Promise<GitHubDraftPullRequestResult>;
}

export interface ExecuteGitHubDraftPullRequestWorkflowPlanInput {
  plan: GitHubDraftPullRequestWorkflowPlan;
  tokenProvider: GitHubInstallationTokenProvider;
  client: GitHubDraftPullRequestWorkflowExecutionClient;
  now?: (() => Date) | undefined;
  minTokenTtlMs?: number | undefined;
}

export interface GitHubDraftPullRequestWorkflowExecutionResult {
  type: "github.draft_pull_request_workflow_execution";
  resource: string;
  installationId: string;
  tokenLease: GitHubInstallationTokenLease;
  branch: GitHubBranchResult;
  commit: GitHubCommitResult;
  pullRequest: GitHubDraftPullRequestResult;
  steps: GitHubDraftPullRequestWorkflowStep[];
  runId?: string | undefined;
  requesterPrincipalId?: string | undefined;
}

export async function executeGitHubDraftPullRequestWorkflowPlan(
  input: ExecuteGitHubDraftPullRequestWorkflowPlanInput,
): Promise<GitHubDraftPullRequestWorkflowExecutionResult> {
  const token = await input.tokenProvider.getInstallationToken(
    input.plan.tokenRequest,
  );
  const tokenLease = assertGitHubInstallationTokenLease({
    token,
    request: input.plan.tokenRequest,
    now: input.now,
    minTtlMs: input.minTokenTtlMs,
  });
  const auth: GitHubWorkflowExecutionAuth = {
    installationToken: token,
    tokenLease,
  };

  const branch = await input.client.createBranch(input.plan.branch, auth);
  const commit = await input.client.commitFiles(
    {
      ...input.plan.commit,
      expectedHeadSha: branch.commitSha,
    },
    auth,
  );
  const pullRequest = await input.client.createDraftPullRequest(
    input.plan,
    auth,
  );

  const result: GitHubDraftPullRequestWorkflowExecutionResult = {
    type: "github.draft_pull_request_workflow_execution",
    resource: input.plan.resource,
    installationId: input.plan.installationId,
    tokenLease,
    branch,
    commit,
    pullRequest,
    steps: [...input.plan.steps],
  };
  if (input.plan.runId) {
    result.runId = input.plan.runId;
  }
  if (input.plan.requesterPrincipalId) {
    result.requesterPrincipalId = input.plan.requesterPrincipalId;
  }
  return result;
}
