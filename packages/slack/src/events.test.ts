import { describe, expect, it } from "vitest";
import { normalizeSlackEvent } from "./events";

describe("Slack event normalization", () => {
  it("keeps message timestamps for threaded app mention replies", () => {
    expect(
      normalizeSlackEvent({
        event: {
          type: "app_mention",
          channel: "C123",
          user: "U123",
          text: "@bek summarize this",
          ts: "1700000000.000001",
        },
      }),
    ).toMatchObject({
      type: "mention",
      channelId: "C123",
      userId: "U123",
      threadTs: "1700000000.000001",
    });

    expect(
      normalizeSlackEvent({
        event: {
          type: "app_mention",
          channel: "C123",
          user: "U123",
          text: "@bek continue",
          ts: "1700000000.000002",
          thread_ts: "1700000000.000001",
        },
      }),
    ).toMatchObject({
      type: "mention",
      threadTs: "1700000000.000001",
    });
  });

  it("keeps reaction item timestamps for threaded replies", () => {
    expect(
      normalizeSlackEvent({
        event: {
          type: "reaction_added",
          user: "U123",
          reaction: "eyes",
          item: {
            channel: "C123",
            ts: "1700000000.000003",
          },
        },
      }),
    ).toMatchObject({
      type: "reaction",
      channelId: "C123",
      reaction: "eyes",
      threadTs: "1700000000.000003",
    });
  });
});
