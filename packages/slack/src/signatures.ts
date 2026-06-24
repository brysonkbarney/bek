import { createHmac, timingSafeEqual } from "node:crypto";

export function createSlackSignature(
  secret: string,
  timestamp: string,
  rawBody: string,
): string {
  const base = `v0:${timestamp}:${rawBody}`;
  return `v0=${createHmac("sha256", secret).update(base).digest("hex")}`;
}

export function verifySlackSignature(input: {
  signingSecret?: string | undefined;
  timestamp?: string | undefined;
  signature?: string | undefined;
  rawBody: string;
  nowSeconds?: number | undefined;
  allowUnsigned?: boolean | undefined;
}): boolean {
  if (!input.signingSecret) {
    return input.allowUnsigned === true;
  }
  if (!input.timestamp || !input.signature) {
    return false;
  }
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const then = Number(input.timestamp);
  if (!Number.isFinite(then) || Math.abs(now - then) > 60 * 5) {
    return false;
  }

  const expected = createSlackSignature(
    input.signingSecret,
    input.timestamp,
    input.rawBody,
  );
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(input.signature);
  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, actualBuffer);
}
