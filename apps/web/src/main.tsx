import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import React from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "./ui/AppShell";
import {
  AccessBundleDetailPage,
  AccessBundlesPage,
  ApprovalsPage,
  AuditPage,
  BudgetsPage,
  ChannelDetailPage,
  ChannelsPage,
  ConnectorsPage,
  HealthPage,
  IdentitiesPage,
  MemoryPage,
  ModelsPage,
  RunDetailPage,
  SetupPage,
} from "./ui/AdminPages";
import { DashboardPage } from "./ui/DashboardPage";
import { RunsPage } from "./ui/RunsPage";
import { SettingsPage } from "./ui/SettingsPage";
import { WorkerPage } from "./ui/WorkerPage";
import "./styles.css";

const rootRoute = createRootRoute({
  component: AppShell,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: DashboardPage,
});

const runsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runs",
  component: RunsPage,
});

const runDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runs/$runId",
  component: RunDetailPage,
});

const workerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/worker",
  component: WorkerPage,
});

const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/setup",
  component: SetupPage,
});

const channelsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/channels",
  component: ChannelsPage,
});

const channelDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/channels/$channelId",
  component: ChannelDetailPage,
});

const accessBundlesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/access-bundles",
  component: AccessBundlesPage,
});

const accessBundleDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/access-bundles/$bundleId",
  component: AccessBundleDetailPage,
});

const approvalsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/approvals",
  component: ApprovalsPage,
});

const connectorsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/connectors",
  component: ConnectorsPage,
});

const modelsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/models",
  component: ModelsPage,
});

const budgetsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/budgets",
  component: BudgetsPage,
});

const identitiesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/identities",
  component: IdentitiesPage,
});

const memoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/memory",
  component: MemoryPage,
});

const healthRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/health",
  component: HealthPage,
});

const auditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/audit",
  component: AuditPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  setupRoute,
  channelsRoute,
  channelDetailRoute,
  accessBundlesRoute,
  accessBundleDetailRoute,
  runsRoute,
  runDetailRoute,
  workerRoute,
  approvalsRoute,
  connectorsRoute,
  modelsRoute,
  budgetsRoute,
  identitiesRoute,
  memoryRoute,
  healthRoute,
  auditRoute,
  settingsRoute,
]);
const router = createRouter({ routeTree });
const queryClient = new QueryClient();

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
