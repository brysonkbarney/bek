import {
  BekStore,
  createSeedSnapshot,
  type AgentIdentityProfile,
} from "@bek/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";

// Memory is governed by the resolved agent identity: ACL-before-injection
// retrieval honors place + isolation boundaries, and tenant scoping applies.

const managedEnvKeys = [
  "BEK_ADMIN_API_TOKEN",
  "BEK_ALLOW_UNAUTHENTICATED_LOCAL",
  "BEK_SLACK_BACKGROUND_DRAIN",
] as const;
const originalEnv: Partial<Record<(typeof managedEnvKeys)[number], string>> =
  {};
for (const key of managedEnvKeys) {
  originalEnv[key] = process.env[key];
}
const ORG = "org_demo";

beforeEach(() => {
  process.env.BEK_ALLOW_UNAUTHENTICATED_LOCAL = "true";
  process.env.BEK_SLACK_BACKGROUND_DRAIN = "false";
  delete process.env.BEK_ADMIN_API_TOKEN;
});
afterEach(() => {
  for (const key of managedEnvKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

const json = { "content-type": "application/json" };

function appWith(identities?: AgentIdentityProfile[]) {
  const snapshot = createSeedSnapshot();
  if (identities) snapshot.agentIdentities = identities;
  return createApp(new BekStore(snapshot));
}

async function ingest(
  app: ReturnType<typeof createApp>,
  opts: { placeId?: string; text: string; hash: string },
) {
  const sourceRes = await app.request("/api/memory/sources", {
    method: "POST",
    headers: json,
    body: JSON.stringify({
      kind: "doc",
      sensitivity: "internal",
      contentHash: `src_${opts.hash}`,
      ...(opts.placeId ? { placeId: opts.placeId } : {}),
    }),
  });
  const source = (await sourceRes.json()) as { id: string };
  const chunkRes = await app.request("/api/memory/chunks", {
    method: "POST",
    headers: json,
    body: JSON.stringify({
      sourceId: source.id,
      chunks: [
        {
          contentHash: `chunk_${opts.hash}`,
          text: opts.text,
          citation: {
            sourceId: source.id,
            sourceKind: "doc",
            label: opts.hash,
          },
        },
      ],
    }),
  });
  return { sourceStatus: sourceRes.status, chunkStatus: chunkRes.status };
}

async function retrieve(app: ReturnType<typeof createApp>, placeId: string) {
  const res = await app.request(
    `/api/memory/retrieve?placeId=${encodeURIComponent(placeId)}`,
  );
  return {
    status: res.status,
    body: (await res.json()) as {
      isolated?: boolean;
      allowed?: Array<{ contentHash: string }>;
    },
  };
}

describe("memory API", () => {
  it("ingests sources + chunks and ACL-retrieves for a public place", async () => {
    const app = appWith();
    await ingest(app, { placeId: "place_checkout", text: "co", hash: "co" });
    await ingest(app, { placeId: "place_general", text: "gen", hash: "gen" });
    await ingest(app, { text: "workspace", hash: "ws" }); // no place = workspace

    const { status, body } = await retrieve(app, "place_checkout");
    expect(status).toBe(200);
    const hashes = (body.allowed ?? []).map((c) => c.contentHash).sort();
    // checkout (same place) + workspace (un-bound) allowed; general excluded.
    expect(hashes).toEqual(["chunk_co", "chunk_ws"]);
  });

  it("isolates a private channel from workspace memory", async () => {
    const app = appWith([
      {
        id: "id_base",
        orgId: ORG,
        scope: "workspace",
        name: "baseline",
        baseline: true,
        enabled: true,
        accessBundleIds: [],
      },
      {
        id: "id_co",
        orgId: ORG,
        scope: "private_channel",
        name: "checkout",
        enabled: true,
        placeId: "place_checkout",
        accessBundleIds: [],
      },
    ]);
    await ingest(app, {
      placeId: "place_checkout",
      text: "secret",
      hash: "co",
    });
    await ingest(app, { text: "workspace", hash: "ws" });

    const { body } = await retrieve(app, "place_checkout");
    expect(body.isolated).toBe(true);
    const hashes = (body.allowed ?? []).map((c) => c.contentHash);
    expect(hashes).toEqual(["chunk_co"]); // workspace chunk excluded by isolation
  });

  it("ranks ACL-allowed chunks by embedding similarity to a query", async () => {
    const app = appWith();
    await ingest(app, {
      placeId: "place_checkout",
      text: "how to process a customer refund for an order",
      hash: "refund",
    });
    await ingest(app, {
      placeId: "place_checkout",
      text: "kubernetes pod autoscaling configuration",
      hash: "k8s",
    });
    const res = await app.request(
      "/api/memory/retrieve?placeId=place_checkout&query=" +
        encodeURIComponent("customer refund request"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      query?: string;
      embedder?: string;
      allowed: Array<{ contentHash: string; score?: number }>;
    };
    expect(body.query).toBe("customer refund request");
    expect(body.embedder).toContain("deterministic");
    expect(body.allowed[0]?.contentHash).toBe("chunk_refund");
    expect(typeof body.allowed[0]?.score).toBe("number");
  });

  it("enforces tenant scoping on ingest + retrieve", async () => {
    const app = appWith();
    const foreignSource = await app.request("/api/memory/sources", {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        kind: "doc",
        sensitivity: "internal",
        contentHash: "x",
        placeId: "place_does_not_exist",
      }),
    });
    expect(foreignSource.status).toBe(404);

    const foreignRetrieve = await app.request(
      "/api/memory/retrieve?placeId=place_does_not_exist",
    );
    expect(foreignRetrieve.status).toBe(404);
  });
});
