import type {
  AccessBundle,
  CapabilityGrant,
  CapabilityKind,
  Decision,
  PlaceScope,
  RiskLevel,
} from "./types";

export interface PolicyRequest {
  placeScopeId: string;
  capability: CapabilityKind;
  resource?: string | undefined;
}

export interface PolicyDecision {
  decision: Decision;
  risk: RiskLevel;
  requiresApproval: boolean;
  matchingGrant?: CapabilityGrant;
  reason: string;
}

export function bundlesForPlace(
  bundles: AccessBundle[],
  place: PlaceScope,
): AccessBundle[] {
  return bundles.filter((bundle) => bundle.attachedPlaceIds.includes(place.id));
}

export function evaluatePolicy(
  bundles: AccessBundle[],
  request: PolicyRequest,
): PolicyDecision {
  const grants = bundles.flatMap((bundle) => bundle.grants);
  const matchingGrants = grants
    .filter((grant) => grant.capability === request.capability)
    .filter((grant) => resourceMatches(grant.resource, request.resource))
    .sort(
      (a, b) =>
        specificityScore(b.resource, request.resource) -
        specificityScore(a.resource, request.resource),
    );

  if (matchingGrants.length === 0) {
    return {
      decision: "deny",
      risk: "privileged",
      requiresApproval: false,
      reason: `No grant allows ${request.capability} in this place.`,
    };
  }

  const denyingGrant = matchingGrants.find(
    (grant) => grant.decision === "deny",
  );
  if (denyingGrant) {
    return {
      decision: "deny",
      risk: denyingGrant.risk,
      requiresApproval: false,
      matchingGrant: denyingGrant,
      reason: `Grant ${denyingGrant.id} explicitly denies ${request.capability}.`,
    };
  }

  const matchingGrant = matchingGrants[0]!;
  return {
    decision: matchingGrant.decision,
    risk: matchingGrant.risk,
    requiresApproval:
      matchingGrant.requiresApproval || matchingGrant.decision === "ask",
    matchingGrant,
    reason:
      matchingGrant.decision === "ask"
        ? `Grant ${matchingGrant.id} allows ${request.capability} after approval.`
        : `Grant ${matchingGrant.id} allows ${request.capability}.`,
  };
}

function resourceMatches(
  grantResource: string,
  requestedResource?: string,
): boolean {
  if (!requestedResource) {
    return grantResource === "*";
  }
  if (grantResource === requestedResource || grantResource === "*") {
    return true;
  }
  if (grantResource.endsWith("*")) {
    return requestedResource.startsWith(grantResource.slice(0, -1));
  }
  return false;
}

function specificityScore(
  grantResource: string,
  requestedResource?: string,
): number {
  if (!requestedResource) {
    return grantResource === "*" ? 1 : 0;
  }
  if (grantResource === requestedResource) {
    return 1000;
  }
  if (grantResource.endsWith("*")) {
    return grantResource.length;
  }
  if (grantResource === "*") {
    return 1;
  }
  return 0;
}

export function assertSingleVisibleAgent(agentHandles: string[]): void {
  const unique = new Set(agentHandles.map((handle) => handle.toLowerCase()));
  if (unique.size !== 1) {
    throw new Error(
      "Bek v1 must expose exactly one visible agent handle per workspace.",
    );
  }
}
