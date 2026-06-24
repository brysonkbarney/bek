export interface NormalizedSlackInteraction {
  type: "mention" | "reaction" | "url_verification" | "unknown";
  channelId?: string | undefined;
  userId?: string | undefined;
  text?: string | undefined;
  reaction?: string | undefined;
  threadTs?: string | undefined;
  challenge?: string | undefined;
}

export function normalizeSlackEvent(
  payload: unknown,
): NormalizedSlackInteraction {
  if (!payload || typeof payload !== "object") {
    return { type: "unknown" };
  }
  const record = payload as Record<string, unknown>;
  if (
    record.type === "url_verification" &&
    typeof record.challenge === "string"
  ) {
    return { type: "url_verification", challenge: record.challenge };
  }
  const event = record.event as Record<string, unknown> | undefined;
  if (!event) {
    return { type: "unknown" };
  }
  if (typeof event.bot_id === "string" || event.subtype === "bot_message") {
    return { type: "unknown" };
  }
  if (event.type === "app_mention") {
    return {
      type: "mention",
      channelId: typeof event.channel === "string" ? event.channel : undefined,
      userId: typeof event.user === "string" ? event.user : undefined,
      text: typeof event.text === "string" ? event.text : undefined,
      threadTs: slackThreadTs(event),
    };
  }
  if (event.type === "reaction_added") {
    return {
      type: "reaction",
      channelId:
        typeof (event.item as Record<string, unknown> | undefined)?.channel ===
        "string"
          ? ((event.item as Record<string, unknown>).channel as string)
          : undefined,
      userId: typeof event.user === "string" ? event.user : undefined,
      reaction: typeof event.reaction === "string" ? event.reaction : undefined,
      threadTs: slackThreadTs(event.item),
    };
  }
  return { type: "unknown" };
}

function slackThreadTs(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return stringValue(record.thread_ts) ?? stringValue(record.ts);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
