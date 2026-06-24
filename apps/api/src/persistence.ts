import { BekStore, createSeedSnapshot } from "@bek/core";
import {
  createBekDbClient,
  DrizzleBekSnapshotRepository,
  seedBekSnapshot,
  type BekDbClient,
} from "@bek/db";

export type BekApiStorageMode = "memory" | "postgres";

export interface BekApiStoreHandle {
  store: BekStore;
  storageMode: BekApiStorageMode;
  close: () => Promise<void>;
}

export async function createApiStoreFromEnv(
  env: Record<string, string | undefined> = process.env,
): Promise<BekApiStoreHandle> {
  const storageMode = selectStorageMode(env);
  if (storageMode === "memory") {
    const store = new BekStore();
    return {
      store,
      storageMode,
      close: () => store.flushChanges(),
    };
  }

  const client = createBekDbClient({
    databaseUrl: env.DATABASE_URL,
    logger: env.BEK_DB_LOGGER === "true",
  });

  try {
    return await createPostgresStoreHandle(client, env);
  } catch (error) {
    await client.close();
    throw error;
  }
}

export function selectStorageMode(
  env: Record<string, string | undefined>,
): BekApiStorageMode {
  const configured = env.BEK_STORAGE?.trim().toLowerCase();
  if (!configured) {
    return env.DATABASE_URL ? "postgres" : "memory";
  }
  if (configured === "memory" || configured === "postgres") {
    return configured;
  }
  throw new Error("BEK_STORAGE must be either memory or postgres.");
}

async function createPostgresStoreHandle(
  client: BekDbClient,
  env: Record<string, string | undefined>,
): Promise<BekApiStoreHandle> {
  const orgId = env.BEK_ORG_ID ?? "org_demo";
  const repository = new DrizzleBekSnapshotRepository(client.db);
  const existingSnapshot = await repository.readSnapshot(orgId);
  const snapshot =
    existingSnapshot ??
    (await seedDefaultSnapshot({
      env,
      orgId,
      repository,
      client,
    }));

  const store = new BekStore(snapshot, {
    onSnapshotChanged: (changedSnapshot) =>
      repository.saveSnapshot(changedSnapshot),
  });

  return {
    store,
    storageMode: "postgres",
    close: async () => {
      await store.flushChanges();
      await client.close();
    },
  };
}

async function seedDefaultSnapshot(input: {
  env: Record<string, string | undefined>;
  orgId: string;
  repository: DrizzleBekSnapshotRepository;
  client: BekDbClient;
}) {
  if (input.env.BEK_DB_AUTO_SEED === "false") {
    throw new Error(
      `No Bek snapshot found for ${input.orgId}. Run pnpm db:seed or enable BEK_DB_AUTO_SEED.`,
    );
  }

  const snapshot = createSeedSnapshot();
  if (snapshot.org.id !== input.orgId) {
    throw new Error(
      `BEK_ORG_ID=${input.orgId} requires a pre-seeded database snapshot.`,
    );
  }

  await seedBekSnapshot(input.client.db, { snapshot });
  const seeded = await input.repository.readSnapshot(input.orgId);
  if (!seeded) {
    throw new Error(`Bek failed to seed ${input.orgId}.`);
  }
  return seeded;
}
