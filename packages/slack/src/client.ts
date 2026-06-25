import type { SlackMessagePayload } from "./blocks";

const defaultSlackWebApiBaseUrl = "https://slack.com/api";

export interface SlackPostMessageInput extends SlackMessagePayload {
  channel: string;
}

export interface SlackUpdateMessageInput extends SlackMessagePayload {
  channel: string;
  ts: string;
}

export interface SlackPostEphemeralInput extends SlackMessagePayload {
  channel: string;
  user: string;
}

export interface SlackListChannelsInput {
  cursor?: string | undefined;
  limit?: number | undefined;
  types?: string | undefined;
  excludeArchived?: boolean | undefined;
}

export interface SlackDiscoveredChannel {
  id: string;
  name: string;
  isPrivate: boolean;
  isArchived: boolean;
  isMember: boolean;
  numMembers?: number | undefined;
}

export type SlackWebApiMessageResult =
  | {
      ok: true;
      channel: string;
      ts: string;
    }
  | {
      ok: false;
      error: string;
      retryAfterSeconds?: number | undefined;
    };

export type SlackWebApiChannelListResult =
  | {
      ok: true;
      channels: SlackDiscoveredChannel[];
      nextCursor?: string | undefined;
    }
  | {
      ok: false;
      error: string;
      retryAfterSeconds?: number | undefined;
    };

export interface SlackWebApiClient {
  postMessage(input: SlackPostMessageInput): Promise<SlackWebApiMessageResult>;
  updateMessage(
    input: SlackUpdateMessageInput,
  ): Promise<SlackWebApiMessageResult>;
  postEphemeral(
    input: SlackPostEphemeralInput,
  ): Promise<SlackWebApiMessageResult>;
  listChannels(
    input?: SlackListChannelsInput,
  ): Promise<SlackWebApiChannelListResult>;
}

export interface SlackWebApiHttpClientOptions {
  token: string;
  baseUrl?: string | undefined;
  fetch?: typeof fetch | undefined;
}

export class SlackWebApiHttpClient implements SlackWebApiClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SlackWebApiHttpClientOptions) {
    this.token = options.token.trim();
    this.baseUrl = (options.baseUrl ?? defaultSlackWebApiBaseUrl).replace(
      /\/$/,
      "",
    );
    this.fetchImpl = options.fetch ?? fetch;
  }

  async postMessage(
    input: SlackPostMessageInput,
  ): Promise<SlackWebApiMessageResult> {
    return this.call("chat.postMessage", input);
  }

  async updateMessage(
    input: SlackUpdateMessageInput,
  ): Promise<SlackWebApiMessageResult> {
    return this.call("chat.update", input);
  }

  async postEphemeral(
    input: SlackPostEphemeralInput,
  ): Promise<SlackWebApiMessageResult> {
    return this.call("chat.postEphemeral", input);
  }

  async listChannels(
    input: SlackListChannelsInput = {},
  ): Promise<SlackWebApiChannelListResult> {
    if (!this.token) {
      return { ok: false, error: "Slack bot token is missing." };
    }

    const params = new URLSearchParams();
    params.set("exclude_archived", String(input.excludeArchived ?? false));
    params.set("limit", String(input.limit ?? 100));
    params.set("types", input.types ?? "public_channel,private_channel");
    if (input.cursor) {
      params.set("cursor", input.cursor);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/conversations.list?${params.toString()}`,
        {
          method: "GET",
          headers: {
            authorization: `Bearer ${this.token}`,
          },
        },
      );
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error
            ? `Slack Web API conversations.list failed: ${error.message}`
            : "Slack Web API conversations.list failed.",
      };
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      return {
        ok: false,
        error: `Slack Web API conversations.list returned non-JSON HTTP ${response.status}.`,
        ...optionalNumber(
          "retryAfterSeconds",
          retryAfterSeconds(response.headers),
        ),
      };
    }
    if (!isRecord(raw)) {
      return {
        ok: false,
        error: "Slack Web API conversations.list returned an invalid response.",
      };
    }
    if (!response.ok || raw.ok !== true) {
      return {
        ok: false,
        error: slackWebApiError(raw, response.status),
        ...optionalNumber(
          "retryAfterSeconds",
          retryAfterSeconds(response.headers),
        ),
      };
    }
    if (!Array.isArray(raw.channels)) {
      return {
        ok: false,
        error:
          "Slack Web API conversations.list returned an invalid channel list.",
      };
    }

    return {
      ok: true,
      channels: raw.channels.flatMap(slackDiscoveredChannel),
      ...optionalString(
        "nextCursor",
        stringValue(
          isRecord(raw.response_metadata)
            ? raw.response_metadata.next_cursor
            : undefined,
        ),
      ),
    };
  }

  private async call(
    method: string,
    body:
      | SlackPostMessageInput
      | SlackUpdateMessageInput
      | SlackPostEphemeralInput,
  ): Promise<SlackWebApiMessageResult> {
    if (!this.token) {
      return { ok: false, error: "Slack bot token is missing." };
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/${method}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error
            ? `Slack Web API ${method} failed: ${error.message}`
            : `Slack Web API ${method} failed.`,
      };
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      return {
        ok: false,
        error: `Slack Web API ${method} returned non-JSON HTTP ${response.status}.`,
        ...optionalNumber(
          "retryAfterSeconds",
          retryAfterSeconds(response.headers),
        ),
      };
    }
    if (!isRecord(raw)) {
      return {
        ok: false,
        error: `Slack Web API ${method} returned an invalid response.`,
      };
    }
    if (!response.ok || raw.ok !== true) {
      return {
        ok: false,
        error: slackWebApiError(raw, response.status),
        ...optionalNumber(
          "retryAfterSeconds",
          retryAfterSeconds(response.headers),
        ),
      };
    }

    const channel = stringValue(raw.channel) ?? body.channel;
    const ts = stringValue(raw.ts) ?? stringValue(raw.message_ts);
    if (!ts) {
      return {
        ok: false,
        error: `Slack Web API ${method} did not return a message timestamp.`,
      };
    }
    return { ok: true, channel, ts };
  }
}

export interface FakeSlackWebApiClientOptions {
  failWith?: string;
  tsPrefix?: string;
  channels?: SlackDiscoveredChannel[];
  nextCursor?: string | undefined;
}

export class FakeSlackWebApiClient implements SlackWebApiClient {
  readonly postMessageCalls: SlackPostMessageInput[] = [];
  readonly updateMessageCalls: SlackUpdateMessageInput[] = [];
  readonly postEphemeralCalls: SlackPostEphemeralInput[] = [];
  readonly listChannelsCalls: SlackListChannelsInput[] = [];

  private counter = 0;

  constructor(private readonly options: FakeSlackWebApiClientOptions = {}) {}

  async postMessage(
    input: SlackPostMessageInput,
  ): Promise<SlackWebApiMessageResult> {
    this.postMessageCalls.push(structuredClone(input));
    return this.result(input.channel);
  }

  async updateMessage(
    input: SlackUpdateMessageInput,
  ): Promise<SlackWebApiMessageResult> {
    this.updateMessageCalls.push(structuredClone(input));
    if (this.options.failWith) {
      return { ok: false, error: this.options.failWith };
    }
    return { ok: true, channel: input.channel, ts: input.ts };
  }

  async postEphemeral(
    input: SlackPostEphemeralInput,
  ): Promise<SlackWebApiMessageResult> {
    this.postEphemeralCalls.push(structuredClone(input));
    return this.result(input.channel);
  }

  async listChannels(
    input: SlackListChannelsInput = {},
  ): Promise<SlackWebApiChannelListResult> {
    this.listChannelsCalls.push(structuredClone(input));
    if (this.options.failWith) {
      return { ok: false, error: this.options.failWith };
    }
    return {
      ok: true,
      channels: structuredClone(this.options.channels ?? []),
      ...optionalString("nextCursor", this.options.nextCursor),
    };
  }

  reset(): void {
    this.postMessageCalls.length = 0;
    this.updateMessageCalls.length = 0;
    this.postEphemeralCalls.length = 0;
    this.listChannelsCalls.length = 0;
    this.counter = 0;
  }

  private result(channel: string): SlackWebApiMessageResult {
    if (this.options.failWith) {
      return { ok: false, error: this.options.failWith };
    }
    this.counter += 1;
    return {
      ok: true,
      channel,
      ts: `${this.options.tsPrefix ?? "1700000000"}.${String(
        this.counter,
      ).padStart(6, "0")}`,
    };
  }
}

function slackWebApiError(
  raw: Record<string, unknown>,
  status: number,
): string {
  const error = stringValue(raw.error);
  if (error) {
    return error;
  }
  return `Slack Web API returned HTTP ${status}.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function slackDiscoveredChannel(value: unknown): SlackDiscoveredChannel[] {
  if (!isRecord(value)) {
    return [];
  }
  const id = stringValue(value.id);
  const name = stringValue(value.name);
  if (!id || !name) {
    return [];
  }
  const channel: SlackDiscoveredChannel = {
    id,
    name,
    isPrivate: value.is_private === true || value.is_group === true,
    isArchived: value.is_archived === true,
    isMember: value.is_member === true,
  };
  if (
    typeof value.num_members === "number" &&
    Number.isFinite(value.num_members)
  ) {
    channel.numMembers = value.num_members;
  }
  return [channel];
}

function optionalString<K extends string>(
  key: K,
  value: string | undefined,
): Partial<Record<K, string>> {
  return value ? ({ [key]: value } as Partial<Record<K, string>>) : {};
}

function optionalNumber<K extends string>(
  key: K,
  value: number | undefined,
): Partial<Record<K, number>> {
  return value === undefined
    ? {}
    : ({ [key]: value } as Partial<Record<K, number>>);
}

function retryAfterSeconds(headers: Headers): number | undefined {
  const value = headers.get("retry-after")?.trim();
  if (!value) {
    return undefined;
  }
  const seconds = Number.parseInt(value, 10);
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : undefined;
}
