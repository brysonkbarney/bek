import { expect, test } from "@playwright/test";

test("creates and approves a demo run against the real API", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      name: "@bek is one teammate with governed capabilities.",
    }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Demo PR Run" }).click();
  await expect(page.getByText("Demo run started.")).toBeVisible();

  await page
    .getByRole("navigation", { name: "Bek admin navigation" })
    .getByRole("link", { name: "Approvals", exact: true })
    .click();
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

  await page
    .getByRole("navigation", { name: "Bek admin navigation" })
    .getByRole("link", { name: "Audit", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Every policy decision and action should leave a trail.",
    }),
  ).toBeVisible();
  await expect(page.getByText("approval.decided").first()).toBeVisible();
  await expect(page.getByText("run.completed").first()).toBeVisible();

  expect(pageErrors).toEqual([]);
});
