import { describe, expect, it } from "vitest";
import { parseSlackCommand } from "./commands";
import { parseSlackInteraction } from "./interactivity";

describe("Slack command parsing", () => {
  it("normalizes slash command form payloads", () => {
    const body = new URLSearchParams({
      command: "/bek",
      text: "ship it",
      channel_id: "C123",
      user_id: "U123",
      team_id: "T123",
    }).toString();

    expect(parseSlackCommand(body)).toMatchObject({
      command: "/bek",
      text: "ship it",
      channelId: "C123",
      userId: "U123",
      teamId: "T123",
    });
  });
});

describe("Slack interactivity parsing", () => {
  it("extracts approval actions from block actions", () => {
    const body = new URLSearchParams({
      payload: JSON.stringify({
        type: "block_actions",
        user: { id: "U123" },
        channel: { id: "C123" },
        team: { id: "T123" },
        actions: [
          {
            action_id: "bek.approval.deny",
            value: JSON.stringify({
              approvalId: "approval_123",
              payloadHash: "payload_hash_123456",
            }),
          },
        ],
      }),
    }).toString();

    expect(parseSlackInteraction(body)).toMatchObject({
      type: "approval",
      decision: "denied",
      approvalId: "approval_123",
      payloadHash: "payload_hash_123456",
      slackUserId: "U123",
      channelId: "C123",
      teamId: "T123",
    });
  });

  it("returns unsupported for malformed payloads", () => {
    expect(parseSlackInteraction("payload=not-json")).toMatchObject({
      type: "unsupported",
      reason: expect.stringContaining("valid JSON"),
    });
  });
});
