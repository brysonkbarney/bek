import { createHmac, timingSafeEqual } from "node:crypto";

export type GitHubWebhookBody = string | Uint8Array;

export interface VerifyGitHubWebhookSignatureInput {
  webhookSecret?: string | undefined;
  signature?: string | undefined;
  rawBody: GitHubWebhookBody;
  allowUnsigned?: boolean | undefined;
}

export function createGitHubWebhookSignature(
  webhookSecret: string,
  rawBody: GitHubWebhookBody,
): string {
  return `sha256=${createHmac("sha256", webhookSecret)
    .update(bodyToBuffer(rawBody))
    .digest("hex")}`;
}

export function verifyGitHubWebhookSignature(
  input: VerifyGitHubWebhookSignatureInput,
): boolean {
  const webhookSecret = input.webhookSecret?.trim();
  if (!webhookSecret) {
    return input.allowUnsigned === true;
  }
  if (!input.signature) {
    return false;
  }

  const signature = normalizeSignature(input.signature);
  if (!signature) {
    return false;
  }

  const expected = createGitHubWebhookSignature(webhookSecret, input.rawBody);
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signature);
  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, actualBuffer);
}

function bodyToBuffer(rawBody: GitHubWebhookBody): Buffer {
  return typeof rawBody === "string"
    ? Buffer.from(rawBody, "utf8")
    : Buffer.from(rawBody);
}

function normalizeSignature(signature: string): string | undefined {
  const normalized = signature.trim().toLowerCase();
  return /^sha256=[0-9a-f]{64}$/.test(normalized) ? normalized : undefined;
}
