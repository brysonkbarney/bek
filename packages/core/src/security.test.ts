import { describe, expect, it } from "vitest";
import { createRunEvent, hashPayload } from "./runs";
import { redactSecrets, redactUnknown } from "./security";

describe("Bek security helpers", () => {
  it("redacts common secrets before audit persistence", () => {
    expect(
      redactSecrets(
        "token xoxb-1234567890-secret and key ghp_abcdefghijklmnopqrstuvwxyz",
      ),
    ).toContain("[redacted:slack-token]");
    expect(
      redactUnknown({
        authorization: "Bearer secret-token-value",
        nested: "sk-1234567890abcdefghijklmnop",
      }),
    ).toEqual({
      authorization: "[redacted:field]",
      nested: "[redacted:api-key]",
    });
  });

  it("redacts run event messages and data", () => {
    const event = createRunEvent(
      "org_demo",
      "run_test",
      "run.created",
      "saw xoxp-1234567890-secret",
      {
        githubToken: "ghp_abcdefghijklmnopqrstuvwxyz",
        note: "Bearer secret-token-value",
      },
    );

    expect(event.message).toContain("[redacted:slack-token]");
    expect(event.data).toEqual({
      githubToken: "[redacted:field]",
      note: "[redacted:bearer-token]",
    });
  });

  it("redacts common token formats from nested run event payloads", () => {
    const slackToken = "xoxb-1234567890-secret";
    const githubClassicToken = "gho_abcdefghijklmnopqrstuvwxyz";
    const githubFineGrainedToken =
      "github_pat_1234567890abcdefghijklmnopqrstuvwxyz";
    const apiKey = "sk-proj-1234567890abcdefghijklmnop";
    const awsAccessKey = "AKIAIOSFODNN7EXAMPLE";
    const bearerToken = "Bearer abcdefghijklmnop";
    const privateKey =
      "-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----";
    const event = createRunEvent(
      "org_demo",
      "run_test",
      "tool.requested",
      `Using ${slackToken} ${githubClassicToken} ${githubFineGrainedToken} ${apiKey} ${awsAccessKey} ${bearerToken}`,
      {
        command: ["deploy", `--token=${slackToken}`],
        nested: {
          github: githubFineGrainedToken,
          api: apiKey,
          aws: awsAccessKey,
          bearer: bearerToken,
          key: privateKey,
        },
      },
    );
    const serializedEvent = JSON.stringify(event);

    for (const secret of [
      slackToken,
      githubClassicToken,
      githubFineGrainedToken,
      apiKey,
      awsAccessKey,
      bearerToken,
      privateKey,
    ]) {
      expect(serializedEvent).not.toContain(secret);
    }
    expect(serializedEvent).toContain("[redacted:slack-token]");
    expect(serializedEvent).toContain("[redacted:github-token]");
    expect(serializedEvent).toContain("[redacted:api-key]");
    expect(serializedEvent).toContain("[redacted:aws-access-key]");
    expect(serializedEvent).toContain("[redacted:bearer-token]");
    expect(serializedEvent).toContain("[redacted:private-key]");
  });

  it("hashes approval payloads canonically", () => {
    expect(hashPayload({ b: 2, a: 1 })).toBe(hashPayload({ a: 1, b: 2 }));
  });
});
