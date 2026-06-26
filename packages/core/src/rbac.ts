/**
 * Role-based access control for the Bek admin control plane.
 *
 * Replaces the all-or-nothing bootstrap token with explicit roles and scoped
 * permissions. Pure and deterministic — the API derives a {@link Role} from the
 * authenticated principal/token and calls {@link authorizeScope} before any
 * governed mutation. Reads stay open to any authenticated role; the scopes here
 * gate the high-risk write/operate/export paths.
 */

export type Role =
  | "owner"
  | "admin"
  | "operator"
  | "approver"
  | "developer"
  | "viewer"
  | "billing_admin";

export type Scope =
  | "slack.manage"
  | "github.manage"
  | "models.manage"
  | "mcp.manage"
  | "credentials.manage"
  | "connectors.manage"
  | "channels.manage"
  | "access.manage"
  | "runtime.manage"
  | "settings.manage"
  | "worker.operate"
  | "writes.approve"
  | "runs.create"
  | "runs.cancel"
  | "audit.view"
  | "audit.export"
  | "billing.manage";

export const ALL_ROLES: readonly Role[] = [
  "owner",
  "admin",
  "operator",
  "approver",
  "developer",
  "viewer",
  "billing_admin",
];

export const ALL_SCOPES: readonly Scope[] = [
  "slack.manage",
  "github.manage",
  "models.manage",
  "mcp.manage",
  "credentials.manage",
  "connectors.manage",
  "channels.manage",
  "access.manage",
  "runtime.manage",
  "settings.manage",
  "worker.operate",
  "writes.approve",
  "runs.create",
  "runs.cancel",
  "audit.view",
  "audit.export",
  "billing.manage",
];

const configScopes: Scope[] = [
  "slack.manage",
  "github.manage",
  "models.manage",
  "mcp.manage",
  "credentials.manage",
  "connectors.manage",
  "channels.manage",
  "access.manage",
  "runtime.manage",
  "settings.manage",
];

/**
 * Role → granted scopes. Owner is unrestricted; admin manages everything except
 * billing; operator runs the live system; approver only decides approvals;
 * developer can only start runs; viewer is read-only; billing_admin only billing.
 */
export const ROLE_SCOPES: Record<Role, readonly Scope[]> = {
  owner: ALL_SCOPES,
  admin: [
    ...configScopes,
    "worker.operate",
    "writes.approve",
    "runs.create",
    "runs.cancel",
    "audit.view",
    "audit.export",
  ],
  operator: [
    "worker.operate",
    "writes.approve",
    "runs.create",
    "runs.cancel",
    "audit.view",
  ],
  approver: ["writes.approve", "audit.view"],
  developer: ["runs.create", "audit.view"],
  viewer: ["audit.view"],
  billing_admin: ["billing.manage", "audit.view"],
};

export function isRole(value: string): value is Role {
  return (ALL_ROLES as readonly string[]).includes(value);
}

export function scopesForRole(role: Role): readonly Scope[] {
  return ROLE_SCOPES[role];
}

export function roleHasScope(role: Role, scope: Scope): boolean {
  return ROLE_SCOPES[role].includes(scope);
}

export interface AuthorizeDecision {
  allowed: boolean;
  role: Role;
  scope: Scope;
  reason: string;
}

/**
 * Authorizes a role for a required scope. Returns a structured decision so the
 * caller can audit denials.
 */
export function authorizeScope(role: Role, scope: Scope): AuthorizeDecision {
  const allowed = roleHasScope(role, scope);
  return {
    allowed,
    role,
    scope,
    reason: allowed
      ? `Role ${role} has scope ${scope}.`
      : `Role ${role} is missing required scope ${scope}.`,
  };
}

/**
 * Maps an admin API request (method + path) to the scope it requires, or null
 * when the request is an open read available to any authenticated role.
 */
export function requiredScopeForRequest(
  method: string,
  path: string,
): Scope | null {
  const upper = method.toUpperCase();
  const isWrite =
    upper === "POST" ||
    upper === "PATCH" ||
    upper === "PUT" ||
    upper === "DELETE";

  // Session management (sign-in / sign-out / whoami) is open to any
  // authenticated caller — it never mutates governed state.
  if (path.startsWith("/api/auth/")) {
    return null;
  }
  // Audit export is gated even though it is technically a read of sensitive data.
  if (path.startsWith("/api/audit-events/export")) {
    return "audit.export";
  }
  if (!isWrite) {
    return null;
  }

  // Approvals: deciding writes.
  if (/^\/api\/approvals\/[^/]+\/(approve|deny)$/.test(path)) {
    return "writes.approve";
  }
  // Runs.
  if (/^\/api\/runs\/[^/]+\/cancel$/.test(path)) {
    return "runs.cancel";
  }
  if (path === "/api/runs") {
    return "runs.create";
  }
  // Worker / outbox operations.
  if (
    path.startsWith("/api/worker/") ||
    path.startsWith("/api/outbound/") ||
    path.includes("/dead-letter")
  ) {
    return "worker.operate";
  }
  // Connector / config management.
  if (path.startsWith("/api/connectors/mcp")) {
    return "mcp.manage";
  }
  if (path.startsWith("/api/connectors")) {
    return "connectors.manage";
  }
  if (path.startsWith("/api/slack")) {
    return "slack.manage";
  }
  if (path.startsWith("/api/github")) {
    return "github.manage";
  }
  if (path.startsWith("/api/channels")) {
    return "channels.manage";
  }
  if (path.startsWith("/api/access-bundles")) {
    return "access.manage";
  }
  if (path.startsWith("/api/model-policies")) {
    return "models.manage";
  }
  if (path.startsWith("/api/runtime-profiles")) {
    return "runtime.manage";
  }
  // Everything else that writes is workspace settings (agent, principals, etc.).
  return "settings.manage";
}
