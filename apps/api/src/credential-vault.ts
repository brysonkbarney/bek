import { createHash } from "node:crypto";
import {
  createAesGcmCredentialMetadataCipher,
  type EncryptedCredentialMetadataEnvelope,
} from "@bek/credentials";
import type { CredentialRecord } from "@bek/core";

export interface LocalCredentialVaultOptions {
  masterKey?: string | undefined;
  keyId?: string | undefined;
}

interface ResolvedLocalCredentialVaultOptions {
  masterKey: string;
  keyId: string;
}

export interface EncryptedSlackBotToken {
  secretRef: string;
  vaultEnvelope: EncryptedCredentialMetadataEnvelope;
  fingerprint: string;
}

export class LocalCredentialVault {
  constructor(private readonly options: ResolvedLocalCredentialVaultOptions) {}

  encryptSlackBotToken(input: {
    orgId: string;
    teamId: string;
    credentialId: string;
    botToken: string;
  }): EncryptedSlackBotToken {
    const token = input.botToken.trim();
    if (!token) {
      throw new Error("Slack bot token is required.");
    }
    const cipher = createAesGcmCredentialMetadataCipher({
      keyId: this.options.keyId,
      key: this.options.masterKey,
    });
    const vaultEnvelope = cipher.encrypt(
      {
        kind: "slack.bot_token",
        botToken: token,
      },
      credentialEncryptionContext(input),
    );
    return {
      secretRef: slackBotTokenSecretRef(input.orgId, input.teamId),
      vaultEnvelope,
      fingerprint: tokenFingerprint(token),
    };
  }

  decryptSlackBotToken(input: {
    credential: CredentialRecord;
  }): string | undefined {
    const envelope = input.credential.metadata?.vaultEnvelope;
    if (!isEncryptedCredentialMetadataEnvelope(envelope)) {
      return undefined;
    }
    const cipher = createAesGcmCredentialMetadataCipher({
      keyId: this.options.keyId,
      key: this.options.masterKey,
    });
    const decrypted = cipher.decrypt(
      envelope,
      credentialEncryptionContext({
        orgId: input.credential.orgId,
        teamId: input.credential.externalAccountId ?? "unknown-team",
        credentialId: input.credential.id,
      }),
    );
    const token = decrypted.botToken;
    return typeof token === "string" && token.length > 0 ? token : undefined;
  }
}

export function createLocalCredentialVaultFromEnv(
  env: Record<string, string | undefined> = process.env,
): LocalCredentialVault | undefined {
  const masterKey = env.BEK_CREDENTIAL_MASTER_KEY?.trim();
  if (!masterKey) {
    return undefined;
  }
  return new LocalCredentialVault({
    masterKey,
    keyId: env.BEK_CREDENTIAL_KEY_ID?.trim() || "bek-local-vault-v1",
  });
}

export function requireLocalCredentialVault(
  env: Record<string, string | undefined> = process.env,
): LocalCredentialVault {
  const vault = createLocalCredentialVaultFromEnv(env);
  if (!vault) {
    throw new Error(
      "BEK_CREDENTIAL_MASTER_KEY is required to persist Slack OAuth bot tokens.",
    );
  }
  return vault;
}

export function slackBotTokenSecretRef(orgId: string, teamId: string): string {
  return `bek-local-vault:slack:${orgId}:${teamId}:bot`;
}

function credentialEncryptionContext(input: {
  orgId: string;
  teamId: string;
  credentialId: string;
}) {
  return {
    orgId: input.orgId,
    credentialId: input.credentialId,
    provider: "slack",
    aad: `slack-team:${input.teamId}`,
  };
}

function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

function isEncryptedCredentialMetadataEnvelope(
  value: unknown,
): value is EncryptedCredentialMetadataEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Partial<EncryptedCredentialMetadataEnvelope>;
  return (
    record.type === "bek.credential_metadata.envelope" &&
    record.version === 1 &&
    record.algorithm === "AES-256-GCM" &&
    typeof record.keyId === "string" &&
    typeof record.nonce === "string" &&
    typeof record.tag === "string" &&
    typeof record.ciphertext === "string" &&
    typeof record.createdAt === "string"
  );
}
