import { describe, expect, it } from "vitest";
import {
  createDeterministicGitHubBranchName,
  createGitHubPullRequestPlanHash,
  createGitHubPullRequestPlanHashBinding,
  resolveGitHubBranchPlan,
} from "./branches";
import { createGitHubPullRequestProposal } from "./proposals";
import { normalizeGitHubBranchName } from "./proposals";

describe("createDeterministicGitHubBranchName", () => {
  it("is idempotent for the same inputs", () => {
    const a = createDeterministicGitHubBranchName({
      runId: "run_123",
      planHash: "abc123",
      slug: "Add retry tests",
    });
    const b = createDeterministicGitHubBranchName({
      runId: "run_123",
      planHash: "abc123",
      slug: "Add retry tests",
    });
    expect(a).toBe(b);
    expect(a.startsWith("bek/")).toBe(true);
  });

  it("changes when the plan hash changes", () => {
    const base = { runId: "run_123", slug: "fix" };
    expect(
      createDeterministicGitHubBranchName({ ...base, planHash: "hash-one" }),
    ).not.toBe(
      createDeterministicGitHubBranchName({ ...base, planHash: "hash-two" }),
    );
  });

  it("changes when the run id changes", () => {
    const base = { planHash: "abc123", slug: "fix" };
    expect(
      createDeterministicGitHubBranchName({ ...base, runId: "run_a" }),
    ).not.toBe(
      createDeterministicGitHubBranchName({ ...base, runId: "run_b" }),
    );
  });

  it("always produces a valid git ref name", () => {
    const branch = createDeterministicGitHubBranchName({
      runId: "run_123",
      planHash: "abc123",
      slug: "ok",
    });
    expect(() => normalizeGitHubBranchName(branch)).not.toThrow();
  });

  it("sanitizes nasty slugs and run ids into ref-safe names", () => {
    const nasty = [
      "  ..hello..world..  ",
      "feat/../etc",
      "a b\tc\nd",
      "UPPER Case Title",
      "weird~^:?*[]\\chars",
      "trailing/slash/",
      "double//slash",
      "emoji 🚀 here",
      "tab\tand space",
      "dots...everywhere...",
    ];
    for (const slug of nasty) {
      const branch = createDeterministicGitHubBranchName({
        runId: "run_1",
        planHash: "h",
        slug,
      });
      expect(() => normalizeGitHubBranchName(branch)).not.toThrow();
      expect(branch).not.toContain(" ");
      expect(branch).not.toContain("..");
      expect(branch).not.toContain("//");
      expect(branch.endsWith("/")).toBe(false);
      expect(branch).toBe(branch.toLowerCase());
    }
  });

  it("caps the branch length while keeping the plan-hash anchor", () => {
    const branch = createDeterministicGitHubBranchName({
      runId: "run_" + "x".repeat(200),
      planHash: "stable-hash",
      slug: "y".repeat(200),
      maxLength: 50,
    });
    expect(branch.length).toBeLessThanOrEqual(50);
    expect(() => normalizeGitHubBranchName(branch)).not.toThrow();
    // The hash digest is preserved so retries with the same plan collide.
    const again = createDeterministicGitHubBranchName({
      runId: "run_" + "x".repeat(200),
      planHash: "stable-hash",
      slug: "y".repeat(200),
      maxLength: 50,
    });
    expect(branch).toBe(again);
  });

  it("supports a custom prefix", () => {
    const branch = createDeterministicGitHubBranchName({
      runId: "run_1",
      planHash: "h",
      prefix: "bot/auto",
    });
    expect(branch.startsWith("bot/auto/")).toBe(true);
  });

  it("rejects empty run id and empty plan hash", () => {
    expect(() =>
      createDeterministicGitHubBranchName({ runId: "   ", planHash: "h" }),
    ).toThrow("runId");
    expect(() =>
      createDeterministicGitHubBranchName({ runId: "run", planHash: "  " }),
    ).toThrow("planHash");
  });

  it("rejects a maxLength too small to hold the prefix and hash", () => {
    expect(() =>
      createDeterministicGitHubBranchName({
        runId: "run",
        planHash: "h",
        maxLength: 5,
      }),
    ).toThrow("too small");
  });

  it("works without a slug", () => {
    const branch = createDeterministicGitHubBranchName({
      runId: "run_99",
      planHash: "h",
    });
    expect(() => normalizeGitHubBranchName(branch)).not.toThrow();
  });
});

describe("resolveGitHubBranchPlan", () => {
  it("creates new when nothing exists", () => {
    const result = resolveGitHubBranchPlan({
      branchName: "bek/feature",
      planHash: "plan-1",
    });
    expect(result.decision).toBe("create_new");
    expect(result.reason).toContain("creating new");
  });

  it("reuses an existing branch with a matching plan hash", () => {
    const result = resolveGitHubBranchPlan({
      branchName: "bek/feature",
      planHash: "plan-1",
      existingBranches: [{ name: "bek/feature", planHash: "plan-1" }],
    });
    expect(result.decision).toBe("reuse_existing");
  });

  it("conflicts when an existing branch has a different plan hash", () => {
    const result = resolveGitHubBranchPlan({
      branchName: "bek/feature",
      planHash: "plan-2",
      existingBranches: [{ name: "bek/feature", planHash: "plan-1" }],
    });
    expect(result.decision).toBe("conflict");
    expect(result.reason).toContain("different plan hash");
  });

  it("conflicts when an existing branch has no recorded plan hash", () => {
    const result = resolveGitHubBranchPlan({
      branchName: "bek/feature",
      planHash: "plan-1",
      existingBranches: [{ name: "bek/feature" }],
    });
    expect(result.decision).toBe("conflict");
    expect(result.reason).toContain("without a recorded plan hash");
  });

  it("reuses an open PR whose plan hash matches", () => {
    const result = resolveGitHubBranchPlan({
      branchName: "bek/feature",
      planHash: "plan-1",
      existingPullRequests: [
        { number: 7, headBranch: "bek/feature", planHash: "plan-1" },
      ],
    });
    expect(result.decision).toBe("reuse_existing");
    expect(result.existingPullRequestNumber).toBe(7);
  });

  it("conflicts on an open PR with a different plan hash", () => {
    const result = resolveGitHubBranchPlan({
      branchName: "bek/feature",
      planHash: "plan-2",
      existingPullRequests: [
        { number: 7, headBranch: "bek/feature", planHash: "plan-1" },
      ],
    });
    expect(result.decision).toBe("conflict");
    expect(result.existingPullRequestNumber).toBe(7);
    expect(result.reason).toContain("different plan hash");
  });

  it("conflicts on a merged PR even if the plan hash matches", () => {
    const result = resolveGitHubBranchPlan({
      branchName: "bek/feature",
      planHash: "plan-1",
      existingPullRequests: [
        {
          number: 7,
          headBranch: "bek/feature",
          planHash: "plan-1",
          state: "merged",
        },
      ],
    });
    expect(result.decision).toBe("conflict");
    expect(result.reason).toContain("merged");
  });

  it("conflicts when an open PR targets a different base branch", () => {
    const result = resolveGitHubBranchPlan({
      branchName: "bek/feature",
      baseBranch: "main",
      planHash: "plan-1",
      existingPullRequests: [
        {
          number: 7,
          headBranch: "bek/feature",
          baseBranch: "develop",
          planHash: "plan-1",
        },
      ],
    });
    expect(result.decision).toBe("conflict");
    expect(result.reason).toContain("different base branch");
  });

  it("conflicts when an open PR has no recorded plan hash", () => {
    const result = resolveGitHubBranchPlan({
      branchName: "bek/feature",
      planHash: "plan-1",
      existingPullRequests: [{ number: 7, headBranch: "bek/feature" }],
    });
    expect(result.decision).toBe("conflict");
    expect(result.reason).toContain("no recorded plan hash");
  });

  it("prefers a PR match over a bare branch match", () => {
    const result = resolveGitHubBranchPlan({
      branchName: "bek/feature",
      planHash: "plan-1",
      existingBranches: [{ name: "bek/feature", planHash: "plan-1" }],
      existingPullRequests: [
        { number: 7, headBranch: "bek/feature", planHash: "plan-2" },
      ],
    });
    expect(result.decision).toBe("conflict");
    expect(result.existingPullRequestNumber).toBe(7);
  });

  it("matches branches/PRs regardless of casing in head branch refs", () => {
    const result = resolveGitHubBranchPlan({
      branchName: "bek/Feature",
      planHash: "plan-1",
      existingPullRequests: [
        { number: 7, headBranch: "bek/Feature", planHash: "plan-1" },
      ],
    });
    expect(result.decision).toBe("reuse_existing");
  });
});

describe("createGitHubPullRequestPlanHashBinding", () => {
  const baseInput = {
    repository: "github:RedoHQ/Checkout",
    installationId: 123,
    title: "Add retry tests",
    body: "Open a draft PR.",
    baseBranch: "main",
    headBranch: "bek/retry-tests",
    diffSummary: "2 files changed, +40 -3",
    files: ["src/a.ts", "src/b.ts"],
    modelRoute: "anthropic/claude",
    runtime: "opencode-docker",
    requesterPrincipalId: "user_42",
  };

  it("is deterministic for the same plan", () => {
    expect(createGitHubPullRequestPlanHash(baseInput)).toBe(
      createGitHubPullRequestPlanHash(baseInput),
    );
  });

  it("normalizes file order so it is order-insensitive", () => {
    expect(
      createGitHubPullRequestPlanHash({
        ...baseInput,
        files: ["src/b.ts", "src/a.ts"],
      }),
    ).toBe(createGitHubPullRequestPlanHash(baseInput));
  });

  it("produces a 64-char sha256 hex digest and a structured binding", () => {
    const binding = createGitHubPullRequestPlanHashBinding(baseInput);
    expect(binding.type).toBe("github.pr.plan_hash_binding");
    expect(binding.algorithm).toBe("sha256");
    expect(binding.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(binding.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(binding.approvalHashInput.resource).toBe("github:redohq/checkout");
  });

  it("never leaks tokens or secrets in the binding", () => {
    const binding = createGitHubPullRequestPlanHashBinding(baseInput);
    expect(JSON.stringify(binding)).not.toContain("token");
  });

  const fields: { key: keyof typeof baseInput; value: unknown }[] = [
    { key: "title", value: "Different title" },
    { key: "body", value: "Different body" },
    { key: "baseBranch", value: "develop" },
    { key: "headBranch", value: "bek/other" },
    { key: "installationId", value: 999 },
    { key: "diffSummary", value: "9 files changed" },
    { key: "files", value: ["src/c.ts"] },
    { key: "modelRoute", value: "anthropic/opus" },
    { key: "runtime", value: "deterministic-local" },
    { key: "requesterPrincipalId", value: "user_99" },
    { key: "repository", value: "github:RedoHQ/Other" },
  ];

  for (const field of fields) {
    it(`is sensitive to the ${String(field.key)} field`, () => {
      const changed = { ...baseInput, [field.key]: field.value };
      expect(createGitHubPullRequestPlanHash(changed)).not.toBe(
        createGitHubPullRequestPlanHash(baseInput),
      );
    });
  }

  it("treats absent optional fields distinctly from present ones", () => {
    const minimal = {
      repository: "github:redohq/checkout",
      title: "Minimal",
      headBranch: "bek/minimal",
    };
    const withDiff = { ...minimal, diffSummary: "1 file" };
    expect(createGitHubPullRequestPlanHash(minimal)).not.toBe(
      createGitHubPullRequestPlanHash(withDiff),
    );
  });

  it("accepts a PR proposal directly", () => {
    const proposal = createGitHubPullRequestProposal({
      repository: "github:redohq/checkout",
      title: "Document workflow",
      headBranch: "bek/docs",
    });
    const binding = createGitHubPullRequestPlanHashBinding(proposal);
    expect(binding.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
