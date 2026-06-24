import type {
  AccessBundle,
  ApprovalRequest,
  BekSnapshot,
  CapabilityGrant,
  ConnectorInstall,
  CredentialRecord,
  IngressDelivery,
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
  connectorInstalls,
  credentialMetadata,
  grants,
  ingressDeliveries,
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
  type ConnectorInstallRow,
  type CredentialMetadataRow,
  type GrantRow,
  type IngressDeliveryRow,
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
  | "metadata"
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
type ConnectorInstallSnapshotRow = Pick<
  ConnectorInstallRow,
  | "id"
  | "orgId"
  | "kind"
  | "provider"
  | "externalId"
  | "displayName"
  | "status"
  | "installedByPrincipalId"
  | "config"
  | "metadata"
  | "createdAt"
  | "updatedAt"
>;
type CredentialMetadataSnapshotRow = Pick<
  CredentialMetadataRow,
  | "id"
  | "orgId"
  | "connectorInstallId"
  | "name"
  | "provider"
  | "externalAccountId"
  | "secretRef"
  | "status"
  | "scopeSummary"
  | "metadata"
  | "expiresAt"
  | "rotationDueAt"
  | "lastUsedAt"
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
type IngressDeliverySnapshotRow = Pick<
  IngressDeliveryRow,
  | "id"
  | "orgId"
  | "provider"
  | "kind"
  | "key"
  | "status"
  | "runId"
  | "approvalId"
  | "response"
  | "createdAt"
  | "updatedAt"
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
  connectorInstalls: ConnectorInstallSnapshotRow[];
  credentials: CredentialMetadataSnapshotRow[];
  runs: RunSnapshotRow[];
  events: RunEventSnapshotRow[];
  approvals: ApprovalSnapshotRow[];
  ingressDeliveries: IngressDeliverySnapshotRow[];
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
      connectorInstallRows,
      credentialRows,
      runRows,
      eventRows,
      approvalRows,
      ingressDeliveryRows,
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
        .from(connectorInstalls)
        .where(eq(connectorInstalls.orgId, orgId))
        .orderBy(desc(connectorInstalls.updatedAt), asc(connectorInstalls.id)),
      this.db
        .select()
        .from(credentialMetadata)
        .where(eq(credentialMetadata.orgId, orgId))
        .orderBy(
          desc(credentialMetadata.updatedAt),
          asc(credentialMetadata.id),
        ),
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
      this.db
        .select()
        .from(ingressDeliveries)
        .where(eq(ingressDeliveries.orgId, orgId))
        .orderBy(desc(ingressDeliveries.createdAt), asc(ingressDeliveries.id)),
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
      connectorInstalls: connectorInstallRows,
      credentials: credentialRows,
      runs: runRows,
      events: eventRows,
      approvals: approvalRows,
      ingressDeliveries: ingressDeliveryRows,
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
      metadata: place.metadata ?? {},
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
    connectorInstalls: snapshot.connectorInstalls.map((install) => ({
      id: install.id,
      orgId: install.orgId,
      kind: install.kind,
      provider: install.provider,
      externalId: install.externalId ?? null,
      displayName: install.displayName,
      status: install.status,
      installedByPrincipalId: install.installedByPrincipalId ?? null,
      config: install.config ?? {},
      metadata: install.metadata ?? {},
      createdAt: toDate(install.createdAt),
      updatedAt: toDate(install.updatedAt),
    })),
    credentials: snapshot.credentials.map((credential) => ({
      id: credential.id,
      orgId: credential.orgId,
      connectorInstallId: credential.connectorInstallId ?? null,
      name: credential.name,
      provider: credential.provider,
      externalAccountId: credential.externalAccountId ?? null,
      secretRef: credential.secretRef,
      status: credential.status,
      scopeSummary: credential.scopeSummary,
      metadata: credential.metadata ?? {},
      expiresAt: credential.expiresAt ? toDate(credential.expiresAt) : null,
      rotationDueAt: credential.rotationDueAt
        ? toDate(credential.rotationDueAt)
        : null,
      lastUsedAt: credential.lastUsedAt ? toDate(credential.lastUsedAt) : null,
      createdAt: toDate(credential.createdAt),
      updatedAt: toDate(credential.updatedAt),
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
    ingressDeliveries: snapshot.ingressDeliveries.map((delivery) => ({
      id: delivery.id,
      orgId: delivery.orgId,
      provider: delivery.provider,
      kind: delivery.kind,
      key: delivery.key,
      status: delivery.status,
      runId: delivery.runId ?? null,
      approvalId: delivery.approvalId ?? null,
      response: delivery.response ?? {},
      createdAt: toDate(delivery.createdAt),
      updatedAt: toDate(delivery.updatedAt),
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
      ...(Object.keys(place.metadata ?? {}).length > 0
        ? { metadata: place.metadata }
        : {}),
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
    connectorInstalls: rows.connectorInstalls.map(connectorInstallFromRow),
    credentials: rows.credentials.map(credentialFromRow),
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
    ingressDeliveries: rows.ingressDeliveries.map(ingressDeliveryFromRow),
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
  await db.delete(ingressDeliveries).where(eq(ingressDeliveries.orgId, orgId));
  await db.delete(approvals).where(eq(approvals.orgId, orgId));
  await db.delete(runEvents).where(eq(runEvents.orgId, orgId));
  await db.delete(runs).where(eq(runs.orgId, orgId));
  await db
    .delete(credentialMetadata)
    .where(eq(credentialMetadata.orgId, orgId));
  await db.delete(connectorInstalls).where(eq(connectorInstalls.orgId, orgId));
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
  if (rows.connectorInstalls.length > 0) {
    await db.insert(connectorInstalls).values(rows.connectorInstalls);
  }
  if (rows.credentials.length > 0) {
    await db.insert(credentialMetadata).values(rows.credentials);
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
  if (rows.ingressDeliveries.length > 0) {
    await db.insert(ingressDeliveries).values(rows.ingressDeliveries);
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

function connectorInstallFromRow(
  row: ConnectorInstallSnapshotRow,
): ConnectorInstall {
  const install: ConnectorInstall = {
    id: row.id,
    orgId: row.orgId,
    kind: row.kind,
    provider: row.provider,
    displayName: row.displayName,
    status: row.status,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
  if (row.externalId) {
    install.externalId = row.externalId;
  }
  if (row.installedByPrincipalId) {
    install.installedByPrincipalId = row.installedByPrincipalId;
  }
  const config = nonEmptyRecord(row.config);
  if (config) {
    install.config = config;
  }
  const metadata = nonEmptyRecord(row.metadata);
  if (metadata) {
    install.metadata = metadata;
  }
  return install;
}

function credentialFromRow(
  row: CredentialMetadataSnapshotRow,
): CredentialRecord {
  const credential: CredentialRecord = {
    id: row.id,
    orgId: row.orgId,
    name: row.name,
    provider: row.provider,
    secretRef: row.secretRef,
    status: row.status,
    scopeSummary: row.scopeSummary,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
  if (row.connectorInstallId) {
    credential.connectorInstallId = row.connectorInstallId;
  }
  if (row.externalAccountId) {
    credential.externalAccountId = row.externalAccountId;
  }
  const metadata = nonEmptyRecord(row.metadata);
  if (metadata) {
    credential.metadata = metadata;
  }
  if (row.expiresAt) {
    credential.expiresAt = toIso(row.expiresAt);
  }
  if (row.rotationDueAt) {
    credential.rotationDueAt = toIso(row.rotationDueAt);
  }
  if (row.lastUsedAt) {
    credential.lastUsedAt = toIso(row.lastUsedAt);
  }
  return credential;
}

function ingressDeliveryFromRow(
  row: IngressDeliverySnapshotRow,
): IngressDelivery {
  const delivery: IngressDelivery = {
    id: row.id,
    orgId: row.orgId,
    provider: "slack",
    kind: row.kind as IngressDelivery["kind"],
    key: row.key,
    status: row.status as IngressDelivery["status"],
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
  if (row.runId) {
    delivery.runId = row.runId;
  }
  if (row.approvalId) {
    delivery.approvalId = row.approvalId;
  }
  const response = nonEmptyRecord(row.response);
  if (response) {
    delivery.response = response;
  }
  return delivery;
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
