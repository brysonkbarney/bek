import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adminAuthHeaders,
  cancelRunPath,
  clearAdminApiToken,
  drainSlackOutbox,
  discoverSlackChannels,
  fetchModelUsage,
  fetchSlackOutbox,
  hasStoredAdminToken,
  linkPrincipalExternalIdentity,
  redriveDeadLetterPath,
  readAdminApiToken,
  saveAdminApiToken,
  slackChannelDiscoveryPath,
  slackInstallStartPath,
  slackOutboxPath,
} from "./api";

describe("web API helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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
