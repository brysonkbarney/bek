import { pathToFileURL } from "node:url";
import { BekStore, createSeedSnapshot } from "@bek/core";
import { createRunWorkItem } from "@bek/runtime";
import {
  InMemoryWorkerQueue,
  WorkerRuntimeService,
  createDeterministicLocalRuntimeAdapters,
  createSequentialIdFactory,
} from "./index";

export interface LocalWorkerRunnerOptions {
  prompt?: string | undefined;
  now?: string | undefined;
  maxItems?: number | undefined;
}

export async function runLocalWorker(
  options: LocalWorkerRunnerOptions = {},
): Promise<{
  runId: string;
  processed: number;
  stoppedReason: string;
  queue: ReturnType<InMemoryWorkerQueue["read"]>;
}> {
  const now = options.now ?? new Date().toISOString();
  const store = new BekStore(createSeedSnapshot(now));
  const snapshot = store.read();
  const place = snapshot.places[0];
  if (!place) {
    throw new Error("Seed snapshot is missing a place.");
  }

  const run = store.createRun({
    prompt: options.prompt ?? "@bek run the local worker smoke test",
    placeScopeId: place.id,
    trigger: "api",
  });

  const queue = new InMemoryWorkerQueue({
    idFactory: createSequentialIdFactory(),
    now: () => now,
  });
  queue.enqueue({
    item: createRunWorkItem({
      orgId: run.orgId,
      runId: run.id,
      reason: "new_run",
      traceId: "trace_local_worker",
      now,
    }),
    now,
  });

  const service = new WorkerRuntimeService({
    queue,
    state: () => store.read(),
    adapters: createDeterministicLocalRuntimeAdapters(),
    workerId: "worker_local_runner",
    now: () => now,
  });
  const drain = await service.drain({ maxItems: options.maxItems ?? 10, now });

  return {
    runId: run.id,
    processed: drain.processed,
    stoppedReason: drain.stoppedReason,
    queue: queue.read(),
  };
}

async function main(): Promise<void> {
  const result = await runLocalWorker({
    prompt: process.env.BEK_LOCAL_WORKER_PROMPT,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const entrypoint = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;

if (entrypoint === import.meta.url) {
  await main();
}
