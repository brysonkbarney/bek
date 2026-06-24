import { describe, expect, it } from "vitest";
import { FakeSlackWebApiClient, SlackWebApiHttpClient } from "./client";
import { renderSlackFinalAnswerMessage } from "./messages";

describe("Fake Slack Web API client", () => {
  it("records message calls and returns deterministic timestamps", async () => {
    const client = new FakeSlackWebApiClient({ tsPrefix: "1234567890" });
    const message = renderSlackFinalAnswerMessage({
      runId: "run_123",
      answer: "Done.",
    });

    const posted = await client.postMessage({
      channel: "C123",
      ...message,
    });
    const ephemeral = await client.postEphemeral({
      channel: "C123",
      user: "U123",
      text: "Only you can see this.",
    });

    expect(posted).toEqual({
      ok: true,
      channel: "C123",
      ts: "1234567890.000001",
    });
    expect(ephemeral).toEqual({
      ok: true,
      channel: "C123",
      ts: "1234567890.000002",
    });
    expect(client.postMessageCalls).toHaveLength(1);
    expect(client.postMessageCalls[0]).toMatchObject({
      channel: "C123",
      text: "Bek finished. Done.",
    });
    expect(client.postEphemeralCalls[0]).toMatchObject({
      channel: "C123",
      user: "U123",
    });
  });

  it("can be configured to fail without throwing", async () => {
    const client = new FakeSlackWebApiClient({ failWith: "ratelimited" });

    await expect(
      client.postMessage({ channel: "C123", text: "Hello" }),
    ).resolves.toEqual({ ok: false, error: "ratelimited" });
    await expect(
      client.updateMessage({ channel: "C123", ts: "123.456", text: "Hello" }),
    ).resolves.toEqual({ ok: false, error: "ratelimited" });
  });
});

describe("Slack Web API HTTP client", () => {
  it("posts JSON messages with bearer auth", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json({
        ok: true,
        channel: "C123",
        ts: "1700000000.000001",
      });
    };
    const client = new SlackWebApiHttpClient({
      token: "xoxb-test-token",
      baseUrl: "https://slack.test/api",
      fetch: fetchImpl,
    });

    await expect(
      client.postMessage({
        channel: "C123",
        text: "Hello",
        thread_ts: "1700000000.000000",
      }),
    ).resolves.toEqual({
      ok: true,
      channel: "C123",
      ts: "1700000000.000001",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://slack.test/api/chat.postMessage");
    expect(calls[0]!.init).toMatchObject({
      method: "POST",
      headers: {
        authorization: "Bearer xoxb-test-token",
        "content-type": "application/json; charset=utf-8",
      },
    });
    expect(JSON.parse(calls[0]!.init!.body as string)).toMatchObject({
      channel: "C123",
      text: "Hello",
      thread_ts: "1700000000.000000",
    });
  });

  it("maps Slack provider failures and ephemeral timestamps", async () => {
    const providerFailure = new SlackWebApiHttpClient({
      token: "xoxb-test-token",
      fetch: async () => Response.json({ ok: false, error: "invalid_auth" }),
    });
    await expect(
      providerFailure.postMessage({ channel: "C123", text: "Hello" }),
    ).resolves.toEqual({ ok: false, error: "invalid_auth" });

    const ephemeral = new SlackWebApiHttpClient({
      token: "xoxb-test-token",
      fetch: async () =>
        Response.json({
          ok: true,
          channel: "C123",
          message_ts: "1700000000.000002",
        }),
    });
    await expect(
      ephemeral.postEphemeral({
        channel: "C123",
        user: "U123",
        text: "Only you can see this.",
      }),
    ).resolves.toEqual({
      ok: true,
      channel: "C123",
      ts: "1700000000.000002",
    });
  });
});
