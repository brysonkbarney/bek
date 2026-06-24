import { describe, expect, it } from "vitest";
import {
  createGitHubWebhookDeliveryDedupeKey,
  getGitHubWebhookDeliveryDedupeKeyFromHeaders,
  normalizeGitHubWebhookEvent,
} from "./webhooks";

describe("GitHub webhook helpers", () => {
  it("creates stable delivery dedupe keys from ids or headers", () => {
    expect(
      createGitHubWebhookDeliveryDedupeKey({
        eventName: "Pull_Request",
        deliveryId: "ABC-123",
      }),
    ).toBe("github:webhook:pull_request:abc-123");
    expect(
      getGitHubWebhookDeliveryDedupeKeyFromHeaders({
        "X-GitHub-Delivery": "delivery-1",
        "X-GitHub-Event": "check_run",
      }),
    ).toBe("github:webhook:check_run:delivery-1");
  });

  it("normalizes installation webhook payloads", () => {
    expect(
      normalizeGitHubWebhookEvent({
        eventName: "installation",
        deliveryId: "delivery-2",
        payload: {
          action: "created",
          installation: {
            id: 123,
            account: { login: "RedoHQ" },
            repository_selection: "selected",
          },
          repositories: [{ full_name: "RedoHQ/Checkout" }],
          sender: { login: "bryson" },
        },
      }),
    ).toEqual({
      provider: "github",
      type: "github.installation",
      eventName: "installation",
      action: "created",
      installationId: "123",
      deliveryId: "delivery-2",
      dedupeKey: "github:webhook:installation:delivery-2",
      senderLogin: "bryson",
      accountLogin: "RedoHQ",
      repositorySelection: "selected",
      repositories: [
        {
          provider: "github",
          owner: "redohq",
          repo: "checkout",
          fullName: "redohq/checkout",
          resource: "github:redohq/checkout",
          url: "https://github.com/redohq/checkout",
        },
      ],
      repositoriesAdded: [],
      repositoriesRemoved: [],
    });
  });

  it("normalizes pull request webhook payloads", () => {
    expect(
      normalizeGitHubWebhookEvent({
        eventName: "pull_request",
        payload: {
          action: "opened",
          repository: { full_name: "RedoHQ/Checkout" },
          installation: { id: 123 },
          pull_request: {
            id: 456,
            number: 12,
            title: "Add retry tests",
            state: "open",
            draft: true,
            html_url: "https://github.com/redohq/checkout/pull/12",
            user: { login: "bek" },
            head: {
              ref: "bek/retry-tests",
              sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              repo: { full_name: "RedoHQ/Checkout" },
            },
            base: {
              ref: "main",
              sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              repo: { full_name: "RedoHQ/Checkout" },
            },
          },
          sender: { login: "bryson" },
        },
      }),
    ).toMatchObject({
      provider: "github",
      type: "github.pull_request",
      eventName: "pull_request",
      action: "opened",
      installationId: "123",
      repository: { resource: "github:redohq/checkout" },
      senderLogin: "bryson",
      pullRequest: {
        id: 456,
        number: 12,
        title: "Add retry tests",
        state: "open",
        draft: true,
        authorLogin: "bek",
        head: {
          branch: "bek/retry-tests",
          sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          repository: { resource: "github:redohq/checkout" },
        },
        base: {
          branch: "main",
          sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          repository: { resource: "github:redohq/checkout" },
        },
      },
    });
  });

  it("normalizes check_run webhook payloads", () => {
    expect(
      normalizeGitHubWebhookEvent({
        eventName: "check_run",
        payload: {
          action: "completed",
          repository: { full_name: "RedoHQ/Checkout" },
          check_run: {
            id: 987,
            name: "unit tests",
            head_sha: "cccccccccccccccccccccccccccccccccccccccc",
            status: "completed",
            conclusion: "success",
            html_url: "https://github.com/redohq/checkout/runs/987",
            pull_requests: [{ number: 12 }],
          },
        },
      }),
    ).toMatchObject({
      provider: "github",
      type: "github.check_run",
      eventName: "check_run",
      action: "completed",
      repository: { resource: "github:redohq/checkout" },
      checkRun: {
        id: 987,
        name: "unit tests",
        headSha: "cccccccccccccccccccccccccccccccccccccccc",
        status: "completed",
        conclusion: "success",
        htmlUrl: "https://github.com/redohq/checkout/runs/987",
        pullRequestNumbers: [12],
      },
    });
  });
});
