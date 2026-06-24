import { describe, expect, it } from "vitest";
import { slackInstallStartPath } from "./api";

describe("web API helpers", () => {
  it("builds Slack install start paths with encoded return targets", () => {
    expect(slackInstallStartPath()).toBe(
      "/api/slack/install-url?return_to=%2Fconnectors",
    );
    expect(slackInstallStartPath("/connectors?slack=1")).toBe(
      "/api/slack/install-url?return_to=%2Fconnectors%3Fslack%3D1",
    );
  });
});
