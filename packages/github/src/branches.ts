import { createHash } from "node:crypto";

import {
  createGitHubPullRequestWriteApprovalHashInput,
  type CreateGitHubPullRequestWriteApprovalHashInputInput,
  type GitHubPullRequestWriteApprovalHashInput,
} from "./approvals";
import { normalizeGitHubBranchName } from "./proposals";
import type { GitHubPullRequestProposal } from "./proposals";

const DEFAULT_BRANCH_PREFIX = "bek";
const DEFAULT_BRANCH_MAX_LENGTH = 60;
const BRANCH_HASH_LENGTH = 12;

export interface CreateDeterministicGitHubBranchNameInput {
  runId: string;
  planHash: string;
  slug?: string | undefined;
  prefix?: string | undefined;
  maxLength?: number | undefined;
}

/**
 * Produce a deterministic, retry-safe git branch name from run inputs. The
 * same `runId` + `planHash` (+ optional slug/prefix) always yields the exact
 * same branch name, so retries of a workflow reuse the branch instead of
 * forking a new one. The result is always a valid git ref name.
 */
export function createDeterministicGitHubBranchName(
  input: CreateDeterministicGitHubBranchNameInput,
): string {
  const prefix = sanitizeBranchPrefix(input.prefix ?? DEFAULT_BRANCH_PREFIX);
  if (!prefix) {
    throw new Error("GitHub branch prefix must contain ref-safe characters.");
  }

  const runIdSegment = sanitizeBranchSegment(input.runId);
  if (!runIdSegment) {
    throw new Error("GitHub branch runId must contain ref-safe characters.");
  }

  const planHashDigest = hashToHexSegment(
    normalizeRequiredText(input.planHash, "GitHub branch planHash"),
  );

  const maxLength = normalizeBranchMaxLength(input.maxLength);
  const slugSegment =
    input.slug !== undefined ? sanitizeBranchSegment(input.slug) : "";

  // The plan hash digest is the idempotency anchor and is kept whole; the
  // run id and slug are budgeted against the remaining length so the branch
  // stays under `maxLength` without ever dropping the disambiguating hash.
  const fixed = `${prefix}/`;
  const tail = `-${planHashDigest}`;
  const variableBudget = maxLength - fixed.length - tail.length;
  if (variableBudget < 1) {
    throw new Error("GitHub branch maxLength is too small for the prefix.");
  }

  const middle = joinBranchSegments([runIdSegment, slugSegment]).slice(
    0,
    variableBudget,
  );
  const candidate = `${fixed}${trimBranchEdges(middle)}${tail}`;

  // Validates against the shared git-ref rules and throws on anything unsafe.
  return normalizeGitHubBranchName(candidate);
}

export interface GitHubExistingBranch {
  name: string;
  planHash?: string | undefined;
}

export interface GitHubExistingPullRequest {
  number: number;
  headBranch: string;
  baseBranch?: string | undefined;
  state?: "open" | "closed" | "merged" | undefined;
  planHash?: string | undefined;
}

export interface ResolveGitHubBranchPlanInput {
  branchName: string;
  baseBranch?: string | undefined;
  planHash: string;
  existingBranches?: readonly GitHubExistingBranch[] | undefined;
  existingPullRequests?: readonly GitHubExistingPullRequest[] | undefined;
}

export type GitHubBranchPlanDecision =
  | "create_new"
  | "reuse_existing"
  | "conflict";

export interface GitHubBranchPlanResolution {
  type: "github.branch_plan_resolution";
  decision: GitHubBranchPlanDecision;
  branchName: string;
  planHash: string;
  reason: string;
  existingPullRequestNumber?: number | undefined;
}

/**
 * Decide whether a proposed branch/plan should create a new branch, reuse an
 * existing one (idempotent retry), or be treated as a conflict. Pure: callers
 * pass the already-fetched branches/PRs as plain data.
 */
export function resolveGitHubBranchPlan(
  input: ResolveGitHubBranchPlanInput,
): GitHubBranchPlanResolution {
  const branchName = normalizeGitHubBranchName(input.branchName);
  const planHash = normalizeRequiredText(input.planHash, "GitHub plan hash");
  const baseBranch =
    input.baseBranch !== undefined
      ? normalizeGitHubBranchName(input.baseBranch)
      : undefined;

  const matchingPullRequest = (input.existingPullRequests ?? []).find(
    (pullRequest) =>
      normalizeGitHubBranchName(pullRequest.headBranch) === branchName,
  );
  if (matchingPullRequest) {
    const state = matchingPullRequest.state ?? "open";
    if (state === "merged") {
      return resolution("conflict", branchName, planHash, {
        reason: `Branch ${branchName} already has a merged pull request #${matchingPullRequest.number}.`,
        existingPullRequestNumber: matchingPullRequest.number,
      });
    }
    if (
      baseBranch !== undefined &&
      matchingPullRequest.baseBranch !== undefined &&
      normalizeGitHubBranchName(matchingPullRequest.baseBranch) !== baseBranch
    ) {
      return resolution("conflict", branchName, planHash, {
        reason: `Pull request #${matchingPullRequest.number} for ${branchName} targets a different base branch.`,
        existingPullRequestNumber: matchingPullRequest.number,
      });
    }
    if (matchingPullRequest.planHash === undefined) {
      return resolution("conflict", branchName, planHash, {
        reason: `Pull request #${matchingPullRequest.number} for ${branchName} has no recorded plan hash to reconcile against.`,
        existingPullRequestNumber: matchingPullRequest.number,
      });
    }
    if (matchingPullRequest.planHash === planHash) {
      return resolution("reuse_existing", branchName, planHash, {
        reason: `Pull request #${matchingPullRequest.number} already matches this plan hash; reusing it.`,
        existingPullRequestNumber: matchingPullRequest.number,
      });
    }
    return resolution("conflict", branchName, planHash, {
      reason: `Pull request #${matchingPullRequest.number} for ${branchName} was opened for a different plan hash.`,
      existingPullRequestNumber: matchingPullRequest.number,
    });
  }

  const matchingBranch = (input.existingBranches ?? []).find(
    (branch) => normalizeGitHubBranchName(branch.name) === branchName,
  );
  if (matchingBranch) {
    if (matchingBranch.planHash === undefined) {
      return resolution("conflict", branchName, planHash, {
        reason: `Branch ${branchName} already exists without a recorded plan hash.`,
      });
    }
    if (matchingBranch.planHash === planHash) {
      return resolution("reuse_existing", branchName, planHash, {
        reason: `Branch ${branchName} already exists for this plan hash; reusing it.`,
      });
    }
    return resolution("conflict", branchName, planHash, {
      reason: `Branch ${branchName} already exists for a different plan hash.`,
    });
  }

  return resolution("create_new", branchName, planHash, {
    reason: `No existing branch or pull request for ${branchName}; creating new.`,
  });
}

export interface GitHubPullRequestPlanHashInput extends CreateGitHubPullRequestWriteApprovalHashInputInput {
  diffSummary?: string | undefined;
  files?: readonly string[] | undefined;
  modelRoute?: string | undefined;
  runtime?: string | undefined;
  requesterPrincipalId?: string | undefined;
}

export interface GitHubPullRequestPlanHashBinding {
  type: "github.pr.plan_hash_binding";
  version: 1;
  algorithm: "sha256";
  hash: string;
  approvalHashInput: GitHubPullRequestWriteApprovalHashInput;
  diffSummary?: string | undefined;
  files?: string[] | undefined;
  modelRoute?: string | undefined;
  runtime?: string | undefined;
  requesterPrincipalId?: string | undefined;
}

/**
 * Compute a deterministic plan hash that binds an approval to the exact PR
 * plan: repo, base, branch, diff summary, files, permissions, install id,
 * model route, runtime, and requester. Same plan -> same hash; any field
 * change -> different hash.
 */
export function createGitHubPullRequestPlanHashBinding(
  input: GitHubPullRequestPlanHashInput | GitHubPullRequestProposal,
): GitHubPullRequestPlanHashBinding {
  const approvalHashInput =
    createGitHubPullRequestWriteApprovalHashInput(input);

  const diffSummary = optionalText(getField(input, "diffSummary"));
  const files = normalizeFiles(getFiles(input));
  const modelRoute = optionalText(getField(input, "modelRoute"));
  const runtime = optionalText(getField(input, "runtime"));
  const requesterPrincipalId = optionalText(
    getField(input, "requesterPrincipalId"),
  );

  const binding: GitHubPullRequestPlanHashBinding = {
    type: "github.pr.plan_hash_binding",
    version: 1,
    algorithm: "sha256",
    hash: "",
    approvalHashInput,
  };
  if (diffSummary !== undefined) {
    binding.diffSummary = diffSummary;
  }
  if (files !== undefined) {
    binding.files = files;
  }
  if (modelRoute !== undefined) {
    binding.modelRoute = modelRoute;
  }
  if (runtime !== undefined) {
    binding.runtime = runtime;
  }
  if (requesterPrincipalId !== undefined) {
    binding.requesterPrincipalId = requesterPrincipalId;
  }

  binding.hash = hashCanonical({
    approvalHashInput,
    diffSummary: diffSummary ?? null,
    files: files ?? null,
    modelRoute: modelRoute ?? null,
    runtime: runtime ?? null,
    requesterPrincipalId: requesterPrincipalId ?? null,
  });
  return binding;
}

/**
 * Convenience wrapper returning only the digest from
 * {@link createGitHubPullRequestPlanHashBinding}.
 */
export function createGitHubPullRequestPlanHash(
  input: GitHubPullRequestPlanHashInput | GitHubPullRequestProposal,
): string {
  return createGitHubPullRequestPlanHashBinding(input).hash;
}

function hashCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalStringify(value)).digest("hex");
}

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(
      ([key, entryValue]) =>
        `${JSON.stringify(key)}:${canonicalStringify(entryValue)}`,
    )
    .join(",")}}`;
}

function getField(input: unknown, key: string): unknown {
  return typeof input === "object" && input !== null && key in input
    ? (input as Record<string, unknown>)[key]
    : undefined;
}

function getFiles(input: unknown): readonly unknown[] | undefined {
  const files = getField(input, "files");
  return Array.isArray(files) ? files : undefined;
}

function normalizeFiles(
  files: readonly unknown[] | undefined,
): string[] | undefined {
  if (files === undefined) {
    return undefined;
  }
  const normalized = files
    .map((file) => (typeof file === "string" ? file.trim() : ""))
    .filter(Boolean);
  return [...new Set(normalized)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

function optionalText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function resolution(
  decision: GitHubBranchPlanDecision,
  branchName: string,
  planHash: string,
  rest: { reason: string; existingPullRequestNumber?: number | undefined },
): GitHubBranchPlanResolution {
  const value: GitHubBranchPlanResolution = {
    type: "github.branch_plan_resolution",
    decision,
    branchName,
    planHash,
    reason: rest.reason,
  };
  if (rest.existingPullRequestNumber !== undefined) {
    value.existingPullRequestNumber = rest.existingPullRequestNumber;
  }
  return value;
}

function sanitizeBranchSegment(value: string): string {
  const lowered = value.trim().toLowerCase();
  // Collapse any run of non-ref-safe characters into a single hyphen, then
  // strip leading/trailing hyphens and dots so segments never start with "."
  // or produce ".." / "//" sequences.
  const collapsed = lowered
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/\.+/g, ".")
    .replace(/\/+/g, "-")
    .replace(/-+/g, "-");
  return trimBranchEdges(collapsed);
}

function sanitizeBranchPrefix(value: string): string {
  // A prefix may carry slash-delimited namespaces (e.g. "bot/auto"); each
  // path segment is sanitized independently and empty segments are dropped.
  return value.split("/").map(sanitizeBranchSegment).filter(Boolean).join("/");
}

function joinBranchSegments(segments: readonly string[]): string {
  return segments.filter(Boolean).join("-").replace(/-+/g, "-");
}

function trimBranchEdges(value: string): string {
  return value.replace(/^[-.]+/, "").replace(/[-.]+$/, "");
}

function hashToHexSegment(value: string): string {
  return createHash("sha256")
    .update(value)
    .digest("hex")
    .slice(0, BRANCH_HASH_LENGTH);
}

function normalizeBranchMaxLength(maxLength: number | undefined): number {
  if (maxLength === undefined) {
    return DEFAULT_BRANCH_MAX_LENGTH;
  }
  if (!Number.isInteger(maxLength) || maxLength <= 0 || maxLength > 255) {
    throw new Error(
      "GitHub branch maxLength must be a positive integer no greater than 255.",
    );
  }
  return maxLength;
}

function normalizeRequiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}
