# Comparison: Bek And Alternatives

This is a positioning guide, not a vendor feature audit.

| Category             | Common pattern                                         | Bek pattern                                                                |
| -------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------- |
| Bot directory        | Users choose the right bot for each task.              | Users tag one teammate: `@bek`.                                            |
| Workflow automation  | Admins build fixed flows for known tasks.              | Bek can route open-ended requests through governed capabilities.           |
| Chat-only assistant  | Assistant answers from available context.              | Bek also models tools, repos, runtimes, approvals, budgets, and audit.     |
| Raw MCP client       | Tools are exposed directly to a model or user session. | MCP tools are classified, bundled, approved, proxied, and audited.         |
| Model-specific agent | UX, capability, and model are coupled.                 | Admin policy can change model providers without changing the Slack handle. |
| Self-hosted scripts  | Teams wire ad hoc secrets and permissions.             | Bek centralizes channel-scoped access bundles and approval policy.         |

## Where Bek Should Win

- Slack-first teams that want one teammate instead of many bots.
- Teams that need repo, tool, sandbox, and model access under explicit admin control.
- Teams that want an open-source control plane before adopting hosted agent infrastructure.
- Teams that need auditability and approval gates for write-capable agent work.

## Where Bek Is Not The Right Fit Yet

- Teams needing production-hardening today.
- Teams that want a fully managed hosted install before Bek hosted beta is available.
- Teams that only need a static FAQ bot.
- Teams that do not want to administer channel, repo, tool, model, and approval policy.
