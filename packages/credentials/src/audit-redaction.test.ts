import { describe, expect, it } from "vitest";
import {
  createCredentialAuditReference,
  credentialAuditReferenceToString,
  redactCredentialPayload,
  redactCredentialText,
  type CredentialMetadataRecord,
} from "./index";

const credential: CredentialMetadataRecord = {
  id: "cred_slack_bot",
  orgId: "org_demo",
  name: "Slack bot token",
  provider: "slack",
  secretRef: "vault://prod/slack/bot-token",
  status: "active",
  scopeSummary: "chat:write, channels:history",
  connectorInstallId: "conn_slack",
  externalAccountId: "T123",
};

describe("credential audit references and redaction", () => {
  it("creates stable audit references without exposing broker paths", () => {
    const first = createCredentialAuditReference(credential, {
      fingerprintSalt: "test-salt",
    });
    const second = createCredentialAuditReference(credential, {
      fingerprintSalt: "test-salt",
    });

    expect(first).toEqual(second);
    expect(first.secretRefFingerprint).toMatch(/^sha256:[a-f0-9]{32}$/);
    expect(credentialAuditReferenceToString(first)).toBe(
      `credential.ref:slack:cred_slack_bot:${first.secretRefFingerprint}`,
    );
    expect(JSON.stringify(first)).not.toContain(credential.secretRef);
    expect(JSON.stringify(first)).not.toContain("vault://");
  });

  it("redacts known credential material from text and nested payloads", () => {
    const githubToken = "ghp_abcdefghijklmnopqrstuvwxyz";
    const slackToken = "xoxb-1234567890-secret";
    const privateKey =
      "-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----";

    expect(redactCredentialText(`use ${githubToken} and ${slackToken}`)).toBe(
      "use [redacted:github-token] and [redacted:slack-token]",
    );
    expect(
      redactCredentialPayload({
        credentialId: "cred_slack_bot",
        secretRef: credential.secretRef,
        nested: {
          note: `Bearer abcdefghijklmnop and ${privateKey}`,
          accessToken: githubToken,
        },
      }),
    ).toEqual({
      credentialId: "cred_slack_bot",
      secretRef: "[redacted:field]",
      nested: {
        note: "[redacted:bearer-token] and [redacted:private-key]",
        accessToken: "[redacted:field]",
      },
    });
  });
});
