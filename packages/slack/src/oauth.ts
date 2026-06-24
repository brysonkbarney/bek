import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const stateVersion = "v1";
const slackOAuthAccessUrl = "https://slack.com/api/oauth.v2.access";

export interface SlackOAuthStatePayload {
  nonce: string;
  issuedAt: number;
  returnTo?: string;
  callbackMode?: "json" | "redirect";
}

export type SlackOAuthStateVerification =
  | { ok: true; payload: SlackOAuthStatePayload }
  | { ok: false; reason: string };

export interface SlackOAuthExchangeInput {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  fetch?: typeof fetch | undefined;
}

export interface SlackInstallRecord {
  appId?: string | undefined;
  teamId: string;
  teamName?: string | undefined;
  botUserId?: string | undefined;
  botToken: string;
  scope: string[];
  installedAt: string;
  enterpriseId?: string | undefined;
  enterpriseName?: string | undefined;
  authedUserId?: string | undefined;
}

export type RedactedSlackInstallRecord = Omit<
  SlackInstallRecord,
  "botToken"
> & {
  botTokenRedacted: string;
};

export type SlackOAuthExchangeResult =
  | { ok: true; install: SlackInstallRecord; raw: Record<string, unknown> }
  | { ok: false; error: string; raw?: Record<string, unknown> | undefined };

export function createSlackOAuthState(input: {
  stateSecret: string;
  nowSeconds?: number | undefined;
  nonce?: string | undefined;
  returnTo?: string | undefined;
  callbackMode?: "json" | "redirect" | undefined;
}): string {
  if (!input.stateSecret) {
    throw new Error("SLACK_STATE_SECRET is required to create OAuth state.");
  }

  const payload: SlackOAuthStatePayload = {
    nonce: input.nonce ?? randomBytes(16).toString("base64url"),
    issuedAt: input.nowSeconds ?? Math.floor(Date.now() / 1000),
  };
  const returnTo = normalizeOAuthReturnTo(input.returnTo);
  if (returnTo) {
    payload.returnTo = returnTo;
  }
  if (input.callbackMode === "redirect") {
    payload.callbackMode = "redirect";
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
  if (
    payload.callbackMode !== undefined &&
    payload.callbackMode !== "json" &&
    payload.callbackMode !== "redirect"
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

export async function exchangeSlackOAuthCode(
  input: SlackOAuthExchangeInput,
): Promise<SlackOAuthExchangeResult> {
  const missing = [
    ["clientId", input.clientId],
    ["clientSecret", input.clientSecret],
    ["code", input.code],
    ["redirectUri", input.redirectUri],
  ].filter(([, value]) => !value);
  if (missing.length > 0) {
    return {
      ok: false,
      error: `Slack OAuth exchange is missing ${missing
        .map(([name]) => name)
        .join(", ")}.`,
    };
  }

  const form = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code: input.code,
    redirect_uri: input.redirectUri,
  });

  let response: Response;
  try {
    response = await (input.fetch ?? fetch)(slackOAuthAccessUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form,
    });
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? `Slack OAuth exchange failed: ${error.message}`
          : "Slack OAuth exchange failed.",
    };
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    return {
      ok: false,
      error: `Slack OAuth exchange returned non-JSON HTTP ${response.status}.`,
    };
  }

  if (!isRecord(raw)) {
    return {
      ok: false,
      error: "Slack OAuth exchange returned an invalid response.",
    };
  }
  if (!response.ok || raw.ok !== true) {
    return {
      ok: false,
      error: slackOAuthError(raw, response.status),
      raw,
    };
  }

  const install = installRecordFromOAuthResponse(raw);
  if (!install) {
    return {
      ok: false,
      error: "Slack OAuth exchange did not return a bot token and team.",
      raw,
    };
  }

  return { ok: true, install, raw };
}

export function redactSlackInstallRecord(
  install: SlackInstallRecord,
): RedactedSlackInstallRecord {
  const { botToken, ...safeInstall } = install;
  return {
    ...safeInstall,
    botTokenRedacted: redactSecret(botToken),
  };
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

function installRecordFromOAuthResponse(
  raw: Record<string, unknown>,
): SlackInstallRecord | undefined {
  const team = raw.team;
  const enterprise = raw.enterprise;
  const authedUser = raw.authed_user;
  const teamId = nestedString(team, "id");
  const botToken = stringValue(raw.access_token);
  if (!teamId || !botToken) {
    return undefined;
  }

  const install: SlackInstallRecord = {
    appId: stringValue(raw.app_id),
    teamId,
    teamName: nestedString(team, "name"),
    botUserId: stringValue(raw.bot_user_id),
    botToken,
    scope: parseScope(stringValue(raw.scope)),
    installedAt: new Date().toISOString(),
    enterpriseId: nestedString(enterprise, "id"),
    enterpriseName: nestedString(enterprise, "name"),
    authedUserId: nestedString(authedUser, "id"),
  };

  return install;
}

function slackOAuthError(raw: Record<string, unknown>, status: number): string {
  const error = stringValue(raw.error);
  return error
    ? `Slack OAuth exchange failed: ${error}.`
    : `Slack OAuth exchange failed with HTTP ${status}.`;
}

function parseScope(scope: string | undefined): string[] {
  return (scope ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function nestedString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return stringValue(value[key]);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function redactSecret(secret: string): string {
  if (secret.length <= 8) {
    return "****";
  }
  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

function normalizeOAuthReturnTo(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !trimmed.startsWith("/") || trimmed.startsWith("//")) {
    return undefined;
  }
  if (/[\0\r\n\\]/.test(trimmed) || /%5c/i.test(trimmed)) {
    return undefined;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(trimmed);
  } catch {
    return undefined;
  }
  if (decoded.startsWith("//") || decoded.includes("\\")) {
    return undefined;
  }

  try {
    const base = new URL("https://bek.local");
    const url = new URL(trimmed, base);
    if (url.origin !== base.origin) {
      return undefined;
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return undefined;
  }
}
