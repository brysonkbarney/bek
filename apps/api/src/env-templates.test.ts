import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function readEnvTemplate(name: string): Map<string, string> {
  const text = readFileSync(resolve(repoRoot, name), "utf8");
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) {
      continue;
    }
    values.set(trimmed.slice(0, equalsIndex), trimmed.slice(equalsIndex + 1));
  }
  return values;
}

describe("environment templates", () => {
  const requiredSlackScopes = [
    "app_mentions:read",
    "commands",
    "chat:write",
    "channels:read",
    "groups:read",
    "im:history",
  ];

  it.each([".env.example", ".env.docker.example"])(
    "%s keeps Slack OAuth scopes aligned with channel discovery",
    (templateName) => {
      const values = readEnvTemplate(templateName);
      const scopes = new Set(
        values
          .get("SLACK_BOT_SCOPES")
          ?.split(",")
          .map((scope) => scope.trim())
          .filter(Boolean),
      );

      for (const requiredScope of requiredSlackScopes) {
        expect(scopes.has(requiredScope)).toBe(true);
      }
    },
  );

  it("keeps Docker Compose Slack scope fallback aligned with channel discovery", () => {
    const compose = readFileSync(
      resolve(repoRoot, "docker-compose.yml"),
      "utf8",
    );
    const match = compose.match(
      /SLACK_BOT_SCOPES:\s+\$\{SLACK_BOT_SCOPES:-(.*?)\}/,
    );
    const fallbackScopes = match?.[1] ?? "";
    expect(fallbackScopes).not.toBe("");
    const scopes = new Set(
      fallbackScopes
        .split(",")
        .map((scope) => scope.trim())
        .filter(Boolean),
    );

    for (const requiredScope of requiredSlackScopes) {
      expect(scopes.has(requiredScope)).toBe(true);
    }
  });

  it("keeps executable sandboxes disabled in first-run templates", () => {
    expect(readEnvTemplate(".env.example").get("BEK_SANDBOX_PROVIDER")).toBe(
      "none",
    );
    expect(
      readEnvTemplate(".env.docker.example").get("BEK_SANDBOX_PROVIDER"),
    ).toBe("none");
  });

  it("keeps real GitHub worker execution disabled in first-run templates", () => {
    expect(readEnvTemplate(".env.example").get("BEK_GITHUB_EXECUTION")).toBe(
      "disabled",
    );
    expect(
      readEnvTemplate(".env.docker.example").get("BEK_GITHUB_EXECUTION"),
    ).toBe("disabled");
  });
});
