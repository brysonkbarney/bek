export interface NormalizedSlackCommand {
  command: string;
  text: string;
  channelId?: string;
  userId?: string;
  teamId?: string;
  responseUrl?: string;
  triggerId?: string;
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

function addOptional<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: string | null,
) {
  if (value) {
    target[key] = value as T[K];
  }
}
