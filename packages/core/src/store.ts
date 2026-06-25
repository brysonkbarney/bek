import { createSeedSnapshot } from "./seed";
import { bundlesForPlace, evaluatePolicy } from "./policy";
import { createApprovalRequest, createRun, createRunEvent } from "./runs";
import { createId } from "./ids";
import { redactSecrets, redactUnknown } from "./security";
import type {
  AccessBundle,
  AgentIdentity,
  ApprovalRequest,
  BekSnapshot,
  CapabilityGrant,
  CapabilityKind,
  CapabilityProfile,
  ConnectorInstall,
  ConnectorInstallStatus,
  CredentialRecord,
  CredentialStatus,
  IngressDelivery,
  IngressDeliveryKind,
  ModelPolicy,
  OutboundDelivery,
  OutboundDeliveryKind,
  PlaceScope,
  Principal,
  Run,
  RunEvent,
  RunStatus,
  RuntimeProfile,
  TriggerKind,
} from "./types";

export type RunAdvanceMode = "inline_stub" | "worker";

export interface ApprovalDecisionInput {
  principalId: string;
  payloadHash: string;
  now?: string | undefined;
  advanceMode?: RunAdvanceMode | undefined;
}

export interface AppendRunEventInput {
  runId: string;
  type: RunEvent["type"];
  message: string;
  data?: Record<string, unknown> | undefined;
  now?: string | undefined;
}

export interface SetRunStatusInput {
  runId: string;
  status: RunStatus;
  message: string;
  actualCostCents?: number | undefined;
  data?: Record<string, unknown> | undefined;
  now?: string | undefined;
}

export interface RecordIngressDeliveryInput {
  key: string;
  provider?: IngressDelivery["provider"] | undefined;
  kind: IngressDeliveryKind;
  status: IngressDelivery["status"];
  runId?: string | undefined;
  approvalId?: string | undefined;
  response?: Record<string, unknown> | undefined;
  now?: string | undefined;
}

export interface UpsertConnectorInstallInput {
  id?: string | undefined;
  kind: ConnectorInstall["kind"];
  provider: string;
  externalId?: string | undefined;
  displayName: string;
  status?: ConnectorInstallStatus | undefined;
  installedByPrincipalId?: string | undefined;
  config?: Record<string, unknown> | undefined;
  metadata?: Record<string, unknown> | undefined;
  now?: string | undefined;
}

export interface UpsertCredentialInput {
  id?: string | undefined;
  connectorInstallId?: string | undefined;
  name: string;
  provider: string;
  externalAccountId?: string | undefined;
  secretRef: string;
  status?: CredentialStatus | undefined;
  scopeSummary: string;
  metadata?: Record<string, unknown> | undefined;
  expiresAt?: string | undefined;
  rotationDueAt?: string | undefined;
  lastUsedAt?: string | undefined;
  now?: string | undefined;
}

export interface RemoveIngressDeliveryOptions {
  recordChange?: boolean | undefined;
}

export interface EnqueueOutboundDeliveryInput {
  key: string;
  kind: OutboundDeliveryKind;
  target: Record<string, unknown>;
  payload: Record<string, unknown>;
  runId?: string | undefined;
  approvalId?: string | undefined;
  maxAttempts?: number | undefined;
  now?: string | undefined;
}

export interface ListDueOutboundDeliveriesInput {
  provider?: OutboundDelivery["provider"] | undefined;
  now?: string | undefined;
  limit?: number | undefined;
}

export interface FailOutboundDeliveryInput {
  id: string;
  error: string;
  retryable?: boolean | undefined;
  retryDelayMs?: number | undefined;
  now?: string | undefined;
}

export interface BekStoreOptions {
  onSnapshotChanged?:
    | ((snapshot: BekSnapshot) => Promise<void> | void)
    | undefined;
}

export class BekStore {
  private snapshot: BekSnapshot;
  private persistenceQueue: Promise<void> = Promise.resolve();
  private persistenceError: Error | undefined;
  private readonly onSnapshotChanged:
    | ((snapshot: BekSnapshot) => Promise<void> | void)
    | undefined;

  constructor(
    snapshot: BekSnapshot = createSeedSnapshot(),
    options: BekStoreOptions = {},
  ) {
    this.snapshot = snapshot;
    this.onSnapshotChanged = options.onSnapshotChanged;
  }

  read(): BekSnapshot {
    return structuredClone(this.snapshot);
  }

  async flushChanges(): Promise<void> {
    await this.persistenceQueue;
    if (this.persistenceError) {
      const error = this.persistenceError;
      this.persistenceError = undefined;
      throw error;
    }
  }

  findIngressDelivery(key: string): IngressDelivery | undefined {
    const delivery = this.snapshot.ingressDeliveries.find(
      (candidate) => candidate.key === key,
    );
    return delivery ? structuredClone(delivery) : undefined;
  }

  updateAgent(input: {
    name?: string | undefined;
    description?: string | undefined;
    status?: AgentIdentity["status"] | undefined;
    defaultModelPolicyId?: string | undefined;
    defaultRuntimeProfileId?: string | undefined;
  }): AgentIdentity {
    if (
      input.defaultModelPolicyId &&
      !this.snapshot.modelPolicies.some(
        (policy) => policy.id === input.defaultModelPolicyId,
      )
    ) {
      throw new Error("Model policy not found.");
    }
    if (
      input.defaultRuntimeProfileId &&
      !this.snapshot.runtimeProfiles.some(
        (profile) => profile.id === input.defaultRuntimeProfileId,
      )
    ) {
      throw new Error("Runtime profile not found.");
    }

    this.snapshot.agent = {
      ...this.snapshot.agent,
      ...(input.name ? { name: input.name } : {}),
      ...(input.description ? { description: input.description } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.defaultModelPolicyId
        ? { defaultModelPolicyId: input.defaultModelPolicyId }
        : {}),
      ...(input.defaultRuntimeProfileId
        ? { defaultRuntimeProfileId: input.defaultRuntimeProfileId }
        : {}),
      handle: "@bek",
    };
    this.recordChange();
    return structuredClone(this.snapshot.agent);
  }

  linkPrincipalExternalIdentity(
    principalId: string,
    input: {
      externalProvider: string;
      externalId: string;
      metadata?: Record<string, unknown> | undefined;
    },
  ): Principal {
    const principal = this.findPrincipal(principalId);
    const externalProvider = input.externalProvider.trim();
    const externalId = input.externalId.trim();
    if (!externalProvider || !externalId) {
      throw new Error("External provider and external ID are required.");
    }
    const existing = this.snapshot.principals.find(
      (candidate) =>
        candidate.id !== principal.id &&
        candidate.orgId === principal.orgId &&
        candidate.externalProvider === externalProvider &&
        candidate.externalId === externalId,
    );
    if (existing) {
      throw new Error(
        "External identity is already linked to another principal.",
      );
    }

    principal.externalProvider = externalProvider;
    principal.externalId = externalId;
    assignOptional(principal, "metadata", redactedRecord(input.metadata));
    this.recordChange();
    return structuredClone(principal);
  }

  createPlace(input: {
    kind: PlaceScope["kind"];
    provider: PlaceScope["provider"];
    externalId: string;
    name: string;
    sensitivity: PlaceScope["sensitivity"];
    metadata?: Record<string, unknown> | undefined;
  }): PlaceScope {
    if (
      this.snapshot.places.some(
        (place) =>
          place.provider === input.provider &&
          place.externalId.toLowerCase() === input.externalId.toLowerCase(),
      )
    ) {
      throw new Error(
        "Place with this provider and external ID already exists.",
      );
    }

    const place: PlaceScope = {
      id: createId("place"),
      orgId: this.snapshot.org.id,
      kind: input.kind,
      provider: input.provider,
      externalId: input.externalId,
      name: input.name,
      sensitivity: input.sensitivity,
    };
    assignOptional(place, "metadata", redactedRecord(input.metadata));
    this.snapshot.places.unshift(place);
    this.recordChange();
    return structuredClone(place);
  }

  updatePlace(
    placeId: string,
    input: {
      name?: string | undefined;
      externalId?: string | undefined;
      sensitivity?: PlaceScope["sensitivity"] | undefined;
      metadata?: Record<string, unknown> | undefined;
    },
  ): PlaceScope {
    const place = this.findPlace(placeId);
    if (
      input.externalId &&
      this.snapshot.places.some(
        (candidate) =>
          candidate.id !== place.id &&
          candidate.provider === place.provider &&
          candidate.externalId.toLowerCase() ===
            input.externalId!.toLowerCase(),
      )
    ) {
      throw new Error(
        "Place with this provider and external ID already exists.",
      );
    }

    if (input.name) {
      place.name = input.name;
    }
    if (input.externalId) {
      place.externalId = input.externalId;
    }
    if (input.sensitivity) {
      place.sensitivity = input.sensitivity;
    }
    if (input.metadata) {
      const metadata = redactedRecord(input.metadata);
      if (metadata) {
        place.metadata = metadata;
      }
    }
    this.recordChange();
    return structuredClone(place);
  }

  deletePlace(placeId: string): PlaceScope {
    const place = this.findPlace(placeId);
    if (this.snapshot.runs.some((run) => run.placeScopeId === place.id)) {
      throw new Error("Cannot delete a place that has runs.");
    }
    this.snapshot.accessBundles = this.snapshot.accessBundles.map((bundle) => ({
      ...bundle,
      attachedPlaceIds: bundle.attachedPlaceIds.filter((id) => id !== place.id),
    }));
    this.snapshot.places = this.snapshot.places.filter(
      (candidate) => candidate.id !== place.id,
    );
    this.recordChange();
    return structuredClone(place);
  }

  createAccessBundle(input: {
    name: string;
    description: string;
    budgetPolicyId?: string | undefined;
    attachedPlaceIds?: string[] | undefined;
  }): AccessBundle {
    const budgetPolicyId =
      input.budgetPolicyId ?? this.snapshot.budgetPolicies[0]?.id;
    if (
      !budgetPolicyId ||
      !this.snapshot.budgetPolicies.some(
        (policy) => policy.id === budgetPolicyId,
      )
    ) {
      throw new Error("Budget policy not found.");
    }
    const attachedPlaceIds = [...new Set(input.attachedPlaceIds ?? [])];
    for (const placeId of attachedPlaceIds) {
      this.findPlace(placeId);
    }

    const bundle: AccessBundle = {
      id: createId("bundle"),
      orgId: this.snapshot.org.id,
      name: input.name,
      description: input.description,
      budgetPolicyId,
      attachedPlaceIds,
      grants: [],
    };
    this.snapshot.accessBundles.unshift(bundle);
    this.recordChange();
    return structuredClone(bundle);
  }

  updateAccessBundle(
    bundleId: string,
    input: {
      name?: string | undefined;
      description?: string | undefined;
      budgetPolicyId?: string | undefined;
    },
  ): AccessBundle {
    const bundle = this.findBundle(bundleId);
    if (
      input.budgetPolicyId &&
      !this.snapshot.budgetPolicies.some(
        (policy) => policy.id === input.budgetPolicyId,
      )
    ) {
      throw new Error("Budget policy not found.");
    }
    if (input.name) {
      bundle.name = input.name;
    }
    if (input.description) {
      bundle.description = input.description;
    }
    if (input.budgetPolicyId) {
      bundle.budgetPolicyId = input.budgetPolicyId;
    }
    this.recordChange();
    return structuredClone(bundle);
  }

  attachBundleToPlace(bundleId: string, placeId: string): AccessBundle {
    const bundle = this.findBundle(bundleId);
    const place = this.findPlace(placeId);
    if (!bundle.attachedPlaceIds.includes(place.id)) {
      bundle.attachedPlaceIds.push(place.id);
    }
    this.recordChange();
    return structuredClone(bundle);
  }

  detachBundleFromPlace(bundleId: string, placeId: string): AccessBundle {
    const bundle = this.findBundle(bundleId);
    const place = this.findPlace(placeId);
    bundle.attachedPlaceIds = bundle.attachedPlaceIds.filter(
      (id) => id !== place.id,
    );
    this.recordChange();
    return structuredClone(bundle);
  }

  createGrant(
    bundleId: string,
    input: Omit<CapabilityGrant, "id"> & { id?: string | undefined },
  ): CapabilityGrant {
    const bundle = this.findBundle(bundleId);
    const grant: CapabilityGrant = {
      id: input.id ?? createId("grant"),
      capability: input.capability,
      resource: input.resource,
      decision: input.decision,
      risk: input.risk,
      requiresApproval: input.requiresApproval,
    };
    bundle.grants.unshift(grant);
    this.recordChange();
    return structuredClone(grant);
  }

  updateGrant(
    bundleId: string,
    grantId: string,
    input: {
      capability?: CapabilityGrant["capability"] | undefined;
      resource?: string | undefined;
      decision?: CapabilityGrant["decision"] | undefined;
      risk?: CapabilityGrant["risk"] | undefined;
      requiresApproval?: boolean | undefined;
    },
  ): CapabilityGrant {
    const grant = this.findGrant(bundleId, grantId);
    Object.assign(grant, input);
    this.recordChange();
    return structuredClone(grant);
  }

  deleteGrant(bundleId: string, grantId: string): CapabilityGrant {
    const bundle = this.findBundle(bundleId);
    const grant = this.findGrant(bundleId, grantId);
    bundle.grants = bundle.grants.filter(
      (candidate) => candidate.id !== grant.id,
    );
    this.recordChange();
    return structuredClone(grant);
  }

  updateModelPolicy(
    modelPolicyId: string,
    input: {
      name?: string | undefined;
      defaultModel?: string | undefined;
      fallbackModels?: string[] | undefined;
      perRunBudgetCents?: number | undefined;
    },
  ): ModelPolicy {
    const policy = this.findModelPolicy(modelPolicyId);
    if (input.name) {
      policy.name = input.name;
    }
    if (input.defaultModel) {
      policy.defaultModel = input.defaultModel;
    }
    if (input.fallbackModels) {
      policy.fallbackModels = [...new Set(input.fallbackModels)];
    }
    if (input.perRunBudgetCents !== undefined) {
      policy.perRunBudgetCents = input.perRunBudgetCents;
    }
    this.recordChange();
    return structuredClone(policy);
  }

  updateRuntimeProfile(
    runtimeProfileId: string,
    input: {
      name?: string | undefined;
      adapter?: string | undefined;
      runtimeKind?: RuntimeProfile["runtimeKind"] | undefined;
    },
  ): RuntimeProfile {
    const profile = this.findRuntimeProfile(runtimeProfileId);
    if (input.name) {
      profile.name = input.name;
    }
    if (input.adapter) {
      profile.adapter = input.adapter;
    }
    if (input.runtimeKind) {
      profile.runtimeKind = input.runtimeKind;
    }
    this.recordChange();
    return structuredClone(profile);
  }

  upsertConnectorInstall(input: UpsertConnectorInstallInput): ConnectorInstall {
    const now = input.now ?? new Date().toISOString();
    const existing = this.snapshot.connectorInstalls.find(
      (candidate) =>
        candidate.id === input.id ||
        (input.externalId !== undefined &&
          candidate.provider === input.provider &&
          candidate.externalId === input.externalId),
    );

    if (existing) {
      existing.kind = input.kind;
      existing.provider = input.provider;
      existing.displayName = input.displayName;
      existing.status = input.status ?? existing.status;
      existing.updatedAt = now;
      assignOptional(existing, "externalId", input.externalId);
      assignOptional(
        existing,
        "installedByPrincipalId",
        input.installedByPrincipalId,
      );
      assignOptional(existing, "config", redactedRecord(input.config));
      assignOptional(existing, "metadata", redactedRecord(input.metadata));
      this.recordChange();
      return structuredClone(existing);
    }

    const install: ConnectorInstall = {
      id: input.id ?? createId("connector"),
      orgId: this.snapshot.org.id,
      kind: input.kind,
      provider: input.provider,
      displayName: input.displayName,
      status: input.status ?? "active",
      createdAt: now,
      updatedAt: now,
    };
    assignOptional(install, "externalId", input.externalId);
    assignOptional(
      install,
      "installedByPrincipalId",
      input.installedByPrincipalId,
    );
    assignOptional(install, "config", redactedRecord(input.config));
    assignOptional(install, "metadata", redactedRecord(input.metadata));
    this.snapshot.connectorInstalls.unshift(install);
    this.recordChange();
    return structuredClone(install);
  }

  upsertCredential(input: UpsertCredentialInput): CredentialRecord {
    const now = input.now ?? new Date().toISOString();
    if (
      input.connectorInstallId &&
      !this.snapshot.connectorInstalls.some(
        (install) => install.id === input.connectorInstallId,
      )
    ) {
      throw new Error("Connector install not found.");
    }

    const existing = this.snapshot.credentials.find(
      (candidate) =>
        candidate.id === input.id ||
        (input.connectorInstallId !== undefined &&
          candidate.connectorInstallId === input.connectorInstallId &&
          candidate.provider === input.provider &&
          candidate.externalAccountId === input.externalAccountId),
    );

    if (existing) {
      existing.name = input.name;
      existing.provider = input.provider;
      existing.secretRef = redactSecrets(input.secretRef);
      existing.status = input.status ?? existing.status;
      existing.scopeSummary = input.scopeSummary;
      existing.updatedAt = now;
      assignOptional(existing, "connectorInstallId", input.connectorInstallId);
      assignOptional(existing, "externalAccountId", input.externalAccountId);
      assignOptional(existing, "metadata", redactedRecord(input.metadata));
      assignOptional(existing, "expiresAt", input.expiresAt);
      assignOptional(existing, "rotationDueAt", input.rotationDueAt);
      assignOptional(existing, "lastUsedAt", input.lastUsedAt);
      this.recordChange();
      return structuredClone(existing);
    }

    const credential: CredentialRecord = {
      id: input.id ?? createId("credential"),
      orgId: this.snapshot.org.id,
      name: input.name,
      provider: input.provider,
      secretRef: redactSecrets(input.secretRef),
      status: input.status ?? "active",
      scopeSummary: input.scopeSummary,
      createdAt: now,
      updatedAt: now,
    };
    assignOptional(credential, "connectorInstallId", input.connectorInstallId);
    assignOptional(credential, "externalAccountId", input.externalAccountId);
    assignOptional(credential, "metadata", redactedRecord(input.metadata));
    assignOptional(credential, "expiresAt", input.expiresAt);
    assignOptional(credential, "rotationDueAt", input.rotationDueAt);
    assignOptional(credential, "lastUsedAt", input.lastUsedAt);
    this.snapshot.credentials.unshift(credential);
    this.recordChange();
    return structuredClone(credential);
  }

  createRun(input: {
    prompt: string;
    placeScopeId: string;
    requesterPrincipalId?: string | undefined;
    trigger?: TriggerKind | undefined;
    capability?: CapabilityKind | undefined;
    resource?: string | undefined;
    advanceMode?: RunAdvanceMode | undefined;
  }): Run {
    const advanceMode = input.advanceMode ?? "inline_stub";
    const { modelPolicy, runtimeProfile } = this.resolveRunProfiles(
      input.capability,
    );

    const place = this.snapshot.places.find(
      (candidate) => candidate.id === input.placeScopeId,
    );
    if (!place) {
      throw new Error("Unknown place scope.");
    }

    const run = createRun({
      orgId: this.snapshot.org.id,
      agentId: this.snapshot.agent.id,
      requesterPrincipalId: input.requesterPrincipalId ?? "principal_bryson",
      placeScopeId: input.placeScopeId,
      trigger: input.trigger ?? "api",
      prompt: input.prompt,
      modelPolicy,
      runtimeProfile,
    });

    this.snapshot.runs.unshift(run);
    this.snapshot.events.unshift(
      createRunEvent(
        this.snapshot.org.id,
        run.id,
        "run.created",
        `Bek queued: ${run.prompt}`,
      ),
    );

    if (input.capability) {
      const decision = evaluatePolicy(
        bundlesForPlace(this.snapshot.accessBundles, place),
        {
          placeScopeId: input.placeScopeId,
          capability: input.capability,
          resource: input.resource,
        },
      );

      this.snapshot.events.unshift(
        createRunEvent(
          this.snapshot.org.id,
          run.id,
          "policy.evaluated",
          decision.reason,
          {
            decision: decision.decision,
            requiresApproval: decision.requiresApproval,
          },
        ),
      );

      if (decision.decision === "deny") {
        run.status = "failed";
        this.snapshot.events.unshift(
          createRunEvent(
            this.snapshot.org.id,
            run.id,
            "run.failed",
            decision.reason,
            {
              capability: input.capability,
              resource: input.resource,
            },
          ),
        );
      } else if (decision.requiresApproval) {
        const approval = createApprovalRequest(
          this.snapshot.org.id,
          run.id,
          run.requesterPrincipalId,
          input.capability,
          {
            prompt: input.prompt,
            capability: input.capability,
            resource: input.resource,
          },
          decision.risk,
        );
        run.status = "awaiting_approval";
        this.snapshot.approvals.unshift(approval);
        this.snapshot.events.unshift(
          createRunEvent(
            this.snapshot.org.id,
            run.id,
            "approval.requested",
            `Approval required for ${input.capability}.`,
            {
              approvalId: approval.id,
            },
          ),
        );
      } else {
        if (advanceMode === "inline_stub") {
          run.status = "completed";
          run.actualCostCents = Math.max(1, run.estimatedCostCents - 1);
          this.snapshot.events.unshift(
            createRunEvent(
              this.snapshot.org.id,
              run.id,
              "run.completed",
              "Bek completed the local stub run.",
            ),
          );
        } else {
          this.snapshot.events.unshift(
            createRunEvent(
              this.snapshot.org.id,
              run.id,
              "run.status_changed",
              "Policy allowed the run; worker advancement is pending.",
              { advanceMode },
            ),
          );
        }
      }
    }

    run.updatedAt = new Date().toISOString();
    this.recordChange();
    return structuredClone(run);
  }

  decideApproval(
    approvalId: string,
    decision: "approved" | "denied",
    input: ApprovalDecisionInput,
  ) {
    const approval = this.snapshot.approvals.find(
      (candidate) => candidate.id === approvalId,
    );
    if (!approval) {
      throw new Error("Approval not found.");
    }
    if (approval.status !== "pending") {
      throw new Error("Approval is no longer pending.");
    }
    if (approval.payloadHash !== input.payloadHash) {
      throw new Error(
        "Approval payload hash does not match the pending request.",
      );
    }

    const now = input.now ?? new Date().toISOString();
    if (Date.parse(approval.expiresAt) <= Date.parse(now)) {
      approval.status = "expired";
      approval.decidedAt = now;
      throw new Error("Approval has expired.");
    }

    const actor = this.snapshot.principals.find(
      (candidate) =>
        candidate.id === input.principalId &&
        candidate.orgId === approval.orgId,
    );
    if (!actor) {
      throw new Error("Approval actor not found.");
    }
    if (actor.kind !== "human") {
      throw new Error("Approval actor must be a human principal.");
    }
    if (
      actor.id === approval.requestedByPrincipalId &&
      (approval.risk === "write_external" || approval.risk === "privileged")
    ) {
      throw new Error(
        "Requester cannot self-approve write or privileged actions.",
      );
    }

    approval.status = decision;
    approval.decidedByPrincipalId = actor.id;
    approval.decidedAt = now;

    const run = this.snapshot.runs.find(
      (candidate) => candidate.id === approval.runId,
    );
    if (run) {
      if (decision === "approved" && input.advanceMode === "worker") {
        run.status = "queued";
      } else {
        run.status = decision === "approved" ? "completed" : "cancelled";
        run.actualCostCents =
          decision === "approved" ? Math.max(1, run.estimatedCostCents) : 0;
      }
      run.updatedAt = now;
    }

    this.snapshot.events.unshift(
      createRunEvent(
        this.snapshot.org.id,
        approval.runId,
        "approval.decided",
        `Approval ${decision}.`,
        {
          approvalId,
          decidedByPrincipalId: actor.id,
        },
      ),
    );

    this.recordChange();
    return structuredClone(approval);
  }

  recordIngressDelivery(input: RecordIngressDeliveryInput): IngressDelivery {
    const now = input.now ?? new Date().toISOString();
    const existing = this.snapshot.ingressDeliveries.find(
      (candidate) => candidate.key === input.key,
    );
    if (existing) {
      existing.status = input.status;
      existing.updatedAt = now;
      if (input.runId !== undefined) {
        existing.runId = input.runId;
      }
      if (input.approvalId !== undefined) {
        existing.approvalId = input.approvalId;
      }
      if (input.response !== undefined) {
        existing.response = redactUnknown(input.response) as Record<
          string,
          unknown
        >;
      }
      this.recordChange();
      return structuredClone(existing);
    }

    const delivery: IngressDelivery = {
      id: createId("delivery"),
      orgId: this.snapshot.org.id,
      provider: input.provider ?? "slack",
      kind: input.kind,
      key: input.key,
      status: input.status,
      createdAt: now,
      updatedAt: now,
    };
    if (input.runId !== undefined) {
      delivery.runId = input.runId;
    }
    if (input.approvalId !== undefined) {
      delivery.approvalId = input.approvalId;
    }
    if (input.response !== undefined) {
      delivery.response = redactUnknown(input.response) as Record<
        string,
        unknown
      >;
    }
    this.snapshot.ingressDeliveries.unshift(delivery);
    this.recordChange();
    return structuredClone(delivery);
  }

  removeIngressDelivery(
    key: string,
    options: RemoveIngressDeliveryOptions = {},
  ): boolean {
    const before = this.snapshot.ingressDeliveries.length;
    this.snapshot.ingressDeliveries = this.snapshot.ingressDeliveries.filter(
      (candidate) => candidate.key !== key,
    );
    const removed = this.snapshot.ingressDeliveries.length !== before;
    if (removed && options.recordChange !== false) {
      this.recordChange();
    }
    return removed;
  }

  enqueueOutboundDelivery(
    input: EnqueueOutboundDeliveryInput,
  ): OutboundDelivery {
    const now = input.now ?? new Date().toISOString();
    const existing = this.snapshot.outboundDeliveries.find(
      (candidate) => candidate.key === input.key,
    );
    if (existing) {
      existing.kind = input.kind;
      existing.target = redactedRecord(input.target) ?? {};
      existing.payload = redactedRecord(input.payload) ?? {};
      existing.maxAttempts = normalizeOutboundMaxAttempts(input.maxAttempts);
      existing.updatedAt = now;
      if (existing.status === "failed") {
        existing.status = "queued";
        existing.nextAttemptAt = now;
        delete existing.lastError;
      }
      if (input.runId !== undefined) {
        existing.runId = input.runId;
      }
      if (input.approvalId !== undefined) {
        existing.approvalId = input.approvalId;
      }
      this.recordChange();
      return structuredClone(existing);
    }

    const delivery: OutboundDelivery = {
      id: createId("outbound"),
      orgId: this.snapshot.org.id,
      provider: "slack",
      kind: input.kind,
      key: input.key,
      status: "queued",
      target: redactedRecord(input.target) ?? {},
      payload: redactedRecord(input.payload) ?? {},
      attempts: 0,
      maxAttempts: normalizeOutboundMaxAttempts(input.maxAttempts),
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    };
    if (input.runId !== undefined) {
      delivery.runId = input.runId;
    }
    if (input.approvalId !== undefined) {
      delivery.approvalId = input.approvalId;
    }
    this.snapshot.outboundDeliveries.unshift(delivery);
    this.recordChange();
    return structuredClone(delivery);
  }

  listDueOutboundDeliveries(
    input: ListDueOutboundDeliveriesInput = {},
  ): OutboundDelivery[] {
    const nowMs = Date.parse(input.now ?? new Date().toISOString());
    const limit = Math.max(1, input.limit ?? 25);
    return this.snapshot.outboundDeliveries
      .filter(
        (delivery) =>
          delivery.status === "queued" &&
          (input.provider ? delivery.provider === input.provider : true) &&
          Date.parse(delivery.nextAttemptAt ?? delivery.createdAt) <= nowMs,
      )
      .sort((a, b) =>
        (a.nextAttemptAt ?? a.createdAt).localeCompare(
          b.nextAttemptAt ?? b.createdAt,
        ),
      )
      .slice(0, limit)
      .map((delivery) => structuredClone(delivery));
  }

  beginOutboundDelivery(
    id: string,
    input: { now?: string | undefined } = {},
  ): OutboundDelivery {
    const delivery = this.findOutboundDelivery(id);
    const now = input.now ?? new Date().toISOString();
    if (delivery.status !== "queued") {
      throw new Error("Outbound delivery is not queued.");
    }
    delivery.status = "delivering";
    delivery.attempts += 1;
    delivery.updatedAt = now;
    delete delivery.nextAttemptAt;
    this.recordChange();
    return structuredClone(delivery);
  }

  completeOutboundDelivery(
    id: string,
    input: { now?: string | undefined } = {},
  ): OutboundDelivery {
    const delivery = this.findOutboundDelivery(id);
    const now = input.now ?? new Date().toISOString();
    delivery.status = "delivered";
    delete delivery.lastError;
    delete delivery.nextAttemptAt;
    delivery.deliveredAt = now;
    delivery.updatedAt = now;
    this.recordChange();
    return structuredClone(delivery);
  }

  failOutboundDelivery(input: FailOutboundDeliveryInput): OutboundDelivery {
    const delivery = this.findOutboundDelivery(input.id);
    const now = input.now ?? new Date().toISOString();
    const retryable =
      input.retryable !== false && delivery.attempts < delivery.maxAttempts;
    delivery.status = retryable ? "queued" : "failed";
    delivery.lastError = redactSecrets(input.error).slice(0, 500);
    if (retryable) {
      delivery.nextAttemptAt = new Date(
        Date.parse(now) + Math.max(0, input.retryDelayMs ?? 1_000),
      ).toISOString();
    } else {
      delete delivery.nextAttemptAt;
    }
    delivery.updatedAt = now;
    this.recordChange();
    return structuredClone(delivery);
  }

  appendRunEvent(input: AppendRunEventInput): RunEvent {
    const run = this.findRun(input.runId);
    const event = createRunEvent(
      run.orgId,
      run.id,
      input.type,
      input.message,
      input.data,
      input.now,
    );
    this.snapshot.events.unshift(event);
    this.recordChange();
    return structuredClone(event);
  }

  setRunStatus(input: SetRunStatusInput): Run {
    const run = this.findRun(input.runId);
    const now = input.now ?? new Date().toISOString();
    run.status = input.status;
    if (input.actualCostCents !== undefined) {
      run.actualCostCents = input.actualCostCents;
    }
    run.updatedAt = now;
    this.snapshot.events.unshift(
      createRunEvent(
        run.orgId,
        run.id,
        eventTypeForStatus(input.status),
        input.message,
        input.data,
        now,
      ),
    );
    this.recordChange();
    return structuredClone(run);
  }

  upsertApprovalRequest(approval: ApprovalRequest): ApprovalRequest {
    const run = this.findRun(approval.runId);
    if (run.orgId !== approval.orgId) {
      throw new Error("Approval does not belong to the run organization.");
    }

    const existing = this.snapshot.approvals.find(
      (candidate) => candidate.id === approval.id,
    );
    if (existing) {
      Object.assign(existing, structuredClone(approval));
    } else {
      this.snapshot.approvals.unshift(structuredClone(approval));
    }
    this.recordChange();
    return structuredClone(approval);
  }

  private findOutboundDelivery(id: string): OutboundDelivery {
    const delivery = this.snapshot.outboundDeliveries.find(
      (candidate) => candidate.id === id,
    );
    if (!delivery) {
      throw new Error("Outbound delivery not found.");
    }
    return delivery;
  }

  private recordChange(): void {
    if (!this.onSnapshotChanged) {
      return;
    }

    const snapshot = this.read();
    this.persistenceQueue = this.persistenceQueue
      .then(() => {
        if (this.persistenceError) {
          return;
        }
        return this.onSnapshotChanged?.(snapshot);
      })
      .catch((error: unknown) => {
        this.persistenceError =
          error instanceof Error ? error : new Error(String(error));
      });
  }

  private findRun(runId: string): Run {
    const run = this.snapshot.runs.find((candidate) => candidate.id === runId);
    if (!run) {
      throw new Error("Run not found.");
    }
    return run;
  }

  private findPrincipal(principalId: string): Principal {
    const principal = this.snapshot.principals.find(
      (candidate) => candidate.id === principalId,
    );
    if (!principal) {
      throw new Error("Principal not found.");
    }
    return principal;
  }

  private findPlace(placeId: string): PlaceScope {
    const place = this.snapshot.places.find(
      (candidate) =>
        candidate.id === placeId || candidate.externalId === placeId,
    );
    if (!place) {
      throw new Error("Place not found.");
    }
    return place;
  }

  private findBundle(bundleId: string): AccessBundle {
    const bundle = this.snapshot.accessBundles.find(
      (candidate) => candidate.id === bundleId,
    );
    if (!bundle) {
      throw new Error("Access bundle not found.");
    }
    return bundle;
  }

  private findGrant(bundleId: string, grantId: string): CapabilityGrant {
    const bundle = this.findBundle(bundleId);
    const grant = bundle.grants.find((candidate) => candidate.id === grantId);
    if (!grant) {
      throw new Error("Grant not found.");
    }
    return grant;
  }

  private findModelPolicy(modelPolicyId: string): ModelPolicy {
    const policy = this.snapshot.modelPolicies.find(
      (candidate) => candidate.id === modelPolicyId,
    );
    if (!policy) {
      throw new Error("Model policy not found.");
    }
    return policy;
  }

  private findRuntimeProfile(runtimeProfileId: string): RuntimeProfile {
    const profile = this.snapshot.runtimeProfiles.find(
      (candidate) => candidate.id === runtimeProfileId,
    );
    if (!profile) {
      throw new Error("Runtime profile not found.");
    }
    return profile;
  }

  private resolveRunProfiles(capability: CapabilityKind | undefined): {
    modelPolicy: ModelPolicy;
    runtimeProfile: RuntimeProfile;
  } {
    const capabilityProfile = this.findCapabilityProfile(
      capabilityKindForCapability(capability),
    );
    return {
      modelPolicy: this.findModelPolicy(
        capabilityProfile?.modelPolicyId ??
          this.snapshot.agent.defaultModelPolicyId,
      ),
      runtimeProfile: this.findRuntimeProfile(
        capabilityProfile?.runtimeProfileId ??
          this.snapshot.agent.defaultRuntimeProfileId,
      ),
    };
  }

  private findCapabilityProfile(
    capabilityKind: CapabilityProfile["capabilityKind"],
  ): CapabilityProfile | undefined {
    return this.snapshot.capabilityProfiles.find(
      (profile) =>
        profile.orgId === this.snapshot.org.id &&
        profile.agentId === this.snapshot.agent.id &&
        profile.enabled &&
        profile.capabilityKind === capabilityKind,
    );
  }
}

function capabilityKindForCapability(
  capability: CapabilityKind | undefined,
): CapabilityProfile["capabilityKind"] {
  if (
    capability === "github.read" ||
    capability === "github.branch" ||
    capability === "github.pr" ||
    capability === "sandbox.exec"
  ) {
    return "coding";
  }
  if (
    capability === "linear.read" ||
    capability === "linear.write" ||
    capability === "mcp.tool"
  ) {
    return "workflow";
  }
  return "answer";
}

function eventTypeForStatus(status: RunStatus): RunEvent["type"] {
  if (status === "completed") {
    return "run.completed";
  }
  if (status === "failed") {
    return "run.failed";
  }
  return "run.status_changed";
}

function normalizeOutboundMaxAttempts(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 5;
  }
  return Math.max(1, Math.min(20, Math.floor(value)));
}

function assignOptional<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K],
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function redactedRecord(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return value === undefined
    ? undefined
    : (redactUnknown(value) as Record<string, unknown>);
}
