import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import {
  DockerSandboxProvider,
  FakeSandboxProvider,
  assertSandboxPolicy,
  buildDockerRunCommand,
  createDefaultSandboxPolicy,
  createSandboxArtifact,
  defaultEffectiveResourceLimits,
  defaultResourceLimitBounds,
  evaluateEgressPolicy,
  evaluateFilesystemAccess,
  hashSandboxBytes,
  normalizeResourceLimits,
  toSandboxResourceLimits,
  validateNetworkAllowlist,
  type DockerProcessCommand,
  type DockerProcessResult,
  type FilesystemPolicy,
  type SandboxNetworkPolicy,
  type SandboxPolicy,
  type SandboxResult,
} from "./index";

const baseNow = "2026-06-24T18:00:00.000Z";

function dockerPolicy(overrides: Partial<SandboxPolicy> = {}): SandboxPolicy {
  return {
    ...createDefaultSandboxPolicy({
      providerKind: "docker-local",
      risk: "read_internal",
      mounts: [
        {
          source: "/srv/bek/repo",
          target: "/workspace/source",
          mode: "read_only",
          purpose: "source",
        },
        {
          source: "/srv/bek/worktree",
          target: "/workspace/worktree",
          mode: "read_write",
          purpose: "worktree",
        },
        {
          source: "/srv/bek/artifacts",
          target: "/workspace/artifacts",
          mode: "read_write",
          purpose: "artifact",
        },
      ],
    }),
    imageRef: "node:22-alpine",
    resourceLimits: {
      cpuCount: 1,
      memoryMb: 512,
      diskMb: 256,
      processLimit: 64,
      timeoutMs: 60_000,
    },
    env: { NODE_ENV: "test" },
    ...overrides,
  };
}

describe("docker run command builder", () => {
  it("builds safe no-network docker args by default", () => {
    const command = buildDockerRunCommand({
      create: {
        orgId: "org_demo",
        runId: "run_demo",
        attempt: 2,
        policy: dockerPolicy(),
        traceId: "trace_demo",
      },
      containerName: "bek-run-demo",
      command: ["node", "--version"],
    });

    expect(command).toMatchObject({
      executable: "docker",
      containerName: "bek-run-demo",
      networkAllowlist: [],
    });
    expect(command.args).toEqual([
      "run",
      "--detach",
      "--rm",
      "--name",
      "bek-run-demo",
      "--label",
      "dev.bek.org=org_demo",
      "--label",
      "dev.bek.run=run_demo",
      "--label",
      "dev.bek.trace=trace_demo",
      "--network",
      "none",
      "--cpus",
      "1",
      "--memory",
      "512m",
      "--pids-limit",
      "64",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,noexec,size=256m",
      "--security-opt",
      "no-new-privileges",
      "--cap-drop",
      "ALL",
      "--init",
      "--user",
      "1000:1000",
      "--workdir",
      "/workspace/worktree",
      "--mount",
      "type=bind,src=/srv/bek/repo,dst=/workspace/source,readonly",
      "--mount",
      "type=bind,src=/srv/bek/worktree,dst=/workspace/worktree",
      "--mount",
      "type=bind,src=/srv/bek/artifacts,dst=/workspace/artifacts",
      "--env",
      "NODE_ENV=test",
      "node:22-alpine",
      "node",
      "--version",
    ]);
    expect(command.args).not.toContain("--privileged");
  });

  it("normalizes allowlisted egress onto an explicit Docker network", () => {
    const policy = dockerPolicy({
      network: {
        mode: "egress_allowlist",
        allowlist: ["https://API.GitHub.com/", "http://cache.example.com:8080"],
        blockPrivateNetworks: true,
        blockMetadataService: true,
      },
    });

    const command = buildDockerRunCommand({
      create: {
        orgId: "org_demo",
        runId: "run_network",
        attempt: 1,
        policy,
        traceId: "trace_network",
      },
    });

    expect(command.networkAllowlist).toEqual([
      "api.github.com",
      "cache.example.com:8080",
    ]);
    expect(command.args).toContain("bek-egress-allowlist");
    expect(command.args).toContain(
      "BEK_SANDBOX_EGRESS_ALLOWLIST=api.github.com,cache.example.com:8080",
    );
  });
});

describe("docker sandbox provider", () => {
  it("creates, executes, uploads, downloads, and destroys containers through docker argv", async () => {
    const commands: DockerProcessCommand[] = [];
    const provider = new DockerSandboxProvider({
      now: () => baseNow,
      idFactory: (prefix) => `${prefix}_test`,
      runner: async (command) => {
        commands.push(command);
        if (
          command.args[0] === "cp" &&
          typeof command.args[1] === "string" &&
          command.args[1].includes(":/workspace/artifacts/out.txt")
        ) {
          await writeFile(command.args[2]!, "artifact");
        }
        return dockerOk();
      },
    });
    const lease = await provider.create({
      orgId: "org_demo",
      runId: "run_docker",
      attempt: 1,
      policy: dockerPolicy(),
      traceId: "trace_docker",
    });

    expect(lease).toMatchObject({
      id: "sandbox_test",
      providerKind: "docker-local",
      runId: "run_docker",
    });
    expect(commands[0]?.args.slice(0, 8)).toEqual([
      "run",
      "--detach",
      "--rm",
      "--name",
      "bek-run_docker-1",
      "--label",
      "dev.bek.org=org_demo",
      "--label",
    ]);

    const execResult = await provider.exec(lease, {
      idempotencyKey: "cmd_1",
      command: ["node", "--version"],
      cwd: "/workspace/worktree",
      env: { A: "B" },
      timeoutMs: 2_000,
      risk: "read_internal",
    });
    expect(execResult.exitCode).toBe(0);
    expect(commands[1]?.args).toEqual([
      "exec",
      "--workdir",
      "/workspace/worktree",
      "--env",
      "A=B",
      "bek-run_docker-1",
      "node",
      "--version",
    ]);

    await provider.upload(lease, {
      path: "/workspace/artifacts/in.txt",
      bytes: new TextEncoder().encode("upload"),
      mode: "read_write",
    });
    expect(commands[2]?.args).toEqual([
      "exec",
      "bek-run_docker-1",
      "mkdir",
      "-p",
      "/workspace/artifacts",
    ]);
    expect(commands[3]?.args.slice(0, 2)).toEqual(["cp", expect.any(String)]);
    expect(commands[3]?.args[2]).toBe(
      "bek-run_docker-1:/workspace/artifacts/in.txt",
    );

    const artifact = await provider.download(
      lease,
      "/workspace/artifacts/out.txt",
    );
    expect(commands[4]?.args.slice(0, 2)).toEqual([
      "cp",
      "bek-run_docker-1:/workspace/artifacts/out.txt",
    ]);
    expect(artifact).toMatchObject({
      path: "/workspace/artifacts/out.txt",
      sizeBytes: 8,
      contentHash:
        "sha256:c7c5c1d70c5dec4416ab6158afd0b223ef40c29b1dc1f97ed9428b94d4cadb1c",
    });

    await provider.destroy(lease);
    expect(commands[5]?.args).toEqual(["rm", "--force", "bek-run_docker-1"]);
  });

  it("kills timed-out docker execs and marks the lease destroyed", async () => {
    const commands: DockerProcessCommand[] = [];
    const provider = new DockerSandboxProvider({
      now: () => baseNow,
      idFactory: (prefix) => `${prefix}_timeout`,
      runner: async (command) => {
        commands.push(command);
        if (command.args[0] === "exec") {
          return {
            exitCode: 124,
            stdout: "",
            stderr: "",
            durationMs: 2_000,
            timedOut: true,
          };
        }
        return dockerOk();
      },
    });
    const lease = await provider.create({
      orgId: "org_demo",
      runId: "run_timeout",
      attempt: 1,
      policy: dockerPolicy(),
      traceId: "trace_timeout",
    });

    const result = await provider.exec(lease, {
      idempotencyKey: "cmd_timeout",
      command: ["sleep", "10"],
      timeoutMs: 1_000,
      risk: "read_internal",
    });

    expect(result.timedOut).toBe(true);
    expect(commands.at(-1)?.args).toEqual(["kill", "bek-run_timeout-1"]);
    await expect(
      provider.exec(lease, {
        idempotencyKey: "cmd_after_timeout",
        command: ["true"],
        risk: "read_internal",
      }),
    ).rejects.toThrow(/destroyed/);
  });

  it("surfaces docker failures with redacted output", async () => {
    const provider = new DockerSandboxProvider({
      runner: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "failed with xoxb-secret-token",
        durationMs: 5,
        timedOut: false,
      }),
    });

    await expect(
      provider.create({
        orgId: "org_demo",
        runId: "run_fail",
        attempt: 1,
        policy: dockerPolicy(),
        traceId: "trace_fail",
      }),
    ).rejects.toThrow("[redacted:slack-token]");
  });
});

describe("sandbox policy validation", () => {
  it("rejects privileged policies, metadata services, and private network targets", () => {
    expect(() =>
      assertSandboxPolicy({
        ...dockerPolicy(),
        allowPrivileged: true as false,
      }),
    ).toThrow(/privileged/);

    expect(() =>
      validateNetworkAllowlist({
        mode: "egress_allowlist",
        allowlist: ["169.254.169.254"],
        blockPrivateNetworks: true,
        blockMetadataService: true,
      }),
    ).toThrow(/metadata service/);

    expect(() =>
      validateNetworkAllowlist({
        mode: "egress_allowlist",
        allowlist: ["10.0.0.5"],
        blockPrivateNetworks: true,
        blockMetadataService: true,
      }),
    ).toThrow(/private network/);

    expect(() =>
      validateNetworkAllowlist({
        mode: "egress_allowlist",
        allowlist: ["http://[::ffff:127.0.0.1]"],
        blockPrivateNetworks: true,
        blockMetadataService: true,
      }),
    ).toThrow(/private network/);

    expect(() =>
      validateNetworkAllowlist({
        mode: "egress_allowlist",
        allowlist: ["http://[::ffff:169.254.169.254]"],
        blockPrivateNetworks: true,
        blockMetadataService: true,
      }),
    ).toThrow(/metadata service/);
  });

  it("requires explicit allowlists and rejects unsafe mount sources", () => {
    expect(() =>
      validateNetworkAllowlist({
        mode: "egress_allowlist",
        allowlist: [],
        blockPrivateNetworks: true,
        blockMetadataService: true,
      }),
    ).toThrow(/at least one host/);

    expect(() =>
      assertSandboxPolicy(
        dockerPolicy({
          mounts: [
            {
              source: "/var/run/docker.sock",
              target: "/workspace/docker.sock",
              mode: "read_write",
              purpose: "scratch",
            },
          ],
        }),
      ),
    ).toThrow(/Docker socket/);

    expect(() =>
      assertSandboxPolicy(
        dockerPolicy({
          mounts: [
            {
              source: "/srv/bek/repo",
              target: "/workspace/source",
              mode: "read_write",
              purpose: "source",
            },
          ],
        }),
      ),
    ).toThrow(/source mounts must be read-only/);
  });
});

function dockerOk(): DockerProcessResult {
  return {
    exitCode: 0,
    stdout: "ok",
    stderr: "",
    durationMs: 5,
    timedOut: false,
  };
}

describe("artifact hashing helpers", () => {
  it("hashes sandbox artifact bytes with a stable sha256 prefix", () => {
    const bytes = new TextEncoder().encode("hello");
    expect(hashSandboxBytes(bytes)).toBe(
      "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    expect(
      createSandboxArtifact({
        path: "/workspace/artifacts/hello.txt",
        bytes,
        mediaType: "text/plain",
      }),
    ).toEqual({
      path: "/workspace/artifacts/hello.txt",
      contentHash:
        "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      sizeBytes: 5,
      mediaType: "text/plain",
    });
  });
});

describe("fake sandbox provider", () => {
  it("validates policy, records commands, hashes uploads, and closes leases", async () => {
    const execResult: SandboxResult = {
      exitCode: 7,
      stdout: "planned failure",
      stderr: "",
      durationMs: 12,
      timedOut: false,
    };
    const provider = new FakeSandboxProvider({
      now: () => baseNow,
      idFactory: (prefix) => `${prefix}_1`,
      execResults: [execResult],
    });
    const policy = createDefaultSandboxPolicy({
      providerKind: "noop",
      risk: "read_internal",
    });

    const lease = await provider.create({
      orgId: "org_demo",
      runId: "run_fake",
      attempt: 1,
      policy,
      traceId: "trace_fake",
    });
    expect(lease).toMatchObject({
      id: "sandbox_1",
      providerKind: "noop",
      runId: "run_fake",
      createdAt: baseNow,
    });

    await expect(
      provider.exec(lease, {
        idempotencyKey: "cmd_timeout",
        command: ["pnpm", "test"],
        timeoutMs: policy.resourceLimits.timeoutMs + 1,
        risk: "read_internal",
      }),
    ).rejects.toThrow(/timeout/);

    await expect(
      provider.exec(lease, {
        idempotencyKey: "cmd_empty",
        command: [],
        risk: "read_internal",
      }),
    ).rejects.toThrow(/argv/);

    const result = await provider.exec(lease, {
      idempotencyKey: "cmd_1",
      command: ["pnpm", "test"],
      cwd: "/workspace/worktree",
      risk: "read_internal",
    });
    expect(result).toEqual(execResult);

    const bytes = new TextEncoder().encode("artifact body");
    await provider.upload(lease, {
      path: "/workspace/artifacts/output.txt",
      bytes,
      mode: "read_only",
    });
    await expect(
      provider.download(lease, "/workspace/artifacts/output.txt"),
    ).resolves.toEqual({
      path: "/workspace/artifacts/output.txt",
      contentHash:
        "sha256:9938be87d35f2a7a2b80237e8dc71806b209aaea8252f12c1b12949f61d40476",
      sizeBytes: 13,
    });

    expect(provider.read().commands).toEqual([
      {
        leaseId: "sandbox_1",
        command: {
          idempotencyKey: "cmd_1",
          command: ["pnpm", "test"],
          cwd: "/workspace/worktree",
          risk: "read_internal",
        },
      },
    ]);

    await provider.destroy(lease);
    await expect(
      provider.exec(lease, {
        idempotencyKey: "cmd_after_destroy",
        command: ["true"],
        risk: "read_internal",
      }),
    ).rejects.toThrow(/destroyed/);
  });
});

function egressPolicy(
  overrides: Partial<SandboxNetworkPolicy> = {},
): SandboxNetworkPolicy {
  return {
    mode: "egress_allowlist",
    allowlist: ["api.github.com", "cache.example.com:8080"],
    blockPrivateNetworks: true,
    blockMetadataService: true,
    ...overrides,
  };
}

describe("evaluateEgressPolicy", () => {
  it("allows an exact allowlisted host", () => {
    const decision = evaluateEgressPolicy(
      egressPolicy(),
      "https://api.github.com/repos",
    );
    expect(decision).toMatchObject({
      allowed: true,
      reason: "allowlisted",
      host: "api.github.com",
    });
  });

  it("normalizes case and parses bare hosts, host:port, and URLs", () => {
    expect(evaluateEgressPolicy(egressPolicy(), "API.GitHub.com").allowed).toBe(
      true,
    );
    expect(
      evaluateEgressPolicy(egressPolicy(), "cache.example.com:8080").allowed,
    ).toBe(true);
    // Wrong port for a port-scoped allowlist entry is denied.
    expect(
      evaluateEgressPolicy(egressPolicy(), "cache.example.com:9090"),
    ).toMatchObject({ allowed: false, reason: "not_allowlisted" });
    // Port-less allowlist entry matches any port.
    expect(
      evaluateEgressPolicy(egressPolicy(), "https://api.github.com:8443/")
        .allowed,
    ).toBe(true);
  });

  it("denies non-allowlisted hosts", () => {
    expect(
      evaluateEgressPolicy(egressPolicy(), "evil.example.org"),
    ).toMatchObject({ allowed: false, reason: "not_allowlisted" });
  });

  it("denies all egress when the network is disabled", () => {
    expect(
      evaluateEgressPolicy(
        egressPolicy({ mode: "disabled", allowlist: [] }),
        "api.github.com",
      ),
    ).toMatchObject({ allowed: false, reason: "network_disabled" });
  });

  it("blocks the cloud metadata IP even if it is allowlisted", () => {
    const policy = egressPolicy({ allowlist: ["169.254.169.254"] });
    expect(evaluateEgressPolicy(policy, "169.254.169.254")).toMatchObject({
      allowed: false,
      reason: "metadata_blocked",
    });
    expect(
      evaluateEgressPolicy(policy, "http://[::ffff:169.254.169.254]/"),
    ).toMatchObject({ allowed: false, reason: "metadata_blocked" });
    expect(
      evaluateEgressPolicy(policy, "metadata.google.internal"),
    ).toMatchObject({ allowed: false, reason: "metadata_blocked" });
  });

  it("blocks private RFC1918 ranges and localhost by default", () => {
    expect(evaluateEgressPolicy(egressPolicy(), "10.0.0.5")).toMatchObject({
      allowed: false,
      reason: "private_network_blocked",
    });
    expect(evaluateEgressPolicy(egressPolicy(), "192.168.1.1")).toMatchObject({
      allowed: false,
      reason: "private_network_blocked",
    });
    expect(evaluateEgressPolicy(egressPolicy(), "172.16.4.4")).toMatchObject({
      allowed: false,
      reason: "private_network_blocked",
    });
    expect(evaluateEgressPolicy(egressPolicy(), "localhost")).toMatchObject({
      allowed: false,
      reason: "localhost_blocked",
    });
    expect(evaluateEgressPolicy(egressPolicy(), "127.0.0.1")).toMatchObject({
      allowed: false,
      reason: "localhost_blocked",
    });
    expect(evaluateEgressPolicy(egressPolicy(), "[::1]:443")).toMatchObject({
      allowed: false,
      reason: "localhost_blocked",
    });
  });

  it("permits private hosts only when guards are disabled or overridden", () => {
    // Guard disabled on the policy.
    expect(
      evaluateEgressPolicy(
        egressPolicy({
          allowlist: ["10.0.0.5"],
          blockPrivateNetworks: false,
        }),
        "10.0.0.5",
      ).allowed,
    ).toBe(true);

    // Guard still on, but explicit override for an allowlisted host.
    expect(
      evaluateEgressPolicy(
        egressPolicy({ allowlist: ["10.0.0.5"] }),
        "10.0.0.5",
        { allowlistOverridesGuards: true },
      ).allowed,
    ).toBe(true);

    // Override never bypasses the metadata guard.
    expect(
      evaluateEgressPolicy(
        egressPolicy({ allowlist: ["169.254.169.254"] }),
        "169.254.169.254",
        { allowlistOverridesGuards: true },
      ),
    ).toMatchObject({ allowed: false, reason: "metadata_blocked" });
  });

  it("rejects malformed targets", () => {
    for (const bad of [
      "",
      "   ",
      "ht tp://x",
      "*.example.com",
      "host:notaport",
    ]) {
      expect(evaluateEgressPolicy(egressPolicy(), bad)).toMatchObject({
        allowed: false,
        reason: "invalid_target",
      });
    }
  });
});

function fsPolicy(overrides: Partial<FilesystemPolicy> = {}): FilesystemPolicy {
  return {
    sourceRoot: "/workspace/source",
    worktreeRoot: "/workspace/worktree",
    artifactRoot: "/workspace/artifacts",
    maxWriteBytes: 1_000,
    ...overrides,
  };
}

describe("evaluateFilesystemAccess", () => {
  it("allows reads within any root", () => {
    expect(
      evaluateFilesystemAccess(fsPolicy(), "/workspace/source/src/index.ts"),
    ).toMatchObject({ allowed: true, reason: "allowed", root: "source" });
    expect(
      evaluateFilesystemAccess(fsPolicy(), "/workspace/worktree/a.txt", {
        mode: "read",
      }),
    ).toMatchObject({ allowed: true, root: "worktree" });
  });

  it("allows writes to worktree and artifact roots but not the source root", () => {
    expect(
      evaluateFilesystemAccess(fsPolicy(), "/workspace/worktree/out.txt", {
        mode: "write",
      }),
    ).toMatchObject({ allowed: true, root: "worktree" });
    expect(
      evaluateFilesystemAccess(fsPolicy(), "/workspace/artifacts/out.txt", {
        mode: "write",
      }),
    ).toMatchObject({ allowed: true, root: "artifact" });
    expect(
      evaluateFilesystemAccess(fsPolicy(), "/workspace/source/out.txt", {
        mode: "write",
      }),
    ).toMatchObject({
      allowed: false,
      reason: "read_only_root",
      root: "source",
    });
  });

  it("rejects path traversal and escapes", () => {
    expect(
      evaluateFilesystemAccess(
        fsPolicy(),
        "/workspace/worktree/../../etc/passwd",
      ),
    ).toMatchObject({ allowed: false, reason: "path_traversal" });
    expect(
      evaluateFilesystemAccess(
        fsPolicy(),
        "/workspace/source/../source-secrets",
      ),
    ).toMatchObject({ allowed: false, reason: "path_traversal" });
    // Traversal that resolves back inside is still rejected (no '..' allowed).
    expect(
      evaluateFilesystemAccess(fsPolicy(), "/workspace/worktree/sub/../ok.txt"),
    ).toMatchObject({ allowed: false, reason: "path_traversal" });
  });

  it("rejects paths outside all roots", () => {
    expect(evaluateFilesystemAccess(fsPolicy(), "/etc/passwd")).toMatchObject({
      allowed: false,
      reason: "outside_roots",
    });
    // Prefix sibling must not be treated as inside the root.
    expect(
      evaluateFilesystemAccess(fsPolicy(), "/workspace/worktree-evil/x"),
    ).toMatchObject({ allowed: false, reason: "outside_roots" });
  });

  it("rejects invalid paths", () => {
    expect(evaluateFilesystemAccess(fsPolicy(), "")).toMatchObject({
      allowed: false,
      reason: "invalid_path",
    });
    expect(evaluateFilesystemAccess(fsPolicy(), "relative/path")).toMatchObject(
      { allowed: false, reason: "invalid_path" },
    );
    expect(
      evaluateFilesystemAccess(fsPolicy(), "/workspace/worktree/a\0b"),
    ).toMatchObject({ allowed: false, reason: "invalid_path" });
  });

  it("enforces the maximum write size", () => {
    expect(
      evaluateFilesystemAccess(fsPolicy(), "/workspace/worktree/big.bin", {
        mode: "write",
        sizeBytes: 5_000,
      }),
    ).toMatchObject({ allowed: false, reason: "size_exceeded" });
    expect(
      evaluateFilesystemAccess(fsPolicy(), "/workspace/worktree/ok.bin", {
        mode: "write",
        sizeBytes: 500,
      }),
    ).toMatchObject({ allowed: true });
    // Size is not checked on reads.
    expect(
      evaluateFilesystemAccess(fsPolicy(), "/workspace/worktree/ok.bin", {
        mode: "read",
        sizeBytes: 5_000,
      }).allowed,
    ).toBe(true);
  });

  it("treats the root directory itself as in-range", () => {
    expect(
      evaluateFilesystemAccess(fsPolicy(), "/workspace/worktree", {
        mode: "write",
      }),
    ).toMatchObject({ allowed: true, root: "worktree" });
  });
});

describe("normalizeResourceLimits", () => {
  it("returns defaults with no warnings when nothing is requested", () => {
    const result = normalizeResourceLimits();
    expect(result.limits).toEqual(defaultEffectiveResourceLimits);
    expect(result.warnings).toEqual([]);
  });

  it("passes through valid in-range requests untouched", () => {
    const result = normalizeResourceLimits({
      cpuCount: 4,
      memoryMb: 8192,
      diskMb: 20_480,
      processLimit: 512,
      timeoutMs: 120_000,
      wallClockMs: 240_000,
      egressBytes: 1024 * 1024,
    });
    expect(result.warnings).toEqual([]);
    expect(result.limits).toEqual({
      cpuCount: 4,
      memoryMb: 8192,
      diskMb: 20_480,
      processLimit: 512,
      timeoutMs: 120_000,
      wallClockMs: 240_000,
      egressBytes: 1024 * 1024,
    });
  });

  it("clamps oversized values down to the maxima and warns", () => {
    const result = normalizeResourceLimits({
      cpuCount: 999,
      memoryMb: 10_000_000,
      egressBytes: Number.MAX_SAFE_INTEGER,
    });
    expect(result.limits.cpuCount).toBe(defaultResourceLimitBounds.maxCpuCount);
    expect(result.limits.memoryMb).toBe(defaultResourceLimitBounds.maxMemoryMb);
    expect(result.limits.egressBytes).toBe(
      defaultResourceLimitBounds.maxEgressBytes,
    );
    const fields = result.warnings.map((w) => `${w.field}:${w.kind}`);
    expect(fields).toContain("cpuCount:clamped_high");
    expect(fields).toContain("memoryMb:clamped_high");
    expect(fields).toContain("egressBytes:clamped_high");
  });

  it("clamps undersized values up to the minima and warns", () => {
    const result = normalizeResourceLimits({
      cpuCount: 0.01,
      memoryMb: 1,
      timeoutMs: 5,
    });
    expect(result.limits.cpuCount).toBe(defaultResourceLimitBounds.minCpuCount);
    expect(result.limits.memoryMb).toBe(defaultResourceLimitBounds.minMemoryMb);
    expect(result.limits.timeoutMs).toBe(
      defaultResourceLimitBounds.minTimeoutMs,
    );
    expect(result.warnings.every((w) => w.kind === "clamped_low")).toBe(true);
  });

  it("falls back to defaults for invalid values and warns", () => {
    const result = normalizeResourceLimits({
      memoryMb: 512.5,
      diskMb: Number.NaN,
      processLimit: -10,
    });
    expect(result.limits.memoryMb).toBe(
      defaultEffectiveResourceLimits.memoryMb,
    );
    expect(result.limits.diskMb).toBe(defaultEffectiveResourceLimits.diskMb);
    expect(result.limits.processLimit).toBe(
      defaultEffectiveResourceLimits.processLimit,
    );
    expect(
      result.warnings.filter((w) => w.kind === "defaulted_invalid").length,
    ).toBe(3);
  });

  it("raises wall-clock to be at least the command timeout", () => {
    const result = normalizeResourceLimits({
      timeoutMs: 300_000,
      wallClockMs: 60_000,
    });
    expect(result.limits.wallClockMs).toBe(300_000);
    expect(
      result.warnings.some(
        (w) => w.field === "wallClockMs" && w.kind === "clamped_low",
      ),
    ).toBe(true);
  });

  it("projects effective limits back onto SandboxResourceLimits", () => {
    const { limits } = normalizeResourceLimits({ cpuCount: 4, memoryMb: 8192 });
    expect(toSandboxResourceLimits(limits)).toEqual({
      cpuCount: 4,
      memoryMb: 8192,
      diskMb: limits.diskMb,
      processLimit: limits.processLimit,
      timeoutMs: limits.timeoutMs,
    });
  });
});
