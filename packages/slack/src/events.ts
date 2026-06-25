export interface NormalizedSlackInteraction {
  type:
    | "mention"
    | "reaction"
    | "dm"
    | "channel_joined"
    | "channel_left"
    | "app_uninstalled"
    | "tokens_revoked"
    | "url_verification"
    | "unknown";
  channelId?: string | undefined;
  channelName?: string | undefined;
  channelType?: string | undefined;
  teamId?: string | undefined;
  userId?: string | undefined;
  text?: string | undefined;
  reaction?: string | undefined;
  threadTs?: string | undefined;
  challenge?: string | undefined;
  isSelfJoin?: boolean | undefined;
  isSelfLeave?: boolean | undefined;
  revokedBotUserIds?: string[] | undefined;
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
  const teamId =
    stringValue(record.team_id) ?? nestedString(record, "team", "id");
  if (event.type === "channel_joined") {
    const channel =
      event.channel && typeof event.channel === "object"
        ? (event.channel as Record<string, unknown>)
        : undefined;
    return {
      type: "channel_joined",
      channelId:
        stringValue(channel?.id) ??
        (typeof event.channel === "string" ? event.channel : undefined),
      channelName: stringValue(channel?.name),
      teamId,
      userId: typeof event.user === "string" ? event.user : undefined,
      isSelfJoin: true,
    };
  }
  if (event.type === "member_joined_channel") {
    return {
      type: "channel_joined",
      channelId: typeof event.channel === "string" ? event.channel : undefined,
      channelName:
        typeof event.channel_name === "string" ? event.channel_name : undefined,
      channelType:
        typeof event.channel_type === "string" ? event.channel_type : undefined,
      teamId,
      userId: typeof event.user === "string" ? event.user : undefined,
      isSelfJoin: false,
    };
  }
  if (event.type === "channel_left") {
    return {
      type: "channel_left",
      channelId:
        typeof event.channel === "string"
          ? event.channel
          : nestedString(event, "channel", "id"),
      teamId,
      userId: typeof event.user === "string" ? event.user : undefined,
      isSelfLeave: true,
    };
  }
  if (event.type === "member_left_channel") {
    return {
      type: "channel_left",
      channelId: typeof event.channel === "string" ? event.channel : undefined,
      channelType:
        typeof event.channel_type === "string" ? event.channel_type : undefined,
      teamId,
      userId: typeof event.user === "string" ? event.user : undefined,
      isSelfLeave: false,
    };
  }
  if (event.type === "app_uninstalled") {
    return {
      type: "app_uninstalled",
      teamId,
    };
  }
  if (event.type === "tokens_revoked") {
    const tokens =
      event.tokens && typeof event.tokens === "object"
        ? (event.tokens as Record<string, unknown>)
        : undefined;
    return {
      type: "tokens_revoked",
      teamId,
      revokedBotUserIds: stringArray(tokens?.bot),
    };
  }
  if (typeof event.bot_id === "string" || event.subtype === "bot_message") {
    return { type: "unknown" };
  }
  if (
    event.type === "message" &&
    event.channel_type === "im" &&
    event.subtype === undefined
  ) {
    return {
      type: "dm",
      channelId: typeof event.channel === "string" ? event.channel : undefined,
      channelType: "im",
      teamId,
      userId: typeof event.user === "string" ? event.user : undefined,
      text: typeof event.text === "string" ? event.text : undefined,
      threadTs: slackThreadTs(event),
    };
  }
  if (event.type === "app_mention") {
    return {
      type: "mention",
      channelId: typeof event.channel === "string" ? event.channel : undefined,
      teamId,
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
      teamId,
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

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => stringValue(entry) !== undefined)
    : [];
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
  return stringValue((value as Record<string, unknown>)[child]);
}
