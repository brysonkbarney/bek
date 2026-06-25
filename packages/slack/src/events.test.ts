import { describe, expect, it } from "vitest";
import { normalizeSlackEvent } from "./events";

describe("Slack event normalization", () => {
  it("keeps message timestamps for threaded app mention replies", () => {
    expect(
      normalizeSlackEvent({
        team_id: "T123",
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
      teamId: "T123",
      userId: "U123",
      threadTs: "1700000000.000001",
    });

    expect(
      normalizeSlackEvent({
        team: { id: "T123" },
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
      teamId: "T123",
      threadTs: "1700000000.000001",
    });
  });

  it("keeps reaction item timestamps for threaded replies", () => {
    expect(
      normalizeSlackEvent({
        team_id: "T123",
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
      teamId: "T123",
      reaction: "eyes",
      threadTs: "1700000000.000003",
    });
  });

  it("normalizes Slack direct messages", () => {
    expect(
      normalizeSlackEvent({
        team_id: "T123",
        event: {
          type: "message",
          channel: "D123",
          user: "U123",
          text: "can you help here?",
          ts: "1700000000.000006",
          event_ts: "1700000000.000006",
          channel_type: "im",
        },
      }),
    ).toMatchObject({
      type: "dm",
      channelId: "D123",
      channelType: "im",
      teamId: "T123",
      userId: "U123",
      text: "can you help here?",
      threadTs: "1700000000.000006",
    });

    expect(
      normalizeSlackEvent({
        team_id: "T123",
        event: {
          type: "message",
          channel: "D123",
          user: "U123",
          text: "edited",
          subtype: "message_changed",
          channel_type: "im",
        },
      }),
    ).toEqual({ type: "unknown" });
  });

  it("normalizes bot channel join events", () => {
    expect(
      normalizeSlackEvent({
        team_id: "T123",
        event: {
          type: "member_joined_channel",
          user: "U_BEK",
          channel: "C123",
          channel_type: "C",
          event_ts: "1700000000.000004",
        },
      }),
    ).toMatchObject({
      type: "channel_joined",
      channelId: "C123",
      teamId: "T123",
      userId: "U_BEK",
      channelType: "C",
      isSelfJoin: false,
    });

    expect(
      normalizeSlackEvent({
        team: { id: "T456" },
        event: {
          type: "member_joined_channel",
          user: "U_BEK",
          channel: "G123",
          channel_name: "private-team",
          channel_type: "G",
        },
      }),
    ).toMatchObject({
      type: "channel_joined",
      channelId: "G123",
      channelName: "private-team",
      teamId: "T456",
    });
  });

  it("normalizes Slack app channel_joined callbacks", () => {
    expect(
      normalizeSlackEvent({
        team_id: "T123",
        event: {
          type: "channel_joined",
          channel: {
            id: "C123",
            name: "checkout",
          },
        },
      }),
    ).toMatchObject({
      type: "channel_joined",
      channelId: "C123",
      channelName: "checkout",
      teamId: "T123",
      isSelfJoin: true,
    });
  });

  it("normalizes bot channel leave events", () => {
    expect(
      normalizeSlackEvent({
        team_id: "T123",
        event: {
          type: "member_left_channel",
          user: "U_BEK",
          channel: "C123",
          channel_type: "C",
          event_ts: "1700000000.000005",
        },
      }),
    ).toMatchObject({
      type: "channel_left",
      channelId: "C123",
      teamId: "T123",
      userId: "U_BEK",
      channelType: "C",
      isSelfLeave: false,
    });

    expect(
      normalizeSlackEvent({
        team_id: "T123",
        event: {
          type: "channel_left",
          channel: { id: "G123" },
        },
      }),
    ).toMatchObject({
      type: "channel_left",
      channelId: "G123",
      teamId: "T123",
      isSelfLeave: true,
    });
  });

  it("normalizes Slack workspace lifecycle events", () => {
    expect(
      normalizeSlackEvent({
        team_id: "T123",
        event: {
          type: "app_uninstalled",
        },
      }),
    ).toMatchObject({
      type: "app_uninstalled",
      teamId: "T123",
    });

    expect(
      normalizeSlackEvent({
        team_id: "T123",
        event: {
          type: "tokens_revoked",
          tokens: {
            bot: ["U_BEK", "U_OTHER"],
          },
        },
      }),
    ).toMatchObject({
      type: "tokens_revoked",
      teamId: "T123",
      revokedBotUserIds: ["U_BEK", "U_OTHER"],
    });
  });
});
