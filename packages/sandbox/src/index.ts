import type { RiskLevel } from "@bek/core";

export type SandboxProviderKind =
  | "docker-local"
  | "vercel-sandbox"
  | "e2b"
  | "noop";
export type SandboxNetworkMode = "disabled" | "egress_allowlist";
export type SandboxMountMode = "read_only" | "read_write";

export interface SandboxResourceLimits {
  cpuCount: number;
  memoryMb: number;
  diskMb: number;
  processLimit: number;
  timeoutMs: number;
}

export interface SandboxMount {
  source: string;
  target: string;
  mode: SandboxMountMode;
  purpose: "source" | "worktree" | "artifact" | "cache" | "scratch";
}

export interface SandboxNetworkPolicy {
  mode: SandboxNetworkMode;
  allowlist: string[];
  blockPrivateNetworks: boolean;
  blockMetadataService: boolean;
}

export interface SandboxPolicy {
  providerKind: SandboxProviderKind;
  imageRef?: string | undefined;
  templateId?: string | undefined;
  risk: RiskLevel;
  network: SandboxNetworkPolicy;
  mounts: SandboxMount[];
  resourceLimits: SandboxResourceLimits;
  env: Record<string, string>;
  allowPrivileged: false;
}

export interface SandboxCreateInput {
  orgId: string;
  runId: string;
  attempt: number;
  policy: SandboxPolicy;
  traceId: string;
}

export interface SandboxLease {
  id: string;
  providerKind: SandboxProviderKind;
  runId: string;
  createdAt: string;
  expiresAt: string;
}

export interface SandboxCommand {
  idempotencyKey: string;
  command: string[];
  cwd?: string | undefined;
  env?: Record<string, string> | undefined;
  timeoutMs?: number | undefined;
  risk: RiskLevel;
}

export interface SandboxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface SandboxUpload {
  path: string;
  bytes: Uint8Array;
  mode: SandboxMountMode;
}

export interface SandboxArtifact {
  path: string;
  contentHash: string;
  sizeBytes: number;
  mediaType?: string | undefined;
}

export interface SandboxProvider {
  id: string;
  kind: SandboxProviderKind;
  create(input: SandboxCreateInput): Promise<SandboxLease>;
  exec(lease: SandboxLease, command: SandboxCommand): Promise<SandboxResult>;
  upload(lease: SandboxLease, artifact: SandboxUpload): Promise<void>;
  download(lease: SandboxLease, path: string): Promise<SandboxArtifact>;
  destroy(lease: SandboxLease): Promise<void>;
}

export const defaultSandboxResourceLimits: SandboxResourceLimits = {
  cpuCount: 2,
  memoryMb: 4096,
  diskMb: 10240,
  processLimit: 256,
  timeoutMs: 15 * 60 * 1000,
};

export const defaultSandboxNetworkPolicy: SandboxNetworkPolicy = {
  mode: "disabled",
  allowlist: [],
  blockPrivateNetworks: true,
  blockMetadataService: true,
};

export function createDefaultSandboxPolicy(input: {
  providerKind: SandboxProviderKind;
  risk: RiskLevel;
  mounts?: SandboxMount[] | undefined;
}): SandboxPolicy {
  return {
    providerKind: input.providerKind,
    risk: input.risk,
    network: defaultSandboxNetworkPolicy,
    mounts: input.mounts ?? [],
    resourceLimits: defaultSandboxResourceLimits,
    env: {},
    allowPrivileged: false,
  };
}

export function requiresNetworkApproval(policy: SandboxPolicy): boolean {
  return policy.network.mode !== "disabled" && policy.risk !== "read_internal";
}

export function assertSandboxPolicy(policy: SandboxPolicy): void {
  if (policy.allowPrivileged !== false) {
    throw new Error("Bek sandbox policies cannot enable privileged execution.");
  }
  if (!policy.network.blockMetadataService) {
    throw new Error("Bek sandbox policies must block cloud metadata services.");
  }
  if (
    policy.network.mode === "disabled" &&
    policy.network.allowlist.length > 0
  ) {
    throw new Error(
      "Disabled sandbox networks cannot include egress allowlist entries.",
    );
  }
}
