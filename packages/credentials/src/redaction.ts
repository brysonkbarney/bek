export interface CredentialRedactionPattern {
  pattern: RegExp;
  label: string;
}

export interface CredentialRedactionOptions {
  patterns?: readonly CredentialRedactionPattern[];
  replacement?: (label: string) => string;
}

export const DEFAULT_CREDENTIAL_REDACTION_PATTERNS: CredentialRedactionPattern[] =
  [
    { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, label: "slack-token" },
    { pattern: /\bxapp-\d-[A-Za-z0-9-]{10,}\b/g, label: "slack-app-token" },
    { pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, label: "github-token" },
    { pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, label: "github-token" },
    { pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g, label: "api-key" },
    {
      pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
      label: "aws-access-key",
    },
    {
      pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi,
      label: "bearer-token",
    },
    {
      pattern:
        /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      label: "private-key",
    },
  ];

export function redactCredentialText(
  value: string,
  options: CredentialRedactionOptions = {},
): string {
  const patterns = options.patterns ?? DEFAULT_CREDENTIAL_REDACTION_PATTERNS;
  return patterns.reduce(
    (redacted, { pattern, label }) =>
      redacted.replace(ensureGlobal(pattern), marker(label, options)),
    value,
  );
}

export function redactCredentialPayload(
  value: unknown,
  options: CredentialRedactionOptions = {},
): unknown {
  if (typeof value === "string") {
    return redactCredentialText(value, options);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactCredentialPayload(entry, options));
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => {
        if (isSensitiveCredentialFieldName(key)) {
          return [key, marker("field", options)];
        }
        return [key, redactCredentialPayload(entry, options)];
      }),
    );
  }
  return value;
}

export function isSensitiveCredentialFieldName(fieldName: string): boolean {
  return /token|secret|password|passphrase|api[_-]?key|private[_-]?key|authorization|credential[_-]?(secret|value|ref)|refresh[_-]?token|access[_-]?token|bot[_-]?token|signing[_-]?secret/i.test(
    normalizeFieldName(fieldName),
  );
}

function normalizeFieldName(fieldName: string): string {
  return fieldName
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/\s+/g, "_")
    .toLowerCase();
}

function marker(label: string, options: CredentialRedactionOptions): string {
  return options.replacement?.(label) ?? `[redacted:${label}]`;
}

function ensureGlobal(pattern: RegExp): RegExp {
  if (pattern.global) {
    return pattern;
  }
  return new RegExp(pattern.source, `${pattern.flags}g`);
}
