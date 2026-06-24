# Positioning

Bek is open-source Claude Tag-style infrastructure for Slack teams: one visible teammate, `@bek`, with governed capability routing behind it.

## The Thesis

Teams should not need a directory of bots for coding, searching, incident response, docs, tickets, and tools. They should tag one teammate and let admin policy decide what that teammate can access in that place.

```txt
@bek investigate this and open a PR if you find the fix
```

Behind that simple prompt, Bek evaluates:

- Slack place and requester.
- Access bundle grants.
- Tool, repo, model, runtime, and sandbox policy.
- Budget limits.
- Approval requirements.
- Audit and redaction rules.

## What Bek Is

- A governed agent teammate for Slack.
- A control plane for access bundles, approvals, audit, budgets, model policies, tools, repos, and runtimes.
- Provider-neutral infrastructure for teams that want open-source primitives.

## What Bek Is Not

- An agent directory.
- A set of specialist bot names users must memorize.
- A raw MCP client that lets every tool become prompt-accessible by default.
- A chat-only assistant with no policy model.
- A production-hardened deployment yet.

## Launch Narrative

The short public narrative:

> Bek is the open-source Slack teammate you tag once. Admins decide which channels, repos, tools, models, budgets, and approvals sit behind it.

The product promise depends on the admin surface. A simple `@bek` experience is only safe if access, approval, audit, and budget controls are visible and enforceable.
