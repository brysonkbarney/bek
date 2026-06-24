export interface SlackPlainTextObject {
  type: "plain_text";
  text: string;
  emoji?: boolean;
}

export interface SlackMarkdownTextObject {
  type: "mrkdwn";
  text: string;
  verbatim?: boolean;
}

export type SlackTextObject = SlackPlainTextObject | SlackMarkdownTextObject;

export interface SlackButtonElement {
  type: "button";
  text: SlackPlainTextObject;
  action_id: string;
  value: string;
  style?: "primary" | "danger";
  confirm?: {
    title: SlackPlainTextObject;
    text: SlackTextObject;
    confirm: SlackPlainTextObject;
    deny: SlackPlainTextObject;
  };
}

export interface SlackSectionBlock {
  type: "section";
  block_id?: string;
  text?: SlackTextObject;
  fields?: SlackTextObject[];
  accessory?: SlackButtonElement;
}

export interface SlackContextBlock {
  type: "context";
  block_id?: string;
  elements: SlackTextObject[];
}

export interface SlackActionsBlock {
  type: "actions";
  block_id?: string;
  elements: SlackButtonElement[];
}

export interface SlackDividerBlock {
  type: "divider";
  block_id?: string;
}

export type SlackBlock =
  | SlackSectionBlock
  | SlackContextBlock
  | SlackActionsBlock
  | SlackDividerBlock;

export interface SlackMessagePayload {
  text: string;
  blocks?: SlackBlock[];
  thread_ts?: string;
  unfurl_links?: boolean;
  unfurl_media?: boolean;
}

export function slackPlainText(text: string): SlackPlainTextObject {
  return { type: "plain_text", text, emoji: true };
}

export function slackMarkdown(text: string): SlackMarkdownTextObject {
  return { type: "mrkdwn", text };
}

export function escapeSlackText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
