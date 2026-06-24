import { describe, expect, it } from "vitest";
import {
  FakeSandboxProvider,
  assertSandboxPolicy,
  buildDockerRunCommand,
  createDefaultSandboxPolicy,
  createSandboxArtifact,
  hashSandboxBytes,
  validateNetworkAllowlist,
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
