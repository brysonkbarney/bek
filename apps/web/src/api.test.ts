import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adminAuthHeaders,
  cancelRunPath,
  clearAdminApiToken,
  hasStoredAdminToken,
  redriveDeadLetterPath,
  readAdminApiToken,
  saveAdminApiToken,
  slackInstallStartPath,
} from "./api";

describe("web API helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stores admin tokens at runtime for protected admin consoles", () => {
    const storage = createMemoryStorage();
    vi.stubGlobal("window", { localStorage: storage });

    expect(readAdminApiToken()).toBeUndefined();
    expect(hasStoredAdminToken()).toBe(false);

    saveAdminApiToken(" runtime-token ");

    expect(hasStoredAdminToken()).toBe(true);
    expect(readAdminApiToken()).toBe("runtime-token");
    expect(adminAuthHeaders({ "content-type": "application/json" })).toEqual({
      authorization: "Bearer runtime-token",
      "content-type": "application/json",
    });

    clearAdminApiToken();
    expect(readAdminApiToken()).toBeUndefined();
    expect(hasStoredAdminToken()).toBe(false);
  });

  it("clears the runtime admin token when saved input is empty", () => {
    const storage = createMemoryStorage();
    vi.stubGlobal("window", { localStorage: storage });

    saveAdminApiToken("runtime-token");
    saveAdminApiToken("   ");

    expect(readAdminApiToken()).toBeUndefined();
  });

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

  it("builds dead-letter redrive paths with encoded ids", () => {
    expect(redriveDeadLetterPath("dead_123")).toBe(
      "/api/worker/dead-letters/dead_123/redrive",
    );
    expect(redriveDeadLetterPath("dead/with space")).toBe(
      "/api/worker/dead-letters/dead%2Fwith%20space/redrive",
    );
  });
});

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}
