import type { SlackBlock } from "./blocks";

export interface NormalizedSlackCommand {
  command: string;
  text: string;
  channelId?: string;
  userId?: string;
  teamId?: string;
  responseUrl?: string;
  triggerId?: string;
}

export type SlackSlashCommandResponseType = "ephemeral" | "in_channel";

export interface SlackSlashCommandResponse {
  response_type: SlackSlashCommandResponseType;
  text: string;
  blocks?: SlackBlock[];
  ok?: boolean;
  ignored?: boolean;
  reason?: string;
  error?: string;
  runId?: string;
}

export function parseSlackCommand(rawBody: string): NormalizedSlackCommand {
  const params = new URLSearchParams(rawBody);
  const command: NormalizedSlackCommand = {
    command: params.get("command") ?? "",
    text: params.get("text") ?? "",
  };

  addOptional(command, "channelId", params.get("channel_id"));
  addOptional(command, "userId", params.get("user_id"));
  addOptional(command, "teamId", params.get("team_id"));
  addOptional(command, "responseUrl", params.get("response_url"));
  addOptional(command, "triggerId", params.get("trigger_id"));

  return command;
}

export function buildSlackCommandQueuedResponse(input: {
  runId: string;
}): SlackSlashCommandResponse {
  return {
    ok: true,
    runId: input.runId,
    response_type: "ephemeral",
    text: `Bek queued this command as ${input.runId}.`,
  };
}

export function buildSlackCommandIgnoredResponse(input: {
  reason: string;
  text?: string;
}): SlackSlashCommandResponse {
  return {
    ok: false,
    ignored: true,
    reason: input.reason,
    response_type: "ephemeral",
    text: input.text ?? input.reason,
  };
}

export function buildSlackCommandErrorResponse(input: {
  error: string;
  text: string;
}): SlackSlashCommandResponse {
  return {
    ok: false,
    error: input.error,
    response_type: "ephemeral",
    text: input.text,
  };
}

export function buildSlackEphemeralResponse(input: {
  text: string;
  ok?: boolean;
  ignored?: boolean;
  reason?: string;
  error?: string;
  blocks?: SlackBlock[];
}): SlackSlashCommandResponse {
  const response: SlackSlashCommandResponse = {
    response_type: "ephemeral",
    text: input.text,
  };
  addOptional(response, "ok", input.ok);
  addOptional(response, "ignored", input.ignored);
  addOptional(response, "reason", input.reason);
  addOptional(response, "error", input.error);
  addOptional(response, "blocks", input.blocks);
  return response;
}

function addOptional<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | null | undefined,
) {
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value === "string" && value.length === 0) {
    return;
  }
  target[key] = value;
}
