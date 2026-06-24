import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  buildCredentialMetadataAad,
  createAesGcmCredentialMetadataCipher,
  decodeCredentialEncryptionKey,
  type JsonObject,
} from "./index";

describe("credential metadata encryption", () => {
  it("encrypts metadata envelopes and binds decrypts to audit context", () => {
    const key = new Uint8Array(32).fill(7);
    const cipher = createAesGcmCredentialMetadataCipher({
      keyId: "local-test-key",
      key,
      now: () => new Date("2026-06-24T18:00:00.000Z"),
      randomBytes: (size) => new Uint8Array(size).fill(3),
    });
    const metadata: JsonObject = {
      workspaceId: "T123",
      botUserId: "U456",
      scopes: ["chat:write", "channels:history"],
      rotation: { cadenceDays: 30 },
    };
    const context = {
      orgId: "org_1",
      credentialId: "cred_slack",
      provider: "slack",
    };

    const envelope = cipher.encrypt(metadata, context);

    expect(envelope).toMatchObject({
      type: "bek.credential_metadata.envelope",
      version: 1,
      algorithm: "AES-256-GCM",
      keyId: "local-test-key",
      createdAt: "2026-06-24T18:00:00.000Z",
      aad: "org:org_1\ncredential:cred_slack\nprovider:slack",
    });
    expect(JSON.stringify(envelope)).not.toContain("T123");
    expect(cipher.decrypt(envelope, context)).toEqual(metadata);
    expect(() =>
      cipher.decrypt(envelope, {
        orgId: "org_2",
        credentialId: "cred_slack",
        provider: "slack",
      }),
    ).toThrow();
  });

  it("accepts prefixed key encodings and rejects non-json metadata", () => {
    const rawKey = new Uint8Array(32).fill(11);
    const encoded = `base64url:${Buffer.from(rawKey).toString("base64url")}`;
    const cipher = createAesGcmCredentialMetadataCipher({
      keyId: "encoded-key",
      key: encoded,
      randomBytes: (size) => new Uint8Array(size).fill(4),
    });

    expect(decodeCredentialEncryptionKey(encoded)).toEqual(rawKey);
    expect(cipher.decrypt(cipher.encrypt({ ok: true }))).toEqual({ ok: true });
    expect(() =>
      cipher.encrypt({ bad: undefined } as unknown as JsonObject),
    ).toThrow("JSON-serializable");
  });

  it("builds deterministic metadata aad from stable credential context", () => {
    expect(
      buildCredentialMetadataAad({
        aad: "broker:v1",
        credentialId: "cred_1",
        orgId: "org_1",
        provider: "github",
      }),
    ).toBe("org:org_1\ncredential:cred_1\nprovider:github\naad:broker:v1");
  });
});
