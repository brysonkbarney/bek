import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adminAuthHeaders,
  cancelRunPath,
  clearAdminApiToken,
  decideApproval,
  deleteGrant,
  detachBundleFromPlace,
  drainSlackOutbox,
  discoverSlackChannels,
  fetchBootstrap,
  fetchAuditEvents,
  fetchGitHubSetup,
  fetchModelUsage,
  fetchSlackManifest,
  fetchSlackOutbox,
  hasStoredAdminToken,
  githubSetupPath,
  linkPrincipalExternalIdentity,
  redriveDeadLetterPath,
  registerMcpConnector,
  readAdminApiToken,
  readBekApiUrl,
  saveAdminApiToken,
  slackChannelDiscoveryPath,
  slackInstallStartPath,
  slackOutboxPath,
  updateAccessBundle,
  updateGrant,
  updateMcpConnector,
} from "./api";

describe("web API helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses runtime browser config for the API URL when provided", () => {
    vi.stubGlobal("window", {
      __BEK_CONFIG__: { apiUrl: " https://api.example.test/// " },
    });

    expect(readBekApiUrl()).toBe("https://api.example.test");
  });

  it("supports same-origin runtime API URLs", () => {
    vi.stubGlobal("window", {
      __BEK_CONFIG__: { apiUrl: "/" },
    });

    expect(readBekApiUrl()).toBe("");
  });

  it("fetches admin data from the runtime API URL", async () => {
    vi.stubGlobal("window", {
      __BEK_CONFIG__: { apiUrl: "https://api.example.test/" },
    });
    const bootstrap = {
      org: { name: "Acme", plan: "oss" },
      agent: {
        name: "Bek",
        handle: "@bek",
        description: "Open teammate",
        status: "active",
      },
      capabilityProfiles: [],
      places: [],
      accessBundles: [],
      modelPolicies: [],
      runtimeProfiles: [],
      budgetPolicies: [],
      connectorInstalls: [],
      credentials: [],
      runs: [],
      events: [],
      approvals: [],
    };
    const fetchMock = vi.fn(async (...args: Parameters<typeof fetch>) => {
      const [input] = args;
      expect(String(input)).toBe("https://api.example.test/api/bootstrap");
      return new Response(JSON.stringify(bootstrap), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchBootstrap()).resolves.toEqual(bootstrap);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("stores admin tokens at runtime for protected admin consoles", () => {
    const localStorage = createMemoryStorage();
    const sessionStorage = createMemoryStorage();
    vi.stubGlobal("window", { localStorage, sessionStorage });

    expect(readAdminApiToken()).toBeUndefined();
    expect(hasStoredAdminToken()).toBe(false);

    saveAdminApiToken(" runtime-token ");

    expect(hasStoredAdminToken()).toBe(true);
    expect(readAdminApiToken()).toBe("runtime-token");
    expect(sessionStorage.getItem("bek.adminApiToken")).toBe("runtime-token");
    expect(localStorage.getItem("bek.adminApiToken")).toBeNull();
    expect(adminAuthHeaders({ "content-type": "application/json" })).toEqual({
      authorization: "Bearer runtime-token",
      "content-type": "application/json",
    });

    clearAdminApiToken();
    expect(readAdminApiToken()).toBeUndefined();
    expect(hasStoredAdminToken()).toBe(false);
  });

  it("persists admin tokens only when explicitly requested", () => {
    const localStorage = createMemoryStorage();
    const sessionStorage = createMemoryStorage();
    vi.stubGlobal("window", { localStorage, sessionStorage });

    saveAdminApiToken(" persistent-token ", { persist: true });

    expect(readAdminApiToken()).toBe("persistent-token");
    expect(localStorage.getItem("bek.adminApiToken")).toBe("persistent-token");
    expect(sessionStorage.getItem("bek.adminApiToken")).toBeNull();
  });

  it("prefers session admin tokens over legacy persistent tokens", () => {
    const localStorage = createMemoryStorage();
    const sessionStorage = createMemoryStorage();
    localStorage.setItem("bek.adminApiToken", "legacy-token");
    sessionStorage.setItem("bek.adminApiToken", "session-token");
    vi.stubGlobal("window", { localStorage, sessionStorage });

    expect(readAdminApiToken()).toBe("session-token");
  });

  it("clears session and persistent admin tokens together", () => {
    const localStorage = createMemoryStorage();
    const sessionStorage = createMemoryStorage();
    localStorage.setItem("bek.adminApiToken", "legacy-token");
    sessionStorage.setItem("bek.adminApiToken", "session-token");
    vi.stubGlobal("window", { localStorage, sessionStorage });

    clearAdminApiToken();

    expect(readAdminApiToken()).toBeUndefined();
    expect(localStorage.getItem("bek.adminApiToken")).toBeNull();
    expect(sessionStorage.getItem("bek.adminApiToken")).toBeNull();
  });

  it("clears the runtime admin token when saved input is empty", () => {
    const localStorage = createMemoryStorage();
    const sessionStorage = createMemoryStorage();
    vi.stubGlobal("window", { localStorage, sessionStorage });

    saveAdminApiToken("runtime-token");
    saveAdminApiToken("   ");

    expect(readAdminApiToken()).toBeUndefined();
    expect(localStorage.getItem("bek.adminApiToken")).toBeNull();
    expect(sessionStorage.getItem("bek.adminApiToken")).toBeNull();
  });

  it("builds Slack install start paths with encoded return targets", () => {
    expect(slackInstallStartPath()).toBe(
      "/api/slack/install-url?return_to=%2Fconnectors",
    );
    expect(slackInstallStartPath("/connectors?slack=1")).toBe(
      "/api/slack/install-url?return_to=%2Fconnectors%3Fslack%3D1",
    );
  });

  it("fetches the Slack app manifest with admin auth", async () => {
    const storage = createMemoryStorage();
    vi.stubGlobal("window", { localStorage: storage });
    saveAdminApiToken("runtime-token");
    const manifest = {
      ok: true as const,
      baseUrl: "https://bek.example.com",
      manifest: {
        display_information: { name: "Bek" },
      },
      scopes: ["app_mentions:read", "commands"],
      botEvents: ["app_mention", "member_joined_channel"],
      urls: {
        events: "https://bek.example.com/api/slack/events",
        interactivity: "https://bek.example.com/api/slack/interactivity",
        command: "https://bek.example.com/api/slack/commands",
        redirect: "https://bek.example.com/api/slack/oauth/callback",
      },
    };
    const fetchMock = vi.fn(async (...args: Parameters<typeof fetch>) => {
      const [input, init] = args;
      expect(String(input)).toBe("http://localhost:4317/api/slack/manifest");
      expect(init?.headers).toEqual({ authorization: "Bearer runtime-token" });
      return new Response(JSON.stringify(manifest), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSlackManifest()).resolves.toEqual(manifest);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("builds run cancellation paths with encoded run ids", () => {
    expect(cancelRunPath("run_123")).toBe("/api/runs/run_123/cancel");
    expect(cancelRunPath("run/with space")).toBe(
      "/api/runs/run%2Fwith%20space/cancel",
    );
  });

  it("builds dead-letter redrive paths with encoded ids", () => {
    expect(redriveDeadLetterPath("dead_123")).toBe(
      "/api/worker/dead-letters/dead_123/redrive",
    );
    expect(redriveDeadLetterPath("dead/with space")).toBe(
      "/api/worker/dead-letters/dead%2Fwith%20space/redrive",
    );
  });

  it("builds Slack outbox paths with optional details", () => {
    expect(slackOutboxPath()).toBe("/api/outbound/slack");
    expect(slackOutboxPath({ includeDetails: false })).toBe(
      "/api/outbound/slack",
    );
    expect(slackOutboxPath({ includeDetails: true })).toBe(
      "/api/outbound/slack?include=details",
    );
  });

  it("builds Slack channel discovery paths with bounded query options", () => {
    expect(slackChannelDiscoveryPath()).toBe("/api/slack/channels/discover");
    expect(
      slackChannelDiscoveryPath({
        cursor: "next-page",
        limit: 50,
        types: "public_channel,private_channel",
        excludeArchived: false,
      }),
    ).toBe(
      "/api/slack/channels/discover?cursor=next-page&limit=50&types=public_channel%2Cprivate_channel&excludeArchived=false",
    );
  });

  it("builds GitHub setup preview paths with optional installation ids", () => {
    expect(githubSetupPath()).toBe("/api/setup/github");
    expect(githubSetupPath({ installationId: " 456 " })).toBe(
      "/api/setup/github?installationId=456",
    );
  });

  it("fetches the GitHub setup preview with admin auth", async () => {
    const storage = createMemoryStorage();
    vi.stubGlobal("window", { localStorage: storage });
    saveAdminApiToken("runtime-token");
    const preview = {
      ok: true,
      appConfig: {
        ok: true,
        appId: "12345",
        privateKeyConfigured: true,
        webhookSecretConfigured: true,
        legacyWebhookSecretConfigured: false,
        clientIdConfigured: false,
        clientSecretConfigured: false,
        errors: [],
        warnings: [],
      },
      installation: {
        configured: true,
        source: "query" as const,
        installationId: "456",
        errors: [],
      },
      githubGrantCount: 1,
      validRepoGrantCount: 1,
      invalidGrantCount: 0,
      repositories: [
        {
          repository: {
            provider: "github" as const,
            owner: "redohq",
            repo: "checkout",
            fullName: "redohq/checkout",
            resource: "github:redohq/checkout",
            url: "https://github.com/redohq/checkout",
          },
          grants: [
            {
              bundleId: "bundle_repo",
              bundleName: "Repo access",
              grantId: "grant_repo",
              capability: "github.pr" as const,
              resource: "github:redohq/checkout",
              decision: "ask" as const,
              risk: "write_external",
              requiresApproval: true,
            },
          ],
          requiredPermissions: {
            contents: "write" as const,
            metadata: "read" as const,
            pull_requests: "write" as const,
          },
          installationTokenRequestPreview: {
            installationId: "456",
            repository: {
              provider: "github" as const,
              owner: "redohq",
              repo: "checkout",
              fullName: "redohq/checkout",
              resource: "github:redohq/checkout",
              url: "https://github.com/redohq/checkout",
            },
            permissions: {
              contents: "write" as const,
              metadata: "read" as const,
              pull_requests: "write" as const,
            },
          },
          draftPullRequestWorkflowPreview: null,
        },
      ],
      invalidGrants: [],
      errors: [],
      networkCalls: "none" as const,
    };
    const fetchMock = vi.fn(async (...args: Parameters<typeof fetch>) => {
      const [input, init] = args;
      expect(String(input)).toBe(
        "http://localhost:4317/api/setup/github?installationId=456",
      );
      expect(init?.headers).toEqual({ authorization: "Bearer runtime-token" });
      return new Response(JSON.stringify(preview), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchGitHubSetup({ installationId: "456" })).resolves.toEqual(
      preview,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("mutates access bundle places and grants with admin auth", async () => {
    const storage = createMemoryStorage();
    vi.stubGlobal("window", { localStorage: storage });
    saveAdminApiToken("runtime-token");
    const bundle = {
      id: "bundle_checkout",
      name: "Checkout",
      description: "Checkout access",
      attachedPlaceIds: ["place_checkout"],
      budgetPolicyId: "budget_checkout",
      grants: [],
    };
    const grant = {
      id: "grant_checkout_pr",
      capability: "github.pr",
      resource: "github:redohq/checkout",
      decision: "ask" as const,
      risk: "write_external",
      requiresApproval: true,
    };
    const calls: Array<{
      path: string;
      method: string;
      body: unknown;
      authorization: string | undefined;
    }> = [];
    const fetchMock = vi.fn(async (...args: Parameters<typeof fetch>) => {
      const [input, init] = args;
      const url = new URL(String(input));
      calls.push({
        path: `${url.pathname}${url.search}`,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
        authorization:
          init?.headers instanceof Headers
            ? (init.headers.get("authorization") ?? undefined)
            : (init?.headers as Record<string, string> | undefined)
                ?.authorization,
      });
      const body = url.pathname.includes("/grants/") ? grant : bundle;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      updateAccessBundle({
        bundleId: "bundle_checkout",
        name: "Checkout",
        description: "Checkout access",
      }),
    ).resolves.toEqual(bundle);
    await expect(
      detachBundleFromPlace({
        bundleId: "bundle_checkout",
        placeId: "place_general",
      }),
    ).resolves.toEqual(bundle);
    await expect(
      updateGrant({
        bundleId: "bundle_checkout",
        grantId: "grant_checkout_pr",
        decision: "deny",
        requiresApproval: false,
      }),
    ).resolves.toEqual(grant);
    await expect(
      deleteGrant({
        bundleId: "bundle_checkout",
        grantId: "grant_checkout_pr",
      }),
    ).resolves.toEqual(grant);

    expect(calls).toEqual([
      {
        path: "/api/access-bundles/bundle_checkout",
        method: "PATCH",
        body: {
          name: "Checkout",
          description: "Checkout access",
        },
        authorization: "Bearer runtime-token",
      },
      {
        path: "/api/access-bundles/bundle_checkout/places/place_general",
        method: "DELETE",
        body: null,
        authorization: "Bearer runtime-token",
      },
      {
        path: "/api/access-bundles/bundle_checkout/grants/grant_checkout_pr",
        method: "PATCH",
        body: {
          decision: "deny",
          requiresApproval: false,
        },
        authorization: "Bearer runtime-token",
      },
      {
        path: "/api/access-bundles/bundle_checkout/grants/grant_checkout_pr",
        method: "DELETE",
        body: null,
        authorization: "Bearer runtime-token",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("fetches model usage totals with admin auth", async () => {
    const storage = createMemoryStorage();
    vi.stubGlobal("window", { localStorage: storage });
    saveAdminApiToken("runtime-token");
    const usage = {
      runs: 2,
      totalEstimatedCents: 11,
      totalActualCents: 9,
      modelCalls: 3,
      inputTokens: 2400,
      outputTokens: 600,
      totalTokens: 3000,
      source: "model_usage" as const,
    };
    const fetchMock = vi.fn(async (...args: Parameters<typeof fetch>) => {
      const [input, init] = args;
      expect(String(input)).toBe("http://localhost:4317/api/model-usage");
      expect(init?.headers).toEqual({ authorization: "Bearer runtime-token" });
      return new Response(JSON.stringify(usage), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchModelUsage()).resolves.toEqual(usage);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("fetches durable audit events with admin auth", async () => {
    const storage = createMemoryStorage();
    vi.stubGlobal("window", { localStorage: storage });
    saveAdminApiToken("runtime-token");
    const auditEvents = [
      {
        id: "audit_123",
        orgId: "org_demo",
        actorPrincipalId: "principal_admin",
        action: "access_grant.updated",
        resourceType: "access_grant",
        resourceId: "grant_checkout_pr",
        decision: "ask" as const,
        risk: "write_external",
        message: "Access grant updated.",
        createdAt: "2026-06-24T18:00:00.000Z",
      },
      {
        id: "event_123",
        runId: "run_123",
        type: "run.created",
        message: "Run created.",
        createdAt: "2026-06-24T18:00:00.000Z",
      },
    ];
    const fetchMock = vi.fn(async (...args: Parameters<typeof fetch>) => {
      const [input, init] = args;
      expect(String(input)).toBe("http://localhost:4317/api/audit-events");
      expect(init?.headers).toEqual({ authorization: "Bearer runtime-token" });
      return new Response(JSON.stringify(auditEvents), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchAuditEvents()).resolves.toEqual(auditEvents);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("registers MCP connectors with admin auth", async () => {
    const storage = createMemoryStorage();
    vi.stubGlobal("window", { localStorage: storage });
    saveAdminApiToken("runtime-token");
    const connector = {
      id: "connector_mcp_linear",
      kind: "mcp",
      provider: "mcp",
      externalId: "linear",
      displayName: "Linear",
      status: "pending",
      metadata: {
        serverId: "linear",
        transport: "stdio",
        origin: "npx @linear/mcp-server",
        tags: ["issues"],
      },
      createdAt: "2026-06-24T18:00:00.000Z",
      updatedAt: "2026-06-24T18:00:00.000Z",
    };
    const fetchMock = vi.fn(async (...args: Parameters<typeof fetch>) => {
      const [input, init] = args;
      expect(String(input)).toBe("http://localhost:4317/api/connectors/mcp");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({
        authorization: "Bearer runtime-token",
        "content-type": "application/json",
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        serverId: "linear",
        displayName: "Linear",
        transport: "stdio",
        origin: "npx @linear/mcp-server",
        tags: ["issues"],
      });
      return new Response(JSON.stringify(connector), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      registerMcpConnector({
        serverId: "linear",
        displayName: "Linear",
        transport: "stdio",
        origin: "npx @linear/mcp-server",
        tags: ["issues"],
      }),
    ).resolves.toEqual(connector);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("updates MCP connectors with admin auth", async () => {
    const storage = createMemoryStorage();
    vi.stubGlobal("window", { localStorage: storage });
    saveAdminApiToken("runtime-token");
    const connector = {
      id: "connector_mcp_docs",
      kind: "mcp",
      provider: "mcp",
      externalId: "docs",
      displayName: "Docs MCP",
      status: "active",
      metadata: {
        serverId: "docs",
        transport: "stdio",
        origin: "npx @bek/docs-mcp",
        tags: ["docs"],
      },
      createdAt: "2026-06-24T18:00:00.000Z",
      updatedAt: "2026-06-24T18:00:00.000Z",
    };
    const fetchMock = vi.fn(async (...args: Parameters<typeof fetch>) => {
      const [input, init] = args;
      expect(String(input)).toBe(
        "http://localhost:4317/api/connectors/mcp/docs",
      );
      expect(init?.method).toBe("PATCH");
      expect(init?.headers).toEqual({
        authorization: "Bearer runtime-token",
        "content-type": "application/json",
      });
      expect(JSON.parse(String(init?.body))).toEqual({ status: "active" });
      return new Response(JSON.stringify(connector), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      updateMcpConnector({ serverId: "docs", status: "active" }),
    ).resolves.toEqual(connector);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("fetches Slack outbox details with admin auth", async () => {
    const storage = createMemoryStorage();
    vi.stubGlobal("window", { localStorage: storage });
    saveAdminApiToken("runtime-token");
    const outbox = {
      deliveries: [
        {
          id: "outbound_123",
          provider: "slack" as const,
          kind: "slack.run_outcome" as const,
          status: "queued" as const,
          attempts: 1,
          maxAttempts: 3,
          runId: "run_123",
          nextAttemptAt: "2026-06-24T10:00:00.000Z",
          createdAt: "2026-06-24T09:00:00.000Z",
          updatedAt: "2026-06-24T09:01:00.000Z",
          target: { channelId: "C123" },
          payload: { text: "ready" },
        },
      ],
    };
    const fetchMock = vi.fn(async (...args: Parameters<typeof fetch>) => {
      const [input, init] = args;
      expect(String(input)).toBe(
        "http://localhost:4317/api/outbound/slack?include=details",
      );
      expect(init?.headers).toEqual({ authorization: "Bearer runtime-token" });
      return new Response(JSON.stringify(outbox), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSlackOutbox({ includeDetails: true })).resolves.toEqual(
      outbox,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("fetches discovered Slack channels with admin auth", async () => {
    const storage = createMemoryStorage();
    vi.stubGlobal("window", { localStorage: storage });
    saveAdminApiToken("runtime-token");
    const discovery = {
      ok: true as const,
      source: "stored_oauth" as const,
      teamId: "T123",
      workspaceName: "Redo",
      channels: [
        {
          id: "C123",
          name: "#checkout-eng",
          isPrivate: false,
          isArchived: false,
          botIsMember: true,
          configured: false,
          configuredPlaceId: null,
          sensitivity: null,
          numMembers: 12,
        },
      ],
      nextCursor: null,
    };
    const fetchMock = vi.fn(async (...args: Parameters<typeof fetch>) => {
      const [input, init] = args;
      expect(String(input)).toBe(
        "http://localhost:4317/api/slack/channels/discover?limit=25",
      );
      expect(init?.headers).toEqual({ authorization: "Bearer runtime-token" });
      return new Response(JSON.stringify(discovery), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(discoverSlackChannels({ limit: 25 })).resolves.toEqual(
      discovery,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("links principal external identities with admin auth", async () => {
    const storage = createMemoryStorage();
    vi.stubGlobal("window", { localStorage: storage });
    saveAdminApiToken("runtime-token");
    const principal = {
      id: "principal_bryson",
      kind: "human",
      displayName: "Bryson",
      externalProvider: "slack",
      externalId: "T123:U123",
      metadata: { teamId: "T123" },
    };
    const fetchMock = vi.fn(async (...args: Parameters<typeof fetch>) => {
      const [input, init] = args;
      expect(String(input)).toBe(
        "http://localhost:4317/api/principals/principal_bryson/external-identity",
      );
      expect(init?.method).toBe("PATCH");
      expect(init?.headers).toEqual({
        authorization: "Bearer runtime-token",
        "content-type": "application/json",
      });
      expect(init?.body).toBe(
        JSON.stringify({
          externalProvider: "slack",
          externalId: "T123:U123",
          metadata: { teamId: "T123" },
        }),
      );
      return new Response(JSON.stringify(principal), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      linkPrincipalExternalIdentity({
        principalId: "principal_bryson",
        externalProvider: "slack",
        externalId: "T123:U123",
        metadata: { teamId: "T123" },
      }),
    ).resolves.toEqual(principal);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("lets the API derive approval actors from admin auth", async () => {
    const storage = createMemoryStorage();
    vi.stubGlobal("window", { localStorage: storage });
    saveAdminApiToken("runtime-token");
    const approval = {
      id: "approval_123",
      runId: "run_123",
      requesterPrincipalId: "principal_bryson",
      action: "github.pr",
      resource: "github:redohq/checkout",
      risk: "write_draft",
      payloadHash: "hash_hash_hash_hash",
      status: "approved",
      decidedByPrincipalId: "principal_admin",
      createdAt: "2026-01-02T03:04:05.000Z",
      updatedAt: "2026-01-02T03:04:05.000Z",
    };
    const fetchMock = vi.fn(async (...args: Parameters<typeof fetch>) => {
      const [input, init] = args;
      expect(String(input)).toBe(
        "http://localhost:4317/api/approvals/approval_123/approve",
      );
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({
        authorization: "Bearer runtime-token",
        "content-type": "application/json",
      });
      expect(init?.body).toBe(
        JSON.stringify({ payloadHash: "hash_hash_hash_hash" }),
      );
      return new Response(JSON.stringify(approval), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      decideApproval({
        approvalId: "approval_123",
        decision: "approve",
        payloadHash: "hash_hash_hash_hash",
      }),
    ).resolves.toEqual(approval);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("drains the Slack outbox with a bounded limit", async () => {
    const drain = { outbound: { attempted: 2, deliveries: [] } };
    const fetchMock = vi.fn(async (...args: Parameters<typeof fetch>) => {
      const [input, init] = args;
      expect(String(input)).toBe(
        "http://localhost:4317/api/outbound/slack/drain",
      );
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({ "content-type": "application/json" });
      expect(init?.body).toBe(JSON.stringify({ limit: 25 }));
      return new Response(JSON.stringify(drain), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(drainSlackOutbox({ limit: 25 })).resolves.toEqual(drain);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}
