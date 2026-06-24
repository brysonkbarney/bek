import { describe, expect, it } from "vitest";
import { cancelRunPath, slackInstallStartPath } from "./api";

describe("web API helpers", () => {
  it("builds Slack install start paths with encoded return targets", () => {
    expect(slackInstallStartPath()).toBe(
      "/api/slack/install-url?return_to=%2Fconnectors",
    );
    expect(slackInstallStartPath("/connectors?slack=1")).toBe(
      "/api/slack/install-url?return_to=%2Fconnectors%3Fslack%3D1",
    );
  });

  it("builds run cancellation paths with encoded run ids", () => {
    expect(cancelRunPath("run_123")).toBe("/api/runs/run_123/cancel");
    expect(cancelRunPath("run/with space")).toBe(
      "/api/runs/run%2Fwith%20space/cancel",
    );
  });
});
