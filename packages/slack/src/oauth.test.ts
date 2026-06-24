import { describe, expect, it } from "vitest";
import {
  createSlackOAuthState,
  exchangeSlackOAuthCode,
  redactSlackInstallRecord,
  verifySlackOAuthState,
} from "./oauth";

describe("Slack OAuth state", () => {
  it("round trips signed state payloads", () => {
    const state = createSlackOAuthState({
      stateSecret: "secret",
      nonce: "nonce-1",
      nowSeconds: 1000,
      returnTo: "/settings/slack",
      callbackMode: "redirect",
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
        callbackMode: "redirect",
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

  it("drops unsafe OAuth return targets from signed state", () => {
    for (const returnTo of [
      "https://evil.example/settings",
      "//evil.example/settings",
      "/%2F%2Fevil.example/settings",
      "/\\evil.example\\settings",
    ]) {
      const state = createSlackOAuthState({
        stateSecret: "secret",
        nonce: "nonce-1",
        nowSeconds: 1000,
        returnTo,
      });
      const verified = verifySlackOAuthState({
        stateSecret: "secret",
        state,
        nowSeconds: 1001,
      });

      expect(verified).toMatchObject({ ok: true });
      if (verified.ok) {
        expect(verified.payload.returnTo).toBeUndefined();
      }
    }
  });
});

describe("Slack OAuth exchange", () => {
  it("exchanges codes for install records", async () => {
    const fetchCalls: Array<{
      url: string;
      init: RequestInit;
    }> = [];
    const fetcher: typeof fetch = async (url, init) => {
      fetchCalls.push({ url: String(url), init: init ?? {} });
      return Response.json({
        ok: true,
        app_id: "A123",
        access_token: "xoxb-secret-token",
        scope: "app_mentions:read,commands,chat:write",
        bot_user_id: "U_BEK",
        team: { id: "T123", name: "Redo" },
        enterprise: { id: "E123", name: "Enterprise" },
        authed_user: { id: "U_ADMIN" },
      });
    };

    const result = await exchangeSlackOAuthCode({
      clientId: "client-id",
      clientSecret: "client-secret",
      code: "oauth-code",
      redirectUri: "https://bek.example.com/api/slack/oauth/callback",
      fetch: fetcher,
    });

    expect(result).toMatchObject({
      ok: true,
      install: {
        appId: "A123",
        teamId: "T123",
        teamName: "Redo",
        botUserId: "U_BEK",
        botToken: "xoxb-secret-token",
        scope: ["app_mentions:read", "commands", "chat:write"],
        enterpriseId: "E123",
        enterpriseName: "Enterprise",
        authedUserId: "U_ADMIN",
      },
    });
    expect(fetchCalls[0]?.url).toBe("https://slack.com/api/oauth.v2.access");
    expect(fetchCalls[0]?.init.method).toBe("POST");
    expect(String(fetchCalls[0]?.init.body)).toContain("code=oauth-code");
  });

  it("returns provider errors without throwing", async () => {
    const result = await exchangeSlackOAuthCode({
      clientId: "client-id",
      clientSecret: "client-secret",
      code: "oauth-code",
      redirectUri: "https://bek.example.com/api/slack/oauth/callback",
      fetch: async () => Response.json({ ok: false, error: "bad_code" }),
    });

    expect(result).toEqual({
      ok: false,
      error: "Slack OAuth exchange failed: bad_code.",
      raw: { ok: false, error: "bad_code" },
    });
  });

  it("redacts bot tokens from install summaries", () => {
    const redacted = redactSlackInstallRecord({
      teamId: "T123",
      botToken: "xoxb-very-secret-token",
      scope: ["chat:write"],
      installedAt: "2026-06-24T00:00:00.000Z",
    });

    expect(redacted).toEqual({
      teamId: "T123",
      scope: ["chat:write"],
      installedAt: "2026-06-24T00:00:00.000Z",
      botTokenRedacted: "xoxb...oken",
    });
    expect("botToken" in redacted).toBe(false);
  });
});
