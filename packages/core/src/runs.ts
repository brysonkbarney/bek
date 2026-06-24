import { createHash } from "node:crypto";
import { createId } from "./ids";
import { redactSecrets, redactUnknown } from "./security";
import type {
  ApprovalRequest,
  ModelPolicy,
  Run,
  RunEvent,
  RuntimeProfile,
  TriggerKind,
} from "./types";

export interface CreateRunInput {
  orgId: string;
  agentId: string;
  requesterPrincipalId: string;
  placeScopeId: string;
  trigger: TriggerKind;
  prompt: string;
  modelPolicy: ModelPolicy;
  runtimeProfile: RuntimeProfile;
}

export function createRun(
  input: CreateRunInput,
  now = new Date().toISOString(),
): Run {
  return {
    id: createId("run"),
    orgId: input.orgId,
    agentId: input.agentId,
    requesterPrincipalId: input.requesterPrincipalId,
    placeScopeId: input.placeScopeId,
    trigger: input.trigger,
    prompt: input.prompt,
    status: "queued",
    modelPolicyId: input.modelPolicy.id,
    runtimeProfileId: input.runtimeProfile.id,
    estimatedCostCents: estimatePromptCostCents(
      input.prompt,
      input.modelPolicy,
    ),
    actualCostCents: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export function createRunEvent(
  orgId: string,
  runId: string,
  type: RunEvent["type"],
  message: string,
  data?: Record<string, unknown>,
  now = new Date().toISOString(),
): RunEvent {
  const event: RunEvent = {
    id: createId("event"),
    orgId,
    runId,
    type,
    message: redactSecrets(message),
    createdAt: now,
  };
  if (data) {
    event.data = redactUnknown(data) as Record<string, unknown>;
  }
  return event;
}

export function createApprovalRequest(
  orgId: string,
  runId: string,
  requestedByPrincipalId: string,
  action: string,
  payload: unknown,
  risk: ApprovalRequest["risk"],
  now = new Date().toISOString(),
  expiresAt = new Date(Date.parse(now) + 30 * 60 * 1000).toISOString(),
): ApprovalRequest {
  return {
    id: createId("approval"),
    orgId,
    runId,
    action,
    risk,
    status: "pending",
    payloadHash: hashPayload(payload),
    requestedByPrincipalId,
    createdAt: now,
    expiresAt,
  };
}

export function hashPayload(payload: unknown): string {
  return createHash("sha256").update(canonicalStringify(payload)).digest("hex");
}

export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(",")}]`;
  }
  return `{${Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([key, entry]) => `${JSON.stringify(key)}:${canonicalStringify(entry)}`,
    )
    .join(",")}}`;
}

export function estimatePromptCostCents(
  prompt: string,
  modelPolicy: ModelPolicy,
): number {
  const roughTokens = Math.ceil(prompt.length / 4);
  const roughCents = Math.max(1, Math.ceil(roughTokens / 1000));
  return Math.min(roughCents, modelPolicy.perRunBudgetCents);
}
