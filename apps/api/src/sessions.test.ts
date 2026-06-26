import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";

// Admin sessions: a bearer token is exchanged for a signed, expiring session
// cookie; the cookie authenticates subsequent requests, with a CSRF header
// required on writes.

const managedEnvKeys = [
  "BEK_ADMIN_API_TOKEN",
  "BEK_SESSION_SECRET",
  "BEK_ALLOW_UNAUTHENTICATED_LOCAL",
  "BEK_SLACK_BACKGROUND_DRAIN",
  "NODE_ENV",
] as const;

const originalEnv: Partial<Record<(typeof managedEnvKeys)[number], string>> =
  {};
for (const key of managedEnvKeys) {
  originalEnv[key] = process.env[key];
}

const ADMIN_TOKEN = "owner-token-abcdefghijklmnop";

beforeEach(() => {
  process.env.BEK_SLACK_BACKGROUND_DRAIN = "false";
  process.env.BEK_ADMIN_API_TOKEN = ADMIN_TOKEN;
  process.env.BEK_SESSION_SECRET = "session-signing-secret-abcdef";
  delete process.env.BEK_ALLOW_UNAUTHENTICATED_LOCAL;
});

afterEach(() => {
  for (const key of managedEnvKeys) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }
});

function bearer(token = ADMIN_TOKEN): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function cookieValue(res: Response): string {
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/bek_session=([^;]+)/);
  return match?.[1] ?? "";
}

async function signIn(app: ReturnType<typeof createApp>) {
  const res = await app.request("/api/auth/session", {
    method: "POST",
    headers: bearer(),
  });
  const body = (await res.json()) as { csrfToken: string };
  return { status: res.status, cookie: cookieValue(res), csrf: body.csrfToken };
}

describe("admin sessions", () => {
  it("signs in with a bearer token and sets a session cookie", async () => {
    const app = createApp();
    const { status, cookie, csrf } = await signIn(app);
    expect(status).toBe(200);
    expect(cookie.length).toBeGreaterThan(0);
    expect(csrf.length).toBeGreaterThan(0);
  });

  it("authenticates reads via the session cookie (no bearer)", async () => {
    const app = createApp();
    const { cookie } = await signIn(app);

    const whoami = await app.request("/api/auth/session", {
      headers: { cookie: `bek_session=${cookie}` },
    });
    expect(whoami.status).toBe(200);
    expect((await whoami.json()) as unknown).toMatchObject({
      role: "owner",
      method: "session",
    });

    const bootstrap = await app.request("/api/bootstrap", {
      headers: { cookie: `bek_session=${cookie}` },
    });
    expect(bootstrap.status).toBe(200);
  });

  it("rejects a cookie write without a CSRF header", async () => {
    const app = createApp();
    const { cookie } = await signIn(app);
    const res = await app.request("/api/channels", {
      method: "POST",
      headers: {
        cookie: `bek_session=${cookie}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "#x", externalId: "C1" }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()) as { error?: string }).toMatchObject({
      error: expect.stringMatching(/csrf/i),
    });
  });

  it("allows a cookie write with the matching CSRF header", async () => {
    const app = createApp();
    const { cookie, csrf } = await signIn(app);
    const res = await app.request("/api/channels", {
      method: "POST",
      headers: {
        cookie: `bek_session=${cookie}`,
        "content-type": "application/json",
        "x-bek-csrf": csrf,
      },
      body: JSON.stringify({ name: "#csrf-ok", externalId: "C_CSRF_OK" }),
    });
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(401);
  });

  it("rejects a tampered session cookie", async () => {
    const app = createApp();
    const res = await app.request("/api/auth/session", {
      headers: { cookie: "bek_session=not.a.valid.token" },
    });
    expect(res.status).toBe(401);
  });

  it("logs out by clearing the cookie", async () => {
    const app = createApp();
    const { cookie } = await signIn(app);
    const res = await app.request("/api/auth/logout", {
      method: "POST",
      headers: { cookie: `bek_session=${cookie}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie") ?? "").toMatch(/bek_session=/);
  });

  it("returns 501 when sessions are not configured", async () => {
    delete process.env.BEK_SESSION_SECRET;
    const app = createApp();
    const res = await app.request("/api/auth/session", {
      method: "POST",
      headers: bearer(),
    });
    expect(res.status).toBe(501);
  });
});
