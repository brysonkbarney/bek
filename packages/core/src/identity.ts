import type {
  AccessBundle,
  CapabilityGrant,
  PlaceScope,
  Principal,
} from "./types";

/**
 * Agent identity model.
 *
 * Bek shows one visible teammate (`@bek`), but internally that teammate acts
 * through distinct *agent identities* per compartment: a workspace baseline,
 * per-public-channel identities, isolated private-channel identities, DM mode,
 * and service-account bindings. Access bundles remain the policy packs; an
 * identity *binds* effective permissions (bundles, model policy, runtime,
 * approvers, invocation allowlist) to a place.
 *
 * This module is the pure resolution + invocation core. Persistence
 * (migrations for `agent_identities` / `agent_identity_bindings`) and admin UI
 * are layered on top of these types and functions.
 */

export type AgentIdentityScope =
  | "workspace"
  | "public_channel"
  | "private_channel"
  | "dm"
  | "service_account";

export interface AgentIdentityProfile {
  id: string;
  orgId: string;
  scope: AgentIdentityScope;
  name: string;
  /** Exactly one workspace identity should be the baseline. */
  baseline?: boolean | undefined;
  enabled: boolean;
  /** Bound place for channel/DM identities (omitted for the workspace baseline). */
  placeId?: string | undefined;
  /** Access bundles bound to this identity. */
  accessBundleIds: string[];
  modelPolicyId?: string | undefined;
  runtimeProfileId?: string | undefined;
  /** Principals allowed to approve this identity's risky actions. */
  approverPrincipalIds?: string[] | undefined;
  /**
   * Principals allowed to invoke Bek under this identity. Empty/undefined means
   * "any member of the place may invoke" (membership is enforced elsewhere).
   */
  invocationAllowlistPrincipalIds?: string[] | undefined;
  /**
   * Whether this identity inherits the workspace baseline's bundles. Defaults to
   * true for public channels/DMs. Private-channel identities are ALWAYS isolated
   * regardless of this flag.
   */
  inheritsBaseline?: boolean | undefined;
}

export interface AgentIdentityBinding {
  id: string;
  orgId: string;
  identityId: string;
  placeId: string;
  enabled: boolean;
}

export interface ResolvedAgentIdentity {
  identity: AgentIdentityProfile;
  baseline?: AgentIdentityProfile | undefined;
  /** Effective enabled state (identity + baseline + binding all considered). */
  enabled: boolean;
  /**
   * True when this compartment must not share memory, credentials, artifacts, or
   * retrieval with public/workspace contexts (private channels, or identities
   * with `inheritsBaseline: false`).
   */
  isolated: boolean;
  effectiveBundleIds: string[];
  effectiveGrants: CapabilityGrant[];
  approverPrincipalIds: string[];
  invocationAllowlistPrincipalIds: string[];
  reason: string;
}

export interface ResolveAgentIdentityInput {
  identities: AgentIdentityProfile[];
  place: PlaceScope;
  accessBundles: AccessBundle[];
  bindings?: AgentIdentityBinding[] | undefined;
}

function isWorkspaceBaseline(identity: AgentIdentityProfile): boolean {
  return identity.scope === "workspace" && identity.baseline === true;
}

function identityIsIsolated(identity: AgentIdentityProfile): boolean {
  if (identity.scope === "private_channel") {
    return true;
  }
  return identity.inheritsBaseline === false;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Resolves the effective agent identity for a place, applying baseline
 * inheritance, private-channel isolation, and disabled-state revocation.
 */
export function resolveAgentIdentity(
  input: ResolveAgentIdentityInput,
): ResolvedAgentIdentity {
  const orgIdentities = input.identities.filter(
    (identity) => identity.orgId === input.place.orgId,
  );
  const baseline = orgIdentities.find(isWorkspaceBaseline);

  const boundIdentityIds = new Set(
    (input.bindings ?? [])
      .filter(
        (binding) =>
          binding.placeId === input.place.id &&
          binding.orgId === input.place.orgId,
      )
      .map((binding) => binding.identityId),
  );

  const placeIdentity =
    orgIdentities.find(
      (identity) =>
        identity.placeId === input.place.id ||
        boundIdentityIds.has(identity.id),
    ) ?? baseline;

  if (!placeIdentity) {
    return {
      identity: emptyIdentity(input.place),
      enabled: false,
      isolated: input.place.kind === "slack_dm",
      effectiveBundleIds: [],
      effectiveGrants: [],
      approverPrincipalIds: [],
      invocationAllowlistPrincipalIds: [],
      reason:
        "No agent identity (and no workspace baseline) covers this place.",
    };
  }

  const bindingDisabled = (input.bindings ?? []).some(
    (binding) =>
      binding.placeId === input.place.id &&
      binding.identityId === placeIdentity.id &&
      binding.enabled === false,
  );

  const isolated = identityIsIsolated(placeIdentity);
  const inheritsBaseline =
    !isolated &&
    !isWorkspaceBaseline(placeIdentity) &&
    placeIdentity.inheritsBaseline !== false;

  const bundleIds = dedupe([
    ...(inheritsBaseline && baseline ? baseline.accessBundleIds : []),
    ...placeIdentity.accessBundleIds,
  ]);

  const effectiveGrants = grantsForBundleIds(input.accessBundles, bundleIds);

  // Revocation: a disabled identity (or disabled baseline it depends on, or a
  // disabled binding) disables the whole compartment.
  const baselineEnabled = !inheritsBaseline || !baseline || baseline.enabled;
  const enabled = placeIdentity.enabled && baselineEnabled && !bindingDisabled;

  return {
    identity: placeIdentity,
    ...(inheritsBaseline && baseline ? { baseline } : {}),
    enabled,
    isolated,
    effectiveBundleIds: bundleIds,
    effectiveGrants,
    approverPrincipalIds: placeIdentity.approverPrincipalIds ?? [],
    invocationAllowlistPrincipalIds:
      placeIdentity.invocationAllowlistPrincipalIds ?? [],
    reason: enabled
      ? reasonForEnabled(placeIdentity, isolated, inheritsBaseline)
      : reasonForDisabled(placeIdentity, baselineEnabled, bindingDisabled),
  };
}

export type InvocationDecision = "allow" | "deny";

export interface InvocationCheckInput {
  resolved: ResolvedAgentIdentity;
  principal: Principal;
  /**
   * Whether the principal is a member of the place. Defaults to true; callers
   * that can determine Slack channel membership should pass the real value.
   */
  isPlaceMember?: boolean | undefined;
}

export interface InvocationCheckResult {
  decision: InvocationDecision;
  reason: string;
}

/**
 * "Who may invoke" check — separate from "what the agent may access". An
 * identity can be richly permissioned yet only invocable by an allowlisted set
 * of principals (or only by members of the place).
 */
export function canInvokeAgent(
  input: InvocationCheckInput,
): InvocationCheckResult {
  if (!input.resolved.enabled) {
    return {
      decision: "deny",
      reason: "The agent identity for this place is disabled.",
    };
  }

  const allowlist = input.resolved.invocationAllowlistPrincipalIds;
  if (allowlist.length > 0) {
    return allowlist.includes(input.principal.id)
      ? {
          decision: "allow",
          reason: "Principal is on the invocation allowlist.",
        }
      : {
          decision: "deny",
          reason: "Principal is not on this identity's invocation allowlist.",
        };
  }

  if (input.isPlaceMember === false) {
    return {
      decision: "deny",
      reason: "Principal is not a member of this place.",
    };
  }

  return { decision: "allow", reason: "Principal may invoke this identity." };
}

/**
 * Whether memory, credentials, artifacts, and retrieval for this resolved
 * identity must stay isolated from public/workspace contexts.
 */
export function isIdentityDataIsolated(
  resolved: ResolvedAgentIdentity,
): boolean {
  return resolved.isolated;
}

export interface DeriveDefaultIdentityProfilesInput {
  orgId: string;
  places: PlaceScope[];
  accessBundles: AccessBundle[];
}

function scopeForPlace(place: PlaceScope): AgentIdentityScope {
  if (place.kind === "slack_dm") {
    return "dm";
  }
  if (
    place.sensitivity === "confidential" ||
    place.sensitivity === "restricted"
  ) {
    return "private_channel";
  }
  return "public_channel";
}

/**
 * Derives a sensible default identity profile set for an org: one workspace
 * baseline (bound to workspace-wide bundles, i.e. bundles attached to no
 * specific place) plus one identity per place bound to that place's bundles.
 * Private/confidential channels are isolated. Pure and deterministic — useful
 * for seeding, demos, and as the starting point an operator edits.
 */
export function deriveDefaultIdentityProfiles(
  input: DeriveDefaultIdentityProfilesInput,
): AgentIdentityProfile[] {
  const orgBundles = input.accessBundles.filter(
    (bundle) => bundle.orgId === input.orgId,
  );
  const baselineBundleIds = orgBundles
    .filter((bundle) => bundle.attachedPlaceIds.length === 0)
    .map((bundle) => bundle.id);

  const baseline: AgentIdentityProfile = {
    id: `identity_baseline_${input.orgId}`,
    orgId: input.orgId,
    scope: "workspace",
    name: "Workspace baseline",
    baseline: true,
    enabled: true,
    accessBundleIds: baselineBundleIds,
  };

  const placeIdentities = input.places
    .filter((place) => place.orgId === input.orgId)
    .map((place): AgentIdentityProfile => {
      const bundleIds = orgBundles
        .filter((bundle) => bundle.attachedPlaceIds.includes(place.id))
        .map((bundle) => bundle.id);
      return {
        id: `identity_${place.id}`,
        orgId: input.orgId,
        scope: scopeForPlace(place),
        name: `${place.name} identity`,
        enabled: true,
        placeId: place.id,
        accessBundleIds: bundleIds,
      };
    });

  return [baseline, ...placeIdentities];
}

function grantsForBundleIds(
  bundles: AccessBundle[],
  bundleIds: string[],
): CapabilityGrant[] {
  const wanted = new Set(bundleIds);
  return bundles
    .filter((bundle) => wanted.has(bundle.id))
    .flatMap((bundle) => bundle.grants);
}

function emptyIdentity(place: PlaceScope): AgentIdentityProfile {
  return {
    id: `identity_unresolved_${place.id}`,
    orgId: place.orgId,
    scope: place.kind === "slack_dm" ? "dm" : "public_channel",
    name: "Unresolved identity",
    enabled: false,
    accessBundleIds: [],
  };
}

function reasonForEnabled(
  identity: AgentIdentityProfile,
  isolated: boolean,
  inheritsBaseline: boolean,
): string {
  if (isWorkspaceBaseline(identity)) {
    return "Resolved to the workspace baseline identity.";
  }
  if (isolated) {
    return `Resolved to isolated ${identity.scope} identity (no baseline inheritance).`;
  }
  return inheritsBaseline
    ? `Resolved to ${identity.scope} identity inheriting the workspace baseline.`
    : `Resolved to ${identity.scope} identity.`;
}

function reasonForDisabled(
  identity: AgentIdentityProfile,
  baselineEnabled: boolean,
  bindingDisabled: boolean,
): string {
  if (bindingDisabled) {
    return "The identity binding for this place is disabled.";
  }
  if (!baselineEnabled) {
    return "The inherited workspace baseline identity is disabled.";
  }
  return `Agent identity ${identity.name} is disabled.`;
}
