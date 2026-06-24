import { Buffer } from "node:buffer";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes as nodeRandomBytes,
} from "node:crypto";
import type {
  CredentialMetadataCipher,
  CredentialMetadataEncryptionContext,
  EncryptedCredentialMetadataEnvelope,
  JsonObject,
  JsonValue,
} from "./types";

const AES_256_GCM_KEY_BYTES = 32;
const AES_GCM_NONCE_BYTES = 12;

export interface AesGcmCredentialMetadataCipherOptions {
  keyId: string;
  key: string | Uint8Array;
  now?: () => Date;
  randomBytes?: (size: number) => Uint8Array;
}

export function createAesGcmCredentialMetadataCipher(
  options: AesGcmCredentialMetadataCipherOptions,
): CredentialMetadataCipher {
  const keyId = normalizeRequiredString(options.keyId, "keyId");
  const key = normalizeCredentialEncryptionKey(options.key);
  const now = options.now ?? (() => new Date());
  const randomBytes: (size: number) => Uint8Array =
    options.randomBytes ?? ((size) => nodeRandomBytes(size));

  return {
    encrypt(metadata, context) {
      assertJsonObject(metadata);

      const nonce = Buffer.from(randomBytes(AES_GCM_NONCE_BYTES));
      if (nonce.byteLength !== AES_GCM_NONCE_BYTES) {
        throw new Error("Credential metadata nonce must be 12 bytes.");
      }

      const aad = buildCredentialMetadataAad(context);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      if (aad) {
        cipher.setAAD(Buffer.from(aad, "utf8"));
      }

      const plaintext = Buffer.from(JSON.stringify(metadata), "utf8");
      const ciphertext = Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();

      const envelope: EncryptedCredentialMetadataEnvelope = {
        type: "bek.credential_metadata.envelope",
        version: 1,
        algorithm: "AES-256-GCM",
        keyId,
        nonce: encodeBase64Url(nonce),
        tag: encodeBase64Url(tag),
        ciphertext: encodeBase64Url(ciphertext),
        createdAt: now().toISOString(),
      };
      if (aad) {
        envelope.aad = aad;
      }
      return envelope;
    },

    decrypt(envelope, context) {
      assertSupportedEnvelope(envelope, keyId);

      const aad = buildCredentialMetadataAad(context) ?? envelope.aad;
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        decodeBase64Url(envelope.nonce),
      );
      if (aad) {
        decipher.setAAD(Buffer.from(aad, "utf8"));
      }
      decipher.setAuthTag(decodeBase64Url(envelope.tag));

      const plaintext = Buffer.concat([
        decipher.update(decodeBase64Url(envelope.ciphertext)),
        decipher.final(),
      ]).toString("utf8");
      const parsed = JSON.parse(plaintext) as unknown;
      assertJsonObject(parsed);
      return parsed;
    },
  };
}

export function decodeCredentialEncryptionKey(encoded: string): Uint8Array {
  const trimmed = normalizeRequiredString(encoded, "credential encryption key");
  const { payload, encoding } = splitEncodedKey(trimmed);
  const decoded = Buffer.from(payload, encoding);
  if (decoded.byteLength !== AES_256_GCM_KEY_BYTES) {
    throw new Error("Credential encryption key must decode to 32 bytes.");
  }
  return Uint8Array.from(decoded);
}

export function buildCredentialMetadataAad(
  context: CredentialMetadataEncryptionContext | undefined,
): string | undefined {
  if (!context) {
    return undefined;
  }

  const fields: string[] = [];
  appendAadField(fields, "org", context.orgId);
  appendAadField(fields, "credential", context.credentialId);
  appendAadField(fields, "provider", context.provider);
  appendAadField(fields, "aad", context.aad);
  return fields.length > 0 ? fields.join("\n") : undefined;
}

function appendAadField(
  fields: string[],
  name: string,
  value: string | undefined,
): void {
  if (value === undefined) {
    return;
  }
  const normalized = value.trim();
  if (normalized) {
    fields.push(`${name}:${normalized}`);
  }
}

function normalizeCredentialEncryptionKey(key: string | Uint8Array): Buffer {
  const bytes =
    typeof key === "string" ? decodeCredentialEncryptionKey(key) : key;
  const buffer = Buffer.from(bytes);
  if (buffer.byteLength !== AES_256_GCM_KEY_BYTES) {
    throw new Error("Credential encryption key must be 32 bytes.");
  }
  return buffer;
}

function splitEncodedKey(encoded: string): {
  payload: string;
  encoding: BufferEncoding;
} {
  const separator = encoded.indexOf(":");
  if (separator === -1) {
    return { payload: encoded, encoding: "base64url" };
  }

  const prefix = encoded.slice(0, separator);
  const payload = encoded.slice(separator + 1);
  if (!payload) {
    throw new Error("Credential encryption key payload is required.");
  }
  if (prefix === "base64url") {
    return { payload, encoding: "base64url" };
  }
  if (prefix === "base64") {
    return { payload, encoding: "base64" };
  }
  if (prefix === "hex") {
    return { payload, encoding: "hex" };
  }
  throw new Error("Unsupported credential encryption key encoding.");
}

function assertSupportedEnvelope(
  envelope: EncryptedCredentialMetadataEnvelope,
  keyId: string,
): void {
  if (
    envelope.type !== "bek.credential_metadata.envelope" ||
    envelope.version !== 1 ||
    envelope.algorithm !== "AES-256-GCM"
  ) {
    throw new Error("Unsupported credential metadata envelope.");
  }
  if (envelope.keyId !== keyId) {
    throw new Error("Credential metadata envelope key id does not match.");
  }
}

function assertJsonObject(value: unknown): asserts value is JsonObject {
  if (!isPlainObject(value)) {
    throw new Error("Credential metadata must be a JSON object.");
  }
  assertJsonValue(value);
}

function assertJsonValue(value: unknown): asserts value is JsonValue {
  if (value === null) {
    return;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Credential metadata numbers must be finite.");
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      assertJsonValue(entry);
    }
    return;
  }
  if (isPlainObject(value)) {
    for (const entry of Object.values(value)) {
      assertJsonValue(entry);
    }
    return;
  }
  throw new Error("Credential metadata must be JSON-serializable.");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeRequiredString(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}
