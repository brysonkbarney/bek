import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  if (
    command === "build" &&
    mode === "production" &&
    env.VITE_BEK_ADMIN_API_TOKEN?.trim()
  ) {
    throw new Error(
      "VITE_BEK_ADMIN_API_TOKEN must not be set for production web builds. The admin console prompts for the token at runtime.",
    );
  }

  return {
    plugins: [react()],
    server: {
      port: Number(process.env.BEK_WEB_PORT ?? 5173),
    },
  };
});
