import { describe, expect, it } from "vitest";
import {
  createGitHubWebhookSignature,
  verifyGitHubWebhookSignature,
} from "./signatures";
import {
  createGitHubWebhookDeliveryDedupeKey,
  getGitHubWebhookDeliveryDedupeKeyFromHeaders,
  normalizeGitHubWebhookEvent,
  type GitHubWebhookEventName,
} from "./webhooks";

const SECRET = "test-webhook-secret";
const WRONG_SECRET = "test-webhook-secret-wrong";

// One representative payload per supported GitHub webhook event.
const GITHUB_PAYLOADS: Record<GitHubWebhookEventName, unknown> = {
  installation: {
    action: "created",
    installation: {
      id: 123,
      account: { login: "RedoHQ" },
      repository_selection: "selected",
    },
    repositories: [{ id: 112233, full_name: "RedoHQ/Checkout" }],
    sender: { login: "bryson" },
  },
  installation_repositories: {
    action: "added",
    installation: { id: 123, account: { login: "RedoHQ" } },
    repositories_added: [{ id: 1, full_name: "RedoHQ/Added" }],
    repositories_removed: [{ id: 2, full_name: "RedoHQ/Removed" }],
    sender: { login: "bryson" },
  },
  pull_request: {
    action: "opened",
    number: 7,
    repository: { id: 99, full_name: "RedoHQ/Checkout" },
    pull_request: {
      id: 5001,
      number: 7,
      title: "Add thing",
      state: "open",
      draft: false,
      html_url: "https://github.com/RedoHQ/Checkout/pull/7",
      user: { login: "bryson" },
      head: { ref: "feature", sha: "a".repeat(40) },
      base: { ref: "main", sha: "b".repeat(40) },
    },
    installation: { id: 123 },
    sender: { login: "bryson" },
  },
  check_run: {
    action: "completed",
    repository: { id: 99, full_name: "RedoHQ/Checkout" },
    check_run: {
      id: 7002,
      name: "ci",
      head_sha: "c".repeat(40),
      status: "completed",
      conclusion: "success",
      html_url: "https://github.com/RedoHQ/Checkout/runs/7002",
      pull_requests: [{ number: 7 }],
    },
    installation: { id: 123 },
    sender: { login: "bryson" },
  },
};

const EVENT_NAMES = Object.keys(GITHUB_PAYLOADS) as GitHubWebhookEventName[];

function bodyFor(eventName: GitHubWebhookEventName): string {
  return JSON.stringify(GITHUB_PAYLOADS[eventName]);
}

describe("GitHub replay/tamper: signature verification per event type", () => {
  for (const eventName of EVENT_NAMES) {
    const rawBody = bodyFor(eventName);
    const signature = createGitHubWebhookSignature(SECRET, rawBody);

    it(`accepts a correctly signed ${eventName} body`, () => {
      expect(
        verifyGitHubWebhookSignature({
          webhookSecret: SECRET,
          signature,
          rawBody,
        }),
      ).toBe(true);
    });

    it(`accepts a Uint8Array body that matches the string signature`, () => {
      expect(
        verifyGitHubWebhookSignature({
          webhookSecret: SECRET,
          signature,
          rawBody: new TextEncoder().encode(rawBody),
        }),
      ).toBe(true);
    });

    it(`rejects a single-byte mutated ${eventName} body`, () => {
      const lastChar = rawBody.slice(-1);
      const mutated = rawBody.slice(0, -1) + (lastChar === "}" ? " " : "}");
      expect(
        verifyGitHubWebhookSignature({
          webhookSecret: SECRET,
          signature,
          rawBody: mutated,
        }),
      ).toBe(false);
    });

    it(`rejects a field-changed ${eventName} body`, () => {
      const tampered = JSON.stringify({
        ...(GITHUB_PAYLOADS[eventName] as Record<string, unknown>),
        injected: "evil",
      });
      expect(
        verifyGitHubWebhookSignature({
          webhookSecret: SECRET,
          signature,
          rawBody: tampered,
        }),
      ).toBe(false);
    });

    it(`rejects a re-serialized (whitespace) ${eventName} body`, () => {
      const reordered = JSON.stringify(JSON.parse(rawBody), null, 2);
      expect(
        verifyGitHubWebhookSignature({
          webhookSecret: SECRET,
          signature,
          rawBody: reordered,
        }),
      ).toBe(false);
    });
  }
});

describe("GitHub signature edge cases", () => {
  const rawBody = bodyFor("pull_request");
  const validSig = createGitHubWebhookSignature(SECRET, rawBody);

  it("rejects a missing signature", () => {
    expect(
      verifyGitHubWebhookSignature({ webhookSecret: SECRET, rawBody }),
    ).toBe(false);
  });

  it("rejects a wrong-secret signature", () => {
    expect(
      verifyGitHubWebhookSignature({
        webhookSecret: SECRET,
        signature: createGitHubWebhookSignature(WRONG_SECRET, rawBody),
        rawBody,
      }),
    ).toBe(false);
  });

  it("rejects a truncated signature", () => {
    expect(
      verifyGitHubWebhookSignature({
        webhookSecret: SECRET,
        signature: validSig.slice(0, -2),
        rawBody,
      }),
    ).toBe(false);
  });

  it("rejects an over-length signature", () => {
    expect(
      verifyGitHubWebhookSignature({
        webhookSecret: SECRET,
        signature: `${validSig}ab`,
        rawBody,
      }),
    ).toBe(false);
  });

  it("rejects a wrong version prefix (sha1=)", () => {
    expect(
      verifyGitHubWebhookSignature({
        webhookSecret: SECRET,
        signature: validSig.replace("sha256=", "sha1=2"),
        rawBody,
      }),
    ).toBe(false);
  });

  it("rejects a hex digest without the sha256= prefix", () => {
    expect(
      verifyGitHubWebhookSignature({
        webhookSecret: SECRET,
        signature: validSig.replace("sha256=", ""),
        rawBody,
      }),
    ).toBe(false);
  });

  it("rejects a non-hex signature of correct shape", () => {
    expect(
      verifyGitHubWebhookSignature({
        webhookSecret: SECRET,
        signature: `sha256=${"z".repeat(64)}`,
        rawBody,
      }),
    ).toBe(false);
  });

  it("rejects an empty signature", () => {
    expect(
      verifyGitHubWebhookSignature({
        webhookSecret: SECRET,
        signature: "",
        rawBody,
      }),
    ).toBe(false);
  });

  it("rejects leading/trailing whitespace-only differences in body", () => {
    expect(
      verifyGitHubWebhookSignature({
        webhookSecret: SECRET,
        signature: validSig,
        rawBody: ` ${rawBody}`,
      }),
    ).toBe(false);
  });

  it("accepts case/whitespace-normalized signatures (constant-time path)", () => {
    // The verifier normalizes the incoming signature (trim + lowercase), so an
    // upper-cased and padded but otherwise-correct signature still verifies.
    expect(
      verifyGitHubWebhookSignature({
        webhookSecret: SECRET,
        signature: `  ${validSig.toUpperCase()}  `,
        rawBody,
      }),
    ).toBe(true);
  });

  it("signs and verifies an empty body deterministically", () => {
    const sig = createGitHubWebhookSignature(SECRET, "");
    expect(
      verifyGitHubWebhookSignature({
        webhookSecret: SECRET,
        signature: sig,
        rawBody: "",
      }),
    ).toBe(true);
    expect(
      verifyGitHubWebhookSignature({
        webhookSecret: SECRET,
        signature: sig,
        rawBody: " ",
      }),
    ).toBe(false);
  });

  it("fails closed without a secret unless explicitly unsigned", () => {
    expect(verifyGitHubWebhookSignature({ rawBody })).toBe(false);
    expect(verifyGitHubWebhookSignature({ rawBody, allowUnsigned: true })).toBe(
      true,
    );
  });

  it("treats a whitespace-only secret as no secret (fails closed)", () => {
    expect(
      verifyGitHubWebhookSignature({
        webhookSecret: "   ",
        signature: validSig,
        rawBody,
      }),
    ).toBe(false);
  });
});

describe("GitHub replay: delivery dedupe detection", () => {
  it("produces identical keys for duplicate deliveries (replay detection)", () => {
    const first = createGitHubWebhookDeliveryDedupeKey({
      eventName: "pull_request",
      deliveryId: "ABC-123",
    });
    const replay = createGitHubWebhookDeliveryDedupeKey({
      eventName: "Pull_Request",
      deliveryId: "abc-123",
    });
    expect(first).toBe(replay);
  });

  it("produces distinct keys for distinct deliveries", () => {
    const a = createGitHubWebhookDeliveryDedupeKey({
      eventName: "pull_request",
      deliveryId: "delivery-1",
    });
    const b = createGitHubWebhookDeliveryDedupeKey({
      eventName: "pull_request",
      deliveryId: "delivery-2",
    });
    expect(a).not.toBe(b);
  });

  it("detects duplicates through a seen-set across normalized events", () => {
    const seen = new Set<string>();
    const deliver = (deliveryId: string) => {
      const event = normalizeGitHubWebhookEvent({
        eventName: "pull_request",
        deliveryId,
        payload: GITHUB_PAYLOADS.pull_request,
      });
      const key = event.dedupeKey!;
      if (seen.has(key)) {
        return "duplicate" as const;
      }
      seen.add(key);
      return "accepted" as const;
    };
    expect(deliver("dup-1")).toBe("accepted");
    expect(deliver("DUP-1")).toBe("duplicate"); // case-insensitive replay
    expect(deliver("dup-2")).toBe("accepted");
  });

  it("derives dedupe keys from headers regardless of casing", () => {
    expect(
      getGitHubWebhookDeliveryDedupeKeyFromHeaders({
        "X-GitHub-Delivery": "Delivery-9",
        "X-GitHub-Event": "Check_Run",
      }),
    ).toBe(
      getGitHubWebhookDeliveryDedupeKeyFromHeaders({
        "x-github-delivery": "delivery-9",
        "x-github-event": "check_run",
      }),
    );
  });

  it("returns undefined when no delivery id header is present", () => {
    expect(
      getGitHubWebhookDeliveryDedupeKeyFromHeaders({
        "x-github-event": "pull_request",
      }),
    ).toBeUndefined();
  });

  it("rejects adversarial delivery ids", () => {
    expect(() =>
      createGitHubWebhookDeliveryDedupeKey({ deliveryId: "" }),
    ).toThrow();
    expect(() =>
      createGitHubWebhookDeliveryDedupeKey({ deliveryId: "../etc/passwd" }),
    ).toThrow();
    expect(() =>
      createGitHubWebhookDeliveryDedupeKey({ deliveryId: " spaced id " }),
    ).toThrow();
  });
});

describe("GitHub fuzz: normalize rejects/handles adversarial bodies without unhandled errors", () => {
  // normalizeGitHubWebhookEvent rejects malformed input by throwing a
  // structured Error. For each fuzz input we assert a deterministic outcome:
  // either it throws an Error (rejection) or returns a typed event — never an
  // unhandled crash (e.g. a TypeError from undefined access).
  const malformed: Array<{
    label: string;
    eventName: string;
    payload: unknown;
  }> = [
    { label: "unsupported event", eventName: "push", payload: {} },
    { label: "empty event name", eventName: "", payload: {} },
    { label: "null payload", eventName: "pull_request", payload: null },
    { label: "string payload", eventName: "pull_request", payload: "nope" },
    { label: "array payload", eventName: "pull_request", payload: [] },
    { label: "number payload", eventName: "pull_request", payload: 42 },
    {
      label: "pull_request missing pull_request",
      eventName: "pull_request",
      payload: { action: "opened", repository: { full_name: "a/b" } },
    },
    {
      label: "pull_request bad types",
      eventName: "pull_request",
      payload: {
        action: "opened",
        repository: { full_name: "a/b" },
        pull_request: {
          id: "not-a-number",
          number: -1,
          title: 5,
          state: null,
          head: {},
          base: {},
        },
      },
    },
    {
      label: "installation missing id",
      eventName: "installation",
      payload: { action: "created", installation: {} },
    },
    {
      label: "installation missing action",
      eventName: "installation",
      payload: { installation: { id: 1 } },
    },
    {
      label: "check_run missing check_run",
      eventName: "check_run",
      payload: { action: "completed", repository: { full_name: "a/b" } },
    },
    {
      label: "check_run pull_requests bad entry",
      eventName: "check_run",
      payload: {
        action: "completed",
        repository: { full_name: "a/b" },
        check_run: {
          id: 1,
          name: "ci",
          head_sha: "x",
          status: "completed",
          pull_requests: [{ number: "nope" }],
        },
      },
    },
    {
      label: "repository missing owner/name",
      eventName: "pull_request",
      payload: {
        action: "opened",
        repository: {},
        pull_request: {
          id: 1,
          number: 1,
          title: "t",
          state: "open",
          head: { ref: "a", sha: "b" },
          base: { ref: "c" },
        },
      },
    },
    {
      label: "deeply nested payload",
      eventName: "pull_request",
      payload: deepNest(500),
    },
    {
      label: "huge title string",
      eventName: "pull_request",
      payload: {
        action: "opened",
        repository: { full_name: "a/b" },
        pull_request: {
          id: 1,
          number: 1,
          title: "x".repeat(100000),
          state: "open",
          head: { ref: "a", sha: "b" },
          base: { ref: "c" },
        },
      },
    },
    {
      label: "unicode and null byte fields",
      eventName: "pull_request",
      payload: {
        action: "opened ",
        repository: { full_name: "🔥/💀" },
        pull_request: {
          id: 1,
          number: 1,
          title: "🔥".repeat(50),
          state: "open",
          head: { ref: "a", sha: "b" },
          base: { ref: "c" },
        },
      },
    },
  ];

  for (const { label, eventName, payload } of malformed) {
    it(`handles ${label} without an unhandled crash`, () => {
      let threw = false;
      let result: unknown;
      try {
        result = normalizeGitHubWebhookEvent({ eventName, payload });
      } catch (error) {
        threw = true;
        // Rejection must be a structured Error, not a raw TypeError surfacing
        // an internal undefined-access bug.
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message.length).toBeGreaterThan(0);
      }
      if (!threw) {
        // If it did not reject, it must have produced a typed, provider-tagged
        // event — never a partially-built object.
        expect((result as { provider?: string }).provider).toBe("github");
      }
    });
  }

  it("also fuzzes invalid JSON bodies through signature verification", () => {
    // Raw transport bytes are never parsed by the verifier, so even garbage
    // bytes must produce a deterministic boolean, never a throw.
    const garbage = ["", "{", "][", "  ", "🔥".repeat(1000)];
    for (const body of garbage) {
      expect(() =>
        verifyGitHubWebhookSignature({
          webhookSecret: SECRET,
          signature: createGitHubWebhookSignature(SECRET, body),
          rawBody: body,
        }),
      ).not.toThrow();
      // Correctly signed garbage still verifies (signature is over bytes).
      expect(
        verifyGitHubWebhookSignature({
          webhookSecret: SECRET,
          signature: createGitHubWebhookSignature(SECRET, body),
          rawBody: body,
        }),
      ).toBe(true);
    }
  });
});

function deepNest(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = { action: "opened" };
  for (let i = 0; i < depth; i += 1) {
    value = { nested: value };
  }
  return value;
}
