# Demo Script

## Setup

1. Run `pnpm install`.
2. Start Bek locally with `pnpm dev`.
3. Open the admin app at `http://localhost:5173`.
4. Confirm one visible handle: `@bek`.
5. Confirm `#checkout-eng` has the Checkout Engineering access bundle.

## Demo Flow

Slack prompt:

```txt
@bek investigate the checkout retry spike and open a PR if you find the fix
```

Expected local MVP behavior:

1. API creates a run.
2. Policy resolves the channel access bundle.
3. GitHub PR capability requires approval.
4. Run enters `awaiting_approval`.
5. Admin UI shows the pending approval and run timeline.
6. Approval marks run completed.
7. Audit events show the full path.

## CLI Version

After `pnpm dev` is running:

```bash
pnpm smoke
```

The smoke script checks API health, creates an approval-gated PR run, approves it as the seeded admin principal, and prints the run ID.

## UI Version

1. Open `http://localhost:5173`.
2. Click **Demo PR Run**.
3. Open **Approvals**.
4. Approve the pending `github.pr` request.
5. Open **Runs** or **Audit** to inspect the resulting timeline.

## Talk Track

Bek is not a bot directory. It is one open-source teammate. The team tags `@bek`; admins decide what that teammate can access per channel and what requires approval. Under the hood, Bek can route to any model, runtime, MCP tool, repo workflow, or sandbox.
