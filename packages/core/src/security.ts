interface SecretPattern {
  pattern: RegExp;
  replacement: string;
}

const redacted = (label: string): string => `[redacted:${label}]`;

const SECRET_PATTERNS: SecretPattern[] = [
  {
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    replacement: redacted("slack-token"),
  },
  {
    pattern: /\bxapp-\d-[A-Za-z0-9-]{10,}\b/g,
    replacement: redacted("slack-app-token"),
  },
  {
    pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
    replacement: redacted("github-token"),
  },
  {
    pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
    replacement: redacted("github-token"),
  },
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g, replacement: redacted("api-key") },
  {
    pattern:
      /\b((?:x-api-key|api[ _-]?key)\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{16,}(["']?)/gi,
    replacement: `$1${redacted("api-key")}$2`,
  },
  {
    pattern:
      /\b((?:authorization|bearer[ _-]?token|access[ _-]?token|refresh[ _-]?token|id[ _-]?token|auth[ _-]?token)\s*[:=]\s*["']?)(?:Bearer\s+)?[A-Za-z0-9._~+/=-]{16,}(["']?)/gi,
    replacement: `$1${redacted("bearer-token")}$2`,
  },
  {
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replacement: redacted("aws-access-key"),
  },
  {
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi,
    replacement: redacted("bearer-token"),
  },
  {
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: redacted("private-key"),
  },
];

export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce(
    (redactedValue, { pattern, replacement }) =>
      redactedValue.replace(pattern, replacement),
    value,
  );
}

export function redactUnknown(value: unknown): unknown {
  if (typeof value === "string") {
    return redactSecrets(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactUnknown(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => {
        if (
          /token|secret|password|api[_-]?key|private[_-]?key|authorization/i.test(
            key,
          )
        ) {
          return [key, "[redacted:field]"];
        }
        return [key, redactUnknown(entry)];
      }),
    );
  }
  return value;
}
