import { describe, expect, it } from "vitest";
import {
  formatGitHubRepoResource,
  isGitHubRepoResource,
  parseGitHubRepoResource,
  tryParseGitHubRepoResource,
} from "./resources";

describe("GitHub repo resources", () => {
  it("formats canonical bundle resources", () => {
    expect(
      formatGitHubRepoResource({ owner: "RedoHQ", repo: "Checkout" }),
    ).toBe("github:redohq/checkout");
  });

  it("parses canonical, shorthand, URL, and SSH repo references", () => {
    expect(parseGitHubRepoResource("github:RedoHQ/Checkout")).toMatchObject({
      provider: "github",
      owner: "redohq",
      repo: "checkout",
      fullName: "redohq/checkout",
      resource: "github:redohq/checkout",
      url: "https://github.com/redohq/checkout",
    });
    expect(parseGitHubRepoResource("RedoHQ/Checkout.git").resource).toBe(
      "github:redohq/checkout",
    );
    expect(
      parseGitHubRepoResource("https://github.com/RedoHQ/Checkout/pull/12")
        .resource,
    ).toBe("github:redohq/checkout");
    expect(
      parseGitHubRepoResource("git@github.com:RedoHQ/Checkout.git").resource,
    ).toBe("github:redohq/checkout");
  });

  it("rejects non-repo resources and invalid names", () => {
    expect(tryParseGitHubRepoResource("github:redohq/*")).toBeUndefined();
    expect(
      tryParseGitHubRepoResource("https://example.com/a/b"),
    ).toBeUndefined();
    expect(() => parseGitHubRepoResource("github:-bad/repo")).toThrow(
      "GitHub owner",
    );
    expect(isGitHubRepoResource("github:redohq/checkout")).toBe(true);
    expect(isGitHubRepoResource("github:redohq")).toBe(false);
  });
});
