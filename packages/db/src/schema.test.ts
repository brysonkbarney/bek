import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  accessBundlePlaces,
  accessBundles,
  agents,
  approvals,
  connectorInstalls,
  credentialMetadata,
  grants,
  ingressDeliveries,
  orgs,
  principals,
  runEvents,
  runs,
  workerDeadLetters,
  workerEvents,
  workerWorkRecords,
} from "./schema";

describe("Bek schema", () => {
  it("keeps one visible @bek agent per org", () => {
    const config = getTableConfig(agents);

    expect(config.name).toBe("agents");
    expect(config.indexes.map((index) => index.config.name)).toContain(
      "agents_one_visible_agent_per_org",
    );
    expect(config.checks.map((check) => check.name)).toContain(
      "agents_handle_is_bek",
    );
    expect(
      config.columns.find((column) => column.name === "handle")?.notNull,
    ).toBe(true);
  });

  it("declares the current snapshot tables without requiring a database", () => {
    const tableNames = [
      orgs,
      principals,
      agents,
      accessBundles,
      accessBundlePlaces,
      grants,
      runs,
      runEvents,
      approvals,
      ingressDeliveries,
      connectorInstalls,
      credentialMetadata,
      workerWorkRecords,
      workerDeadLetters,
      workerEvents,
    ].map((table) => getTableConfig(table).name);

    expect(tableNames).toEqual([
      "orgs",
      "principals",
      "agents",
      "access_bundles",
      "access_bundle_places",
      "grants",
      "runs",
      "run_events",
      "approvals",
      "ingress_deliveries",
      "connector_installs",
      "credential_metadata",
      "worker_work_records",
      "worker_dead_letters",
      "worker_events",
    ]);
  });

  it("indexes the runtime tables by org and workflow identifiers", () => {
    expect(indexNames(runs)).toEqual(
      expect.arrayContaining([
        "runs_org_created_idx",
        "runs_org_status_idx",
        "runs_place_created_idx",
      ]),
    );
    expect(indexNames(runEvents)).toContain("run_events_run_created_idx");
    expect(indexNames(approvals)).toContain("approvals_org_status_idx");
    expect(indexNames(ingressDeliveries)).toContain(
      "ingress_deliveries_org_key_unique",
    );
    expect(indexNames(workerWorkRecords)).toEqual(
      expect.arrayContaining([
        "worker_work_records_claim_idx",
        "worker_work_records_active_idempotency_unique",
        "worker_work_records_lease_expiry_idx",
        "worker_work_records_org_run_idx",
      ]),
    );
    expect(indexNames(workerDeadLetters)).toContain(
      "worker_dead_letters_org_failed_idx",
    );
    expect(indexNames(workerEvents)).toContain(
      "worker_events_org_run_created_idx",
    );
  });
});

function indexNames(table: Parameters<typeof getTableConfig>[0]): string[] {
  return getTableConfig(table).indexes.map((index) => index.config.name);
}
