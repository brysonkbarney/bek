import { describe, expect, it } from "vitest";
import { parseSlackCommand } from "./commands";
import {
  buildSlackCommandDurableKey,
  buildSlackEventDurableKey,
  buildSlackInteractionDurableKey,
} from "./event-keys";

describe("Slack durable event keys", () => {
  it("uses Slack event_id when present", () => {
    expect(
      buildSlackEventDurableKey({
        team_id: "T123",
        event_id: "Ev123",
        event: { type: "app_mention" },
      }),
    ).toBe("slack:event:T123:Ev123");
  });

  it("falls back to stable event fields when event_id is absent", () => {
    expect(
      buildSlackEventDurableKey({
        team_id: "T123",
        event: {
          type: "reaction_added",
          user: "U123",
          item: { channel: "C123", ts: "1700000000.000001" },
        },
      }),
    ).toBe("slack:event:T123:reaction_added:C123:1700000000.000001:U123");

    expect(
      buildSlackEventDurableKey({
        team_id: "T123",
        event: {
          type: "member_joined_channel",
          user: "U_BEK",
          channel: "C123",
          event_ts: "1700000000.000002",
        },
      }),
    ).toBe(
      "slack:event:T123:member_joined_channel:C123:1700000000.000002:U_BEK",
    );

    expect(
      buildSlackEventDurableKey({
        team_id: "T123",
        event: {
          type: "channel_joined",
          channel: { id: "C123" },
          event_ts: "1700000000.000003",
        },
      }),
    ).toBe(
      "slack:event:T123:channel_joined:C123:1700000000.000003:unknown-actor",
    );
  });

  it("builds command and interaction keys", () => {
    const command = parseSlackCommand(
      new URLSearchParams({
        command: "/bek",
        text: "ship it",
        channel_id: "C123",
        user_id: "U123",
        team_id: "T123",
        trigger_id: "trigger.123",
      }).toString(),
    );

    expect(buildSlackCommandDurableKey(command)).toBe(
      "slack:command:T123:C123:U123:%2Fbek:trigger.123",
    );
    expect(
      buildSlackInteractionDurableKey({
        type: "approval",
        actionId: "bek.approval.approve",
        approvalId: "approval_123",
        payloadHash: "payload_hash_123456",
        decision: "approved",
        slackUserId: "U123",
        channelId: "C123",
        teamId: "T123",
        actionTs: "1700000000.000100",
      }),
    ).toBe(
      "slack:interaction:T123:C123:U123:bek.approval.approve:1700000000.000100",
    );
  });

  it("returns undefined when there is not enough identity", () => {
    expect(
      buildSlackEventDurableKey({ event: { type: "app_mention" } }),
    ).toBeUndefined();
    expect(
      buildSlackCommandDurableKey({
        command: "/bek",
        text: "hello",
      }),
    ).toBeUndefined();
  });
});
