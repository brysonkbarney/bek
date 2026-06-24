import { describe, expect, it } from "vitest";
import { createSlackOAuthState, verifySlackOAuthState } from "./oauth";

describe("Slack OAuth state", () => {
  it("round trips signed state payloads", () => {
    const state = createSlackOAuthState({
      stateSecret: "secret",
      nonce: "nonce-1",
      nowSeconds: 1000,
      returnTo: "/settings/slack",
    });

    expect(
      verifySlackOAuthState({
        stateSecret: "secret",
        state,
        nowSeconds: 1001,
      }),
    ).toEqual({
      ok: true,
      payload: {
        nonce: "nonce-1",
        issuedAt: 1000,
        returnTo: "/settings/slack",
      },
    });
  });

  it("rejects tampered and expired state", () => {
    const state = createSlackOAuthState({
      stateSecret: "secret",
      nonce: "nonce-1",
      nowSeconds: 1000,
    });

    expect(
      verifySlackOAuthState({
        stateSecret: "secret",
        state: `${state.slice(0, -1)}x`,
        nowSeconds: 1001,
      }),
    ).toMatchObject({ ok: false });

    expect(
      verifySlackOAuthState({
        stateSecret: "secret",
        state,
        nowSeconds: 2000,
        maxAgeSeconds: 60,
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("expired") });
  });
});
