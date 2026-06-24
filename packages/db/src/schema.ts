import {
  relations,
  sql,
  type InferInsertModel,
  type InferSelectModel,
} from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const jsonObject = <
  T extends Record<string, unknown> = Record<string, unknown>,
>(
  name: string,
) =>
  jsonb(name)
    .$type<T>()
    .notNull()
    .default(sql`'{}'::jsonb`);

export const organizationPlanEnum = pgEnum("organization_plan", [
  "oss",
  "team",
  "enterprise",
]);
export const principalKindEnum = pgEnum("principal_kind", [
  "human",
  "agent",
  "service_account",
  "integration",
  "system",
]);
export const agentStatusEnum = pgEnum("agent_status", [
  "active",
  "paused",
  "disabled",
]);
export const capabilityProfileKindEnum = pgEnum("capability_profile_kind", [
  "answer",
  "coding",
  "incident",
  "support",
  "data",
  "workflow",
]);
export const capabilityKindEnum = pgEnum("capability_kind", [
  "slack.read",
  "slack.write",
  "github.read",
  "github.branch",
  "github.pr",
  "linear.read",
  "linear.write",
  "mcp.tool",
  "sandbox.exec",
  "model.call",
]);
export const riskLevelEnum = pgEnum("risk_level", [
  "read_internal",
  "write_draft",
  "write_external",
  "privileged",
]);
export const decisionEnum = pgEnum("policy_decision", ["allow", "ask", "deny"]);
export const placeKindEnum = pgEnum("place_kind", [
  "slack_channel",
  "slack_dm",
  "github_repo",
  "project",
  "system",
]);
export const placeProviderEnum = pgEnum("place_provider", [
  "slack",
  "github",
  "system",
]);
export const placeSensitivityEnum = pgEnum("place_sensitivity", [
  "public",
  "internal",
  "confidential",
  "restricted",
]);
export const runtimeKindEnum = pgEnum("runtime_kind", [
  "ai_sdk",
  "opencode",
  "langgraph",
  "external",
]);
export const runStatusEnum = pgEnum("run_status", [
  "queued",
  "reading_context",
  "planning",
  "awaiting_approval",
  "running_tools",
  "working_in_sandbox",
  "completed",
  "failed",
  "cancelled",
]);
export const triggerKindEnum = pgEnum("trigger_kind", [
  "mention",
  "reaction",
  "dm",
  "slash_command",
  "api",
  "schedule",
]);
export const runEventTypeEnum = pgEnum("run_event_type", [
  "run.created",
  "policy.evaluated",
  "model.selected",
  "tool.requested",
  "approval.requested",
  "approval.decided",
  "run.status_changed",
  "run.completed",
  "run.failed",
]);
export const approvalStatusEnum = pgEnum("approval_status", [
  "pending",
  "approved",
  "denied",
  "expired",
]);
export const connectorKindEnum = pgEnum("connector_kind", [
  "slack",
  "github",
  "linear",
  "model_provider",
  "mcp",
  "sandbox",
  "custom",
]);
export const connectorInstallStatusEnum = pgEnum("connector_install_status", [
  "pending",
  "active",
  "paused",
  "revoked",
  "error",
]);
export const credentialStatusEnum = pgEnum("credential_status", [
  "active",
  "disabled",
  "rotation_due",
  "revoked",
]);
export const usageStatusEnum = pgEnum("usage_status", [
  "succeeded",
  "failed",
  "cancelled",
]);

export const orgs = pgTable(
  "orgs",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    plan: organizationPlanEnum("plan").notNull().default("oss"),
    // Kept as text for seed compatibility; validate the agent reference after both rows exist.
    primaryAgentId: text("primary_agent_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("orgs_slug_unique").on(table.slug),
    index("orgs_primary_agent_idx").on(table.primaryAgentId),
  ],
);

export const principals = pgTable(
  "principals",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    kind: principalKindEnum("kind").notNull(),
    displayName: text("display_name").notNull(),
    email: text("email"),
    externalProvider: text("external_provider"),
    externalId: text("external_id"),
    metadata: jsonObject("metadata"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("principals_org_kind_idx").on(table.orgId, table.kind),
    uniqueIndex("principals_org_external_unique").on(
      table.orgId,
      table.externalProvider,
      table.externalId,
    ),
  ],
);

export const modelPolicies = pgTable(
  "model_policies",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    defaultModel: text("default_model").notNull(),
    fallbackModels: jsonb("fallback_models")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    perRunBudgetCents: integer("per_run_budget_cents").notNull(),
    metadata: jsonObject("metadata"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("model_policies_org_idx").on(table.orgId),
    uniqueIndex("model_policies_org_name_unique").on(table.orgId, table.name),
  ],
);

export const runtimeProfiles = pgTable(
  "runtime_profiles",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    runtimeKind: runtimeKindEnum("runtime_kind").notNull(),
    adapter: text("adapter").notNull(),
    config: jsonObject("config"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("runtime_profiles_org_idx").on(table.orgId),
    uniqueIndex("runtime_profiles_org_name_unique").on(table.orgId, table.name),
  ],
);

export const budgetPolicies = pgTable(
  "budget_policies",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    perRunCents: integer("per_run_cents").notNull(),
    perDayCents: integer("per_day_cents").notNull(),
    metadata: jsonObject("metadata"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("budget_policies_org_idx").on(table.orgId),
    uniqueIndex("budget_policies_org_name_unique").on(table.orgId, table.name),
  ],
);

export const agents = pgTable(
  "agents",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    principalId: text("principal_id")
      .notNull()
      .references(() => principals.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    handle: text("handle").notNull().default("@bek"),
    description: text("description").notNull(),
    status: agentStatusEnum("status").notNull().default("active"),
    defaultModelPolicyId: text("default_model_policy_id")
      .notNull()
      .references(() => modelPolicies.id, { onDelete: "restrict" }),
    defaultRuntimeProfileId: text("default_runtime_profile_id")
      .notNull()
      .references(() => runtimeProfiles.id, { onDelete: "restrict" }),
    metadata: jsonObject("metadata"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("agents_one_visible_agent_per_org").on(table.orgId),
    uniqueIndex("agents_principal_unique").on(table.principalId),
    check("agents_handle_is_bek", sql`${table.handle} = '@bek'`),
  ],
);

export const capabilityProfiles = pgTable(
  "capability_profiles",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    capabilityKind: capabilityProfileKindEnum("capability_kind").notNull(),
    runtimeProfileId: text("runtime_profile_id")
      .notNull()
      .references(() => runtimeProfiles.id, { onDelete: "restrict" }),
    modelPolicyId: text("model_policy_id")
      .notNull()
      .references(() => modelPolicies.id, { onDelete: "restrict" }),
    enabled: boolean("enabled").notNull().default(true),
    config: jsonObject("config"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("capability_profiles_org_agent_idx").on(table.orgId, table.agentId),
    uniqueIndex("capability_profiles_agent_kind_unique").on(
      table.agentId,
      table.capabilityKind,
    ),
  ],
);

export const places = pgTable(
  "places",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    kind: placeKindEnum("kind").notNull(),
    provider: placeProviderEnum("provider").notNull(),
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    sensitivity: placeSensitivityEnum("sensitivity").notNull(),
    metadata: jsonObject("metadata"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("places_org_kind_idx").on(table.orgId, table.kind),
    uniqueIndex("places_org_provider_external_unique").on(
      table.orgId,
      table.provider,
      table.externalId,
    ),
  ],
);

export const accessBundles = pgTable(
  "access_bundles",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull(),
    budgetPolicyId: text("budget_policy_id")
      .notNull()
      .references(() => budgetPolicies.id, { onDelete: "restrict" }),
    metadata: jsonObject("metadata"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("access_bundles_org_idx").on(table.orgId),
    uniqueIndex("access_bundles_org_name_unique").on(table.orgId, table.name),
  ],
);

export const accessBundlePlaces = pgTable(
  "access_bundle_places",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    accessBundleId: text("access_bundle_id")
      .notNull()
      .references(() => accessBundles.id, { onDelete: "cascade" }),
    placeId: text("place_id")
      .notNull()
      .references(() => places.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({
      name: "access_bundle_places_pk",
      columns: [table.accessBundleId, table.placeId],
    }),
    index("access_bundle_places_org_place_idx").on(table.orgId, table.placeId),
  ],
);

export const grants = pgTable(
  "grants",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    accessBundleId: text("access_bundle_id")
      .notNull()
      .references(() => accessBundles.id, { onDelete: "cascade" }),
    capability: capabilityKindEnum("capability").notNull(),
    resource: text("resource").notNull(),
    decision: decisionEnum("decision").notNull(),
    risk: riskLevelEnum("risk").notNull(),
    requiresApproval: boolean("requires_approval").notNull().default(false),
    conditions: jsonObject("conditions"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("grants_org_capability_idx").on(table.orgId, table.capability),
    index("grants_bundle_idx").on(table.accessBundleId),
    uniqueIndex("grants_bundle_capability_resource_unique").on(
      table.accessBundleId,
      table.capability,
      table.resource,
    ),
  ],
);

export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    requesterPrincipalId: text("requester_principal_id")
      .notNull()
      .references(() => principals.id, { onDelete: "restrict" }),
    placeScopeId: text("place_scope_id")
      .notNull()
      .references(() => places.id, { onDelete: "restrict" }),
    trigger: triggerKindEnum("trigger").notNull(),
    prompt: text("prompt").notNull(),
    status: runStatusEnum("status").notNull().default("queued"),
    modelPolicyId: text("model_policy_id")
      .notNull()
      .references(() => modelPolicies.id, { onDelete: "restrict" }),
    runtimeProfileId: text("runtime_profile_id")
      .notNull()
      .references(() => runtimeProfiles.id, { onDelete: "restrict" }),
    estimatedCostCents: integer("estimated_cost_cents").notNull().default(0),
    actualCostCents: integer("actual_cost_cents").notNull().default(0),
    metadata: jsonObject("metadata"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("runs_org_created_idx").on(table.orgId, table.createdAt),
    index("runs_org_status_idx").on(table.orgId, table.status),
    index("runs_place_created_idx").on(table.placeScopeId, table.createdAt),
  ],
);

export const runEvents = pgTable(
  "run_events",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    type: runEventTypeEnum("type").notNull(),
    message: text("message").notNull(),
    data: jsonObject("data"),
    createdAt: createdAt(),
  },
  (table) => [
    index("run_events_run_created_idx").on(table.runId, table.createdAt),
    index("run_events_org_idx").on(table.orgId),
  ],
);

export const approvals = pgTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    risk: riskLevelEnum("risk").notNull(),
    status: approvalStatusEnum("status").notNull().default("pending"),
    payloadHash: text("payload_hash").notNull(),
    payloadMetadata: jsonObject("payload_metadata"),
    requestedByPrincipalId: text("requested_by_principal_id")
      .notNull()
      .references(() => principals.id, { onDelete: "restrict" }),
    decidedByPrincipalId: text("decided_by_principal_id").references(
      () => principals.id,
      { onDelete: "restrict" },
    ),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (table) => [
    index("approvals_run_idx").on(table.runId),
    index("approvals_org_status_idx").on(table.orgId, table.status),
    uniqueIndex("approvals_run_action_payload_unique").on(
      table.runId,
      table.action,
      table.payloadHash,
    ),
  ],
);

export const connectorInstalls = pgTable(
  "connector_installs",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    kind: connectorKindEnum("kind").notNull(),
    provider: text("provider").notNull(),
    externalId: text("external_id"),
    displayName: text("display_name").notNull(),
    status: connectorInstallStatusEnum("status").notNull().default("pending"),
    installedByPrincipalId: text("installed_by_principal_id").references(
      () => principals.id,
      { onDelete: "set null" },
    ),
    config: jsonObject("config"),
    metadata: jsonObject("metadata"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("connector_installs_org_kind_idx").on(table.orgId, table.kind),
    uniqueIndex("connector_installs_org_provider_external_unique").on(
      table.orgId,
      table.provider,
      table.externalId,
    ),
  ],
);

export const credentialMetadata = pgTable(
  "credential_metadata",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    connectorInstallId: text("connector_install_id").references(
      () => connectorInstalls.id,
      { onDelete: "set null" },
    ),
    name: text("name").notNull(),
    provider: text("provider").notNull(),
    externalAccountId: text("external_account_id"),
    // Store secret broker references only; never raw tokens, keys, or webhook secrets.
    secretRef: text("secret_ref").notNull(),
    status: credentialStatusEnum("status").notNull().default("active"),
    scopeSummary: text("scope_summary").notNull().default(""),
    metadata: jsonObject("metadata"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    rotationDueAt: timestamp("rotation_due_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("credential_metadata_org_provider_idx").on(
      table.orgId,
      table.provider,
    ),
    index("credential_metadata_connector_idx").on(table.connectorInstallId),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    actorPrincipalId: text("actor_principal_id").references(
      () => principals.id,
      { onDelete: "set null" },
    ),
    runId: text("run_id").references(() => runs.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id"),
    decision: decisionEnum("decision"),
    risk: riskLevelEnum("risk"),
    message: text("message").notNull(),
    data: jsonObject("data"),
    createdAt: createdAt(),
  },
  (table) => [
    index("audit_events_org_created_idx").on(table.orgId, table.createdAt),
    index("audit_events_run_idx").on(table.runId),
    index("audit_events_actor_idx").on(table.actorPrincipalId),
  ],
);

export const ingressDeliveries = pgTable(
  "ingress_deliveries",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    kind: text("kind").notNull(),
    key: text("key").notNull(),
    status: text("status").notNull(),
    runId: text("run_id").references(() => runs.id, { onDelete: "set null" }),
    approvalId: text("approval_id").references(() => approvals.id, {
      onDelete: "set null",
    }),
    response: jsonObject("response"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("ingress_deliveries_org_key_unique").on(table.orgId, table.key),
    index("ingress_deliveries_org_created_idx").on(
      table.orgId,
      table.createdAt,
    ),
    index("ingress_deliveries_run_idx").on(table.runId),
  ],
);

export const modelUsage = pgTable(
  "model_usage",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    runEventId: text("run_event_id").references(() => runEvents.id, {
      onDelete: "set null",
    }),
    modelPolicyId: text("model_policy_id").references(() => modelPolicies.id, {
      onDelete: "set null",
    }),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    estimatedCostCents: integer("estimated_cost_cents").notNull().default(0),
    actualCostCents: integer("actual_cost_cents").notNull().default(0),
    latencyMs: integer("latency_ms"),
    status: usageStatusEnum("status").notNull(),
    errorCode: text("error_code"),
    metadata: jsonObject("metadata"),
    createdAt: createdAt(),
  },
  (table) => [
    index("model_usage_org_created_idx").on(table.orgId, table.createdAt),
    index("model_usage_run_idx").on(table.runId),
    index("model_usage_model_idx").on(table.provider, table.model),
  ],
);

export const toolUsage = pgTable(
  "tool_usage",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    runEventId: text("run_event_id").references(() => runEvents.id, {
      onDelete: "set null",
    }),
    connectorInstallId: text("connector_install_id").references(
      () => connectorInstalls.id,
      { onDelete: "set null" },
    ),
    credentialId: text("credential_id").references(
      () => credentialMetadata.id,
      { onDelete: "set null" },
    ),
    capability: capabilityKindEnum("capability").notNull(),
    toolName: text("tool_name").notNull(),
    resource: text("resource").notNull(),
    decision: decisionEnum("decision").notNull(),
    risk: riskLevelEnum("risk").notNull(),
    status: usageStatusEnum("status").notNull(),
    durationMs: integer("duration_ms"),
    estimatedCostCents: integer("estimated_cost_cents").notNull().default(0),
    actualCostCents: integer("actual_cost_cents").notNull().default(0),
    payloadHash: text("payload_hash"),
    metadata: jsonObject("metadata"),
    createdAt: createdAt(),
  },
  (table) => [
    index("tool_usage_org_created_idx").on(table.orgId, table.createdAt),
    index("tool_usage_run_idx").on(table.runId),
    index("tool_usage_tool_idx").on(table.connectorInstallId, table.toolName),
  ],
);

export const orgsRelations = relations(orgs, ({ one, many }) => ({
  primaryAgent: one(agents, {
    fields: [orgs.primaryAgentId],
    references: [agents.id],
    relationName: "org_primary_agent",
  }),
  principals: many(principals),
  agents: many(agents, { relationName: "org_agents" }),
  places: many(places),
  accessBundles: many(accessBundles),
  modelPolicies: many(modelPolicies),
  runtimeProfiles: many(runtimeProfiles),
  budgetPolicies: many(budgetPolicies),
  runs: many(runs),
  connectorInstalls: many(connectorInstalls),
  credentialMetadata: many(credentialMetadata),
  auditEvents: many(auditEvents),
  ingressDeliveries: many(ingressDeliveries),
}));

export const principalsRelations = relations(principals, ({ one, many }) => ({
  org: one(orgs, { fields: [principals.orgId], references: [orgs.id] }),
  agent: one(agents, {
    fields: [principals.id],
    references: [agents.principalId],
    relationName: "agent_principal",
  }),
  requestedRuns: many(runs),
  requestedApprovals: many(approvals, {
    relationName: "approval_requested_by",
  }),
  decidedApprovals: many(approvals, { relationName: "approval_decided_by" }),
  installedConnectors: many(connectorInstalls),
  auditEvents: many(auditEvents),
}));

export const agentsRelations = relations(agents, ({ one, many }) => ({
  org: one(orgs, {
    fields: [agents.orgId],
    references: [orgs.id],
    relationName: "org_agents",
  }),
  principal: one(principals, {
    fields: [agents.principalId],
    references: [principals.id],
    relationName: "agent_principal",
  }),
  defaultModelPolicy: one(modelPolicies, {
    fields: [agents.defaultModelPolicyId],
    references: [modelPolicies.id],
  }),
  defaultRuntimeProfile: one(runtimeProfiles, {
    fields: [agents.defaultRuntimeProfileId],
    references: [runtimeProfiles.id],
  }),
  capabilityProfiles: many(capabilityProfiles),
  runs: many(runs),
}));

export const capabilityProfilesRelations = relations(
  capabilityProfiles,
  ({ one }) => ({
    org: one(orgs, {
      fields: [capabilityProfiles.orgId],
      references: [orgs.id],
    }),
    agent: one(agents, {
      fields: [capabilityProfiles.agentId],
      references: [agents.id],
    }),
    runtimeProfile: one(runtimeProfiles, {
      fields: [capabilityProfiles.runtimeProfileId],
      references: [runtimeProfiles.id],
    }),
    modelPolicy: one(modelPolicies, {
      fields: [capabilityProfiles.modelPolicyId],
      references: [modelPolicies.id],
    }),
  }),
);

export const placesRelations = relations(places, ({ one, many }) => ({
  org: one(orgs, { fields: [places.orgId], references: [orgs.id] }),
  accessBundlePlaces: many(accessBundlePlaces),
  runs: many(runs),
}));

export const accessBundlesRelations = relations(
  accessBundles,
  ({ one, many }) => ({
    org: one(orgs, { fields: [accessBundles.orgId], references: [orgs.id] }),
    budgetPolicy: one(budgetPolicies, {
      fields: [accessBundles.budgetPolicyId],
      references: [budgetPolicies.id],
    }),
    places: many(accessBundlePlaces),
    grants: many(grants),
  }),
);

export const accessBundlePlacesRelations = relations(
  accessBundlePlaces,
  ({ one }) => ({
    org: one(orgs, {
      fields: [accessBundlePlaces.orgId],
      references: [orgs.id],
    }),
    accessBundle: one(accessBundles, {
      fields: [accessBundlePlaces.accessBundleId],
      references: [accessBundles.id],
    }),
    place: one(places, {
      fields: [accessBundlePlaces.placeId],
      references: [places.id],
    }),
  }),
);

export const grantsRelations = relations(grants, ({ one }) => ({
  org: one(orgs, { fields: [grants.orgId], references: [orgs.id] }),
  accessBundle: one(accessBundles, {
    fields: [grants.accessBundleId],
    references: [accessBundles.id],
  }),
}));

export const modelPoliciesRelations = relations(
  modelPolicies,
  ({ one, many }) => ({
    org: one(orgs, { fields: [modelPolicies.orgId], references: [orgs.id] }),
    agents: many(agents),
    capabilityProfiles: many(capabilityProfiles),
    runs: many(runs),
    modelUsage: many(modelUsage),
  }),
);

export const runtimeProfilesRelations = relations(
  runtimeProfiles,
  ({ one, many }) => ({
    org: one(orgs, { fields: [runtimeProfiles.orgId], references: [orgs.id] }),
    agents: many(agents),
    capabilityProfiles: many(capabilityProfiles),
    runs: many(runs),
  }),
);

export const budgetPoliciesRelations = relations(
  budgetPolicies,
  ({ one, many }) => ({
    org: one(orgs, { fields: [budgetPolicies.orgId], references: [orgs.id] }),
    accessBundles: many(accessBundles),
  }),
);

export const runsRelations = relations(runs, ({ one, many }) => ({
  org: one(orgs, { fields: [runs.orgId], references: [orgs.id] }),
  agent: one(agents, { fields: [runs.agentId], references: [agents.id] }),
  requester: one(principals, {
    fields: [runs.requesterPrincipalId],
    references: [principals.id],
  }),
  place: one(places, { fields: [runs.placeScopeId], references: [places.id] }),
  modelPolicy: one(modelPolicies, {
    fields: [runs.modelPolicyId],
    references: [modelPolicies.id],
  }),
  runtimeProfile: one(runtimeProfiles, {
    fields: [runs.runtimeProfileId],
    references: [runtimeProfiles.id],
  }),
  events: many(runEvents),
  approvals: many(approvals),
  auditEvents: many(auditEvents),
  modelUsage: many(modelUsage),
  toolUsage: many(toolUsage),
  ingressDeliveries: many(ingressDeliveries),
}));

export const runEventsRelations = relations(runEvents, ({ one, many }) => ({
  org: one(orgs, { fields: [runEvents.orgId], references: [orgs.id] }),
  run: one(runs, { fields: [runEvents.runId], references: [runs.id] }),
  modelUsage: many(modelUsage),
  toolUsage: many(toolUsage),
}));

export const approvalsRelations = relations(approvals, ({ one }) => ({
  org: one(orgs, { fields: [approvals.orgId], references: [orgs.id] }),
  run: one(runs, { fields: [approvals.runId], references: [runs.id] }),
  requestedBy: one(principals, {
    fields: [approvals.requestedByPrincipalId],
    references: [principals.id],
    relationName: "approval_requested_by",
  }),
  decidedBy: one(principals, {
    fields: [approvals.decidedByPrincipalId],
    references: [principals.id],
    relationName: "approval_decided_by",
  }),
}));

export const ingressDeliveriesRelations = relations(
  ingressDeliveries,
  ({ one }) => ({
    org: one(orgs, {
      fields: [ingressDeliveries.orgId],
      references: [orgs.id],
    }),
    run: one(runs, {
      fields: [ingressDeliveries.runId],
      references: [runs.id],
    }),
    approval: one(approvals, {
      fields: [ingressDeliveries.approvalId],
      references: [approvals.id],
    }),
  }),
);

export const connectorInstallsRelations = relations(
  connectorInstalls,
  ({ one, many }) => ({
    org: one(orgs, {
      fields: [connectorInstalls.orgId],
      references: [orgs.id],
    }),
    installedBy: one(principals, {
      fields: [connectorInstalls.installedByPrincipalId],
      references: [principals.id],
    }),
    credentialMetadata: many(credentialMetadata),
    toolUsage: many(toolUsage),
  }),
);

export const credentialMetadataRelations = relations(
  credentialMetadata,
  ({ one, many }) => ({
    org: one(orgs, {
      fields: [credentialMetadata.orgId],
      references: [orgs.id],
    }),
    connectorInstall: one(connectorInstalls, {
      fields: [credentialMetadata.connectorInstallId],
      references: [connectorInstalls.id],
    }),
    toolUsage: many(toolUsage),
  }),
);

export const auditEventsRelations = relations(auditEvents, ({ one }) => ({
  org: one(orgs, { fields: [auditEvents.orgId], references: [orgs.id] }),
  actor: one(principals, {
    fields: [auditEvents.actorPrincipalId],
    references: [principals.id],
  }),
  run: one(runs, { fields: [auditEvents.runId], references: [runs.id] }),
}));

export const modelUsageRelations = relations(modelUsage, ({ one }) => ({
  org: one(orgs, { fields: [modelUsage.orgId], references: [orgs.id] }),
  run: one(runs, { fields: [modelUsage.runId], references: [runs.id] }),
  runEvent: one(runEvents, {
    fields: [modelUsage.runEventId],
    references: [runEvents.id],
  }),
  modelPolicy: one(modelPolicies, {
    fields: [modelUsage.modelPolicyId],
    references: [modelPolicies.id],
  }),
}));

export const toolUsageRelations = relations(toolUsage, ({ one }) => ({
  org: one(orgs, { fields: [toolUsage.orgId], references: [orgs.id] }),
  run: one(runs, { fields: [toolUsage.runId], references: [runs.id] }),
  runEvent: one(runEvents, {
    fields: [toolUsage.runEventId],
    references: [runEvents.id],
  }),
  connectorInstall: one(connectorInstalls, {
    fields: [toolUsage.connectorInstallId],
    references: [connectorInstalls.id],
  }),
  credential: one(credentialMetadata, {
    fields: [toolUsage.credentialId],
    references: [credentialMetadata.id],
  }),
}));

export const organizations = orgs;
export const agentIdentities = agents;
export const placeScopes = places;
export const capabilityGrants = grants;
export const credentials = credentialMetadata;

export type OrganizationRow = InferSelectModel<typeof orgs>;
export type NewOrganizationRow = InferInsertModel<typeof orgs>;
export type PrincipalRow = InferSelectModel<typeof principals>;
export type NewPrincipalRow = InferInsertModel<typeof principals>;
export type AgentRow = InferSelectModel<typeof agents>;
export type NewAgentRow = InferInsertModel<typeof agents>;
export type CapabilityProfileRow = InferSelectModel<typeof capabilityProfiles>;
export type NewCapabilityProfileRow = InferInsertModel<
  typeof capabilityProfiles
>;
export type PlaceRow = InferSelectModel<typeof places>;
export type NewPlaceRow = InferInsertModel<typeof places>;
export type AccessBundleRow = InferSelectModel<typeof accessBundles>;
export type NewAccessBundleRow = InferInsertModel<typeof accessBundles>;
export type AccessBundlePlaceRow = InferSelectModel<typeof accessBundlePlaces>;
export type NewAccessBundlePlaceRow = InferInsertModel<
  typeof accessBundlePlaces
>;
export type GrantRow = InferSelectModel<typeof grants>;
export type NewGrantRow = InferInsertModel<typeof grants>;
export type ModelPolicyRow = InferSelectModel<typeof modelPolicies>;
export type NewModelPolicyRow = InferInsertModel<typeof modelPolicies>;
export type RuntimeProfileRow = InferSelectModel<typeof runtimeProfiles>;
export type NewRuntimeProfileRow = InferInsertModel<typeof runtimeProfiles>;
export type BudgetPolicyRow = InferSelectModel<typeof budgetPolicies>;
export type NewBudgetPolicyRow = InferInsertModel<typeof budgetPolicies>;
export type RunRow = InferSelectModel<typeof runs>;
export type NewRunRow = InferInsertModel<typeof runs>;
export type RunEventRow = InferSelectModel<typeof runEvents>;
export type NewRunEventRow = InferInsertModel<typeof runEvents>;
export type ApprovalRow = InferSelectModel<typeof approvals>;
export type NewApprovalRow = InferInsertModel<typeof approvals>;
export type ConnectorInstallRow = InferSelectModel<typeof connectorInstalls>;
export type NewConnectorInstallRow = InferInsertModel<typeof connectorInstalls>;
export type CredentialMetadataRow = InferSelectModel<typeof credentialMetadata>;
export type NewCredentialMetadataRow = InferInsertModel<
  typeof credentialMetadata
>;
export type AuditEventRow = InferSelectModel<typeof auditEvents>;
export type NewAuditEventRow = InferInsertModel<typeof auditEvents>;
export type IngressDeliveryRow = InferSelectModel<typeof ingressDeliveries>;
export type NewIngressDeliveryRow = InferInsertModel<typeof ingressDeliveries>;
export type ModelUsageRow = InferSelectModel<typeof modelUsage>;
export type NewModelUsageRow = InferInsertModel<typeof modelUsage>;
export type ToolUsageRow = InferSelectModel<typeof toolUsage>;
export type NewToolUsageRow = InferInsertModel<typeof toolUsage>;
