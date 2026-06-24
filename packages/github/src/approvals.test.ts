import { describe, expect, it } from "vitest";
import { createGitHubPullRequestWriteApprovalHashInput } from "./approvals";
import { createGitHubPullRequestProposal } from "./proposals";

describe("GitHub PR approval hash inputs", () => {
  it("builds stable, secret-free hash inputs for PR writes", () => {
    const input = createGitHubPullRequestWriteApprovalHashInput({
      repository: "github:RedoHQ/Checkout",
      installationId: 123,
      title: "Add retry tests",
      body: "Open a draft PR for review.",
      baseBranch: "main",
      headBranch: "bek/retry-tests",
      labels: ["tests", "checkout", "tests"],
      reviewers: ["zoe", "amy"],
      headCommitSha: "ABCDEFabcdef1234567890123456789012345678",
    });

    expect(input).toEqual({
      type: "github.pr.write.approval_hash_input",
      version: 1,
      visibleAgentHandle: "@bek",
      action: "github.pr",
      resource: "github:redohq/checkout",
      repository: {
        provider: "github",
        owner: "redohq",
        repo: "checkout",
        fullName: "redohq/checkout",
        resource: "github:redohq/checkout",
      },
      title: "Add retry tests",
      body: "Open a draft PR for review.",
      baseBranch: "main",
      headBranch: "bek/retry-tests",
      draft: true,
      maintainerCanModify: true,
      labels: ["checkout", "tests"],
      reviewers: ["amy", "zoe"],
      installationId: "123",
      headCommitSha: "abcdefabcdef1234567890123456789012345678",
    });
    expect(JSON.stringify(input)).not.toContain("token");
  });

  it("also accepts an existing PR proposal", () => {
    const proposal = createGitHubPullRequestProposal({
      repository: "github:redohq/checkout",
      title: "Document workflow",
      headBranch: "bek/docs-workflow",
    });

    expect(
      createGitHubPullRequestWriteApprovalHashInput(proposal),
    ).toMatchObject({
      action: "github.pr",
      resource: "github:redohq/checkout",
      title: "Document workflow",
      baseBranch: "main",
      headBranch: "bek/docs-workflow",
    });
  });

  it("rejects non-canonical commit SHA metadata", () => {
    expect(() =>
      createGitHubPullRequestWriteApprovalHashInput({
        repository: "github:redohq/checkout",
        title: "Bad SHA",
        headBranch: "bek/bad-sha",
        headCommitSha: "abc123",
      }),
    ).toThrow("40 character hex");
  });
});
