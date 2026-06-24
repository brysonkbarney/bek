import { BekStore } from "@bek/core";
import type {
  SlackPostEphemeralInput,
  SlackPostMessageInput,
  SlackUpdateMessageInput,
  SlackWebApiClient,
  SlackWebApiMessageResult,
} from "@bek/slack";
import { describe, expect, it } from "vitest";
import { SlackOutboundDelivery } from "./slack-outbound";

class SequenceSlackWebApiClient implements SlackWebApiClient {
  readonly postMessageCalls: SlackPostMessageInput[] = [];

  constructor(private readonly results: SlackWebApiMessageResult[]) {}

  async postMessage(
    input: SlackPostMessageInput,
  ): Promise<SlackWebApiMessageResult> {
    this.postMessageCalls.push(structuredClone(input));
    return (
      this.results.shift() ?? {
        ok: true,
        channel: input.channel,
        ts: "1710000000.000999",
      }
    );
  }

  async updateMessage(
    _input: SlackUpdateMessageInput,
  ): Promise<SlackWebApiMessageResult> {
    throw new Error("Unexpected Slack updateMessage call.");
  }

  async postEphemeral(
    _input: SlackPostEphemeralInput,
  ): Promise<SlackWebApiMessageResult> {
    throw new Error("Unexpected Slack postEphemeral call.");
  }
}

function createCompletedSlackRun(store: BekStore) {
  return store.createRun({
    prompt: "@bek say hello",
    placeScopeId: "place_checkout",
    trigger: "mention",
    capability: "slack.read",
    resource: "slack:C_CHECKOUT",
  });
}

describe("SlackOutboundDelivery", () => {
  it("retries transient Slack post failures and records attempt diagnostics", async () => {
    const store = new BekStore();
    const run = createCompletedSlackRun(store);
    const client = new SequenceSlackWebApiClient([
      {
        ok: false,
        error: "Slack Web API chat.postMessage returned non-JSON HTTP 502.",
      },
      {
        ok: true,
        channel: "C_CHECKOUT",
        ts: "1710000000.000123",
      },
    ]);
    const delivery = new SlackOutboundDelivery(store, client, {
      env: {},
      retryDelayMs: 0,
    });

    await delivery.deliverRunOutcome(run.id, {
      channelId: "C_CHECKOUT",
      threadTs: "1710000000.000001",
      teamId: "T123",
    });

    expect(client.postMessageCalls).toHaveLength(2);
    expect(store.read().events[0]).toMatchObject({
      runId: run.id,
      message: "Slack final_answer message posted after 2 attempts.",
      data: {
        slackOutbound: {
          kind: "final_answer",
          ok: true,
          channel: "C_CHECKOUT",
          threadTs: "1710000000.000001",
          ts: "1710000000.000123",
          attempts: 2,
          retried: true,
          attemptLog: [
            {
              attempt: 1,
              ok: false,
              error:
                "Slack Web API chat.postMessage returned non-JSON HTTP 502.",
              failureCategory: "transient",
              retryable: true,
            },
            { attempt: 2, ok: true },
          ],
        },
      },
    });
  });

  it("does not retry permanent Slack failures and redacts stored errors", async () => {
    const store = new BekStore();
    const run = createCompletedSlackRun(store);
    const leakedToken = "xoxb-this-secret-token-should-redact";
    const client = new SequenceSlackWebApiClient([
      {
        ok: false,
        error: `invalid_auth for ${leakedToken}`,
      },
    ]);
    const delivery = new SlackOutboundDelivery(store, client, {
      env: {},
      retryDelayMs: 0,
    });

    await delivery.deliverRunOutcome(run.id, {
      channelId: "C_CHECKOUT",
      teamId: "T123",
    });

    expect(client.postMessageCalls).toHaveLength(1);
    expect(JSON.stringify(store.read())).not.toContain(leakedToken);
    expect(store.read().events[0]).toMatchObject({
      runId: run.id,
      message:
        "Slack final_answer message failed: invalid_auth for [redacted:slack-token].",
      data: {
        slackOutbound: {
          kind: "final_answer",
          ok: false,
          channel: "C_CHECKOUT",
          attempts: 1,
          error: "invalid_auth for [redacted:slack-token]",
          failureCategory: "auth",
          retryable: false,
        },
      },
    });
  });
});
