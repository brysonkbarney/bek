export interface GitHubRepoRef {
  owner: string;
  repo: string;
}

export interface GitHubRepoResource extends GitHubRepoRef {
  provider: "github";
  fullName: string;
  resource: string;
  url: string;
}

export function formatGitHubRepoResource(input: GitHubRepoRef): string {
  const owner = normalizeGitHubOwner(input.owner);
  const repo = normalizeGitHubRepoName(input.repo);
  return `github:${owner}/${repo}`;
}

export function parseGitHubRepoResource(
  input: string | GitHubRepoRef,
): GitHubRepoResource {
  const ref =
    typeof input === "string" ? parseGitHubRepoRef(input) : { ...input };
  if (!ref) {
    throw new Error("Expected a GitHub repo resource like github:owner/repo.");
  }

  const owner = normalizeGitHubOwner(ref.owner);
  const repo = normalizeGitHubRepoName(ref.repo);
  const fullName = `${owner}/${repo}`;
  return {
    provider: "github",
    owner,
    repo,
    fullName,
    resource: `github:${fullName}`,
    url: `https://github.com/${fullName}`,
  };
}

export function tryParseGitHubRepoResource(
  input: string | GitHubRepoRef,
): GitHubRepoResource | undefined {
  try {
    return parseGitHubRepoResource(input);
  } catch {
    return undefined;
  }
}

export function isGitHubRepoResource(input: string): boolean {
  return tryParseGitHubRepoResource(input) !== undefined;
}

function parseGitHubRepoRef(input: string): GitHubRepoRef | undefined {
  const trimmed = input.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.startsWith("github:")) {
    return partsFromPath(trimmed.slice("github:".length));
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return parseGitHubUrl(trimmed);
  }

  if (/^git@github\.com:/i.test(trimmed)) {
    return partsFromPath(trimmed.replace(/^git@github\.com:/i, ""));
  }

  return partsFromPath(trimmed);
}

function parseGitHubUrl(input: string): GitHubRepoRef | undefined {
  try {
    const url = new URL(input);
    if (url.hostname.toLowerCase() !== "github.com") {
      return undefined;
    }
    const [owner, repo] = url.pathname
      .replace(/^\/+/, "")
      .split("/")
      .filter(Boolean);
    return owner && repo ? { owner, repo } : undefined;
  } catch {
    return undefined;
  }
}

function partsFromPath(path: string): GitHubRepoRef | undefined {
  const normalized = path.trim().replace(/\.git$/i, "");
  const parts = normalized.split("/");
  if (parts.length !== 2) {
    return undefined;
  }
  const [owner, repo] = parts;
  return owner && repo ? { owner, repo } : undefined;
}

function normalizeGitHubOwner(owner: string): string {
  const normalized = owner.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(normalized)) {
    throw new Error("GitHub owner must be a valid user or organization name.");
  }
  return normalized;
}

function normalizeGitHubRepoName(repo: string): string {
  const normalized = repo
    .trim()
    .replace(/\.git$/i, "")
    .toLowerCase();
  if (
    normalized === "." ||
    normalized === ".." ||
    !/^[a-z0-9._-]{1,100}$/.test(normalized)
  ) {
    throw new Error("GitHub repo must be a valid repository name.");
  }
  return normalized;
}
