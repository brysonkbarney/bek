import { describe, expect, it } from "vitest";
import {
  createCredentialAuditReference,
  credentialAuditReferenceToString,
  DEFAULT_CREDENTIAL_REDACTION_PATTERNS,
  isSensitiveCredentialFieldName,
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
    const slackToken = "xoxb-EXAMPLETOKEN-secret";
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

  it("redacts every known token shape the package handles", () => {
    const samples: Array<{ token: string; label: string }> = [
      { token: "xoxb-EXAMPLETOKEN-abcdefghijklmno", label: "slack-token" },
      { token: "xoxp-EXAMPLETOKEN-abcdefghijklmno", label: "slack-token" },
      {
        token: "xapp-1-AEXAMPLETOKEN-abcdefghijklmno",
        label: "slack-app-token",
      },
      { token: "ghp_abcdefghijklmnopqrstuvwxyz012345", label: "github-token" },
      { token: "gho_abcdefghijklmnopqrstuvwxyz012345", label: "github-token" },
      {
        token: "github_pat_abcdefghijklmnopqrstuv_0123456789",
        label: "github-token",
      },
      { token: "sk-abcdefghijklmnopqrstuvwxyz0123", label: "api-key" },
      { token: "AKIAIOSFODNN7EXAMPLE", label: "aws-access-key" },
      { token: "ASIAIOSFODNN7EXAMPLE", label: "aws-access-key" },
      { token: "Bearer abcdefghijklmnopqrstuvwxyz", label: "bearer-token" },
      {
        token:
          "-----BEGIN RSA PRIVATE KEY-----\nMIIabc123\n-----END RSA PRIVATE KEY-----",
        label: "private-key",
      },
    ];

    for (const { token, label } of samples) {
      expect(redactCredentialText(`value=${token} end`)).toBe(
        `value=[redacted:${label}] end`,
      );
    }

    // Sanity check: every default pattern is exercised by at least one sample.
    const exercisedLabels = new Set(samples.map((sample) => sample.label));
    for (const { label } of DEFAULT_CREDENTIAL_REDACTION_PATTERNS) {
      expect(exercisedLabels.has(label)).toBe(true);
    }
  });

  it("treats every secret-shaped field name (including new ones) as sensitive", () => {
    const sensitiveFields = [
      "token",
      "secret",
      "password",
      "passphrase",
      "apiKey",
      "api_key",
      "privateKey",
      "private_key",
      "authorization",
      "credentialSecret",
      "credentialValue",
      "credentialRef",
      "refreshToken",
      "accessToken",
      "botToken",
      "signingSecret",
      // Fields surfaced by audit/lease references that carry secret material.
      "secretRef",
    ];
    for (const field of sensitiveFields) {
      expect(isSensitiveCredentialFieldName(field)).toBe(true);
    }

    // Fields introduced by the new last-used and health helpers are NOT
    // secret-shaped and must pass through untouched.
    const nonSensitiveFields = [
      "credentialId",
      "lastUsedAt",
      "lastUsedByIdentityId",
      "lastAction",
      "useCount",
      "state",
      "reason",
      "leaseable",
      "missingScopes",
      "activeLeaseIds",
    ];
    for (const field of nonSensitiveFields) {
      expect(isSensitiveCredentialFieldName(field)).toBe(false);
    }
  });

  it("redacts secret-shaped fields in last-used and health-shaped payloads", () => {
    const payload = {
      credentialId: "cred_slack_bot",
      lastUsedAt: "2026-06-24T18:00:00.000Z",
      lastUsedByIdentityId: "ident_agent",
      lastAction: "slack.chat.postMessage",
      useCount: 3,
      state: "active",
      missingScopes: ["chat:write"],
      // A caller that wrongly attaches raw material must still be scrubbed.
      accessToken: "ghp_abcdefghijklmnopqrstuvwxyz012345",
      secretRef: credential.secretRef,
      note: "leaked sk-abcdefghijklmnopqrstuvwxyz0123 here",
    };

    expect(redactCredentialPayload(payload)).toEqual({
      credentialId: "cred_slack_bot",
      lastUsedAt: "2026-06-24T18:00:00.000Z",
      lastUsedByIdentityId: "ident_agent",
      lastAction: "slack.chat.postMessage",
      useCount: 3,
      state: "active",
      missingScopes: ["chat:write"],
      accessToken: "[redacted:field]",
      secretRef: "[redacted:field]",
      note: "leaked [redacted:api-key] here",
    });
  });
});
