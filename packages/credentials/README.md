# @bek/credentials

Credential and secret-handling foundations for Bek. This package deliberately
does not integrate with the API yet; it exposes primitives that API, worker,
runtime, and connector code can adopt once those surfaces are ready.

## What Lives Here

- Credential metadata records that store broker references, not raw secrets.
- AES-256-GCM envelopes for sensitive credential metadata.
- TTL lease grants that are safe to hand to runtimes.
- Broker-only lease targets that include `secretRef` for secret manager adapters.
- Audit references that use stable fingerprints instead of secret manager paths.
- Redaction helpers for logs, audit payloads, and test diagnostics.

## Usage

```ts
import {
  InMemoryCredentialLeaseBroker,
  createAesGcmCredentialMetadataCipher,
  createCredentialAuditReference,
  redactCredentialPayload,
} from "@bek/credentials";

const cipher = createAesGcmCredentialMetadataCipher({
  keyId: "local-key-v1",
  key: process.env.BEK_CREDENTIAL_METADATA_KEY!,
});

const credential = {
  id: "cred_slack_bot",
  orgId: "org_demo",
  name: "Slack bot token",
  provider: "slack",
  secretRef: "vault://bek/prod/slack/bot-token",
  status: "active" as const,
  scopeSummary: "chat:write",
  encryptedMetadata: cipher.encrypt(
    { workspaceId: "T123", botUserId: "U456" },
    { orgId: "org_demo", credentialId: "cred_slack_bot", provider: "slack" },
  ),
};

const auditRef = createCredentialAuditReference(credential);
const broker = new InMemoryCredentialLeaseBroker();
const lease = await broker.issueLease({
  credential,
  purpose: "slack.chat.postMessage",
  scopes: ["chat:write"],
  ttlMs: 60_000,
});

console.log(redactCredentialPayload({ auditRef, lease }));
```

`lease` is the safe grant for runtime/tool code. `resolveLeaseTarget(lease.id)`
returns the broker-only `secretRef` target and should be used only inside a
credential broker or secret manager adapter.

## Key Material

`createAesGcmCredentialMetadataCipher` accepts a 32-byte key as raw bytes or an
encoded string. Encoded strings may use `base64url:`, `base64:`, or `hex:`
prefixes; unprefixed strings are treated as base64url.

## Audit Rule

Never write `secretRef`, raw tokens, private keys, webhook secrets, or leased
secret material to audit logs. Use `createCredentialAuditReference`,
`createCredentialLeaseAuditReference`, and `redactCredentialPayload` for
persisted or user-visible records.
