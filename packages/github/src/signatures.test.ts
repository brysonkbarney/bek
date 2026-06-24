import { describe, expect, it } from "vitest";
import {
  createGitHubWebhookSignature,
  verifyGitHubWebhookSignature,
} from "./signatures";

describe("GitHub webhook signatures", () => {
  it("fails closed without a webhook secret unless unsigned mode is explicit", () => {
    expect(
      verifyGitHubWebhookSignature({
        rawBody: "{}",
      }),
    ).toBe(false);
    expect(
      verifyGitHubWebhookSignature({
        rawBody: "{}",
        allowUnsigned: true,
      }),
    ).toBe(true);
  });

  it("verifies a valid sha256 webhook signature", () => {
    const rawBody = JSON.stringify({ action: "opened" });
    const signature = createGitHubWebhookSignature("secret", rawBody);

    expect(
      verifyGitHubWebhookSignature({
        webhookSecret: "secret",
        signature,
        rawBody,
      }),
    ).toBe(true);
  });

  it("rejects tampered bodies, missing signatures, and legacy sha1 signatures", () => {
    const rawBody = JSON.stringify({ action: "opened" });
    const signature = createGitHubWebhookSignature("secret", rawBody);

    expect(
      verifyGitHubWebhookSignature({
        webhookSecret: "secret",
        rawBody,
      }),
    ).toBe(false);
    expect(
      verifyGitHubWebhookSignature({
        webhookSecret: "secret",
        signature,
        rawBody: JSON.stringify({ action: "closed" }),
      }),
    ).toBe(false);
    expect(
      verifyGitHubWebhookSignature({
        webhookSecret: "secret",
        signature: signature.replace("sha256", "sha1"),
        rawBody,
      }),
    ).toBe(false);
  });

  it("supports byte bodies and case-insensitive signature headers", () => {
    const rawBody = Buffer.from(
      JSON.stringify({ zen: "Keep it logically awesome." }),
    );
    const signature = createGitHubWebhookSignature("secret", rawBody);

    expect(
      verifyGitHubWebhookSignature({
        webhookSecret: "secret",
        signature: signature.toUpperCase(),
        rawBody,
      }),
    ).toBe(true);
  });
});
