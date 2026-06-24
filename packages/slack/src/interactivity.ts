import {
  decisionFromSlackApprovalActionId,
  isSlackApprovalActionId,
  parseSlackApprovalActionValue,
  type SlackApprovalDecision,
} from "./approval-payloads";

export type { SlackApprovalDecision } from "./approval-payloads";

export interface SlackApprovalInteraction {
  type: "approval";
  actionId: string;
  approvalId: string;
  payloadHash: string;
  decision: SlackApprovalDecision;
  slackUserId?: string;
  channelId?: string;
  teamId?: string;
  responseUrl?: string;
  actionTs?: string;
  messageTs?: string;
}

export type SlackInteraction =
  | SlackApprovalInteraction
  | { type: "unsupported"; reason: string };

export function parseSlackInteraction(rawBody: string): SlackInteraction {
  const payloadText = new URLSearchParams(rawBody).get("payload");
  if (!payloadText) {
    return {
      type: "unsupported",
      reason: "Slack interaction is missing payload.",
    };
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(payloadText) as Record<string, unknown>;
  } catch {
    return {
      type: "unsupported",
      reason: "Slack interaction payload must be valid JSON.",
    };
  }

  const action = firstApprovalAction(payload);
  if (!action) {
    return {
      type: "unsupported",
      reason: "Slack interaction does not contain a Bek approval action.",
    };
  }

  const approvalPayload = parseSlackApprovalActionValue(action.value);
  const decision =
    approvalPayload.decision ?? decisionFromSlackApprovalActionId(action.id);
  if (
    !approvalPayload.approvalId ||
    !approvalPayload.payloadHash ||
    !decision
  ) {
    return {
      type: "unsupported",
      reason:
        "Bek approval action must include approvalId, payloadHash, and decision.",
    };
  }

  const interaction: SlackApprovalInteraction = {
    type: "approval",
    actionId: action.id,
    approvalId: approvalPayload.approvalId,
    payloadHash: approvalPayload.payloadHash,
    decision,
  };

  const slackUserId = nestedString(payload, "user", "id");
  const channelId = nestedString(payload, "channel", "id");
  const teamId = nestedString(payload, "team", "id");
  const responseUrl =
    typeof payload.response_url === "string" ? payload.response_url : undefined;

  if (slackUserId) {
    interaction.slackUserId = slackUserId;
  }
  if (channelId) {
    interaction.channelId = channelId;
  }
  if (teamId) {
    interaction.teamId = teamId;
  }
  if (responseUrl) {
    interaction.responseUrl = responseUrl;
  }
  if (action.actionTs) {
    interaction.actionTs = action.actionTs;
  }
  const messageTs = nestedString(payload, "container", "message_ts");
  if (messageTs) {
    interaction.messageTs = messageTs;
  }

  return interaction;
}

function firstApprovalAction(payload: Record<string, unknown>) {
  const actions = payload.actions;
  if (!Array.isArray(actions)) {
    return undefined;
  }

  for (const action of actions) {
    if (!action || typeof action !== "object") {
      continue;
    }
    const record = action as Record<string, unknown>;
    const id =
      typeof record.action_id === "string" ? record.action_id : undefined;
    const value = typeof record.value === "string" ? record.value : undefined;
    const actionTs =
      typeof record.action_ts === "string" ? record.action_ts : undefined;
    if (id && value && isSlackApprovalActionId(id)) {
      return { id, value, actionTs };
    }
  }

  return undefined;
}

function nestedString(
  payload: Record<string, unknown>,
  parent: string,
  child: string,
): string | undefined {
  const value = payload[parent];
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const childValue = (value as Record<string, unknown>)[child];
  return typeof childValue === "string" ? childValue : undefined;
}
