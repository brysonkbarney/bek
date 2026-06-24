import { createSeedSnapshot, type BekSnapshot } from "@bek/core";
import type { BekDb } from "./client";
import { DrizzleBekSnapshotRepository } from "./snapshot-repository";

export interface SeedBekSnapshotOptions {
  snapshot?: BekSnapshot | undefined;
  now?: Date | string | undefined;
}

export async function seedBekSnapshot(
  db: BekDb,
  options: SeedBekSnapshotOptions = {},
): Promise<BekSnapshot> {
  const now = options.now ?? new Date();
  const snapshot =
    options.snapshot ?? createSeedSnapshot(toIsoTimestamp(options.now ?? now));
  const repository = new DrizzleBekSnapshotRepository(db);

  await repository.saveSnapshot(snapshot);
  return snapshot;
}

function toIsoTimestamp(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}
