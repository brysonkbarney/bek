import { describe, expect, it } from "vitest";
import { parseSlackRetryHeaders } from "./retries";

describe("Slack retry headers", () => {
  it("parses retry number and reason", () => {
    expect(
      parseSlackRetryHeaders({
        retryNum: "2",
        retryReason: " http_timeout ",
      }),
    ).toEqual({
      retryNum: 2,
      reason: "http_timeout",
    });
  });

  it("ignores absent or malformed retry numbers", () => {
    expect(parseSlackRetryHeaders({})).toBeUndefined();
    expect(parseSlackRetryHeaders({ retryNum: "1.5" })).toBeUndefined();
    expect(parseSlackRetryHeaders({ retryNum: "-1" })).toBeUndefined();
    expect(
      parseSlackRetryHeaders({ retryNum: "not-a-number" }),
    ).toBeUndefined();
  });

  it("omits blank retry reasons", () => {
    expect(
      parseSlackRetryHeaders({
        retryNum: "1",
        retryReason: "   ",
      }),
    ).toEqual({ retryNum: 1 });
  });
});
