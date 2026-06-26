#!/usr/bin/env tsx
import {
  evaluateDeploymentPreflight,
  type PreflightMode,
  type PreflightSeverity,
} from "../packages/core/src/index";

// CLI: validate deployment config before boot.
//   pnpm preflight [--mode local|self_hosted|hosted]
// Exits non-zero when any check fails (warnings do not fail the run).

function parseMode(argv: string[]): PreflightMode {
  const index = argv.indexOf("--mode");
  const raw = index >= 0 ? argv[index + 1] : process.env.BEK_DEPLOY_MODE;
  if (raw === "local" || raw === "self_hosted" || raw === "hosted") {
    return raw;
  }
  // Infer a sensible default from the environment.
  if ((process.env.NODE_ENV ?? "") === "production") {
    return "hosted";
  }
  return "local";
}

const ICON: Record<PreflightSeverity, string> = {
  pass: "✓",
  warn: "!",
  fail: "✗",
};

function main(): void {
  const mode = parseMode(process.argv.slice(2));
  const report = evaluateDeploymentPreflight(process.env, mode);

  process.stdout.write(`Bek preflight — mode: ${mode}\n\n`);
  for (const check of report.checks) {
    process.stdout.write(
      `  ${ICON[check.severity]} [${check.severity}] ${check.key}: ${check.message}\n`,
    );
    if (check.remediation && check.severity !== "pass") {
      process.stdout.write(`      → ${check.remediation}\n`);
    }
  }
  process.stdout.write(
    `\n${report.failures} failure(s), ${report.warnings} warning(s).\n`,
  );

  if (!report.ok) {
    process.stdout.write("\nPreflight FAILED. Resolve the failures above.\n");
    process.exit(1);
  }
  process.stdout.write("\nPreflight passed.\n");
}

main();
