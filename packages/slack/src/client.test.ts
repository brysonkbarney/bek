import { describe, expect, it } from "vitest";
import { FakeSlackWebApiClient } from "./client";
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
