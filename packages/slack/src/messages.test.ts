import { describe, expect, it } from "vitest";
import {
  buildSlackApprovalActionsBlock,
  parseSlackApprovalActionValue,
  slackApprovalActionIds,
} from "./approval-payloads";
import type { SlackActionsBlock } from "./blocks";
import {
  renderSlackApprovalDecidedMessage,
  renderSlackApprovalNeededMessage,
  renderSlackFinalAnswerMessage,
  renderSlackRunQueuedMessage,
} from "./messages";

describe("Slack approval action payloads", () => {
  it("builds approval buttons with parseable values", () => {
    const block = buildSlackApprovalActionsBlock({
      approvalId: "approval_123",
      payloadHash: "payload_hash_123456",
      runId: "run_123",
      action: "github.pr",
    });

    expect(block.elements).toHaveLength(2);
    const approve = block.elements[0]!;
    const deny = block.elements[1]!;
    expect(approve.action_id).toBe(slackApprovalActionIds.approved);
    expect(deny.action_id).toBe(slackApprovalActionIds.denied);
    expect(parseSlackApprovalActionValue(approve.value)).toMatchObject({
      approvalId: "approval_123",
      payloadHash: "payload_hash_123456",
      runId: "run_123",
      action: "github.pr",
      decision: "approved",
      version: 1,
    });
    expect(parseSlackApprovalActionValue(deny.value)).toMatchObject({
      decision: "denied",
    });
  });

  it("keeps legacy approval value parsing", () => {
    expect(
      parseSlackApprovalActionValue(
        "approval_123|payload_hash_123456|approved",
      ),
    ).toEqual({
      approvalId: "approval_123",
      payloadHash: "payload_hash_123456",
      decision: "approved",
    });
    expect(parseSlackApprovalActionValue("null")).toEqual({});
  });
});

describe("Slack message rendering", () => {
  it("renders queued messages with escaped prompt text", () => {
    const message = renderSlackRunQueuedMessage({
      runId: "run_123",
      prompt: "@bek inspect <deploy> & report",
      requesterName: "Bryson",
      channelName: "#checkout-eng",
    });

    expect(message.text).toBe("Bek queued your request as run_123.");
    expect(JSON.stringify(message.blocks)).toContain(
      "&lt;deploy&gt; &amp; report",
    );
    expect(JSON.stringify(message.blocks)).toContain("Run `run_123`");
  });

  it("renders approval needed messages with approval actions", () => {
    const message = renderSlackApprovalNeededMessage({
      runId: "run_123",
      approvalId: "approval_123",
      payloadHash: "payload_hash_123456",
      action: "github.pr",
      risk: "write_external",
      prompt: "@bek open a PR",
      requesterName: "Bryson",
    });

    expect(message.text).toBe("Bek needs approval for github.pr.");
    const actions = message.blocks?.find(
      (block) => block.type === "actions",
    ) as SlackActionsBlock | undefined;
    expect(actions).toBeTruthy();
    expect(
      parseSlackApprovalActionValue(actions!.elements[0]!.value),
    ).toMatchObject({
      approvalId: "approval_123",
      payloadHash: "payload_hash_123456",
      runId: "run_123",
      action: "github.pr",
    });
  });

  it("renders approval decisions and final answers", () => {
    expect(
      renderSlackApprovalDecidedMessage({
        runId: "run_123",
        approvalId: "approval_123",
        decision: "approved",
        decidedByName: "Admin",
      }).text,
    ).toBe("Bek approved the request for run_123.");

    const finalAnswer = renderSlackFinalAnswerMessage({
      runId: "run_123",
      answer: "Done <https://example.test> & ready.",
    });
    expect(finalAnswer.text).toContain("Done");
    expect(JSON.stringify(finalAnswer.blocks)).toContain(
      "Done &lt;https://example.test&gt; &amp; ready.",
    );
  });
});
