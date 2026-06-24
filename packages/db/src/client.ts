import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import * as schema from "./schema";

export type BekDbSchema = typeof schema;
export type BekDb = NodePgDatabase<BekDbSchema>;

export interface BekDbClient {
  db: BekDb;
  pool: Pool;
  close: () => Promise<void>;
}

export interface CreateBekDbClientOptions {
  databaseUrl?: string | undefined;
  pool?: Pool | undefined;
  poolConfig?: PoolConfig | undefined;
  logger?: boolean | undefined;
}

export function createBekDbClient(
  options: CreateBekDbClientOptions = {},
): BekDbClient {
  const connectionString =
    options.databaseUrl ?? options.poolConfig?.connectionString;
  const pool =
    options.pool ??
    new Pool({
      ...options.poolConfig,
      connectionString:
        connectionString ??
        (options.poolConfig ? undefined : requireDatabaseUrl()),
    });

  const db = drizzle(pool, {
    schema,
    logger: options.logger ?? false,
  });

  return {
    db,
    pool,
    close: () => pool.end(),
  };
}

export function requireDatabaseUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to create the Bek DB client.");
  }
  return databaseUrl;
}
