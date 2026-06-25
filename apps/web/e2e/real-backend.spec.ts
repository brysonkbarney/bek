import { expect, test } from "@playwright/test";

test("creates and approves a demo run against the real API", async ({
  page,
}, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const mcpServerId = `docs-${testInfo.workerIndex}-${Date.now()}`;
  const mcpDisplayName = `Docs MCP ${mcpServerId}`;

  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      name: "@bek is one teammate with governed capabilities.",
    }),
  ).toBeVisible();

  const nav = page.getByRole("navigation", { name: "Bek admin navigation" });
  await nav.getByRole("link", { name: "Connectors", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Slack, repos, MCP registries, sandboxes, and model providers are governed behind one agent.",
    }),
  ).toBeVisible();
  await page.getByLabel("Server ID").fill(mcpServerId);
  await page.getByLabel("Display name").fill(mcpDisplayName);
  await page.getByLabel("Origin").fill("npx @bek/docs-mcp");
  await page.getByRole("button", { name: "Register Server" }).click();
  await expect(page.getByText("MCP server saved.")).toBeVisible();
  await expect(page.getByText(mcpDisplayName)).toBeVisible();
  await page.getByRole("button", { name: "Activate" }).click();
  await expect(page.getByText("MCP server status saved.")).toBeVisible();

  const mcpToolName = `lookup_${Date.now()}`;
  await nav.getByRole("link", { name: "Access", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Bundle tools, repos, models, and approvals by place.",
    }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Details" }).first().click();
  const addGrantForm = page.getByRole("form", { name: "Add access grant" });
  await addGrantForm.getByLabel("Capability").selectOption("mcp.tool");
  await addGrantForm.getByLabel("MCP server").selectOption(mcpServerId);
  await addGrantForm.getByLabel("Tool name").fill(mcpToolName);
  await addGrantForm.getByRole("button", { name: "Add Grant" }).click();
  await expect(page.getByText("Grant added to this bundle.")).toBeVisible();
  const expectedMcpResource = `mcp:${mcpServerId}/${mcpToolName}`;
  await expect
    .poll(() =>
      page.locator("input").evaluateAll((inputs, expected) => {
        return inputs.some(
          (input) =>
            input instanceof HTMLInputElement && input.value === expected,
        );
      }, expectedMcpResource),
    )
    .toBe(true);

  await nav.getByRole("link", { name: "Overview", exact: true }).click();
  await page.getByRole("button", { name: "Demo PR Run" }).click();
  await expect(page.getByText("Demo run started.")).toBeVisible();

  await nav.getByRole("link", { name: "Approvals", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Risky Bek actions wait for approval." }),
  ).toBeVisible();
  await expect(page.getByText("github.pr")).toBeVisible();

  await page
    .getByRole("button", { name: "Review approval for github.pr" })
    .click();
  await page
    .getByRole("button", { name: "Confirm approval for github.pr" })
    .click();
  await expect(page.getByText("Approval decision saved.")).toBeVisible();

  await nav.getByRole("link", { name: "Audit", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Every policy decision and action should leave a trail.",
    }),
  ).toBeVisible();
  await expect(
    page.getByText(`Registered MCP server ${mcpDisplayName}.`),
  ).toBeVisible();
  await expect(
    page.getByText(`Updated MCP server ${mcpDisplayName}.`),
  ).toBeVisible();
  await expect(page.getByText("approval.decided").first()).toBeVisible();
  await expect(page.getByText("run.completed").first()).toBeVisible();

  expect(pageErrors).toEqual([]);
});
