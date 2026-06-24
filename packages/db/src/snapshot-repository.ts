import type {
  AccessBundle,
  ApprovalRequest,
  BekSnapshot,
  CapabilityGrant,
  Principal,
  RunEvent,
} from "@bek/core";
import { asc, desc, eq } from "drizzle-orm";
import type { BekDb } from "./client";
import {
  accessBundlePlaces,
  accessBundles,
  agents,
  approvals,
  budgetPolicies,
  capabilityProfiles,
  grants,
  modelPolicies,
  orgs,
  places,
  principals,
  runEvents,
  runtimeProfiles,
  runs,
  type AccessBundlePlaceRow,
  type AccessBundleRow,
  type AgentRow,
  type ApprovalRow,
  type BudgetPolicyRow,
  type CapabilityProfileRow,
  type GrantRow,
  type ModelPolicyRow,
  type OrganizationRow,
  type PlaceRow,
  type PrincipalRow,
  type RunEventRow,
  type RunRow,
  type RuntimeProfileRow,
} from "./schema";

type MutationDb = Pick<BekDb, "delete" | "insert">;

type OrgSnapshotRow = Pick<
  OrganizationRow,
  "id" | "name" | "slug" | "plan" | "primaryAgentId" | "createdAt" | "updatedAt"
>;
type PrincipalSnapshotRow = Pick<
  PrincipalRow,
  "id" | "orgId" | "kind" | "displayName" | "email" | "createdAt" | "updatedAt"
>;
type AgentSnapshotRow = Pick<
  AgentRow,
  | "id"
  | "orgId"
  | "principalId"
  | "name"
  | "handle"
  | "description"
  | "status"
  | "defaultModelPolicyId"
  | "defaultRuntimeProfileId"
  | "createdAt"
  | "updatedAt"
>;
type CapabilityProfileSnapshotRow = Pick<
  CapabilityProfileRow,
  | "id"
  | "orgId"
  | "agentId"
  | "name"
  | "capabilityKind"
  | "runtimeProfileId"
  | "modelPolicyId"
  | "enabled"
  | "createdAt"
  | "updatedAt"
>;
type PlaceSnapshotRow = Pick<
  PlaceRow,
  | "id"
  | "orgId"
  | "kind"
  | "provider"
  | "externalId"
  | "name"
  | "sensitivity"
  | "createdAt"
  | "updatedAt"
>;
type AccessBundleSnapshotRow = Pick<
  AccessBundleRow,
  | "id"
  | "orgId"
  | "name"
  | "description"
  | "budgetPolicyId"
  | "createdAt"
  | "updatedAt"
>;
type AccessBundlePlaceSnapshotRow = Pick<
  AccessBundlePlaceRow,
  "orgId" | "accessBundleId" | "placeId" | "createdAt"
>;
type GrantSnapshotRow = Pick<
  GrantRow,
  | "id"
  | "orgId"
  | "accessBundleId"
  | "capability"
  | "resource"
  | "decision"
  | "risk"
  | "requiresApproval"
  | "createdAt"
  | "updatedAt"
>;
type ModelPolicySnapshotRow = Pick<
  ModelPolicyRow,
  | "id"
  | "orgId"
  | "name"
  | "defaultModel"
  | "fallbackModels"
  | "perRunBudgetCents"
  | "createdAt"
  | "updatedAt"
>;
type RuntimeProfileSnapshotRow = Pick<
  RuntimeProfileRow,
  | "id"
  | "orgId"
  | "name"
  | "runtimeKind"
  | "adapter"
  | "createdAt"
  | "updatedAt"
>;
type BudgetPolicySnapshotRow = Pick<
  BudgetPolicyRow,
  | "id"
  | "orgId"
  | "name"
  | "perRunCents"
  | "perDayCents"
  | "createdAt"
  | "updatedAt"
>;
type RunSnapshotRow = Pick<
  RunRow,
  | "id"
  | "orgId"
  | "agentId"
  | "requesterPrincipalId"
  | "placeScopeId"
  | "trigger"
  | "prompt"
  | "status"
  | "modelPolicyId"
  | "runtimeProfileId"
  | "estimatedCostCents"
  | "actualCostCents"
  | "createdAt"
  | "updatedAt"
>;
type RunEventSnapshotRow = Pick<
  RunEventRow,
  "id" | "orgId" | "runId" | "type" | "message" | "data" | "createdAt"
>;
type ApprovalSnapshotRow = Pick<
  ApprovalRow,
  | "id"
  | "orgId"
  | "runId"
  | "action"
  | "risk"
  | "status"
  | "payloadHash"
  | "requestedByPrincipalId"
  | "decidedByPrincipalId"
  | "createdAt"
  | "expiresAt"
  | "decidedAt"
>;

export interface BekSnapshotRows {
  org: OrgSnapshotRow;
  principals: PrincipalSnapshotRow[];
  agents: AgentSnapshotRow[];
  capabilityProfiles: CapabilityProfileSnapshotRow[];
  places: PlaceSnapshotRow[];
  accessBundles: AccessBundleSnapshotRow[];
  accessBundlePlaces: AccessBundlePlaceSnapshotRow[];
  grants: GrantSnapshotRow[];
  modelPolicies: ModelPolicySnapshotRow[];
  runtimeProfiles: RuntimeProfileSnapshotRow[];
  budgetPolicies: BudgetPolicySnapshotRow[];
  runs: RunSnapshotRow[];
  events: RunEventSnapshotRow[];
  approvals: ApprovalSnapshotRow[];
}

export interface BekSnapshotRepository {
  readSnapshot(orgId: string): Promise<BekSnapshot | null>;
  saveSnapshot(snapshot: BekSnapshot): Promise<void>;
}

export class DrizzleBekSnapshotRepository implements BekSnapshotRepository {
  constructor(private readonly db: BekDb) {}

  async readSnapshot(orgId: string): Promise<BekSnapshot | null> {
    const [org] = await this.db
      .select()
      .from(orgs)
      .where(eq(orgs.id, orgId))
      .limit(1);

    if (!org) {
      return null;
    }

    const [
      principalRows,
      agentRows,
      capabilityProfileRows,
      placeRows,
      accessBundleRows,
      accessBundlePlaceRows,
      grantRows,
      modelPolicyRows,
      runtimeProfileRows,
      budgetPolicyRows,
      runRows,
      eventRows,
      approvalRows,
    ] = await Promise.all([
      this.db
        .select()
        .from(principals)
        .where(eq(principals.orgId, orgId))
        .orderBy(asc(principals.id)),
      this.db
        .select()
        .from(agents)
        .where(eq(agents.orgId, orgId))
        .orderBy(asc(agents.id)),
      this.db
        .select()
        .from(capabilityProfiles)
        .where(eq(capabilityProfiles.orgId, orgId))
        .orderBy(asc(capabilityProfiles.id)),
      this.db
        .select()
        .from(places)
        .where(eq(places.orgId, orgId))
        .orderBy(asc(places.id)),
      this.db
        .select()
        .from(accessBundles)
        .where(eq(accessBundles.orgId, orgId))
        .orderBy(asc(accessBundles.id)),
      this.db
        .select()
        .from(accessBundlePlaces)
        .where(eq(accessBundlePlaces.orgId, orgId))
        .orderBy(
          asc(accessBundlePlaces.accessBundleId),
          asc(accessBundlePlaces.placeId),
        ),
      this.db
        .select()
        .from(grants)
        .where(eq(grants.orgId, orgId))
        .orderBy(asc(grants.accessBundleId), asc(grants.id)),
      this.db
        .select()
        .from(modelPolicies)
        .where(eq(modelPolicies.orgId, orgId))
        .orderBy(asc(modelPolicies.id)),
      this.db
        .select()
        .from(runtimeProfiles)
        .where(eq(runtimeProfiles.orgId, orgId))
        .orderBy(asc(runtimeProfiles.id)),
      this.db
        .select()
        .from(budgetPolicies)
        .where(eq(budgetPolicies.orgId, orgId))
        .orderBy(asc(budgetPolicies.id)),
      this.db
        .select()
        .from(runs)
        .where(eq(runs.orgId, orgId))
        .orderBy(desc(runs.createdAt), asc(runs.id)),
      this.db
        .select()
        .from(runEvents)
        .where(eq(runEvents.orgId, orgId))
        .orderBy(desc(runEvents.createdAt), asc(runEvents.id)),
      this.db
        .select()
        .from(approvals)
        .where(eq(approvals.orgId, orgId))
        .orderBy(desc(approvals.createdAt), asc(approvals.id)),
    ]);

    return rowsToSnapshot({
      org,
      principals: principalRows,
      agents: agentRows,
      capabilityProfiles: capabilityProfileRows,
      places: placeRows,
      accessBundles: accessBundleRows,
      accessBundlePlaces: accessBundlePlaceRows,
      grants: grantRows,
      modelPolicies: modelPolicyRows,
      runtimeProfiles: runtimeProfileRows,
      budgetPolicies: budgetPolicyRows,
      runs: runRows,
      events: eventRows,
      approvals: approvalRows,
    });
  }

  async saveSnapshot(snapshot: BekSnapshot): Promise<void> {
    const rows = snapshotToRows(snapshot);

    await this.db.transaction(async (tx) => {
      const db = tx as MutationDb;
      await deleteCurrentSnapshotRows(db, snapshot.org.id);
      await upsertOrgRow(db, rows.org);
      await insertSnapshotRows(db, rows);
    });
  }
}

export function snapshotToRows(
  snapshot: BekSnapshot,
  rowTimestamp: Date | string = new Date(),
): BekSnapshotRows {
  assertWritableSnapshot(snapshot);

  const now = toDate(rowTimestamp);

  return {
    org: {
      ...snapshot.org,
      createdAt: now,
      updatedAt: now,
    },
    principals: snapshot.principals.map((principal) => ({
      id: principal.id,
      orgId: principal.orgId,
      kind: principal.kind,
      displayName: principal.displayName,
      email: principal.email ?? null,
      createdAt: now,
      updatedAt: now,
    })),
    agents: [
      {
        ...snapshot.agent,
        createdAt: now,
        updatedAt: now,
      },
    ],
    capabilityProfiles: snapshot.capabilityProfiles.map((profile) => ({
      ...profile,
      createdAt: now,
      updatedAt: now,
    })),
    places: snapshot.places.map((place) => ({
      ...place,
      createdAt: now,
      updatedAt: now,
    })),
    accessBundles: snapshot.accessBundles.map((bundle) => ({
      id: bundle.id,
      orgId: bundle.orgId,
      name: bundle.name,
      description: bundle.description,
      budgetPolicyId: bundle.budgetPolicyId,
      createdAt: now,
      updatedAt: now,
    })),
    accessBundlePlaces: snapshot.accessBundles.flatMap((bundle) =>
      bundle.attachedPlaceIds.map((placeId) => ({
        orgId: bundle.orgId,
        accessBundleId: bundle.id,
        placeId,
        createdAt: now,
      })),
    ),
    grants: snapshot.accessBundles.flatMap((bundle) =>
      bundle.grants.map((grant) => ({
        id: grant.id,
        orgId: bundle.orgId,
        accessBundleId: bundle.id,
        capability: grant.capability,
        resource: grant.resource,
        decision: grant.decision,
        risk: grant.risk,
        requiresApproval: grant.requiresApproval,
        createdAt: now,
        updatedAt: now,
      })),
    ),
    modelPolicies: snapshot.modelPolicies.map((policy) => ({
      ...policy,
      createdAt: now,
      updatedAt: now,
    })),
    runtimeProfiles: snapshot.runtimeProfiles.map((profile) => ({
      ...profile,
      createdAt: now,
      updatedAt: now,
    })),
    budgetPolicies: snapshot.budgetPolicies.map((policy) => ({
      ...policy,
      createdAt: now,
      updatedAt: now,
    })),
    runs: snapshot.runs.map((run) => ({
      ...run,
      createdAt: toDate(run.createdAt),
      updatedAt: toDate(run.updatedAt),
    })),
    events: snapshot.events.map((event) => ({
      id: event.id,
      orgId: event.orgId,
      runId: event.runId,
      type: event.type,
      message: event.message,
      data: event.data ?? {},
      createdAt: toDate(event.createdAt),
    })),
    approvals: snapshot.approvals.map((approval) => ({
      id: approval.id,
      orgId: approval.orgId,
      runId: approval.runId,
      action: approval.action,
      risk: approval.risk,
      status: approval.status,
      payloadHash: approval.payloadHash,
      requestedByPrincipalId: approval.requestedByPrincipalId,
      decidedByPrincipalId: approval.decidedByPrincipalId ?? null,
      createdAt: toDate(approval.createdAt),
      expiresAt: toDate(approval.expiresAt),
      decidedAt: approval.decidedAt ? toDate(approval.decidedAt) : null,
    })),
  };
}

export function rowsToSnapshot(rows: BekSnapshotRows): BekSnapshot {
  const [agent] = rows.agents;
  if (!agent) {
    throw new Error(`Bek snapshot for ${rows.org.id} has no agent row.`);
  }
  if (rows.agents.length !== 1 || agent.handle !== "@bek") {
    throw new Error(
      `Bek snapshot for ${rows.org.id} must expose exactly one @bek agent.`,
    );
  }
  if (rows.org.primaryAgentId !== agent.id) {
    throw new Error(
      `Bek snapshot for ${rows.org.id} points at ${rows.org.primaryAgentId}, not ${agent.id}.`,
    );
  }

  return {
    org: {
      id: rows.org.id,
      name: rows.org.name,
      slug: rows.org.slug,
      plan: rows.org.plan,
      primaryAgentId: rows.org.primaryAgentId,
    },
    principals: rows.principals.map(principalFromRow),
    agent: {
      id: agent.id,
      orgId: agent.orgId,
      principalId: agent.principalId,
      name: agent.name,
      handle: agent.handle,
      description: agent.description,
      status: agent.status,
      defaultModelPolicyId: agent.defaultModelPolicyId,
      defaultRuntimeProfileId: agent.defaultRuntimeProfileId,
    },
    capabilityProfiles: rows.capabilityProfiles.map((profile) => ({
      id: profile.id,
      orgId: profile.orgId,
      agentId: profile.agentId,
      name: profile.name,
      capabilityKind: profile.capabilityKind,
      runtimeProfileId: profile.runtimeProfileId,
      modelPolicyId: profile.modelPolicyId,
      enabled: profile.enabled,
    })),
    places: rows.places.map((place) => ({
      id: place.id,
      orgId: place.orgId,
      kind: place.kind,
      provider: place.provider,
      externalId: place.externalId,
      name: place.name,
      sensitivity: place.sensitivity,
    })),
    accessBundles: accessBundlesFromRows(rows),
    modelPolicies: rows.modelPolicies.map((policy) => ({
      id: policy.id,
      orgId: policy.orgId,
      name: policy.name,
      defaultModel: policy.defaultModel,
      fallbackModels: policy.fallbackModels,
      perRunBudgetCents: policy.perRunBudgetCents,
    })),
    runtimeProfiles: rows.runtimeProfiles.map((profile) => ({
      id: profile.id,
      orgId: profile.orgId,
      name: profile.name,
      runtimeKind: profile.runtimeKind,
      adapter: profile.adapter,
    })),
    budgetPolicies: rows.budgetPolicies.map((policy) => ({
      id: policy.id,
      orgId: policy.orgId,
      name: policy.name,
      perRunCents: policy.perRunCents,
      perDayCents: policy.perDayCents,
    })),
    runs: rows.runs.map((run) => ({
      id: run.id,
      orgId: run.orgId,
      agentId: run.agentId,
      requesterPrincipalId: run.requesterPrincipalId,
      placeScopeId: run.placeScopeId,
      trigger: run.trigger,
      prompt: run.prompt,
      status: run.status,
      modelPolicyId: run.modelPolicyId,
      runtimeProfileId: run.runtimeProfileId,
      estimatedCostCents: run.estimatedCostCents,
      actualCostCents: run.actualCostCents,
      createdAt: toIso(run.createdAt),
      updatedAt: toIso(run.updatedAt),
    })),
    events: rows.events.map(eventFromRow),
    approvals: rows.approvals.map(approvalFromRow),
  };
}

function assertWritableSnapshot(snapshot: BekSnapshot) {
  if (snapshot.agent.handle !== "@bek") {
    throw new Error("Bek snapshots must persist a single visible @bek agent.");
  }
  if (snapshot.org.primaryAgentId !== snapshot.agent.id) {
    throw new Error(
      `Bek org ${snapshot.org.id} primaryAgentId must point at the visible @bek agent.`,
    );
  }
}

async function deleteCurrentSnapshotRows(db: MutationDb, orgId: string) {
  await db.delete(approvals).where(eq(approvals.orgId, orgId));
  await db.delete(runEvents).where(eq(runEvents.orgId, orgId));
  await db.delete(runs).where(eq(runs.orgId, orgId));
  await db.delete(grants).where(eq(grants.orgId, orgId));
  await db
    .delete(accessBundlePlaces)
    .where(eq(accessBundlePlaces.orgId, orgId));
  await db
    .delete(capabilityProfiles)
    .where(eq(capabilityProfiles.orgId, orgId));
  await db.delete(agents).where(eq(agents.orgId, orgId));
  await db.delete(accessBundles).where(eq(accessBundles.orgId, orgId));
  await db.delete(places).where(eq(places.orgId, orgId));
  await db.delete(budgetPolicies).where(eq(budgetPolicies.orgId, orgId));
  await db.delete(runtimeProfiles).where(eq(runtimeProfiles.orgId, orgId));
  await db.delete(modelPolicies).where(eq(modelPolicies.orgId, orgId));
  await db.delete(principals).where(eq(principals.orgId, orgId));
}

async function upsertOrgRow(db: MutationDb, org: OrgSnapshotRow) {
  await db
    .insert(orgs)
    .values(org)
    .onConflictDoUpdate({
      target: orgs.id,
      set: {
        name: org.name,
        slug: org.slug,
        plan: org.plan,
        primaryAgentId: org.primaryAgentId,
        updatedAt: org.updatedAt,
      },
    });
}

async function insertSnapshotRows(db: MutationDb, rows: BekSnapshotRows) {
  if (rows.principals.length > 0) {
    await db.insert(principals).values(rows.principals);
  }
  if (rows.modelPolicies.length > 0) {
    await db.insert(modelPolicies).values(rows.modelPolicies);
  }
  if (rows.runtimeProfiles.length > 0) {
    await db.insert(runtimeProfiles).values(rows.runtimeProfiles);
  }
  if (rows.budgetPolicies.length > 0) {
    await db.insert(budgetPolicies).values(rows.budgetPolicies);
  }
  if (rows.agents.length > 0) {
    await db.insert(agents).values(rows.agents);
  }
  if (rows.capabilityProfiles.length > 0) {
    await db.insert(capabilityProfiles).values(rows.capabilityProfiles);
  }
  if (rows.places.length > 0) {
    await db.insert(places).values(rows.places);
  }
  if (rows.accessBundles.length > 0) {
    await db.insert(accessBundles).values(rows.accessBundles);
  }
  if (rows.accessBundlePlaces.length > 0) {
    await db.insert(accessBundlePlaces).values(rows.accessBundlePlaces);
  }
  if (rows.grants.length > 0) {
    await db.insert(grants).values(rows.grants);
  }
  if (rows.runs.length > 0) {
    await db.insert(runs).values(rows.runs);
  }
  if (rows.events.length > 0) {
    await db.insert(runEvents).values(rows.events);
  }
  if (rows.approvals.length > 0) {
    await db.insert(approvals).values(rows.approvals);
  }
}

function principalFromRow(row: PrincipalSnapshotRow): Principal {
  const principal: Principal = {
    id: row.id,
    orgId: row.orgId,
    kind: row.kind,
    displayName: row.displayName,
  };
  if (row.email) {
    principal.email = row.email;
  }
  return principal;
}

function accessBundlesFromRows(rows: BekSnapshotRows): AccessBundle[] {
  const placesByBundle = new Map<string, string[]>();
  const grantsByBundle = new Map<string, CapabilityGrant[]>();

  for (const row of rows.accessBundlePlaces) {
    const placeIds = placesByBundle.get(row.accessBundleId) ?? [];
    placeIds.push(row.placeId);
    placesByBundle.set(row.accessBundleId, placeIds);
  }

  for (const row of rows.grants) {
    const bundleGrants = grantsByBundle.get(row.accessBundleId) ?? [];
    bundleGrants.push({
      id: row.id,
      capability: row.capability,
      resource: row.resource,
      decision: row.decision,
      risk: row.risk,
      requiresApproval: row.requiresApproval,
    });
    grantsByBundle.set(row.accessBundleId, bundleGrants);
  }

  return rows.accessBundles.map((bundle) => ({
    id: bundle.id,
    orgId: bundle.orgId,
    name: bundle.name,
    description: bundle.description,
    attachedPlaceIds: placesByBundle.get(bundle.id) ?? [],
    grants: grantsByBundle.get(bundle.id) ?? [],
    budgetPolicyId: bundle.budgetPolicyId,
  }));
}

function eventFromRow(row: RunEventSnapshotRow): RunEvent {
  const event: RunEvent = {
    id: row.id,
    orgId: row.orgId,
    runId: row.runId,
    type: row.type,
    message: row.message,
    createdAt: toIso(row.createdAt),
  };
  const data = nonEmptyRecord(row.data);
  if (data) {
    event.data = data;
  }
  return event;
}

function approvalFromRow(row: ApprovalSnapshotRow): ApprovalRequest {
  const approval: ApprovalRequest = {
    id: row.id,
    orgId: row.orgId,
    runId: row.runId,
    action: row.action,
    risk: row.risk,
    status: row.status,
    payloadHash: row.payloadHash,
    requestedByPrincipalId: row.requestedByPrincipalId,
    createdAt: toIso(row.createdAt),
    expiresAt: toIso(row.expiresAt),
  };

  if (row.decidedByPrincipalId) {
    approval.decidedByPrincipalId = row.decidedByPrincipalId;
  }
  if (row.decidedAt) {
    approval.decidedAt = toIso(row.decidedAt);
  }

  return approval;
}

function nonEmptyRecord(
  value: Record<string, unknown> | null,
): Record<string, unknown> | undefined {
  if (!value || Object.keys(value).length === 0) {
    return undefined;
  }
  return value;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? new Date(value) : new Date(value);
}

function toIso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}
