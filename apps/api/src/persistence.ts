import { BekStore, createSeedSnapshot } from "@bek/core";
import {
  createBekDbClient,
  DrizzleBekSnapshotRepository,
  DrizzleWorkerQueueRepository,
  seedBekSnapshot,
  type BekDbClient,
} from "@bek/db";
import type { WorkerSnapshot } from "@bek/worker";

export type BekApiStorageMode = "memory" | "postgres";
export type BekWorkerQueueBackend = "memory" | "postgres";

export interface BekApiStoreHandle {
  store: BekStore;
  storageMode: BekApiStorageMode;
  workerQueueBackend: BekWorkerQueueBackend;
  workerQueuePersistence?: BekWorkerQueuePersistence | undefined;
  close: () => Promise<void>;
}

export interface BekWorkerQueuePersistence {
  initialSnapshot: WorkerSnapshot;
  onSnapshotChanged: (snapshot: WorkerSnapshot) => Promise<void> | void;
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
      workerQueueBackend: selectWorkerQueueBackend(env, storageMode),
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

export function selectWorkerQueueBackend(
  env: Record<string, string | undefined>,
  storageMode = selectStorageMode(env),
): BekWorkerQueueBackend {
  const configured = env.BEK_WORKER_QUEUE_BACKEND?.trim().toLowerCase();
  const backend =
    configured ?? (storageMode === "postgres" ? "postgres" : "memory");
  if (backend === "memory" || backend === "postgres") {
    if (backend === "postgres" && storageMode !== "postgres") {
      throw new Error(
        "BEK_WORKER_QUEUE_BACKEND=postgres requires BEK_STORAGE=postgres or DATABASE_URL.",
      );
    }
    return backend;
  }
  throw new Error(
    "BEK_WORKER_QUEUE_BACKEND must be either memory or postgres.",
  );
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
  const workerQueueBackend = selectWorkerQueueBackend(env, "postgres");
  const workerQueuePersistence =
    workerQueueBackend === "postgres"
      ? await createPostgresWorkerQueuePersistence(client, orgId)
      : undefined;

  return {
    store,
    storageMode: "postgres",
    workerQueueBackend,
    workerQueuePersistence,
    close: async () => {
      await store.flushChanges();
      await client.close();
    },
  };
}

async function createPostgresWorkerQueuePersistence(
  client: BekDbClient,
  orgId: string,
): Promise<BekWorkerQueuePersistence> {
  const repository = new DrizzleWorkerQueueRepository(client.db);
  return {
    initialSnapshot: await repository.readSnapshot(orgId),
    onSnapshotChanged: (changedSnapshot) =>
      repository.saveSnapshot(orgId, changedSnapshot),
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
