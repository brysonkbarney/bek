// Deployment preflight: validates environment/config for a given deployment
// mode and returns structured checks with remediation. Pure — reads only the
// provided env map — so it is unit-testable and can be exposed by the API or run
// as a CLI before boot.

export type PreflightMode = "local" | "self_hosted" | "hosted";
export type PreflightSeverity = "pass" | "warn" | "fail";

export interface PreflightCheck {
  key: string;
  severity: PreflightSeverity;
  message: string;
  remediation?: string;
}

export interface PreflightReport {
  mode: PreflightMode;
  ok: boolean;
  failures: number;
  warnings: number;
  checks: PreflightCheck[];
}

type Env = Record<string, string | undefined>;

function has(env: Env, key: string): boolean {
  const value = env[key];
  return typeof value === "string" && value.trim().length > 0;
}

function isTrue(env: Env, key: string): boolean {
  return (env[key] ?? "").trim().toLowerCase() === "true";
}

export function evaluateDeploymentPreflight(
  env: Env,
  mode: PreflightMode,
): PreflightReport {
  const checks: PreflightCheck[] = [];
  const add = (
    key: string,
    severity: PreflightSeverity,
    message: string,
    remediation?: string,
  ): void => {
    checks.push(
      remediation
        ? { key, severity, message, remediation }
        : {
            key,
            severity,
            message,
          },
    );
  };
  const nonLocal = mode !== "local";

  // --- Admin authentication ---
  if (isTrue(env, "BEK_ALLOW_UNAUTHENTICATED_LOCAL")) {
    if (nonLocal) {
      add(
        "admin_auth",
        "fail",
        "BEK_ALLOW_UNAUTHENTICATED_LOCAL is enabled in a non-local deployment.",
        "Unset BEK_ALLOW_UNAUTHENTICATED_LOCAL and set BEK_ADMIN_API_TOKEN.",
      );
    } else {
      add("admin_auth", "pass", "Local unauthenticated bypass enabled.");
    }
  } else if (
    !has(env, "BEK_ADMIN_API_TOKEN") &&
    !has(env, "BEK_ADMIN_API_TOKENS")
  ) {
    add(
      "admin_auth",
      nonLocal ? "fail" : "warn",
      "No admin API token configured; the admin API will fail closed.",
      "Set BEK_ADMIN_API_TOKEN (or BEK_ADMIN_API_TOKENS for role tokens).",
    );
  } else {
    add("admin_auth", "pass", "Admin API token configured.");
    const token = env.BEK_ADMIN_API_TOKEN?.trim() ?? "";
    if (token && token.length < 24) {
      add(
        "admin_token_strength",
        "warn",
        "BEK_ADMIN_API_TOKEN is short and may be weak.",
        "Use a high-entropy token of at least 24 characters.",
      );
    }
  }

  if (mode === "hosted" && !isTrue(env, "BEK_REQUIRE_ADMIN_AUTH")) {
    add(
      "require_admin_auth",
      "warn",
      "BEK_REQUIRE_ADMIN_AUTH is not true for a hosted deployment.",
      "Set BEK_REQUIRE_ADMIN_AUTH=true to enforce admin auth.",
    );
  }

  if (mode === "hosted" && !has(env, "BEK_SESSION_SECRET")) {
    add(
      "sessions",
      "warn",
      "BEK_SESSION_SECRET is unset; cookie sign-in is disabled.",
      "Set BEK_SESSION_SECRET to enable signed session cookies.",
    );
  }

  // --- Persistence ---
  const storage = (env.BEK_STORAGE ?? "memory").trim().toLowerCase();
  if (storage === "postgres") {
    if (!has(env, "DATABASE_URL")) {
      add(
        "persistence",
        "fail",
        "BEK_STORAGE=postgres but DATABASE_URL is not set.",
        "Set DATABASE_URL or use BEK_STORAGE=memory.",
      );
    } else {
      add("persistence", "pass", "Postgres persistence configured.");
    }
  } else if (nonLocal) {
    add(
      "persistence",
      "warn",
      "Using the in-memory store in a non-local deployment (not durable).",
      "Set BEK_STORAGE=postgres and provide DATABASE_URL.",
    );
  }

  // --- Credential vault ---
  const slackOauth =
    has(env, "SLACK_CLIENT_ID") && has(env, "SLACK_CLIENT_SECRET");
  if ((slackOauth || nonLocal) && !has(env, "BEK_CREDENTIAL_MASTER_KEY")) {
    add(
      "credential_vault",
      "warn",
      "BEK_CREDENTIAL_MASTER_KEY is unset; encrypted credential storage is unavailable.",
      "Generate a key (openssl rand -hex 32) and set BEK_CREDENTIAL_MASTER_KEY.",
    );
  }

  // --- Slack ---
  if (
    (has(env, "SLACK_BOT_TOKEN") || has(env, "SLACK_CLIENT_ID")) &&
    !has(env, "SLACK_SIGNING_SECRET") &&
    !isTrue(env, "BEK_DEV_UNSIGNED_SLACK")
  ) {
    add(
      "slack_signing",
      "fail",
      "Slack is configured but SLACK_SIGNING_SECRET is missing; events cannot be verified.",
      "Set SLACK_SIGNING_SECRET from your Slack app's Basic Information page.",
    );
  }

  // --- GitHub ---
  if ((env.BEK_GITHUB_EXECUTION ?? "").trim().toLowerCase() === "real") {
    const hasWebhook =
      has(env, "GITHUB_APP_WEBHOOK_SECRET") ||
      has(env, "GITHUB_WEBHOOK_SECRET");
    if (
      !has(env, "GITHUB_APP_ID") ||
      !has(env, "GITHUB_APP_PRIVATE_KEY") ||
      !hasWebhook
    ) {
      add(
        "github",
        "fail",
        "BEK_GITHUB_EXECUTION=real but the GitHub App is not fully configured.",
        "Set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_WEBHOOK_SECRET.",
      );
    } else {
      add("github", "pass", "GitHub App configured for real execution.");
    }
  }

  // --- Model gateway ---
  const gateway = (env.BEK_MODEL_GATEWAY ?? "local").trim().toLowerCase();
  if (gateway !== "local" && !has(env, "AI_GATEWAY_API_KEY")) {
    add(
      "model_gateway",
      "warn",
      `BEK_MODEL_GATEWAY=${gateway} but AI_GATEWAY_API_KEY is not set.`,
      "Set AI_GATEWAY_API_KEY (or switch BEK_MODEL_GATEWAY=local).",
    );
  }

  // --- Hosted networking ---
  if (mode === "hosted") {
    const publicUrl = env.BEK_PUBLIC_URL ?? "";
    if (!publicUrl || publicUrl.includes("localhost")) {
      add(
        "public_url",
        "warn",
        "BEK_PUBLIC_URL is missing or points at localhost; external callbacks will fail.",
        "Set BEK_PUBLIC_URL to your public HTTPS origin.",
      );
    }
    if ((env.NODE_ENV ?? "").trim().toLowerCase() !== "production") {
      add(
        "node_env",
        "warn",
        "NODE_ENV is not 'production' for a hosted deployment.",
        "Set NODE_ENV=production.",
      );
    }
  }

  const failures = checks.filter((check) => check.severity === "fail").length;
  const warnings = checks.filter((check) => check.severity === "warn").length;
  return { mode, ok: failures === 0, failures, warnings, checks };
}
