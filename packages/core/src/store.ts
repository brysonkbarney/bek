import { createSeedSnapshot } from "./seed";
import { bundlesForPlace, evaluatePolicy } from "./policy";
import { createApprovalRequest, createRun, createRunEvent } from "./runs";
import type { BekSnapshot, CapabilityKind, Run, TriggerKind } from "./types";

export interface ApprovalDecisionInput {
  principalId: string;
  payloadHash: string;
  now?: string | undefined;
}

export class BekStore {
  private snapshot: BekSnapshot;

  constructor(snapshot: BekSnapshot = createSeedSnapshot()) {
    this.snapshot = snapshot;
  }

  read(): BekSnapshot {
    return structuredClone(this.snapshot);
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

    return structuredClone(approval);
  }
}
