export type SlackApprovalDecision = "approved" | "denied";

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

  const approvalPayload = parseApprovalValue(action.value);
  const decision = approvalPayload.decision ?? decisionFromActionId(action.id);
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
    if (id && value && isApprovalActionId(id)) {
      return { id, value };
    }
  }

  return undefined;
}

function isApprovalActionId(actionId: string): boolean {
  return (
    actionId === "bek.approval.approve" ||
    actionId === "bek.approval.deny" ||
    actionId === "bek_approval_approve" ||
    actionId === "bek_approval_deny"
  );
}

function decisionFromActionId(
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

function parseApprovalValue(value: string): {
  approvalId?: string;
  payloadHash?: string;
  decision?: SlackApprovalDecision;
} {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const result: {
      approvalId?: string;
      payloadHash?: string;
      decision?: SlackApprovalDecision;
    } = {};
    if (typeof parsed.approvalId === "string") {
      result.approvalId = parsed.approvalId;
    }
    if (typeof parsed.payloadHash === "string") {
      result.payloadHash = parsed.payloadHash;
    }
    if (parsed.decision === "approved" || parsed.decision === "denied") {
      result.decision = parsed.decision;
    }
    return result;
  } catch {
    const [approvalId, payloadHash, decision] = value.split("|");
    const result: {
      approvalId?: string;
      payloadHash?: string;
      decision?: SlackApprovalDecision;
    } = {};
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
