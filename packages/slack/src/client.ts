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

export type SlackWebApiMessageResult =
  | {
      ok: true;
      channel: string;
      ts: string;
    }
  | {
      ok: false;
      error: string;
    };

export interface SlackWebApiClient {
  postMessage(input: SlackPostMessageInput): Promise<SlackWebApiMessageResult>;
  updateMessage(
    input: SlackUpdateMessageInput,
  ): Promise<SlackWebApiMessageResult>;
  postEphemeral(
    input: SlackPostEphemeralInput,
  ): Promise<SlackWebApiMessageResult>;
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
}

export class FakeSlackWebApiClient implements SlackWebApiClient {
  readonly postMessageCalls: SlackPostMessageInput[] = [];
  readonly updateMessageCalls: SlackUpdateMessageInput[] = [];
  readonly postEphemeralCalls: SlackPostEphemeralInput[] = [];

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

  reset(): void {
    this.postMessageCalls.length = 0;
    this.updateMessageCalls.length = 0;
    this.postEphemeralCalls.length = 0;
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
