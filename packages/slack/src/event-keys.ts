import type { NormalizedSlackCommand } from "./commands";
import type { SlackApprovalInteraction } from "./interactivity";

export function buildSlackEventDurableKey(
  payload: unknown,
): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  const eventId = stringValue(record.event_id);
  const teamId =
    stringValue(record.team_id) ?? nestedString(record, "team", "id");
  if (eventId) {
    return durableKey("slack", "event", teamId ?? "unknown-team", eventId);
  }

  const event = objectValue(record.event);
  if (!event) {
    return undefined;
  }

  const eventType = stringValue(event.type);
  const channelId =
    stringValue(event.channel) ??
    nestedString(event, "channel", "id") ??
    nestedString(event, "item", "channel");
  const eventTs =
    stringValue(event.event_ts) ??
    stringValue(event.ts) ??
    nestedString(event, "item", "ts") ??
    timestampValue(record.event_time);
  if (!eventType || !eventTs) {
    return undefined;
  }

  return durableKey(
    "slack",
    "event",
    teamId ?? "unknown-team",
    eventType,
    channelId ?? "workspace",
    eventTs,
    stringValue(event.user) ?? stringValue(event.bot_id) ?? "unknown-actor",
  );
}

export function buildSlackCommandDurableKey(
  command: NormalizedSlackCommand,
): string | undefined {
  if (!command.teamId || !command.channelId || !command.userId) {
    return undefined;
  }
  return durableKey(
    "slack",
    "command",
    command.teamId,
    command.channelId,
    command.userId,
    command.command || "/bek",
    command.triggerId || command.text || "no-trigger",
  );
}

export function buildSlackInteractionDurableKey(
  interaction: SlackApprovalInteraction,
): string | undefined {
  if (
    !interaction.teamId ||
    !interaction.channelId ||
    !interaction.slackUserId
  ) {
    return undefined;
  }
  return durableKey(
    "slack",
    "interaction",
    interaction.teamId,
    interaction.channelId,
    interaction.slackUserId,
    interaction.actionId,
    interaction.actionTs ??
      `${interaction.approvalId}:${interaction.payloadHash}:${interaction.decision}`,
  );
}

function durableKey(...parts: string[]): string {
  return parts.map((part) => encodeURIComponent(part)).join(":");
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function timestampValue(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return stringValue(value);
}

function nestedString(
  payload: Record<string, unknown>,
  parent: string,
  child: string,
): string | undefined {
  const value = objectValue(payload[parent]);
  if (!value) {
    return undefined;
  }
  return stringValue(value[child]);
}
