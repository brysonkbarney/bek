import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { redactSecrets, type RiskLevel } from "@bek/core";

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
    network: {
      ...defaultSandboxNetworkPolicy,
      allowlist: [...defaultSandboxNetworkPolicy.allowlist],
    },
    mounts: input.mounts ?? [],
    resourceLimits: { ...defaultSandboxResourceLimits },
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
  assertSandboxResourceLimits(policy.resourceLimits);
  validateNetworkAllowlist(policy.network);
  policy.mounts.forEach(assertSandboxMount);
  for (const [key, value] of Object.entries(policy.env)) {
    assertDockerEnv(key, value);
  }
}

export interface SandboxNetworkAllowlistEntry {
  raw: string;
  value: string;
  host: string;
  port?: number | undefined;
}

export function validateNetworkAllowlist(
  policy: SandboxNetworkPolicy,
): SandboxNetworkAllowlistEntry[] {
  if (policy.mode === "disabled") {
    if (policy.allowlist.length > 0) {
      throw new Error(
        "Disabled sandbox networks cannot include egress allowlist entries.",
      );
    }
    return [];
  }

  if (policy.allowlist.length === 0) {
    throw new Error("Egress allowlist networks require at least one host.");
  }

  const entries = policy.allowlist.map(parseNetworkAllowlistEntry);
  for (const entry of entries) {
    if (policy.blockMetadataService && isMetadataNetworkTarget(entry.host)) {
      throw new Error(
        `Sandbox network allowlist cannot include metadata service ${entry.raw}.`,
      );
    }
    if (policy.blockPrivateNetworks && isPrivateNetworkTarget(entry.host)) {
      throw new Error(
        `Sandbox network allowlist cannot include private network target ${entry.raw}.`,
      );
    }
  }

  return Array.from(
    new Map(entries.map((entry) => [entry.value, entry])).values(),
  );
}

export function parseNetworkAllowlistEntry(
  raw: string,
): SandboxNetworkAllowlistEntry {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) {
    throw new Error("Sandbox network allowlist entries cannot be empty.");
  }
  if (/[\s,\0]/.test(trimmed)) {
    throw new Error(
      `Sandbox network allowlist entry ${raw} contains an invalid character.`,
    );
  }
  if (trimmed.includes("*")) {
    throw new Error(
      `Sandbox network allowlist entry ${raw} cannot use wildcards.`,
    );
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(trimmed) && trimmed.includes("/")) {
    throw new Error(
      `Sandbox network allowlist entry ${raw} must be a hostname or HTTP(S) origin, not a path or CIDR range.`,
    );
  }

  const url = parseAllowlistUrl(trimmed, raw);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(
      `Sandbox network allowlist entry ${raw} must use http or https.`,
    );
  }
  if (url.username || url.password) {
    throw new Error(
      `Sandbox network allowlist entry ${raw} cannot include credentials.`,
    );
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(
      `Sandbox network allowlist entry ${raw} must be an origin without path, query, or fragment.`,
    );
  }

  const host = normalizeHost(url.hostname);
  assertValidNetworkHost(host, raw);
  const entry: SandboxNetworkAllowlistEntry = {
    raw,
    value: formatAllowlistValue(host, url.port),
    host,
  };
  if (url.port) {
    entry.port = Number(url.port);
  }
  return entry;
}

export function isMetadataNetworkTarget(value: string): boolean {
  const host = normalizeHost(value);
  const embeddedIpv4 = ipv4FromMappedIpv6(host);
  if (embeddedIpv4 && METADATA_NETWORK_TARGETS.has(embeddedIpv4)) {
    return true;
  }
  return METADATA_NETWORK_TARGETS.has(host);
}

export function isPrivateNetworkTarget(value: string): boolean {
  const host = normalizeHost(value);
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return true;
  }
  if (isIP(host) === 4) {
    return isPrivateIpv4(host);
  }
  if (isIP(host) === 6) {
    return isPrivateIpv6(host);
  }
  return false;
}

export interface DockerRunCommand {
  executable: "docker";
  args: string[];
  containerName: string;
  networkAllowlist: string[];
}

export interface DockerRunCommandInput {
  create: SandboxCreateInput;
  containerName?: string | undefined;
  command?: string[] | undefined;
  workdir?: string | undefined;
  user?: string | undefined;
  egressNetworkName?: string | undefined;
}

export const defaultDockerSandboxImage = "bek/sandbox:local";
export const defaultDockerEgressNetworkName = "bek-egress-allowlist";

export function buildDockerRunCommand(
  input: DockerRunCommandInput,
): DockerRunCommand {
  const policy = input.create.policy;
  if (policy.providerKind !== "docker-local") {
    throw new Error("Docker run commands require a docker-local policy.");
  }
  assertSandboxPolicy(policy);

  const networkAllowlist = validateNetworkAllowlist(policy.network).map(
    (entry) => entry.value,
  );
  const containerName =
    input.containerName ??
    dockerContainerName(input.create.runId, input.create.attempt);
  const command = input.command ?? ["sleep", "infinity"];
  const workdir = input.workdir ?? "/workspace/worktree";
  const user = input.user ?? "1000:1000";
  const imageRef = policy.imageRef ?? defaultDockerSandboxImage;
  const args: string[] = [
    "run",
    "--detach",
    "--rm",
    "--name",
    containerName,
    "--label",
    `dev.bek.org=${input.create.orgId}`,
    "--label",
    `dev.bek.run=${input.create.runId}`,
    "--label",
    `dev.bek.trace=${input.create.traceId}`,
    "--network",
    dockerNetworkName(policy.network, input.egressNetworkName),
    "--cpus",
    String(policy.resourceLimits.cpuCount),
    "--memory",
    `${policy.resourceLimits.memoryMb}m`,
    "--pids-limit",
    String(policy.resourceLimits.processLimit),
    "--read-only",
    "--tmpfs",
    `/tmp:rw,nosuid,nodev,noexec,size=${policy.resourceLimits.diskMb}m`,
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--init",
    "--user",
    user,
    "--workdir",
    workdir,
  ];

  for (const mount of policy.mounts) {
    args.push("--mount", dockerMountValue(mount));
  }
  for (const [key, value] of Object.entries(policy.env).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    args.push("--env", `${key}=${value}`);
  }
  if (networkAllowlist.length > 0) {
    args.push(
      "--env",
      `BEK_SANDBOX_EGRESS_ALLOWLIST=${networkAllowlist.join(",")}`,
    );
  }

  args.push(imageRef, ...command);
  return {
    executable: "docker",
    args,
    containerName,
    networkAllowlist,
  };
}

export const sandboxArtifactHashAlgorithm = "sha256";

export function hashSandboxBytes(bytes: Uint8Array): string {
  return `${sandboxArtifactHashAlgorithm}:${createHash(
    sandboxArtifactHashAlgorithm,
  )
    .update(bytes)
    .digest("hex")}`;
}

export function createSandboxArtifact(input: {
  path: string;
  bytes: Uint8Array;
  mediaType?: string | undefined;
}): SandboxArtifact {
  assertArtifactPath(input.path);
  const artifact: SandboxArtifact = {
    path: input.path,
    contentHash: hashSandboxBytes(input.bytes),
    sizeBytes: input.bytes.byteLength,
  };
  if (input.mediaType !== undefined) {
    artifact.mediaType = input.mediaType;
  }
  return artifact;
}

export interface DockerProcessCommand {
  executable: "docker";
  args: string[];
  stdin?: Uint8Array | undefined;
  timeoutMs: number;
  stdoutLimitBytes: number;
  stderrLimitBytes: number;
}

export interface DockerProcessResult extends SandboxResult {}

export type DockerCommandRunner = (
  command: DockerProcessCommand,
) => Promise<DockerProcessResult>;

export interface DockerSandboxProviderOptions {
  id?: string | undefined;
  now?: (() => string) | undefined;
  idFactory?: ((prefix: string) => string) | undefined;
  runner?: DockerCommandRunner | undefined;
  stdoutLimitBytes?: number | undefined;
  stderrLimitBytes?: number | undefined;
  egressNetworkName?: string | undefined;
}

interface DockerSandboxLeaseState {
  lease: SandboxLease;
  containerName: string;
  policy: SandboxPolicy;
  destroyed: boolean;
}

export class DockerSandboxProvider implements SandboxProvider {
  readonly id: string;
  readonly kind: SandboxProviderKind = "docker-local";

  private readonly now: () => string;
  private readonly idFactory: (prefix: string) => string;
  private readonly runner: DockerCommandRunner;
  private readonly stdoutLimitBytes: number;
  private readonly stderrLimitBytes: number;
  private readonly egressNetworkName?: string | undefined;
  private readonly leases = new Map<string, DockerSandboxLeaseState>();

  constructor(options: DockerSandboxProviderOptions = {}) {
    this.id = options.id ?? "docker-local";
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory =
      options.idFactory ?? ((prefix) => `${prefix}_${randomUUID()}`);
    this.runner = options.runner ?? runDockerProcess;
    this.stdoutLimitBytes = options.stdoutLimitBytes ?? 1024 * 1024;
    this.stderrLimitBytes = options.stderrLimitBytes ?? 1024 * 1024;
    this.egressNetworkName = options.egressNetworkName;
  }

  async create(input: SandboxCreateInput): Promise<SandboxLease> {
    const dockerRun = buildDockerRunCommand({
      create: input,
      egressNetworkName: this.egressNetworkName,
    });
    const result = await this.runDocker({
      args: dockerRun.args,
      timeoutMs: input.policy.resourceLimits.timeoutMs,
    });
    assertDockerSuccess(result, "create Docker sandbox");

    const createdAt = this.now();
    const lease: SandboxLease = {
      id: this.idFactory("sandbox"),
      providerKind: this.kind,
      runId: input.runId,
      createdAt,
      expiresAt: new Date(
        Date.parse(createdAt) + input.policy.resourceLimits.timeoutMs,
      ).toISOString(),
    };
    this.leases.set(lease.id, {
      lease,
      containerName: dockerRun.containerName,
      policy: input.policy,
      destroyed: false,
    });
    return { ...lease };
  }

  async exec(
    lease: SandboxLease,
    command: SandboxCommand,
  ): Promise<SandboxResult> {
    const state = this.requireActiveLease(lease);
    assertSandboxCommand(command, state.policy);

    const args = ["exec"];
    if (command.cwd) {
      args.push("--workdir", command.cwd);
    }
    for (const [key, value] of Object.entries(command.env ?? {}).sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      args.push("--env", `${key}=${value}`);
    }
    args.push(state.containerName, ...command.command);

    const result = await this.runDocker({
      args,
      timeoutMs: command.timeoutMs ?? state.policy.resourceLimits.timeoutMs,
    });
    if (result.timedOut) {
      await this.killContainer(state);
    }
    return result;
  }

  async upload(lease: SandboxLease, upload: SandboxUpload): Promise<void> {
    const state = this.requireActiveLease(lease);
    assertArtifactPath(upload.path);
    const tempDir = await mkdtemp(path.join(tmpdir(), "bek-sandbox-upload-"));
    const tempPath = path.join(tempDir, "upload.bin");
    try {
      await writeFile(tempPath, upload.bytes);
      const mkdir = await this.runDocker({
        args: [
          "exec",
          state.containerName,
          "mkdir",
          "-p",
          path.posix.dirname(upload.path),
        ],
        timeoutMs: state.policy.resourceLimits.timeoutMs,
      });
      assertDockerSuccess(mkdir, "prepare sandbox upload directory");
      const copy = await this.runDocker({
        args: ["cp", tempPath, `${state.containerName}:${upload.path}`],
        timeoutMs: state.policy.resourceLimits.timeoutMs,
      });
      assertDockerSuccess(copy, "upload sandbox artifact");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  async download(
    lease: SandboxLease,
    artifactPath: string,
  ): Promise<SandboxArtifact> {
    const state = this.requireActiveLease(lease);
    assertArtifactPath(artifactPath);
    const tempDir = await mkdtemp(path.join(tmpdir(), "bek-sandbox-download-"));
    const tempPath = path.join(tempDir, "download.bin");
    try {
      const copy = await this.runDocker({
        args: ["cp", `${state.containerName}:${artifactPath}`, tempPath],
        timeoutMs: state.policy.resourceLimits.timeoutMs,
      });
      assertDockerSuccess(copy, "download sandbox artifact");
      const bytes = await readFile(tempPath);
      return createSandboxArtifact({ path: artifactPath, bytes });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  async destroy(lease: SandboxLease): Promise<void> {
    const state = this.leases.get(lease.id);
    if (!state || state.destroyed) {
      return;
    }
    const result = await this.runDocker({
      args: ["rm", "--force", state.containerName],
      timeoutMs: state.policy.resourceLimits.timeoutMs,
    });
    state.destroyed = true;
    if (
      result.exitCode !== 0 &&
      !result.stderr.toLowerCase().includes("no such container")
    ) {
      throw new Error(dockerFailureMessage("destroy Docker sandbox", result));
    }
  }

  private async killContainer(state: DockerSandboxLeaseState): Promise<void> {
    await this.runDocker({
      args: ["kill", state.containerName],
      timeoutMs: state.policy.resourceLimits.timeoutMs,
    }).catch(() => undefined);
    state.destroyed = true;
  }

  private async runDocker(input: {
    args: string[];
    timeoutMs: number;
    stdin?: Uint8Array | undefined;
  }): Promise<DockerProcessResult> {
    return this.runner({
      executable: "docker",
      args: input.args,
      stdin: input.stdin,
      timeoutMs: input.timeoutMs,
      stdoutLimitBytes: this.stdoutLimitBytes,
      stderrLimitBytes: this.stderrLimitBytes,
    });
  }

  private requireActiveLease(lease: SandboxLease): DockerSandboxLeaseState {
    const state = this.leases.get(lease.id);
    if (!state) {
      throw new Error(`Sandbox lease ${lease.id} was not found.`);
    }
    if (state.destroyed) {
      throw new Error(`Sandbox lease ${lease.id} has been destroyed.`);
    }
    return state;
  }
}

export async function runDockerProcess(
  command: DockerProcessCommand,
): Promise<DockerProcessResult> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    const stdout = createOutputCollector(command.stdoutLimitBytes);
    const stderr = createOutputCollector(command.stderrLimitBytes);
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, command.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: timedOut ? 124 : (code ?? 1),
        stdout: stdout.text(),
        stderr: stderr.text(),
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    });

    child.stdin?.end(command.stdin);
  });
}

function createOutputCollector(limitBytes: number): {
  push(chunk: Buffer): void;
  text(): string;
} {
  const chunks: Buffer[] = [];
  let bytes = 0;
  return {
    push(chunk) {
      const remaining = limitBytes - bytes;
      if (remaining <= 0) {
        return;
      }
      const slice =
        chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
      chunks.push(slice);
      bytes += slice.byteLength;
    },
    text() {
      return Buffer.concat(chunks).toString("utf8");
    },
  };
}

function assertDockerSuccess(
  result: DockerProcessResult,
  action: string,
): void {
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(dockerFailureMessage(action, result));
  }
}

function dockerFailureMessage(
  action: string,
  result: DockerProcessResult,
): string {
  const output = redactSecrets(
    result.stderr.trim() ||
      result.stdout.trim() ||
      "Docker returned no output.",
  );
  const reason = result.timedOut
    ? `timed out after ${result.durationMs}ms`
    : `exited with code ${result.exitCode}`;
  return `Failed to ${action}: docker ${reason}. ${output}`;
}

export interface FakeSandboxProviderOptions {
  now?: (() => string) | undefined;
  idFactory?: ((prefix: string) => string) | undefined;
  execResults?: SandboxResult[] | undefined;
}

export interface FakeSandboxProviderSnapshot {
  leases: SandboxLease[];
  commands: Array<{ leaseId: string; command: SandboxCommand }>;
  artifacts: Array<{ leaseId: string; artifact: SandboxArtifact }>;
}

interface FakeSandboxLeaseState {
  lease: SandboxLease;
  policy: SandboxPolicy;
  destroyed: boolean;
  commands: SandboxCommand[];
  artifacts: Map<string, SandboxArtifact>;
  uploads: Map<string, Uint8Array>;
}

export class FakeSandboxProvider implements SandboxProvider {
  readonly id = "fake";
  readonly kind: SandboxProviderKind = "noop";

  private readonly now: () => string;
  private readonly idFactory: (prefix: string) => string;
  private readonly execResults: SandboxResult[];
  private readonly leases = new Map<string, FakeSandboxLeaseState>();

  constructor(options: FakeSandboxProviderOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory =
      options.idFactory ?? ((prefix) => `${prefix}_${randomUUID()}`);
    this.execResults = [...(options.execResults ?? [])];
  }

  async create(input: SandboxCreateInput): Promise<SandboxLease> {
    assertSandboxPolicy(input.policy);
    const createdAt = this.now();
    const lease: SandboxLease = {
      id: this.idFactory("sandbox"),
      providerKind: this.kind,
      runId: input.runId,
      createdAt,
      expiresAt: new Date(
        Date.parse(createdAt) + input.policy.resourceLimits.timeoutMs,
      ).toISOString(),
    };
    this.leases.set(lease.id, {
      lease,
      policy: input.policy,
      destroyed: false,
      commands: [],
      artifacts: new Map(),
      uploads: new Map(),
    });
    return lease;
  }

  async exec(
    lease: SandboxLease,
    command: SandboxCommand,
  ): Promise<SandboxResult> {
    const state = this.requireActiveLease(lease);
    assertSandboxCommand(command, state.policy);
    state.commands.push(copySandboxCommand(command));
    return (
      this.execResults.shift() ?? {
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 0,
        timedOut: false,
      }
    );
  }

  async upload(lease: SandboxLease, upload: SandboxUpload): Promise<void> {
    const state = this.requireActiveLease(lease);
    assertArtifactPath(upload.path);
    const bytes = new Uint8Array(upload.bytes);
    state.uploads.set(upload.path, bytes);
    state.artifacts.set(
      upload.path,
      createSandboxArtifact({ path: upload.path, bytes }),
    );
  }

  async download(lease: SandboxLease, path: string): Promise<SandboxArtifact> {
    const state = this.requireActiveLease(lease);
    assertArtifactPath(path);
    const artifact = state.artifacts.get(path);
    if (!artifact) {
      throw new Error(`Sandbox artifact ${path} was not found.`);
    }
    return { ...artifact };
  }

  async destroy(lease: SandboxLease): Promise<void> {
    const state = this.leases.get(lease.id);
    if (state) {
      state.destroyed = true;
    }
  }

  read(): FakeSandboxProviderSnapshot {
    return {
      leases: Array.from(this.leases.values()).map((state) => ({
        ...state.lease,
      })),
      commands: Array.from(this.leases.values()).flatMap((state) =>
        state.commands.map((command) => ({
          leaseId: state.lease.id,
          command: copySandboxCommand(command),
        })),
      ),
      artifacts: Array.from(this.leases.values()).flatMap((state) =>
        Array.from(state.artifacts.values()).map((artifact) => ({
          leaseId: state.lease.id,
          artifact: { ...artifact },
        })),
      ),
    };
  }

  private requireActiveLease(lease: SandboxLease): FakeSandboxLeaseState {
    const state = this.leases.get(lease.id);
    if (!state) {
      throw new Error(`Sandbox lease ${lease.id} was not found.`);
    }
    if (state.destroyed) {
      throw new Error(`Sandbox lease ${lease.id} has been destroyed.`);
    }
    return state;
  }
}

export function assertSandboxCommand(
  command: SandboxCommand,
  policy: SandboxPolicy,
): void {
  if (command.command.length === 0) {
    throw new Error("Sandbox commands must include at least one argv entry.");
  }
  for (const argv of command.command) {
    assertNoControlCharacters(argv, "Sandbox command argv");
  }
  if (
    command.timeoutMs !== undefined &&
    command.timeoutMs > policy.resourceLimits.timeoutMs
  ) {
    throw new Error(
      "Sandbox command timeout cannot exceed the policy timeout.",
    );
  }
  if (command.cwd !== undefined) {
    assertAbsoluteContainerPath(command.cwd, "Sandbox command cwd");
  }
  for (const [key, value] of Object.entries(command.env ?? {})) {
    assertDockerEnv(key, value);
  }
}

function assertSandboxResourceLimits(limits: SandboxResourceLimits): void {
  if (!Number.isFinite(limits.cpuCount) || limits.cpuCount <= 0) {
    throw new Error("Sandbox CPU limit must be greater than zero.");
  }
  assertPositiveInteger(limits.memoryMb, "Sandbox memory limit");
  assertPositiveInteger(limits.diskMb, "Sandbox disk limit");
  assertPositiveInteger(limits.processLimit, "Sandbox process limit");
  assertPositiveInteger(limits.timeoutMs, "Sandbox timeout");
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
}

function assertSandboxMount(mount: SandboxMount): void {
  assertAbsoluteHostPath(mount.source, "Sandbox mount source");
  assertAbsoluteContainerPath(mount.target, "Sandbox mount target");
  assertNoDockerMountDelimiter(mount.source, "Sandbox mount source");
  assertNoDockerMountDelimiter(mount.target, "Sandbox mount target");
  if (isDockerSocketPath(mount.source) || isDockerSocketPath(mount.target)) {
    throw new Error("Sandbox mounts cannot include the Docker socket.");
  }
  if (containsSensitiveHostPath(mount.source)) {
    throw new Error("Sandbox mounts cannot include host credential paths.");
  }
  if (mount.purpose === "source" && mount.mode !== "read_only") {
    throw new Error("Sandbox source mounts must be read-only.");
  }
}

function assertAbsoluteHostPath(value: string, label: string): void {
  assertNoControlCharacters(value, label);
  if (!value.startsWith("/")) {
    throw new Error(`${label} must be an absolute path.`);
  }
  if (value === "/") {
    throw new Error(`${label} cannot be the host root.`);
  }
}

function assertAbsoluteContainerPath(value: string, label: string): void {
  assertNoControlCharacters(value, label);
  if (!value.startsWith("/")) {
    throw new Error(`${label} must be an absolute path.`);
  }
  if (
    value === "/" ||
    value.startsWith("/proc") ||
    value.startsWith("/sys") ||
    value.startsWith("/dev")
  ) {
    throw new Error(`${label} points at a restricted container path.`);
  }
}

function assertNoControlCharacters(value: string, label: string): void {
  if (/[\0\r\n]/.test(value)) {
    throw new Error(`${label} contains a control character.`);
  }
}

function assertNoDockerMountDelimiter(value: string, label: string): void {
  if (value.includes(",")) {
    throw new Error(`${label} cannot contain a comma.`);
  }
}

function assertDockerEnv(key: string, value: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`Sandbox environment variable ${key} is invalid.`);
  }
  assertNoControlCharacters(value, `Sandbox environment variable ${key}`);
}

function assertArtifactPath(path: string): void {
  assertAbsoluteContainerPath(path, "Sandbox artifact path");
  if (path.includes("..")) {
    throw new Error("Sandbox artifact paths cannot contain '..'.");
  }
}

function parseAllowlistUrl(trimmed: string, raw: string): URL {
  try {
    return /^[a-z][a-z0-9+.-]*:\/\//.test(trimmed)
      ? new URL(trimmed)
      : new URL(`https://${trimmed}`);
  } catch {
    throw new Error(`Sandbox network allowlist entry ${raw} is not valid.`);
  }
}

function normalizeHost(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
}

function assertValidNetworkHost(host: string, raw: string): void {
  if (!host) {
    throw new Error(`Sandbox network allowlist entry ${raw} has no host.`);
  }
  if (isIP(host)) {
    return;
  }
  if (host.length > 253) {
    throw new Error(`Sandbox network allowlist host ${raw} is too long.`);
  }
  const labels = host.split(".");
  if (
    labels.some(
      (label) =>
        !label ||
        label.length > 63 ||
        !/^[a-z0-9-]+$/.test(label) ||
        label.startsWith("-") ||
        label.endsWith("-"),
    )
  ) {
    throw new Error(`Sandbox network allowlist host ${raw} is invalid.`);
  }
}

function formatAllowlistValue(host: string, port: string): string {
  const formattedHost = isIP(host) === 6 ? `[${host}]` : host;
  return port ? `${formattedHost}:${port}` : formattedHost;
}

const METADATA_NETWORK_TARGETS = new Set([
  "169.254.169.254",
  "169.254.170.2",
  "metadata",
  "metadata.google.internal",
  "metadata.google",
  "instance-data",
  "fd00:ec2::254",
]);

function isPrivateIpv4(host: string): boolean {
  const octets = host.split(".").map((part) => Number(part));
  const [first, second] = octets;
  if (first === undefined || second === undefined) {
    return true;
  }
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
}

function isPrivateIpv6(host: string): boolean {
  const embeddedIpv4 = ipv4FromMappedIpv6(host);
  if (embeddedIpv4) {
    return isPrivateIpv4(embeddedIpv4);
  }
  return (
    host === "::" ||
    host === "::1" ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    host.startsWith("fe80:")
  );
}

function ipv4FromMappedIpv6(host: string): string | undefined {
  const dotted = host.match(/^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (dotted) {
    return normalizeDottedIpv4(dotted[1]!);
  }

  const hex = host.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!hex) {
    return undefined;
  }
  const high = Number.parseInt(hex[1]!, 16);
  const low = Number.parseInt(hex[2]!, 16);
  if (high > 0xffff || low > 0xffff) {
    return undefined;
  }
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

function normalizeDottedIpv4(value: string): string | undefined {
  const octets = value.split(".").map((part) => Number(part));
  if (
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return undefined;
  }
  return octets.join(".");
}

function dockerContainerName(runId: string, attempt: number): string {
  return `bek-${runId}-${attempt}`
    .replace(/[^a-zA-Z0-9_.-]/g, "-")
    .replace(/^-+/, "")
    .slice(0, 128);
}

function dockerNetworkName(
  policy: SandboxNetworkPolicy,
  egressNetworkName?: string | undefined,
): string {
  return policy.mode === "disabled"
    ? "none"
    : (egressNetworkName ?? defaultDockerEgressNetworkName);
}

function dockerMountValue(mount: SandboxMount): string {
  const parts = [`type=bind`, `src=${mount.source}`, `dst=${mount.target}`];
  if (mount.mode === "read_only") {
    parts.push("readonly");
  }
  return parts.join(",");
}

function isDockerSocketPath(path: string): boolean {
  return path === "/var/run/docker.sock" || path.endsWith("/docker.sock");
}

function containsSensitiveHostPath(path: string): boolean {
  const segments = path.split("/").filter(Boolean);
  return segments.some(
    (segment, index) =>
      segment === ".ssh" ||
      segment === ".aws" ||
      segment === ".kube" ||
      (segment === ".config" && segments[index + 1] === "gcloud") ||
      segment === ".docker" ||
      segment === ".env" ||
      segment.startsWith(".env."),
  );
}

function copySandboxCommand(command: SandboxCommand): SandboxCommand {
  const copy: SandboxCommand = {
    idempotencyKey: command.idempotencyKey,
    command: [...command.command],
    risk: command.risk,
  };
  if (command.cwd !== undefined) {
    copy.cwd = command.cwd;
  }
  if (command.env !== undefined) {
    copy.env = { ...command.env };
  }
  if (command.timeoutMs !== undefined) {
    copy.timeoutMs = command.timeoutMs;
  }
  return copy;
}

// ---------------------------------------------------------------------------
// Egress policy evaluation
//
// Pure helpers that decide whether a sandbox is allowed to reach a given host
// or URL under its `SandboxNetworkPolicy`. These never perform DNS resolution
// or any network I/O; they only reason over the textual target and the
// configured allowlist. Default posture is deny: link-local/metadata, private
// RFC1918 ranges, and localhost are blocked unless the policy explicitly opts
// out (or the exact host is allowlisted, when permitted).
// ---------------------------------------------------------------------------

export type EgressDecisionReason =
  | "network_disabled"
  | "not_allowlisted"
  | "metadata_blocked"
  | "private_network_blocked"
  | "localhost_blocked"
  | "invalid_target"
  | "allowlisted";

export interface EgressDecision {
  allowed: boolean;
  reason: EgressDecisionReason;
  /** Human-readable explanation suitable for logs and audit trails. */
  message: string;
  /** Normalized host extracted from the target, when one could be parsed. */
  host?: string | undefined;
  /** Normalized port extracted from the target, when one was present. */
  port?: number | undefined;
}

export interface EvaluateEgressOptions {
  /**
   * When false, an allowlisted host may bypass the private/localhost guards
   * (metadata is still always blocked when `blockMetadataService` is set).
   * Defaults to true: allowlisting never overrides the metadata guard.
   */
  allowlistOverridesGuards?: boolean | undefined;
}

/**
 * Evaluate a single egress target (a bare host, `host:port`, or full URL)
 * against a sandbox network policy. Pure function, no I/O.
 */
export function evaluateEgressPolicy(
  policy: SandboxNetworkPolicy,
  target: string,
  options: EvaluateEgressOptions = {},
): EgressDecision {
  const parsed = parseEgressTarget(target);
  if (!parsed) {
    return {
      allowed: false,
      reason: "invalid_target",
      message: `Egress target ${JSON.stringify(target)} could not be parsed.`,
    };
  }

  const { host, port } = parsed;
  const allowlistOverridesGuards = options.allowlistOverridesGuards ?? false;
  const allowlistMatch = matchesEgressAllowlist(policy.allowlist, host, port);

  if (policy.mode === "disabled") {
    return {
      allowed: false,
      reason: "network_disabled",
      message: "Sandbox network egress is disabled by policy.",
      host,
      ...(port !== undefined ? { port } : {}),
    };
  }

  // Metadata services are never reachable when the guard is enabled, even if
  // somehow allowlisted.
  if (policy.blockMetadataService && isMetadataNetworkTarget(host)) {
    return {
      allowed: false,
      reason: "metadata_blocked",
      message: `Egress to cloud metadata service ${host} is blocked.`,
      host,
      ...(port !== undefined ? { port } : {}),
    };
  }

  const guardsApply = !(allowlistMatch && allowlistOverridesGuards);
  if (guardsApply) {
    if (policy.blockPrivateNetworks && isLoopbackTarget(host)) {
      return {
        allowed: false,
        reason: "localhost_blocked",
        message: `Egress to localhost target ${host} is blocked.`,
        host,
        ...(port !== undefined ? { port } : {}),
      };
    }
    if (policy.blockPrivateNetworks && isPrivateNetworkTarget(host)) {
      return {
        allowed: false,
        reason: "private_network_blocked",
        message: `Egress to private network target ${host} is blocked.`,
        host,
        ...(port !== undefined ? { port } : {}),
      };
    }
  }

  if (!allowlistMatch) {
    return {
      allowed: false,
      reason: "not_allowlisted",
      message: `Egress target ${host} is not on the allowlist.`,
      host,
      ...(port !== undefined ? { port } : {}),
    };
  }

  return {
    allowed: true,
    reason: "allowlisted",
    message: `Egress target ${host} is allowlisted.`,
    host,
    ...(port !== undefined ? { port } : {}),
  };
}

interface EgressTarget {
  host: string;
  port?: number | undefined;
}

function parseEgressTarget(target: string): EgressTarget | undefined {
  const trimmed = target.trim().toLowerCase();
  if (!trimmed || /[\s,\0]/.test(trimmed) || trimmed.includes("*")) {
    return undefined;
  }

  // Full URL or scheme-prefixed origin.
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return undefined;
    }
    const host = normalizeHost(url.hostname);
    if (!host) {
      return undefined;
    }
    return url.port ? { host, port: Number(url.port) } : { host };
  }

  // Bracketed IPv6 with optional port, e.g. "[::1]:443".
  const bracketed = trimmed.match(/^\[([^\]]+)\](?::(\d{1,5}))?$/);
  if (bracketed) {
    const host = normalizeHost(bracketed[1]!);
    const portText = bracketed[2];
    if (!host) {
      return undefined;
    }
    return portText !== undefined ? { host, port: Number(portText) } : { host };
  }

  // Bare IPv6 literal (no port, multiple colons).
  if (isIP(trimmed) === 6) {
    return { host: normalizeHost(trimmed) };
  }

  // host or host:port (IPv4 / hostname).
  const colonIndex = trimmed.indexOf(":");
  if (colonIndex !== -1) {
    const hostPart = trimmed.slice(0, colonIndex);
    const portPart = trimmed.slice(colonIndex + 1);
    if (!/^\d{1,5}$/.test(portPart)) {
      return undefined;
    }
    const host = normalizeHost(hostPart);
    if (!host || host.includes("/")) {
      return undefined;
    }
    return { host, port: Number(portPart) };
  }

  const host = normalizeHost(trimmed);
  if (!host || host.includes("/")) {
    return undefined;
  }
  return { host };
}

function matchesEgressAllowlist(
  allowlist: string[],
  host: string,
  port: number | undefined,
): boolean {
  for (const raw of allowlist) {
    const entry = parseEgressTarget(raw);
    if (!entry || entry.host !== host) {
      continue;
    }
    // An allowlist entry without a port matches any port on that host; an
    // entry with a port must match the requested port exactly.
    if (entry.port === undefined || entry.port === port) {
      return true;
    }
  }
  return false;
}

function isLoopbackTarget(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) {
    return true;
  }
  if (isIP(host) === 4) {
    return host.startsWith("127.");
  }
  if (isIP(host) === 6) {
    const embedded = ipv4FromMappedIpv6(host);
    if (embedded) {
      return embedded.startsWith("127.");
    }
    return host === "::1";
  }
  return false;
}

// ---------------------------------------------------------------------------
// Filesystem policy evaluation
//
// Pure helper that validates a requested container path against a policy made
// of a read-only source root, a writable worktree root, an artifact root, and
// a maximum write size. Rejects path traversal and any path that escapes the
// configured roots. No filesystem I/O is performed.
// ---------------------------------------------------------------------------

export type FilesystemAccessMode = "read" | "write";

export type FilesystemDecisionReason =
  | "invalid_path"
  | "path_traversal"
  | "outside_roots"
  | "read_only_root"
  | "size_exceeded"
  | "allowed";

export interface FilesystemPolicy {
  /** Absolute, read-only source root (writes are always denied here). */
  sourceRoot: string;
  /** Absolute, writable worktree root. */
  worktreeRoot: string;
  /** Absolute, writable artifact root. */
  artifactRoot: string;
  /** Maximum byte size permitted for a single write, when enforced. */
  maxWriteBytes?: number | undefined;
}

export interface FilesystemDecision {
  allowed: boolean;
  reason: FilesystemDecisionReason;
  message: string;
  /** The normalized absolute path that was evaluated, when parseable. */
  normalizedPath?: string | undefined;
  /** Which configured root the path resolved into, when any. */
  root?: "source" | "worktree" | "artifact" | undefined;
}

export interface EvaluateFilesystemOptions {
  /** Access mode requested; defaults to "read". */
  mode?: FilesystemAccessMode | undefined;
  /** Size of the pending write in bytes, checked against `maxWriteBytes`. */
  sizeBytes?: number | undefined;
}

/**
 * Validate a requested path against a filesystem policy. Pure function: it
 * normalizes the path lexically (never touching disk) and rejects traversal or
 * escape outside the configured roots.
 */
export function evaluateFilesystemAccess(
  policy: FilesystemPolicy,
  requestedPath: string,
  options: EvaluateFilesystemOptions = {},
): FilesystemDecision {
  const mode = options.mode ?? "read";

  if (
    typeof requestedPath !== "string" ||
    requestedPath.length === 0 ||
    /[\0\r\n]/.test(requestedPath) ||
    !requestedPath.startsWith("/")
  ) {
    return {
      allowed: false,
      reason: "invalid_path",
      message: `Requested path ${JSON.stringify(
        requestedPath,
      )} must be a non-empty absolute path.`,
    };
  }

  // Reject explicit traversal segments before normalization so that escapes
  // are never silently collapsed away.
  if (containsTraversalSegment(requestedPath)) {
    return {
      allowed: false,
      reason: "path_traversal",
      message: `Requested path ${requestedPath} contains a '..' traversal segment.`,
    };
  }

  const normalizedPath = path.posix.normalize(requestedPath);
  // Defense in depth: normalization must not have produced an escape either.
  if (normalizedPath === ".." || normalizedPath.startsWith("../")) {
    return {
      allowed: false,
      reason: "path_traversal",
      message: `Requested path ${requestedPath} escapes the filesystem roots.`,
      normalizedPath,
    };
  }

  const roots: Array<{
    name: "source" | "worktree" | "artifact";
    root: string;
    writable: boolean;
  }> = [
    { name: "source", root: policy.sourceRoot, writable: false },
    { name: "worktree", root: policy.worktreeRoot, writable: true },
    { name: "artifact", root: policy.artifactRoot, writable: true },
  ];

  const containing = roots.find((candidate) =>
    isWithinRoot(candidate.root, normalizedPath),
  );

  if (!containing) {
    return {
      allowed: false,
      reason: "outside_roots",
      message: `Requested path ${normalizedPath} is outside the source, worktree, and artifact roots.`,
      normalizedPath,
    };
  }

  if (mode === "write" && !containing.writable) {
    return {
      allowed: false,
      reason: "read_only_root",
      message: `Requested path ${normalizedPath} is in the read-only ${containing.name} root.`,
      normalizedPath,
      root: containing.name,
    };
  }

  if (
    mode === "write" &&
    policy.maxWriteBytes !== undefined &&
    options.sizeBytes !== undefined &&
    options.sizeBytes > policy.maxWriteBytes
  ) {
    return {
      allowed: false,
      reason: "size_exceeded",
      message: `Write of ${options.sizeBytes} bytes exceeds the ${policy.maxWriteBytes}-byte limit.`,
      normalizedPath,
      root: containing.name,
    };
  }

  return {
    allowed: true,
    reason: "allowed",
    message: `Requested path ${normalizedPath} is permitted in the ${containing.name} root.`,
    normalizedPath,
    root: containing.name,
  };
}

function containsTraversalSegment(value: string): boolean {
  return value.split("/").some((segment) => segment === "..");
}

function isWithinRoot(root: string, candidate: string): boolean {
  if (typeof root !== "string" || !root.startsWith("/")) {
    return false;
  }
  const normalizedRoot = path.posix.normalize(root);
  const base =
    normalizedRoot.endsWith("/") && normalizedRoot !== "/"
      ? normalizedRoot.slice(0, -1)
      : normalizedRoot;
  if (candidate === base) {
    return true;
  }
  const prefix = base === "/" ? "/" : `${base}/`;
  return candidate.startsWith(prefix);
}

// ---------------------------------------------------------------------------
// Resource limit normalization
//
// A typed structure describing the effective resource budget for a sandbox,
// plus a pure validator/normalizer that clamps requested limits against sane
// maxima and reports any clamping as warnings. Builds on the existing
// `SandboxResourceLimits` additively by adding optional wall-clock and egress
// byte ceilings.
// ---------------------------------------------------------------------------

export interface ResourceLimitRequest {
  cpuCount?: number | undefined;
  memoryMb?: number | undefined;
  diskMb?: number | undefined;
  processLimit?: number | undefined;
  timeoutMs?: number | undefined;
  /** Wall-clock ceiling distinct from per-command timeout, when desired. */
  wallClockMs?: number | undefined;
  /** Maximum cumulative egress bytes permitted, when network is enabled. */
  egressBytes?: number | undefined;
}

export interface EffectiveResourceLimits {
  cpuCount: number;
  memoryMb: number;
  diskMb: number;
  processLimit: number;
  timeoutMs: number;
  wallClockMs: number;
  egressBytes: number;
}

export interface ResourceLimitBounds {
  minCpuCount: number;
  maxCpuCount: number;
  minMemoryMb: number;
  maxMemoryMb: number;
  minDiskMb: number;
  maxDiskMb: number;
  minProcessLimit: number;
  maxProcessLimit: number;
  minTimeoutMs: number;
  maxTimeoutMs: number;
  minWallClockMs: number;
  maxWallClockMs: number;
  minEgressBytes: number;
  maxEgressBytes: number;
}

export interface ResourceLimitWarning {
  field: keyof EffectiveResourceLimits;
  requested: number;
  applied: number;
  kind: "clamped_low" | "clamped_high" | "defaulted_invalid";
  message: string;
}

export interface NormalizedResourceLimits {
  limits: EffectiveResourceLimits;
  warnings: ResourceLimitWarning[];
}

export const defaultResourceLimitBounds: ResourceLimitBounds = {
  minCpuCount: 0.25,
  maxCpuCount: 16,
  minMemoryMb: 128,
  maxMemoryMb: 65_536,
  minDiskMb: 64,
  maxDiskMb: 102_400,
  minProcessLimit: 16,
  maxProcessLimit: 4_096,
  minTimeoutMs: 1_000,
  maxTimeoutMs: 60 * 60 * 1000,
  minWallClockMs: 1_000,
  maxWallClockMs: 2 * 60 * 60 * 1000,
  minEgressBytes: 0,
  maxEgressBytes: 5 * 1024 * 1024 * 1024,
};

export const defaultEffectiveResourceLimits: EffectiveResourceLimits = {
  cpuCount: defaultSandboxResourceLimits.cpuCount,
  memoryMb: defaultSandboxResourceLimits.memoryMb,
  diskMb: defaultSandboxResourceLimits.diskMb,
  processLimit: defaultSandboxResourceLimits.processLimit,
  timeoutMs: defaultSandboxResourceLimits.timeoutMs,
  wallClockMs: defaultSandboxResourceLimits.timeoutMs,
  egressBytes: 256 * 1024 * 1024,
};

/**
 * Validate and clamp a requested resource budget against sane maxima. Missing
 * or invalid fields fall back to defaults; out-of-range values are clamped.
 * Returns the effective limits plus a warning for every adjustment made. Pure
 * function with no side effects.
 */
export function normalizeResourceLimits(
  request: ResourceLimitRequest = {},
  bounds: ResourceLimitBounds = defaultResourceLimitBounds,
  defaults: EffectiveResourceLimits = defaultEffectiveResourceLimits,
): NormalizedResourceLimits {
  const warnings: ResourceLimitWarning[] = [];

  const limits: EffectiveResourceLimits = {
    cpuCount: clampField(
      "cpuCount",
      request.cpuCount,
      bounds.minCpuCount,
      bounds.maxCpuCount,
      defaults.cpuCount,
      false,
      warnings,
    ),
    memoryMb: clampField(
      "memoryMb",
      request.memoryMb,
      bounds.minMemoryMb,
      bounds.maxMemoryMb,
      defaults.memoryMb,
      true,
      warnings,
    ),
    diskMb: clampField(
      "diskMb",
      request.diskMb,
      bounds.minDiskMb,
      bounds.maxDiskMb,
      defaults.diskMb,
      true,
      warnings,
    ),
    processLimit: clampField(
      "processLimit",
      request.processLimit,
      bounds.minProcessLimit,
      bounds.maxProcessLimit,
      defaults.processLimit,
      true,
      warnings,
    ),
    timeoutMs: clampField(
      "timeoutMs",
      request.timeoutMs,
      bounds.minTimeoutMs,
      bounds.maxTimeoutMs,
      defaults.timeoutMs,
      true,
      warnings,
    ),
    wallClockMs: clampField(
      "wallClockMs",
      request.wallClockMs,
      bounds.minWallClockMs,
      bounds.maxWallClockMs,
      defaults.wallClockMs,
      true,
      warnings,
    ),
    egressBytes: clampField(
      "egressBytes",
      request.egressBytes,
      bounds.minEgressBytes,
      bounds.maxEgressBytes,
      defaults.egressBytes,
      true,
      warnings,
    ),
  };

  // Wall-clock must never be shorter than a single command timeout; lift it to
  // the command timeout if a smaller value slipped through.
  if (limits.wallClockMs < limits.timeoutMs) {
    warnings.push({
      field: "wallClockMs",
      requested: limits.wallClockMs,
      applied: limits.timeoutMs,
      kind: "clamped_low",
      message: `wallClockMs (${limits.wallClockMs}) cannot be less than timeoutMs (${limits.timeoutMs}); raised to match.`,
    });
    limits.wallClockMs = limits.timeoutMs;
  }

  return { limits, warnings };
}

function clampField(
  field: keyof EffectiveResourceLimits,
  requested: number | undefined,
  min: number,
  max: number,
  fallback: number,
  integer: boolean,
  warnings: ResourceLimitWarning[],
): number {
  if (
    requested === undefined ||
    !Number.isFinite(requested) ||
    requested < 0 ||
    (integer && !Number.isInteger(requested))
  ) {
    if (requested !== undefined) {
      warnings.push({
        field,
        requested,
        applied: fallback,
        kind: "defaulted_invalid",
        message: `${field} value ${requested} is invalid; using default ${fallback}.`,
      });
    }
    return fallback;
  }

  if (requested < min) {
    warnings.push({
      field,
      requested,
      applied: min,
      kind: "clamped_low",
      message: `${field} value ${requested} is below the minimum ${min}; clamped up.`,
    });
    return min;
  }

  if (requested > max) {
    warnings.push({
      field,
      requested,
      applied: max,
      kind: "clamped_high",
      message: `${field} value ${requested} exceeds the maximum ${max}; clamped down.`,
    });
    return max;
  }

  return requested;
}

/**
 * Project the broader `EffectiveResourceLimits` back onto the existing
 * `SandboxResourceLimits` shape so normalized budgets can feed directly into a
 * `SandboxPolicy` without restructuring existing call sites.
 */
export function toSandboxResourceLimits(
  limits: EffectiveResourceLimits,
): SandboxResourceLimits {
  return {
    cpuCount: limits.cpuCount,
    memoryMb: limits.memoryMb,
    diskMb: limits.diskMb,
    processLimit: limits.processLimit,
    timeoutMs: limits.timeoutMs,
  };
}
