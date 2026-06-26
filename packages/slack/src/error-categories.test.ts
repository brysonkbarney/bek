import { describe, expect, it } from "vitest";
import {
  classifySlackError,
  decideSlackBackoff,
  type SlackErrorCategory,
} from "./error-categories";

describe("classifySlackError", () => {
  it("categorizes Slack rate limiting from the error string and honors Retry-After", () => {
    const result = classifySlackError({
      error: "ratelimited",
      status: 429,
      retryAfterSeconds: 7,
    });
    expect(result).toEqual({
      category: "rate_limited",
      retryable: true,
      operatorActionRequired: false,
      retryAfterMs: 7000,
      reason: expect.stringContaining("rate limited"),
    });
  });

  it("categorizes rate limiting from HTTP 429 even without an error token", () => {
    const result = classifySlackError({
      error: "too many requests",
      status: 429,
    });
    expect(result.category).toBe("rate_limited");
    expect(result.retryable).toBe(true);
    // No Retry-After provided -> no hint.
    expect(result.retryAfterMs).toBeUndefined();
  });

  it("prefers retryAfterMs over retryAfterSeconds", () => {
    const result = classifySlackError({
      error: "ratelimited",
      retryAfterMs: 1234,
      retryAfterSeconds: 99,
    });
    expect(result.retryAfterMs).toBe(1234);
  });

  it("categorizes not_in_channel as operator-actionable and non-retryable", () => {
    const result = classifySlackError({ error: "not_in_channel" });
    expect(result.category).toBe("not_in_channel");
    expect(result.retryable).toBe(false);
    expect(result.operatorActionRequired).toBe(true);
  });

  it("categorizes channel_not_found", () => {
    const result = classifySlackError({ error: "channel_not_found" });
    expect(result.category).toBe("channel_not_found");
    expect(result.retryable).toBe(false);
    expect(result.operatorActionRequired).toBe(true);
  });

  it("categorizes archived channels (is_archived)", () => {
    const result = classifySlackError({ error: "is_archived" });
    expect(result.category).toBe("channel_archived");
    expect(result.operatorActionRequired).toBe(true);
  });

  it("categorizes bot removal (account_inactive) as bot_removed", () => {
    const result = classifySlackError({ error: "account_inactive" });
    expect(result.category).toBe("bot_removed");
    expect(result.retryable).toBe(false);
    expect(result.operatorActionRequired).toBe(true);
  });

  it("categorizes token revocation and invalid auth as token_revoked", () => {
    for (const error of ["token_revoked", "invalid_auth", "not_authed"]) {
      const result = classifySlackError({ error });
      expect(result.category).toBe("token_revoked");
      expect(result.retryable).toBe(false);
      expect(result.operatorActionRequired).toBe(true);
    }
  });

  it("categorizes missing_scope", () => {
    const result = classifySlackError({ error: "missing_scope" });
    expect(result.category).toBe("missing_scope");
    expect(result.operatorActionRequired).toBe(true);
  });

  it("categorizes missing-token configuration errors", () => {
    const result = classifySlackError({
      error: "Slack bot token is missing.",
    });
    expect(result.category).toBe("config");
    expect(result.retryable).toBe(false);
    expect(result.operatorActionRequired).toBe(true);
  });

  it("categorizes payload validation errors as non-retryable payload", () => {
    for (const error of ["invalid_blocks", "msg_too_long", "no_text"]) {
      const result = classifySlackError({ error });
      expect(result.category).toBe("payload");
      expect(result.retryable).toBe(false);
      expect(result.operatorActionRequired).toBe(false);
    }
  });

  it("categorizes Slack 5xx as a retryable outage", () => {
    const fromStatus = classifySlackError({
      error: "Slack Web API chat.postMessage returned non-JSON HTTP 503.",
      status: 503,
    });
    expect(fromStatus.category).toBe("slack_outage");
    expect(fromStatus.retryable).toBe(true);
    expect(fromStatus.operatorActionRequired).toBe(false);

    const fromText = classifySlackError({
      error: "service_unavailable",
    });
    expect(fromText.category).toBe("slack_outage");
  });

  it("attaches Retry-After to outage classifications when present", () => {
    const result = classifySlackError({ status: 503, retryAfterSeconds: 2 });
    expect(result.category).toBe("slack_outage");
    expect(result.retryAfterMs).toBe(2000);
  });

  it("categorizes network/protocol noise as transient", () => {
    for (const error of [
      "fetch failed",
      "ETIMEDOUT",
      "socket hang up",
      "Slack Web API chat.postMessage returned an invalid response.",
    ]) {
      const result = classifySlackError({ error });
      expect(result.category).toBe("transient");
      expect(result.retryable).toBe(true);
    }
  });

  it("falls back to fatal for unrecognized, non-retryable errors", () => {
    const result = classifySlackError({ error: "some_brand_new_slack_error" });
    expect(result.category).toBe("fatal");
    expect(result.retryable).toBe(false);
    expect(result.operatorActionRequired).toBe(false);
    expect(result.retryAfterMs).toBeUndefined();
  });

  it("treats empty input as fatal", () => {
    expect(classifySlackError({}).category).toBe("fatal");
  });

  it("ignores negative or non-finite Retry-After values", () => {
    expect(
      classifySlackError({ error: "ratelimited", retryAfterSeconds: -1 })
        .retryAfterMs,
    ).toBeUndefined();
    expect(
      classifySlackError({ error: "ratelimited", retryAfterMs: Number.NaN })
        .retryAfterMs,
    ).toBeUndefined();
  });

  it("never attaches Retry-After to non-retryable categories", () => {
    const result = classifySlackError({
      error: "channel_not_found",
      retryAfterSeconds: 5,
    });
    expect(result.retryAfterMs).toBeUndefined();
  });
});

describe("decideSlackBackoff", () => {
  const retryable = classifySlackError({ error: "service_unavailable" });
  const rateLimited = (retryAfterSeconds: number) =>
    classifySlackError({ error: "ratelimited", retryAfterSeconds });

  it("gives up immediately on non-retryable categories", () => {
    const fatal = classifySlackError({ error: "invalid_auth" });
    const decision = decideSlackBackoff(fatal, 1);
    expect(decision.retry).toBe(false);
    expect(decision.delayMs).toBe(0);
    expect(decision.reason).toContain("not retryable");
  });

  it("uses deterministic exponential backoff for retryable categories", () => {
    expect(
      decideSlackBackoff(retryable, 1, { baseDelayMs: 500 }),
    ).toMatchObject({ retry: true, delayMs: 500 });
    expect(
      decideSlackBackoff(retryable, 2, { baseDelayMs: 500 }),
    ).toMatchObject({ retry: true, delayMs: 1000 });
    expect(
      decideSlackBackoff(retryable, 3, {
        baseDelayMs: 500,
        maxAttempts: 5,
      }),
    ).toMatchObject({ retry: true, delayMs: 2000 });
  });

  it("caps the exponential delay at maxDelayMs", () => {
    const decision = decideSlackBackoff(retryable, 4, {
      baseDelayMs: 1000,
      maxDelayMs: 3000,
      maxAttempts: 10,
    });
    expect(decision.delayMs).toBe(3000);
  });

  it("honors Slack Retry-After over exponential backoff", () => {
    const decision = decideSlackBackoff(rateLimited(7), 1, {
      baseDelayMs: 500,
    });
    expect(decision).toMatchObject({
      retry: true,
      delayMs: 7000,
      reason: expect.stringContaining("Retry-After"),
    });
  });

  it("caps an oversized Retry-After at maxDelayMs", () => {
    const decision = decideSlackBackoff(rateLimited(120), 1, {
      maxDelayMs: 5000,
    });
    expect(decision.delayMs).toBe(5000);
  });

  it("gives up when the max attempt count is reached", () => {
    const decision = decideSlackBackoff(retryable, 3, { maxAttempts: 3 });
    expect(decision.retry).toBe(false);
    expect(decision.delayMs).toBe(0);
    expect(decision.reason).toContain("maximum");
  });

  it("gives up past the max attempt count too", () => {
    expect(decideSlackBackoff(retryable, 9, { maxAttempts: 3 }).retry).toBe(
      false,
    );
  });

  it("normalizes invalid attempt numbers to the first attempt", () => {
    expect(decideSlackBackoff(retryable, 0, { baseDelayMs: 250 }).delayMs).toBe(
      250,
    );
    expect(
      decideSlackBackoff(retryable, -5, { baseDelayMs: 250 }).delayMs,
    ).toBe(250);
  });

  it("falls back to defaults for invalid options", () => {
    const decision = decideSlackBackoff(retryable, 1, {
      baseDelayMs: -1,
      maxDelayMs: 0,
      maxAttempts: 0,
    });
    expect(decision.retry).toBe(true);
    expect(decision.delayMs).toBe(500);
  });

  it("covers every retryable category as retryable and the rest as give-up", () => {
    const retryableCategories: SlackErrorCategory[] = [
      "rate_limited",
      "slack_outage",
      "transient",
    ];
    const nonRetryableCategories: SlackErrorCategory[] = [
      "not_in_channel",
      "channel_not_found",
      "channel_archived",
      "bot_removed",
      "token_revoked",
      "missing_scope",
      "config",
      "payload",
      "fatal",
    ];

    for (const category of retryableCategories) {
      const decision = decideSlackBackoff(
        {
          category,
          retryable: true,
          operatorActionRequired: false,
          reason: "test",
        },
        1,
      );
      expect(decision.retry).toBe(true);
    }
    for (const category of nonRetryableCategories) {
      const decision = decideSlackBackoff(
        {
          category,
          retryable: false,
          operatorActionRequired: false,
          reason: "test",
        },
        1,
      );
      expect(decision.retry).toBe(false);
    }
  });
});
