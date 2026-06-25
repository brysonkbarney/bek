import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { createApiStoreFromEnv } from "./persistence";

const port = Number(process.env.BEK_API_PORT ?? 4317);
const handle = await createApiStoreFromEnv();

serve(
  {
    fetch: createApp(handle.store, {
      workerQueuePersistence: handle.workerQueuePersistence,
      modelUsageRepository: handle.modelUsageRepository,
      readinessCheck: handle.readinessCheck,
    }).fetch,
    port,
  },
  (info) => {
    console.log(
      `Bek API listening on http://localhost:${info.port} (${handle.storageMode})`,
    );
  },
);

async function shutdown(signal: NodeJS.Signals) {
  console.log(`Bek API received ${signal}; flushing state.`);
  await handle.close();
  process.exit(0);
}

process.on("SIGINT", (signal) => {
  void shutdown(signal);
});
process.on("SIGTERM", (signal) => {
  void shutdown(signal);
});
