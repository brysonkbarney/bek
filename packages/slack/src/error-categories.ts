/**
 * Pure, network-free helpers for classifying Slack Web API failures and
 * deciding whether/how to retry them.
 *
 * These are additive utilities: they consume the same failure shape the
 * {@link SlackWebApiClient} already returns (the `{ ok: false, error }` string
 * plus optional `retryAfterSeconds`), or a raw HTTP status + Retry-After
 * header, and turn it into a structured category Bek can act on.
 */

/**
 * Structured categories Bek distinguishes for a failed Slack Web API call.
 *
 * Ordered roughly from most operationally-actionable to least specific so the
 * union reads as a decision ladder.
 */
export type SlackErrorCategory =
  | "rate_limited"
  | "not_in_channel"
  | "channel_not_found"
  | "channel_archived"
  | "bot_removed"
  | "token_revoked"
  | "missing_scope"
  | "config"
  | "payload"
  | "slack_outage"
  | "transient"
  | "fatal";

export interface SlackErrorClassification {
  /** The structured category Bek will branch on. */
  category: SlackErrorCategory;
  /** Whether retrying the same request could plausibly succeed. */
  retryable: boolean;
  /**
   * Honored rate-limit / backoff hint in milliseconds, when Slack provided a
   * Retry-After. Only ever present (and only meaningful) when `retryable`.
   */
  retryAfterMs?: number;
  /**
   * True when no automated retry will help — an operator (or the installing
   * user) must take action: re-install the app, re-add the bot to a channel,
   * grant a scope, unarchive a channel, fix configuration, etc.
   */
  operatorActionRequired: boolean;
  /** Stable, human-readable explanation suitable for logs and operator UIs. */
  reason: string;
}

/**
 * Input accepted by {@link classifySlackError}. Every field is optional so the
 * function can classify from whatever signal a caller has: the Slack error
 * string, the HTTP status, and/or a Retry-After value.
 */
export interface SlackErrorClassificationInput {
  /** The `error` string from a `{ ok: false, error }` Slack response. */
  error?: string | undefined;
  /** The HTTP status code, when known. */
  status?: number | undefined;
  /** Retry-After expressed in seconds (e.g. the `SlackWebApi*` field). */
  retryAfterSeconds?: number | undefined;
  /** Retry-After expressed in milliseconds (takes precedence if both given). */
  retryAfterMs?: number | undefined;
}

interface CategoryDescriptor {
  category: SlackErrorCategory;
  retryable: boolean;
  operatorActionRequired: boolean;
  reason: string;
}

const descriptors: Record<SlackErrorCategory, CategoryDescriptor> = {
  rate_limited: {
    category: "rate_limited",
    retryable: true,
    operatorActionRequired: false,
    reason: "Slack rate limited the request; retry after the backoff window.",
  },
  not_in_channel: {
    category: "not_in_channel",
    retryable: false,
    operatorActionRequired: true,
    reason: "The bot is not a member of the target channel; invite it to post.",
  },
  channel_not_found: {
    category: "channel_not_found",
    retryable: false,
    operatorActionRequired: true,
    reason: "The target channel does not exist or is not visible to the bot.",
  },
  channel_archived: {
    category: "channel_archived",
    retryable: false,
    operatorActionRequired: true,
    reason: "The target channel is archived; unarchive it to post.",
  },
  bot_removed: {
    category: "bot_removed",
    retryable: false,
    operatorActionRequired: true,
    reason:
      "The bot account is inactive or was removed from the workspace; reinstall the app.",
  },
  token_revoked: {
    category: "token_revoked",
    retryable: false,
    operatorActionRequired: true,
    reason:
      "The Slack token is invalid or was revoked; reinstall the app to mint a new token.",
  },
  missing_scope: {
    category: "missing_scope",
    retryable: false,
    operatorActionRequired: true,
    reason:
      "The Slack token is missing a required OAuth scope; reinstall with the scope granted.",
  },
  config: {
    category: "config",
    retryable: false,
    operatorActionRequired: true,
    reason: "Slack delivery is not configured; a bot token is missing.",
  },
  payload: {
    category: "payload",
    retryable: false,
    operatorActionRequired: false,
    reason: "The message payload was rejected by Slack and must be corrected.",
  },
  slack_outage: {
    category: "slack_outage",
    retryable: true,
    operatorActionRequired: false,
    reason: "Slack returned a server error (5xx); retry with backoff.",
  },
  transient: {
    category: "transient",
    retryable: true,
    operatorActionRequired: false,
    reason:
      "A transient network or protocol error occurred; retry with backoff.",
  },
  fatal: {
    category: "fatal",
    retryable: false,
    operatorActionRequired: false,
    reason: "An unrecognized, non-retryable Slack error occurred.",
  },
};

/**
 * Classify a Slack Web API failure into a structured {@link SlackErrorClassification}.
 *
 * Resolution order (first match wins):
 *   1. Explicit Slack error strings (most specific, e.g. `not_in_channel`).
 *   2. HTTP 429 / rate-limit signals.
 *   3. HTTP 5xx -> `slack_outage`.
 *   4. Network/protocol noise -> `transient`.
 *   5. Anything else -> `fatal`.
 */
export function classifySlackError(
  input: SlackErrorClassificationInput,
): SlackErrorClassification {
  const normalized = (input.error ?? "").toLowerCase();
  const retryAfterMs = resolveRetryAfterMs(input);

  const category = resolveCategory(normalized, input.status);
  const descriptor = descriptors[category];

  const classification: SlackErrorClassification = {
    category: descriptor.category,
    retryable: descriptor.retryable,
    operatorActionRequired: descriptor.operatorActionRequired,
    reason: descriptor.reason,
  };
  if (descriptor.retryable && retryAfterMs !== undefined) {
    classification.retryAfterMs = retryAfterMs;
  }
  return classification;
}

function resolveCategory(
  normalized: string,
  status: number | undefined,
): SlackErrorCategory {
  // Rate limiting: the error string OR an explicit 429 status.
  if (
    status === 429 ||
    /\bratelimited\b|rate[_ -]?limit|too_many_requests|\b429\b/.test(normalized)
  ) {
    return "rate_limited";
  }

  // Channel-shaped, operator-actionable failures (order matters: each token
  // is distinct so ordering only guards against overlap).
  if (/\bnot_in_channel\b/.test(normalized)) {
    return "not_in_channel";
  }
  if (/\bchannel_not_found\b/.test(normalized)) {
    return "channel_not_found";
  }
  if (/\bis_archived\b|\bchannel_archived\b|\bis_inactive\b/.test(normalized)) {
    return "channel_archived";
  }

  // Identity / token failures.
  if (/\baccount_inactive\b|\buser_removed_from_team\b/.test(normalized)) {
    return "bot_removed";
  }
  if (
    /\btoken_revoked\b|\btoken_expired\b|\binvalid_auth\b|\bnot_authed\b|\bno_permission\b/.test(
      normalized,
    )
  ) {
    return "token_revoked";
  }
  if (/\bmissing_scope\b|\bnot_allowed_token_type\b/.test(normalized)) {
    return "missing_scope";
  }

  // Local configuration (no token wired up at all).
  if (/token is missing|not configured|missing\.$/.test(normalized)) {
    return "config";
  }

  // Payload-shaped failures the caller must fix before retrying.
  if (
    /\binvalid_blocks\b|\binvalid_attachments\b|\binvalid_arguments\b|\binvalid_json\b|\binvalid_post_type\b|\binvalid_charset\b|\bmsg_too_long\b|\bno_text\b|\btoo_many_attachments\b|\bas_user_not_supported\b/.test(
      normalized,
    )
  ) {
    return "payload";
  }

  // Slack-side outage: explicit 5xx status or 5xx-shaped error text.
  if (
    (status !== undefined && status >= 500 && status <= 599) ||
    /\bhttp\s+(500|502|503|504)\b|service_unavailable|internal_error|server_error|temporarily unavailable/.test(
      normalized,
    )
  ) {
    return "slack_outage";
  }

  // Generic transient network / protocol noise.
  if (
    /timeout|timed out|fetch failed|network|econnreset|econnrefused|ehostunreach|enetunreach|etimedout|socket hang up|non-json|invalid response|returned an invalid/.test(
      normalized,
    )
  ) {
    return "transient";
  }

  return "fatal";
}

function resolveRetryAfterMs(
  input: SlackErrorClassificationInput,
): number | undefined {
  if (
    input.retryAfterMs !== undefined &&
    Number.isFinite(input.retryAfterMs) &&
    input.retryAfterMs >= 0
  ) {
    return Math.ceil(input.retryAfterMs);
  }
  if (
    input.retryAfterSeconds !== undefined &&
    Number.isFinite(input.retryAfterSeconds) &&
    input.retryAfterSeconds >= 0
  ) {
    return Math.ceil(input.retryAfterSeconds * 1000);
  }
  return undefined;
}

// --- Retry / backoff decision -------------------------------------------------

export interface SlackBackoffOptions {
  /** Base delay in milliseconds for the first retry. Defaults to 500ms. */
  baseDelayMs?: number | undefined;
  /** Upper bound on any computed delay. Defaults to 30_000ms. */
  maxDelayMs?: number | undefined;
  /** Maximum number of attempts (including the first). Defaults to 3. */
  maxAttempts?: number | undefined;
}

export interface SlackBackoffDecision {
  /** Whether the caller should retry. */
  retry: boolean;
  /** Delay before the next attempt, in milliseconds (0 when not retrying). */
  delayMs: number;
  /** Why this decision was reached (logs / operator UIs). */
  reason: string;
}

const defaultBackoffBaseDelayMs = 500;
const defaultBackoffMaxDelayMs = 30_000;
const defaultBackoffMaxAttempts = 3;

/**
 * Decide whether to retry a failed Slack call and how long to wait.
 *
 * Deterministic by design (no jitter) so it is fully unit-testable: the delay
 * is `baseDelayMs * 2^(attempt-1)` capped at `maxDelayMs`, unless Slack handed
 * us a Retry-After, which is always honored and takes precedence.
 *
 * @param classification Result of {@link classifySlackError}.
 * @param attempt The attempt number that just FAILED (1-based).
 */
export function decideSlackBackoff(
  classification: SlackErrorClassification,
  attempt: number,
  options: SlackBackoffOptions = {},
): SlackBackoffDecision {
  const baseDelayMs = positiveOr(
    options.baseDelayMs,
    defaultBackoffBaseDelayMs,
  );
  const maxDelayMs = positiveOr(options.maxDelayMs, defaultBackoffMaxDelayMs);
  const maxAttempts = positiveIntOr(
    options.maxAttempts,
    defaultBackoffMaxAttempts,
  );

  if (!classification.retryable) {
    return {
      retry: false,
      delayMs: 0,
      reason: `Category "${classification.category}" is not retryable.`,
    };
  }

  const normalizedAttempt =
    Number.isInteger(attempt) && attempt >= 1 ? attempt : 1;
  if (normalizedAttempt >= maxAttempts) {
    return {
      retry: false,
      delayMs: 0,
      reason: `Reached maximum of ${maxAttempts} attempts.`,
    };
  }

  // Honor Slack's Retry-After when present (cap to maxDelayMs).
  if (classification.retryAfterMs !== undefined) {
    return {
      retry: true,
      delayMs: Math.min(classification.retryAfterMs, maxDelayMs),
      reason: "Honoring Slack Retry-After hint.",
    };
  }

  const exponential = baseDelayMs * 2 ** (normalizedAttempt - 1);
  return {
    retry: true,
    delayMs: Math.min(exponential, maxDelayMs),
    reason: `Exponential backoff for attempt ${normalizedAttempt}.`,
  };
}

function positiveOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function positiveIntOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}
