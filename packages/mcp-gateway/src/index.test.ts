import type { CapabilityGrant } from "@bek/core";
import { describe, expect, it } from "vitest";
import { canExposeTool, manifestFromGrants } from "./index";

const grants: CapabilityGrant[] = [
  {
    id: "grant_repo",
    capability: "github.read",
    resource: "github:redohq/checkout",
    decision: "allow",
    risk: "read_internal",
    requiresApproval: false,
  },
  {
    id: "grant_tool",
    capability: "mcp.tool",
    resource: "mcp:linear/create_issue",
    decision: "ask",
    risk: "write_external",
    requiresApproval: true,
  },
  {
    id: "grant_denied_tool",
    capability: "mcp.tool",
    resource: "mcp:prod-db/query",
    decision: "deny",
    risk: "privileged",
    requiresApproval: false,
  },
];

describe("MCP gateway", () => {
  it("exposes only mcp.tool grants", () => {
    const manifest = manifestFromGrants("run_test", grants);
    expect(manifest.tools).toHaveLength(1);
    expect(manifest.tools[0]).toMatchObject({
      name: "linear__create_issue",
      resource: "mcp:linear/create_issue",
      requiresApproval: true,
    });
  });

  it("keeps denied tools visible as denied resources, not callable descriptors", () => {
    const manifest = manifestFromGrants("run_test", grants);
    expect(manifest.deniedResources).toEqual(["mcp:prod-db/query"]);
    expect(canExposeTool(grants[2]!)).toBe(false);
  });
});
