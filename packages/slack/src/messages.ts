import {
  buildSlackApprovalActionsBlock,
  type SlackApprovalDecision,
} from "./approval-payloads";
import type { SlackBlock, SlackMessagePayload } from "./blocks";
import { escapeSlackText, slackMarkdown } from "./blocks";

export interface SlackRunQueuedMessageInput {
  runId: string;
  prompt: string;
  requesterName?: string;
  channelName?: string;
}

export interface SlackApprovalNeededMessageInput {
  runId: string;
  approvalId: string;
  payloadHash: string;
  action: string;
  risk: string;
  prompt?: string;
  requesterName?: string;
  expiresAt?: string;
}

export interface SlackApprovalDecidedMessageInput {
  runId: string;
  approvalId: string;
  decision: SlackApprovalDecision;
  decidedByName?: string;
}

export interface SlackFinalAnswerMessageInput {
  runId: string;
  answer: string;
  title?: string;
}

export function renderSlackRunQueuedMessage(
  input: SlackRunQueuedMessageInput,
): SlackMessagePayload {
  const blocks: SlackBlock[] = [
    {
      type: "section",
      text: slackMarkdown(
        `*Bek queued your request.*\n${quoteForSlack(input.prompt)}`,
      ),
    },
    contextBlock(
      [
        `Run \`${escapeSlackText(input.runId)}\``,
        input.requesterName
          ? `Requested by ${escapeSlackText(input.requesterName)}`
          : undefined,
        input.channelName
          ? `From ${escapeSlackText(input.channelName)}`
          : undefined,
      ].filter(Boolean) as string[],
    ),
  ];

  return {
    text: `Bek queued your request as ${input.runId}.`,
    blocks,
    unfurl_links: false,
    unfurl_media: false,
  };
}

export function renderSlackApprovalNeededMessage(
  input: SlackApprovalNeededMessageInput,
): SlackMessagePayload {
  const lines = [
    "*Bek needs approval before continuing.*",
    `Action: \`${escapeSlackText(input.action)}\``,
    `Risk: \`${escapeSlackText(input.risk)}\``,
  ];
  if (input.prompt) {
    lines.push(quoteForSlack(input.prompt));
  }

  const context = [
    `Run \`${escapeSlackText(input.runId)}\``,
    `Approval \`${escapeSlackText(input.approvalId)}\``,
    input.requesterName
      ? `Requested by ${escapeSlackText(input.requesterName)}`
      : undefined,
    input.expiresAt ? `Expires ${escapeSlackText(input.expiresAt)}` : undefined,
  ].filter(Boolean) as string[];

  return {
    text: `Bek needs approval for ${input.action}.`,
    blocks: [
      {
        type: "section",
        text: slackMarkdown(lines.join("\n")),
      },
      contextBlock(context),
      buildSlackApprovalActionsBlock({
        approvalId: input.approvalId,
        payloadHash: input.payloadHash,
        runId: input.runId,
        action: input.action,
      }),
    ],
    unfurl_links: false,
    unfurl_media: false,
  };
}

export function renderSlackApprovalDecidedMessage(
  input: SlackApprovalDecidedMessageInput,
): SlackMessagePayload {
  const verb = input.decision === "approved" ? "approved" : "denied";
  const context = [
    `Run \`${escapeSlackText(input.runId)}\``,
    `Approval \`${escapeSlackText(input.approvalId)}\``,
    input.decidedByName
      ? `Decided by ${escapeSlackText(input.decidedByName)}`
      : undefined,
  ].filter(Boolean) as string[];

  return {
    text: `Bek ${verb} the request for ${input.runId}.`,
    blocks: [
      {
        type: "section",
        text: slackMarkdown(`*Approval ${verb}.*`),
      },
      contextBlock(context),
    ],
  };
}

export function renderSlackFinalAnswerMessage(
  input: SlackFinalAnswerMessageInput,
): SlackMessagePayload {
  const title = input.title ?? "Bek finished.";
  return {
    text: `${title} ${input.answer}`,
    blocks: [
      {
        type: "section",
        text: slackMarkdown(
          `*${escapeSlackText(title)}*\n${escapeSlackText(
            truncate(input.answer, 2800),
          )}`,
        ),
      },
      contextBlock([`Run \`${escapeSlackText(input.runId)}\``]),
    ],
    unfurl_links: false,
    unfurl_media: false,
  };
}

function contextBlock(lines: string[]): SlackBlock {
  return {
    type: "context",
    elements: [slackMarkdown(lines.join(" | "))],
  };
}

function quoteForSlack(value: string): string {
  return escapeSlackText(truncate(value.trim(), 1200))
    .split("\n")
    .map((line) => `>${line}`)
    .join("\n");
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 3)}...`;
}
