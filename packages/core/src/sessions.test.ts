import { describe, expect, it } from "vitest";
import {
  createSessionToken,
  verifySessionToken,
  type CreateSessionTokenInput,
} from "./sessions";

const base: CreateSessionTokenInput = {
  role: "operator",
  principalId: "principal_admin",
  orgId: "org_demo",
  csrf: "csrf-secret-123",
  secret: "session-signing-secret",
  nowMs: 1_000_000,
  ttlMs: 60_000,
};

describe("session tokens", () => {
  it("round-trips a valid, unexpired session", () => {
    const token = createSessionToken(base);
    const result = verifySessionToken(token, base.secret, base.nowMs + 1_000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload).toMatchObject({
        role: "operator",
        principalId: "principal_admin",
        orgId: "org_demo",
        csrf: "csrf-secret-123",
      });
      expect(result.payload.expiresAt).toBe(base.nowMs + 60_000);
    }
  });

  it("rejects an expired session", () => {
    const token = createSessionToken(base);
    const result = verifySessionToken(token, base.secret, base.nowMs + 60_001);
    expect(result).toMatchObject({ ok: false, reason: "Session expired." });
  });

  it("rejects a tampered payload", () => {
    const token = createSessionToken(base);
    const [body, sig] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({
        ...base,
        role: "owner",
        expiresAt: base.nowMs + 60_000,
      }),
      "utf8",
    ).toString("base64url");
    const result = verifySessionToken(
      `${forged}.${sig}`,
      base.secret,
      base.nowMs + 1,
    );
    expect(result.ok).toBe(false);
    void body;
  });

  it("rejects a wrong-secret signature", () => {
    const token = createSessionToken(base);
    const result = verifySessionToken(
      token,
      "different-secret",
      base.nowMs + 1,
    );
    expect(result).toMatchObject({ ok: false });
  });

  it("rejects missing or malformed tokens", () => {
    expect(verifySessionToken(undefined, base.secret, base.nowMs).ok).toBe(
      false,
    );
    expect(verifySessionToken("nodot", base.secret, base.nowMs).ok).toBe(false);
  });
});
