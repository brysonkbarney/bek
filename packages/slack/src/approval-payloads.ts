import type { SlackActionsBlock, SlackButtonElement } from "./blocks";
import { slackMarkdown, slackPlainText } from "./blocks";

export type SlackApprovalDecision = "approved" | "denied";

export const slackApprovalActionIds = {
  approved: "bek.approval.approve",
  denied: "bek.approval.deny",
} as const satisfies Record<SlackApprovalDecision, string>;

const legacySlackApprovalActionIds = new Set([
  "bek_approval_approve",
  "bek_approval_deny",
]);
const slackApprovalActionIdSet = new Set<string>(
  Object.values(slackApprovalActionIds),
);

export interface SlackApprovalActionValueInput {
  approvalId: string;
  payloadHash: string;
  decision?: SlackApprovalDecision;
  runId?: string;
  action?: string;
}

export interface ParsedSlackApprovalActionValue {
  approvalId?: string;
  payloadHash?: string;
  decision?: SlackApprovalDecision;
  runId?: string;
  action?: string;
  version?: number;
}

export interface SlackApprovalButtonInput extends SlackApprovalActionValueInput {
  decision: SlackApprovalDecision;
}

export function buildSlackApprovalActionValue(
  input: SlackApprovalActionValueInput,
): string {
  const payload: Record<string, unknown> = {
    version: 1,
    approvalId: input.approvalId,
    payloadHash: input.payloadHash,
  };
  if (input.decision) {
    payload.decision = input.decision;
  }
  if (input.runId) {
    payload.runId = input.runId;
  }
  if (input.action) {
    payload.action = input.action;
  }
  return JSON.stringify(payload);
}

export function parseSlackApprovalActionValue(
  value: string,
): ParsedSlackApprovalActionValue {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const record = parsed as Record<string, unknown>;
    const result: ParsedSlackApprovalActionValue = {};
    addString(result, "approvalId", record.approvalId);
    addString(result, "payloadHash", record.payloadHash);
    addString(result, "runId", record.runId);
    addString(result, "action", record.action);
    if (record.decision === "approved" || record.decision === "denied") {
      result.decision = record.decision;
    }
    if (typeof record.version === "number" && Number.isFinite(record.version)) {
      result.version = record.version;
    }
    return result;
  } catch {
    const [approvalId, payloadHash, decision] = value.split("|");
    const result: ParsedSlackApprovalActionValue = {};
    if (approvalId) {
      result.approvalId = approvalId;
    }
    if (payloadHash) {
      result.payloadHash = payloadHash;
    }
    if (decision === "approved" || decision === "denied") {
      result.decision = decision;
    }
    return result;
  }
}

export function buildSlackApprovalButton(
  input: SlackApprovalButtonInput,
): SlackButtonElement {
  return {
    type: "button",
    text: slackPlainText(input.decision === "approved" ? "Approve" : "Deny"),
    style: input.decision === "approved" ? "primary" : "danger",
    action_id: slackApprovalActionIds[input.decision],
    value: buildSlackApprovalActionValue(input),
    confirm: {
      title: slackPlainText(
        input.decision === "approved" ? "Approve request?" : "Deny request?",
      ),
      text: slackMarkdown(
        input.decision === "approved"
          ? "Bek will continue this run."
          : "Bek will stop this run.",
      ),
      confirm: slackPlainText(
        input.decision === "approved" ? "Approve" : "Deny",
      ),
      deny: slackPlainText("Cancel"),
    },
  };
}

export function buildSlackApprovalActionsBlock(
  input: SlackApprovalActionValueInput,
): SlackActionsBlock {
  return {
    type: "actions",
    block_id: `bek.approval.actions.${input.approvalId}`,
    elements: [
      buildSlackApprovalButton({
        ...input,
        decision: "approved",
      }),
      buildSlackApprovalButton({
        ...input,
        decision: "denied",
      }),
    ],
  };
}

export function isSlackApprovalActionId(actionId: string): boolean {
  return (
    slackApprovalActionIdSet.has(actionId) ||
    legacySlackApprovalActionIds.has(actionId)
  );
}

export function decisionFromSlackApprovalActionId(
  actionId: string,
): SlackApprovalDecision | undefined {
  if (actionId.endsWith(".approve") || actionId.endsWith("_approve")) {
    return "approved";
  }
  if (actionId.endsWith(".deny") || actionId.endsWith("_deny")) {
    return "denied";
  }
  return undefined;
}

function addString<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: unknown,
) {
  if (typeof value === "string" && value.length > 0) {
    target[key] = value as T[K];
  }
}
