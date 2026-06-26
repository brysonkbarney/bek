# Agent Identity Model

Status: foundation landed. The pure resolution + invocation core lives in
[`packages/core/src/identity.ts`](../../packages/core/src/identity.ts) with full
unit tests. Persistence (migrations), identity-aware credential selection,
identity-aware audit, and admin UI are the next layers.

## Why identities are distinct from the visible agent

Bek shows **one** teammate, `@bek`. That visible agent is a single record
(`AgentIdentity` in `types.ts`: principal, handle, status, default model/runtime).
But "what @bek may do" must differ by **compartment** — a public channel, a
locked-down private channel, a DM, or a service account. Those compartments are
modeled by **`AgentIdentityProfile`** records, separate from the visible agent.

This mirrors the strong parts of a per-place authorization model while staying
provider-neutral: humans never choose an identity; Bek resolves the right one for
the place.

## Concepts

- **`AgentIdentityProfile`** — a compartment identity: `scope`
  (`workspace` | `public_channel` | `private_channel` | `dm` | `service_account`),
  bound `accessBundleIds`, optional model policy / runtime, approvers, and an
  optional invocation allowlist.
- **Workspace baseline** — the `scope: "workspace", baseline: true` profile whose
  bundles are inherited by default.
- **`AgentIdentityBinding`** — binds a profile to a place; a disabled binding
  disables the compartment.
- **`ResolvedAgentIdentity`** — the effective result for a place: enabled state,
  isolation flag, effective bundle ids + grants, approvers, invocation allowlist.

## Resolution rules (`resolveAgentIdentity`)

1. Find the place's own profile (by `placeId` or a binding); else fall back to the
   workspace baseline.
2. **Inheritance** — public-channel/DM profiles inherit the baseline's bundles by
   default and add their own (deduped).
3. **Private-channel isolation** — `private_channel` profiles (or any profile with
   `inheritsBaseline: false`) do NOT inherit the baseline. `isolated: true` marks
   that memory, credentials, artifacts, and retrieval must not cross into
   public/workspace contexts. `isIdentityDataIsolated()` exposes this for callers.
4. **Revocation** — a disabled profile, a disabled inherited baseline, or a
   disabled binding disables the whole compartment (`enabled: false`).

## Who may invoke (`canInvokeAgent`)

Separate from "what the agent may access". A profile can be richly permissioned
yet only invocable by:

- an **invocation allowlist** of principals, when set; otherwise
- any **member of the place** (membership passed in by the caller).

A disabled compartment denies all invocation.

## What this unblocks on the checklist

Implemented (with tests): first-class identity records distinct from the visible
agent; explicit inheritance; private-channel isolation; disabled-channel/identity
state; "who may invoke" separate from "what may be accessed"; revocation
semantics; isolation tests.

Next: `agent_identities`/`agent_identity_bindings` migrations, identity-aware
credential selection and audit fields, admin UI for identity profiles and
effective-access preview, and wiring resolution into Slack/run creation.
