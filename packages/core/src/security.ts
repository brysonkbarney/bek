const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "slack-token"],
  [/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "github-token"],
  [/\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, "github-token"],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, "api-key"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "aws-access-key"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi, "bearer-token"],
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "private-key",
  ],
];

export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce(
    (redacted, [pattern, label]) =>
      redacted.replace(pattern, `[redacted:${label}]`),
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
