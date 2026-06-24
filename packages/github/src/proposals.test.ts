import { describe, expect, it } from "vitest";
import {
  BEK_VISIBLE_AGENT_HANDLE,
  createGitHubPullRequestProposal,
  normalizeGitHubBranchName,
} from "./proposals";

describe("GitHub PR proposals", () => {
  it("creates an approval-ready PR proposal without performing a GitHub write", () => {
    const proposal = createGitHubPullRequestProposal({
      repository: "github:RedoHQ/Checkout",
      title: "Add checkout retry tests",
      body: "Proposed by Bek after inspecting the failing flow.",
      baseBranch: "main",
      headBranch: "bek/checkout-retry-tests",
      labels: ["tests", "tests", "checkout"],
      reviewers: ["bryson", "bryson"],
      runId: "run_123",
      requesterPrincipalId: "principal_bryson",
    });

    expect(proposal).toMatchObject({
      type: "github.pull_request_proposal",
      visibleAgentHandle: BEK_VISIBLE_AGENT_HANDLE,
      capability: "github.pr",
      resource: "github:redohq/checkout",
      title: "Add checkout retry tests",
      baseBranch: "main",
      headBranch: "bek/checkout-retry-tests",
      draft: true,
      maintainerCanModify: true,
      labels: ["tests", "checkout"],
      reviewers: ["bryson"],
      runId: "run_123",
      requesterPrincipalId: "principal_bryson",
    });
    expect(proposal.approval).toEqual({
      required: true,
      action: "github.pr",
      risk: "write_external",
      resource: "github:redohq/checkout",
      reason:
        "Opening a GitHub pull request is an external write and must pass bundle policy and human approval.",
    });
  });

  it("defaults to main as the base branch", () => {
    expect(
      createGitHubPullRequestProposal({
        repository: { owner: "redohq", repo: "checkout" },
        title: "Document retries",
        headBranch: "bek/docs-retries",
      }).baseBranch,
    ).toBe("main");
  });

  it("rejects unsafe PR proposals before policy or network code sees them", () => {
    expect(() =>
      createGitHubPullRequestProposal({
        repository: "github:redohq/checkout",
        title: "   ",
        headBranch: "bek/test",
      }),
    ).toThrow("PR title is required");
    expect(() =>
      createGitHubPullRequestProposal({
        repository: "github:redohq/checkout",
        title: "Same branch",
        baseBranch: "main",
        headBranch: "main",
      }),
    ).toThrow("must be different");
    expect(() => normalizeGitHubBranchName("bad branch")).toThrow(
      "valid git ref",
    );
    expect(() => normalizeGitHubBranchName("feature/.lock")).toThrow(
      "valid git ref",
    );
  });
});
