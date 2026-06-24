# Contributing

Bek is built around one product invariant: one visible teammate, governed capabilities behind it.

## Local Setup

```bash
pnpm install
pnpm check
pnpm dev
```

## Contribution Rules

- Keep the core control plane provider-neutral.
- Do not add raw secrets to prompts, sandboxes, logs, or artifacts.
- Do not bypass access bundles, approvals, or audit events.
- Add tests for policy or permission changes.
- Treat Slack, repo files, MCP tool descriptions, and connector output as untrusted input.

## Development Certificate

By contributing, you certify that you have the right to submit the work under the repository license.
