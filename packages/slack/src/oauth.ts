import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const stateVersion = "v1";

export interface SlackOAuthStatePayload {
  nonce: string;
  issuedAt: number;
  returnTo?: string;
}

export type SlackOAuthStateVerification =
  | { ok: true; payload: SlackOAuthStatePayload }
  | { ok: false; reason: string };

export function createSlackOAuthState(input: {
  stateSecret: string;
  nowSeconds?: number | undefined;
  nonce?: string | undefined;
  returnTo?: string | undefined;
}): string {
  if (!input.stateSecret) {
    throw new Error("SLACK_STATE_SECRET is required to create OAuth state.");
  }

  const payload: SlackOAuthStatePayload = {
    nonce: input.nonce ?? randomBytes(16).toString("base64url"),
    issuedAt: input.nowSeconds ?? Math.floor(Date.now() / 1000),
  };
  if (input.returnTo) {
    payload.returnTo = input.returnTo;
  }

  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
    "base64url",
  );
  return `${stateVersion}.${encodedPayload}.${signState(
    input.stateSecret,
    encodedPayload,
  )}`;
}

export function verifySlackOAuthState(input: {
  stateSecret?: string | undefined;
  state?: string | undefined;
  nowSeconds?: number | undefined;
  maxAgeSeconds?: number | undefined;
}): SlackOAuthStateVerification {
  if (!input.stateSecret) {
    return {
      ok: false,
      reason: "SLACK_STATE_SECRET is required to validate OAuth state.",
    };
  }
  if (!input.state) {
    return { ok: false, reason: "Slack OAuth callback is missing state." };
  }

  const parts = input.state.split(".");
  const version = parts[0];
  const encodedPayload = parts[1];
  const signature = parts[2];
  if (
    parts.length !== 3 ||
    version !== stateVersion ||
    !encodedPayload ||
    !signature
  ) {
    return { ok: false, reason: "Slack OAuth state is malformed." };
  }

  const expectedSignature = signState(input.stateSecret, encodedPayload);
  if (!safeEqual(signature, expectedSignature)) {
    return { ok: false, reason: "Slack OAuth state signature is invalid." };
  }

  let payload: SlackOAuthStatePayload;
  try {
    payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as SlackOAuthStatePayload;
  } catch {
    return { ok: false, reason: "Slack OAuth state payload is invalid." };
  }

  if (
    !payload ||
    typeof payload !== "object" ||
    typeof payload.nonce !== "string" ||
    payload.nonce.length === 0 ||
    typeof payload.issuedAt !== "number" ||
    !Number.isFinite(payload.issuedAt)
  ) {
    return { ok: false, reason: "Slack OAuth state payload is invalid." };
  }

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const maxAgeSeconds = input.maxAgeSeconds ?? 60 * 10;
  if (payload.issuedAt > now + 60) {
    return { ok: false, reason: "Slack OAuth state was issued in the future." };
  }
  if (now - payload.issuedAt > maxAgeSeconds) {
    return { ok: false, reason: "Slack OAuth state has expired." };
  }

  return { ok: true, payload };
}

function signState(secret: string, encodedPayload: string): string {
  return createHmac("sha256", secret)
    .update(encodedPayload)
    .digest("base64url");
}

function safeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(actualBuffer, expectedBuffer);
}
