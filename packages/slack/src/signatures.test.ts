import { describe, expect, it } from "vitest";
import { createSlackSignature, verifySlackSignature } from "./signatures";

describe("Slack signatures", () => {
  it("fails closed without a signing secret unless explicitly allowed", () => {
    expect(
      verifySlackSignature({
        rawBody: "{}",
      }),
    ).toBe(false);
    expect(
      verifySlackSignature({
        rawBody: "{}",
        allowUnsigned: true,
      }),
    ).toBe(true);
  });

  it("fails closed when a signing secret is configured but signature fields are missing", () => {
    expect(
      verifySlackSignature({
        signingSecret: "secret",
        rawBody: "{}",
        allowUnsigned: true,
      }),
    ).toBe(false);
    expect(
      verifySlackSignature({
        signingSecret: "secret",
        timestamp: "1782320000",
        rawBody: "{}",
        allowUnsigned: true,
      }),
    ).toBe(false);
  });

  it("verifies a valid signature", () => {
    const rawBody = JSON.stringify({ hello: "world" });
    const timestamp = "1782320000";
    const signature = createSlackSignature("secret", timestamp, rawBody);
    expect(
      verifySlackSignature({
        signingSecret: "secret",
        timestamp,
        signature,
        rawBody,
        nowSeconds: 1782320010,
      }),
    ).toBe(true);
  });

  it("rejects replayed signatures", () => {
    const rawBody = "{}";
    const timestamp = "100";
    const signature = createSlackSignature("secret", timestamp, rawBody);
    expect(
      verifySlackSignature({
        signingSecret: "secret",
        timestamp,
        signature,
        rawBody,
        nowSeconds: 1000,
      }),
    ).toBe(false);
  });

  it("rejects malformed and future replay timestamps", () => {
    const rawBody = "{}";
    expect(
      verifySlackSignature({
        signingSecret: "secret",
        timestamp: "not-a-number",
        signature: createSlackSignature("secret", "not-a-number", rawBody),
        rawBody,
        nowSeconds: 1000,
      }),
    ).toBe(false);
    expect(
      verifySlackSignature({
        signingSecret: "secret",
        timestamp: "2000",
        signature: createSlackSignature("secret", "2000", rawBody),
        rawBody,
        nowSeconds: 1000,
      }),
    ).toBe(false);
  });

  it("rejects tampered bodies and signatures", () => {
    const rawBody = JSON.stringify({ command: "/bek", text: "ship it" });
    const timestamp = "1782320000";
    const signature = createSlackSignature("secret", timestamp, rawBody);

    expect(
      verifySlackSignature({
        signingSecret: "secret",
        timestamp,
        signature,
        rawBody: JSON.stringify({ command: "/bek", text: "ship everything" }),
        nowSeconds: 1782320000,
      }),
    ).toBe(false);

    const tamperedSignature = `${signature.slice(0, -1)}${signature.endsWith("0") ? "1" : "0"}`;
    expect(
      verifySlackSignature({
        signingSecret: "secret",
        timestamp,
        signature: tamperedSignature,
        rawBody,
        nowSeconds: 1782320000,
      }),
    ).toBe(false);
  });
});
