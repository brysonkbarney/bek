import { serve } from "@hono/node-server";
import { createApp } from "./app";

const port = Number(process.env.BEK_API_PORT ?? 4317);

serve(
  {
    fetch: createApp().fetch,
    port,
  },
  (info) => {
    console.log(`Bek API listening on http://localhost:${info.port}`);
  },
);
