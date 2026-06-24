# Quickstart

This quickstart runs the current local Bek spine: the API, seeded in-memory workspace data, and the admin console.

## Prerequisites

- Node.js 25, matching CI.
- pnpm 11.1.3.
- Docker, optional for local Postgres, Valkey, and MinIO services.

## Install

```bash
pnpm install
```

## Start Local Services

The API currently uses an in-memory seed store, so Docker is optional for the local demo. Start the services when you want the self-hosting dependencies available:

```bash
docker compose up -d
```

## Start Bek

```bash
pnpm dev
```

Open:

- Admin console: `http://localhost:5173`
- API health: `http://localhost:4317/health`

## Smoke Test A Run

Create a read-only run in the seeded `#checkout-eng` place:

```bash
curl -s http://localhost:4317/api/runs \
  -H "content-type: application/json" \
  -d '{
    "placeScopeId": "place_checkout",
    "prompt": "@bek what can you access here?",
    "capability": "slack.read",
    "resource": "slack:C_CHECKOUT"
  }'
```

Create a run that requires approval:

```bash
curl -s http://localhost:4317/api/runs \
  -H "content-type: application/json" \
  -d '{
    "placeScopeId": "place_checkout",
    "prompt": "@bek investigate checkout retries and open a PR if needed",
    "capability": "github.pr",
    "resource": "github:redohq/checkout"
  }'
```

Then inspect:

```bash
curl -s http://localhost:4317/api/approvals
curl -s http://localhost:4317/api/audit-events
```

## Verify

```bash
pnpm check
```

## What Is Seeded

- One visible agent handle: `@bek`.
- Two Slack places: `#checkout-eng` with external ID `C_CHECKOUT`, and `#general` with external ID `C_GENERAL`.
- A Checkout Engineering access bundle with Slack read, GitHub read, GitHub PR approval, and sandbox approval grants.
- An Auto balanced model policy and answer/code runtime profiles.

## Current Alpha Limits

- Slack OAuth/install is not implemented yet.
- Persistent storage is not wired into the API yet.
- Model calls, GitHub writes, sandbox execution, and MCP tool proxying are foundations or stubs.
- Do not use this repo for production workspaces until the launch blockers in `docs/launch-readiness.md` are closed.
