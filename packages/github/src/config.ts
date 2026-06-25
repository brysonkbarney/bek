import { GitHubAppInstallationTokenProvider } from "./tokens";
import type { GitHubInstallationTokenProvider } from "./tokens";

export interface GitHubAppConfigEnv {
  readonly GITHUB_APP_ID?: string | undefined;
  readonly GITHUB_APP_PRIVATE_KEY?: string | undefined;
  readonly GITHUB_APP_WEBHOOK_SECRET?: string | undefined;
  readonly GITHUB_WEBHOOK_SECRET?: string | undefined;
  readonly GITHUB_APP_CLIENT_ID?: string | undefined;
  readonly GITHUB_APP_CLIENT_SECRET?: string | undefined;
  readonly GITHUB_API_BASE_URL?: string | undefined;
  readonly [key: string]: string | undefined;
}

export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  clientId?: string | undefined;
  clientSecret?: string | undefined;
}

export type GitHubAppConfigValidation =
  | {
      ok: true;
      config: GitHubAppConfig;
      errors: string[];
      warnings: string[];
    }
  | {
      ok: false;
      config?: undefined;
      errors: string[];
      warnings: string[];
    };

export function validateGitHubAppConfig(
  env: GitHubAppConfigEnv,
): GitHubAppConfigValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const appId = normalizeEnvValue(env.GITHUB_APP_ID);
  const privateKey = normalizeGitHubPrivateKey(env.GITHUB_APP_PRIVATE_KEY);
  const webhookSecret = normalizeEnvValue(
    env.GITHUB_APP_WEBHOOK_SECRET ?? env.GITHUB_WEBHOOK_SECRET,
  );
  const clientId = normalizeEnvValue(env.GITHUB_APP_CLIENT_ID);
  const clientSecret = normalizeEnvValue(env.GITHUB_APP_CLIENT_SECRET);

  if (!appId) {
    errors.push("GITHUB_APP_ID is required.");
  } else if (!/^\d+$/.test(appId) || Number(appId) <= 0) {
    errors.push("GITHUB_APP_ID must be a positive integer string.");
  }

  if (!privateKey) {
    errors.push("GITHUB_APP_PRIVATE_KEY is required.");
  } else if (!looksLikePrivateKey(privateKey)) {
    errors.push("GITHUB_APP_PRIVATE_KEY must be a PEM private key.");
  }

  if (!webhookSecret) {
    errors.push("GITHUB_APP_WEBHOOK_SECRET is required.");
  } else if (webhookSecret.length < 16) {
    warnings.push(
      "GITHUB_APP_WEBHOOK_SECRET should be at least 16 characters for shared environments.",
    );
  }

  if (clientSecret && !clientId) {
    errors.push("GITHUB_APP_CLIENT_SECRET requires GITHUB_APP_CLIENT_ID.");
  }

  if (errors.length > 0) {
    return { ok: false, errors, warnings };
  }

  const config: GitHubAppConfig = {
    appId: appId!,
    privateKey: privateKey!,
    webhookSecret: webhookSecret!,
  };
  if (clientId) {
    config.clientId = clientId;
  }
  if (clientSecret) {
    config.clientSecret = clientSecret;
  }

  return {
    ok: true,
    config,
    errors: [],
    warnings,
  };
}

export function assertGitHubAppConfig(
  env: GitHubAppConfigEnv,
): GitHubAppConfig {
  const validation = validateGitHubAppConfig(env);
  if (!validation.ok) {
    throw new Error(
      `Invalid GitHub App config: ${validation.errors.join(" ")}`,
    );
  }
  return validation.config;
}

export function createGitHubInstallationTokenProviderFromEnv(
  env: GitHubAppConfigEnv,
  options: {
    fetch?: typeof fetch | undefined;
    now?: (() => Date) | undefined;
    userAgent?: string | undefined;
  } = {},
): GitHubInstallationTokenProvider {
  const config = assertGitHubAppConfig(env);
  return new GitHubAppInstallationTokenProvider({
    appId: config.appId,
    privateKey: config.privateKey,
    apiBaseUrl: normalizeEnvValue(env.GITHUB_API_BASE_URL),
    ...options,
  });
}

export function normalizeGitHubPrivateKey(
  value: string | undefined,
): string | undefined {
  const normalized = normalizeEnvValue(value);
  if (!normalized) {
    return undefined;
  }
  return normalized.replaceAll("\\n", "\n");
}

function normalizeEnvValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function looksLikePrivateKey(value: string): boolean {
  return /^-----BEGIN (?:RSA )?PRIVATE KEY-----\n[\s\S]+\n-----END (?:RSA )?PRIVATE KEY-----$/.test(
    value,
  );
}
