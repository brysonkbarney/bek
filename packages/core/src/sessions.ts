import { createHmac, timingSafeEqual } from "node:crypto";
import { isRole, type Role } from "./rbac";

/**
 * Signed, expiring admin session tokens.
 *
 * A session is a stateless HMAC-signed token carrying the authenticated role,
 * principal, org, and a bound CSRF secret. The API exchanges an admin/role API
 * token for a session cookie at sign-in, then accepts the cookie (with a
 * matching CSRF header on writes) on subsequent requests. Pure and
 * deterministic — randomness (the CSRF value) and the clock are injected.
 */

export interface SessionPayload {
  role: Role;
  principalId: string;
  orgId: string;
  /** CSRF secret bound to this session; echoed back via a request header. */
  csrf: string;
  issuedAt: number;
  expiresAt: number;
}

export interface CreateSessionTokenInput {
  role: Role;
  principalId: string;
  orgId: string;
  csrf: string;
  secret: string;
  nowMs: number;
  ttlMs?: number;
}

export const defaultSessionTtlMs = 12 * 60 * 60 * 1000;

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function fromBase64url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

export function createSessionToken(input: CreateSessionTokenInput): string {
  const payload: SessionPayload = {
    role: input.role,
    principalId: input.principalId,
    orgId: input.orgId,
    csrf: input.csrf,
    issuedAt: input.nowMs,
    expiresAt: input.nowMs + (input.ttlMs ?? defaultSessionTtlMs),
  };
  const body = base64url(JSON.stringify(payload));
  return `${body}.${sign(body, input.secret)}`;
}

export type VerifySessionResult =
  | { ok: true; payload: SessionPayload }
  | { ok: false; reason: string };

export function verifySessionToken(
  token: string | undefined,
  secret: string,
  nowMs: number,
): VerifySessionResult {
  if (!token) {
    return { ok: false, reason: "Missing session token." };
  }
  const dot = token.lastIndexOf(".");
  if (dot <= 0) {
    return { ok: false, reason: "Malformed session token." };
  }
  const body = token.slice(0, dot);
  const provided = token.slice(dot + 1);
  const expected = sign(body, secret);
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (
    providedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(providedBuf, expectedBuf)
  ) {
    return { ok: false, reason: "Invalid session signature." };
  }
  let payload: SessionPayload;
  try {
    payload = JSON.parse(fromBase64url(body)) as SessionPayload;
  } catch {
    return { ok: false, reason: "Unreadable session payload." };
  }
  if (
    typeof payload?.role !== "string" ||
    !isRole(payload.role) ||
    typeof payload.principalId !== "string" ||
    typeof payload.orgId !== "string" ||
    typeof payload.csrf !== "string" ||
    typeof payload.expiresAt !== "number"
  ) {
    return { ok: false, reason: "Incomplete session payload." };
  }
  if (nowMs >= payload.expiresAt) {
    return { ok: false, reason: "Session expired." };
  }
  return { ok: true, payload };
}
