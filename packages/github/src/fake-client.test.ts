import { describe, expect, it } from "vitest";
import { FakeGitHubClient } from "./fake-client";
import { createGitHubDraftPullRequestWorkflowPlan } from "./workflows";

const mainSha = "1111111111111111111111111111111111111111";

describe("Fake GitHub client", () => {
  it("executes a draft PR workflow locally without network calls", async () => {
    const client = new FakeGitHubClient([
      {
        repository: "github:redohq/checkout",
        branches: { main: mainSha },
      },
    ]);
    const plan = createGitHubDraftPullRequestWorkflowPlan({
      repository: "github:redohq/checkout",
      installationId: 99,
      title: "Add retry tests",
      headBranch: "bek/retry-tests",
      commitMessage: "Add retry tests",
      changes: [
        { path: "tests/retry.test.ts", content: "test('ok', () => {});\n" },
      ],
    });

    await expect(client.createBranch(plan.branch)).resolves.toMatchObject({
      branch: "bek/retry-tests",
      commitSha: mainSha,
      createdFrom: "main",
    });
    const commit = await client.commitFiles(plan.commit);
    expect(commit).toMatchObject({
      branch: "bek/retry-tests",
      parentSha: mainSha,
      message: "Add retry tests",
    });
    expect(commit.commitSha).toMatch(/^[0-9a-f]{40}$/);

    await expect(client.createDraftPullRequest(plan)).resolves.toMatchObject({
      number: 1,
      title: "Add retry tests",
      baseBranch: "main",
      headBranch: "bek/retry-tests",
      draft: true,
      htmlUrl: "https://github.com/redohq/checkout/pull/1",
    });

    const state = client.readRepositoryState("github:redohq/checkout");
    expect(state.branches["bek/retry-tests"]).toBe(commit.commitSha);
    expect(state.commits).toHaveLength(1);
    expect(state.pullRequests).toHaveLength(1);
  });

  it("fails clearly on stale branch heads and duplicate PRs", async () => {
    const client = new FakeGitHubClient([
      {
        repository: "github:redohq/checkout",
        branches: { main: mainSha },
      },
    ]);
    const plan = createGitHubDraftPullRequestWorkflowPlan({
      repository: "github:redohq/checkout",
      installationId: 99,
      title: "Update checkout",
      headBranch: "bek/update-checkout",
      commitMessage: "Update checkout",
      changes: [{ path: "checkout.ts", content: "export {};\n" }],
    });

    await client.createBranch(plan.branch);
    const stalePlan = {
      ...plan.commit,
      expectedHeadSha: "2222222222222222222222222222222222222222",
    };
    await expect(client.commitFiles(stalePlan)).rejects.toThrow(
      "expected commit SHA",
    );

    await client.commitFiles(plan.commit);
    await client.createDraftPullRequest(plan);
    await expect(client.createDraftPullRequest(plan)).rejects.toThrow(
      "already exists",
    );
  });
});
