import type { SlackMessagePayload } from "./blocks";

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
