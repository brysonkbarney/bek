import type { CapabilityGrant } from "@bek/core";

export interface ToolDescriptor {
  name: string;
  description: string;
  resource: string;
  inputSchema: Record<string, unknown>;
  risk: CapabilityGrant["risk"];
  requiresApproval: boolean;
}

export interface ToolManifest {
  runId: string;
  tools: ToolDescriptor[];
  deniedResources: string[];
}

export function manifestFromGrants(
  runId: string,
  grants: CapabilityGrant[],
): ToolManifest {
  const toolGrants = grants.filter((grant) => grant.capability === "mcp.tool");
  return {
    runId,
    tools: toolGrants
      .filter((grant) => grant.decision !== "deny")
      .map((grant) => descriptorFromGrant(grant)),
    deniedResources: toolGrants
      .filter((grant) => grant.decision === "deny")
      .map((grant) => grant.resource),
  };
}

export function canExposeTool(grant: CapabilityGrant): boolean {
  return grant.capability === "mcp.tool" && grant.decision !== "deny";
}

function descriptorFromGrant(grant: CapabilityGrant): ToolDescriptor {
  return {
    name: toolNameFromResource(grant.resource),
    description: `Governed MCP tool access for ${grant.resource}`,
    resource: grant.resource,
    inputSchema: { type: "object", additionalProperties: true },
    risk: grant.risk,
    requiresApproval: grant.requiresApproval || grant.decision === "ask",
  };
}

function toolNameFromResource(resource: string): string {
  return resource
    .replace(/^mcp:/, "")
    .replace(/[^a-zA-Z0-9_/-]/g, "_")
    .replaceAll("/", "__");
}
