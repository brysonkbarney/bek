import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const webRoot = fileURLToPath(new URL(".", import.meta.url));
const port = 5177;
const apiPort = Number(process.env.BEK_E2E_API_PORT ?? 4319);
const baseURL = `http://127.0.0.1:${port}`;
const apiURL = `http://127.0.0.1:${apiPort}`;

export default defineConfig({
  testDir: "./e2e",
  outputDir: "test-results",
  fullyParallel: true,
  reporter: "list",
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  webServer: [
    {
      command: [
        "env",
        "-u BEK_ADMIN_API_TOKEN",
        "-u DATABASE_URL",
        "-u GITHUB_APP_ID",
        "-u GITHUB_APP_PRIVATE_KEY",
        "-u GITHUB_APP_INSTALLATION_ID",
        "-u GITHUB_WEBHOOK_SECRET",
        "-u SLACK_BOT_TOKEN",
        `BEK_API_PORT=${apiPort}`,
        "BEK_ALLOW_UNAUTHENTICATED_LOCAL=true",
        "BEK_REQUIRE_ADMIN_AUTH=false",
        "BEK_STORAGE=memory",
        "BEK_WORKER_QUEUE_BACKEND=memory",
        "BEK_RUN_ADVANCEMENT=worker_local",
        "BEK_SLACK_BACKGROUND_DRAIN=false",
        "BEK_DEV_UNSIGNED_SLACK=false",
        "SLACK_SIGNING_SECRET=bek-e2e-slack-secret",
        "GITHUB_APP_WEBHOOK_SECRET=bek-e2e-github-secret",
        "pnpm --filter @bek/api start",
      ].join(" "),
      cwd: repoRoot,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      url: `${apiURL}/health`,
    },
    {
      command: `VITE_BEK_API_URL=${apiURL} pnpm exec vite --host 127.0.0.1 --port ${port} --strictPort`,
      cwd: webRoot,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      url: baseURL,
    },
  ],
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
