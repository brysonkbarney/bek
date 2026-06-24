import { createSeedSnapshot } from "./seed";
import { bundlesForPlace, evaluatePolicy } from "./policy";
import { createApprovalRequest, createRun, createRunEvent } from "./runs";
import { createId } from "./ids";
import type {
  AccessBundle,
  AgentIdentity,
  BekSnapshot,
  CapabilityGrant,
  CapabilityKind,
  ModelPolicy,
  PlaceScope,
  Run,
  RuntimeProfile,
  TriggerKind,
} from "./types";

export interface ApprovalDecisionInput {
  principalId: string;
  payloadHash: string;
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

  createPlace(input: {
    kind: PlaceScope["kind"];
    provider: PlaceScope["provider"];
    externalId: string;
    name: string;
    sensitivity: PlaceScope["sensitivity"];
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
      ...input,
    };
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

  createRun(input: {
    prompt: string;
    placeScopeId: string;
    requesterPrincipalId?: string | undefined;
    trigger?: TriggerKind | undefined;
    capability?: CapabilityKind | undefined;
    resource?: string | undefined;
  }): Run {
    const modelPolicy = this.snapshot.modelPolicies[0];
    const runtimeProfile =
      input.capability === "github.pr" || input.capability === "sandbox.exec"
        ? this.snapshot.runtimeProfiles.find(
            (profile) => profile.runtimeKind === "opencode",
          )
        : this.snapshot.runtimeProfiles[0];

    if (!modelPolicy || !runtimeProfile) {
      throw new Error("Bek seed is missing model or runtime policies.");
    }

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
        `Bek queued: ${input.prompt}`,
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
      run.status = decision === "approved" ? "completed" : "cancelled";
      run.actualCostCents =
        decision === "approved" ? Math.max(1, run.estimatedCostCents) : 0;
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

  private recordChange(): void {
    if (!this.onSnapshotChanged) {
      return;
    }

    const snapshot = this.read();
    this.persistenceQueue = this.persistenceQueue
      .then(() => this.onSnapshotChanged?.(snapshot))
      .catch((error: unknown) => {
        this.persistenceError =
          error instanceof Error ? error : new Error(String(error));
      });
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
}
