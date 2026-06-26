import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  accessBundlePlaces,
  accessBundles,
  agentIdentityProfileBindings,
  agentIdentityProfiles,
  agents,
  approvals,
  memoryChunks,
  memorySources,
  connectorInstalls,
  credentialMetadata,
  grants,
  ingressDeliveries,
  orgs,
  outboundDeliveries,
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
      outboundDeliveries,
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
      "outbound_deliveries",
      "connector_installs",
      "credential_metadata",
      "worker_work_records",
      "worker_dead_letters",
      "worker_events",
    ]);
  });

  it("declares first-class agent identity tables distinct from the visible agent", () => {
    expect(getTableConfig(agentIdentityProfiles).name).toBe("agent_identities");
    expect(getTableConfig(agentIdentityProfileBindings).name).toBe(
      "agent_identity_bindings",
    );
    // At most one workspace baseline identity per org.
    expect(indexNames(agentIdentityProfiles)).toContain(
      "agent_identities_org_baseline_unique",
    );
    // A place can bind a given identity at most once.
    expect(indexNames(agentIdentityProfileBindings)).toContain(
      "agent_identity_bindings_place_identity_unique",
    );
  });

  it("declares the memory source registry + chunk store tables", () => {
    expect(getTableConfig(memorySources).name).toBe("memory_sources");
    expect(getTableConfig(memoryChunks).name).toBe("memory_chunks");
    expect(indexNames(memorySources)).toContain(
      "memory_sources_org_content_unique",
    );
    expect(indexNames(memoryChunks)).toContain("memory_chunks_org_place_idx");
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
    expect(indexNames(outboundDeliveries)).toEqual(
      expect.arrayContaining([
        "outbound_deliveries_org_key_unique",
        "outbound_deliveries_due_idx",
        "outbound_deliveries_run_idx",
      ]),
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
