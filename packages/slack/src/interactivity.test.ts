import { describe, expect, it } from "vitest";
import {
  buildSlackCommandErrorResponse,
  buildSlackCommandIgnoredResponse,
  buildSlackCommandQueuedResponse,
  parseSlackCommand,
} from "./commands";
import { parseSlackInteraction } from "./interactivity";
import { buildSlackApprovalActionValue } from "./approval-payloads";

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

  it("builds slash command responses", () => {
    expect(buildSlackCommandQueuedResponse({ runId: "run_123" })).toEqual({
      ok: true,
      runId: "run_123",
      response_type: "ephemeral",
      text: "Bek queued this command as run_123.",
    });

    expect(
      buildSlackCommandIgnoredResponse({
        reason: "Bek is not configured for this Slack channel.",
      }),
    ).toMatchObject({
      ok: false,
      ignored: true,
      response_type: "ephemeral",
    });

    expect(
      buildSlackCommandErrorResponse({
        error: "Slack command payload is missing channel_id.",
        text: "Bek could not identify the Slack channel for this command.",
      }),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("channel_id"),
      response_type: "ephemeral",
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
            action_ts: "1700000000.000100",
            value: buildSlackApprovalActionValue({
              approvalId: "approval_123",
              payloadHash: "payload_hash_123456",
              runId: "run_123",
              action: "github.pr",
            }),
          },
        ],
        container: { message_ts: "1700000000.000001" },
        response_url: "https://hooks.slack.test/actions/123",
      }),
    }).toString();

    expect(parseSlackInteraction(body)).toMatchObject({
      type: "approval",
      decision: "denied",
      approvalId: "approval_123",
      payloadHash: "payload_hash_123456",
      runId: "run_123",
      action: "github.pr",
      slackUserId: "U123",
      channelId: "C123",
      teamId: "T123",
      responseUrl: "https://hooks.slack.test/actions/123",
      actionTs: "1700000000.000100",
      messageTs: "1700000000.000001",
    });
  });

  it("returns unsupported for malformed payloads", () => {
    expect(parseSlackInteraction("payload=not-json")).toMatchObject({
      type: "unsupported",
      reason: expect.stringContaining("valid JSON"),
    });
  });
});
