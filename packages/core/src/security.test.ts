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

  it("redacts audit-flagged credential shapes from public text", () => {
    const slackAppToken = "xapp-1-A1234567890-b1234567890-c1234567890";
    const awsTemporaryAccessKey = "ASIAIOSFODNN7EXAMPLE";
    const apiKey = "abcdefghijklmnopqrstuvwxyz123456";
    const bearerAccessToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";

    const redacted = redactSecrets(
      `publish ${slackAppToken} ${awsTemporaryAccessKey} api_key=${apiKey} access_token=${bearerAccessToken}`,
    );

    expect(redacted).not.toContain(slackAppToken);
    expect(redacted).not.toContain(awsTemporaryAccessKey);
    expect(redacted).not.toContain(apiKey);
    expect(redacted).not.toContain(bearerAccessToken);
    expect(redacted).toContain("[redacted:slack-app-token]");
    expect(redacted).toContain("[redacted:aws-access-key]");
    expect(redacted).toContain("api_key=[redacted:api-key]");
    expect(redacted).toContain("access_token=[redacted:bearer-token]");
  });

  it("redacts common bearer and api key assignments in public payloads", () => {
    expect(
      redactUnknown({
        publicMessage:
          'x-api-key: "abcdefghijklmnop12345678" Authorization: Bearer abcdefghijklmnop123456',
      }),
    ).toEqual({
      publicMessage:
        'x-api-key: "[redacted:api-key]" Authorization: [redacted:bearer-token]',
    });
  });

  it("redacts sensitive field names in nested run metadata and events", () => {
    const event = createRunEvent(
      "org_demo",
      "run_test",
      "tool.completed",
      "metadata updated",
      {
        metadata: {
          status: "active",
          name: "deploy",
          passphrase: "correct horse battery staple",
          credentialRef: "cred_live_slack",
          credentialValue: "xoxb-1234567890-secret",
          accessKeyId: "AKIAIOSFODNN7EXAMPLE",
          refreshToken: "refresh-token-value",
          clientSecret: "client-secret-value",
          webhookSigningSecret: "webhook-signing-secret-value",
        },
        events: [
          {
            status: "queued",
            name: "first",
            authorization: "Bearer abcdefghijklmnop123456",
            "api key": "api-key-value",
          },
          {
            status: "complete",
            name: "second",
            nested: {
              "credential-value": "credential-value",
              signingSecret: "signing-secret-value",
              private_key: "private-key-value",
            },
          },
        ],
      },
    );

    expect(event.data).toEqual({
      metadata: {
        status: "active",
        name: "deploy",
        passphrase: "[redacted:field]",
        credentialRef: "[redacted:field]",
        credentialValue: "[redacted:field]",
        accessKeyId: "[redacted:field]",
        refreshToken: "[redacted:field]",
        clientSecret: "[redacted:field]",
        webhookSigningSecret: "[redacted:field]",
      },
      events: [
        {
          status: "queued",
          name: "first",
          authorization: "[redacted:field]",
          "api key": "[redacted:field]",
        },
        {
          status: "complete",
          name: "second",
          nested: {
            "credential-value": "[redacted:field]",
            signingSecret: "[redacted:field]",
            private_key: "[redacted:field]",
          },
        },
      ],
    });
  });

  it("hashes approval payloads canonically", () => {
    expect(hashPayload({ b: 2, a: 1 })).toBe(hashPayload({ a: 1, b: 2 }));
  });
});
