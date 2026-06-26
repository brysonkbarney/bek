import { describe, expect, it } from "vitest";
import { createSlackSignature, verifySlackSignature } from "./signatures";
import { normalizeSlackEvent } from "./events";
import { parseSlackInteraction } from "./interactivity";
import { parseSlackCommand } from "./commands";
import { createSlackOAuthState, verifySlackOAuthState } from "./oauth";

// Deterministic fixtures. Never read the wall clock: every verifier that
// supports clock injection is fed an explicit `nowSeconds`.
const SECRET = "test-signing-secret";
const WRONG_SECRET = "test-signing-secret-wrong";
const TS = "1782320000"; // fixed timestamp
const NOW = 1782320010; // 10s later, inside the 5-minute window
const WINDOW = 60 * 5;

// One representative raw body per Slack delivery surface we accept.
const SLACK_EVENT_BODIES: Record<string, string> = {
  url_verification: JSON.stringify({
    type: "url_verification",
    challenge: "challenge-token-123",
  }),
  app_mention: JSON.stringify({
    team_id: "T1",
    event: {
      type: "app_mention",
      channel: "C1",
      user: "U1",
      text: "<@B1> ship it",
      ts: "111.222",
    },
  }),
  message_im: JSON.stringify({
    team_id: "T1",
    event: {
      type: "message",
      channel_type: "im",
      channel: "D1",
      user: "U1",
      text: "hello dm",
      ts: "111.000",
    },
  }),
  reaction_added: JSON.stringify({
    team_id: "T1",
    event: {
      type: "reaction_added",
      user: "U1",
      reaction: "eyes",
      item: { type: "message", channel: "C1", ts: "111.222" },
    },
  }),
  member_joined_channel: JSON.stringify({
    team_id: "T1",
    event: {
      type: "member_joined_channel",
      channel: "C1",
      channel_type: "C",
      user: "U1",
    },
  }),
  member_left_channel: JSON.stringify({
    team_id: "T1",
    event: { type: "member_left_channel", channel: "C1", user: "U1" },
  }),
  channel_joined: JSON.stringify({
    team_id: "T1",
    event: {
      type: "channel_joined",
      channel: { id: "C1", name: "general" },
      user: "U1",
    },
  }),
  channel_left: JSON.stringify({
    team_id: "T1",
    event: { type: "channel_left", channel: "C1", user: "U1" },
  }),
  app_uninstalled: JSON.stringify({
    team_id: "T1",
    event: { type: "app_uninstalled" },
  }),
  tokens_revoked: JSON.stringify({
    team_id: "T1",
    event: { type: "tokens_revoked", tokens: { bot: ["B1"] } },
  }),
};

function signed(rawBody: string, timestamp = TS, secret = SECRET) {
  return {
    signingSecret: secret,
    timestamp,
    signature: createSlackSignature(secret, timestamp, rawBody),
    rawBody,
  };
}

describe("Slack replay/tamper: signature verification per event type", () => {
  for (const [name, rawBody] of Object.entries(SLACK_EVENT_BODIES)) {
    it(`accepts a correctly signed ${name} body`, () => {
      expect(
        verifySlackSignature({ ...signed(rawBody), nowSeconds: NOW }),
      ).toBe(true);
    });

    it(`rejects a single-byte mutated ${name} body`, () => {
      const base = signed(rawBody);
      // Flip the last character of the body but keep the original signature.
      const lastChar = rawBody.slice(-1);
      const mutatedBody = rawBody.slice(0, -1) + (lastChar === "}" ? " " : "}");
      expect(
        verifySlackSignature({
          ...base,
          rawBody: mutatedBody,
          nowSeconds: NOW,
        }),
      ).toBe(false);
    });

    it(`rejects a field-changed ${name} body`, () => {
      const base = signed(rawBody);
      const parsed = JSON.parse(rawBody) as Record<string, unknown>;
      const tampered = JSON.stringify({ ...parsed, injected: "evil" });
      expect(
        verifySlackSignature({
          ...base,
          rawBody: tampered,
          nowSeconds: NOW,
        }),
      ).toBe(false);
    });

    it(`rejects a re-ordered (re-serialized whitespace) ${name} body`, () => {
      const base = signed(rawBody);
      // Pretty-printed re-serialization keeps the same logical content but
      // changes the bytes, so the HMAC must no longer match.
      const reordered = JSON.stringify(JSON.parse(rawBody), null, 2);
      expect(
        verifySlackSignature({
          ...base,
          rawBody: reordered,
          nowSeconds: NOW,
        }),
      ).toBe(false);
    });
  }
});

describe("Slack replay: timestamp window enforcement", () => {
  const rawBody = SLACK_EVENT_BODIES.app_mention;

  it("accepts a request at the edge of the allowed window", () => {
    expect(
      verifySlackSignature({
        ...signed(rawBody),
        nowSeconds: Number(TS) + WINDOW,
      }),
    ).toBe(true);
  });

  it("rejects a stale request just outside the past window", () => {
    expect(
      verifySlackSignature({
        ...signed(rawBody),
        nowSeconds: Number(TS) + WINDOW + 1,
      }),
    ).toBe(false);
  });

  it("rejects a far-future replayed timestamp", () => {
    expect(
      verifySlackSignature({
        ...signed(rawBody),
        nowSeconds: Number(TS) - WINDOW - 1,
      }),
    ).toBe(false);
  });

  it("rejects a non-numeric timestamp even with a matching signature", () => {
    const ts = "not-a-number";
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        timestamp: ts,
        signature: createSlackSignature(SECRET, ts, rawBody),
        rawBody,
        nowSeconds: NOW,
      }),
    ).toBe(false);
  });

  it("rejects an old request even if a valid signature is replayed verbatim", () => {
    // Classic replay: attacker captures a once-valid (ts, sig, body) tuple and
    // re-sends it later. The window check must reject it.
    const captured = signed(rawBody, "100");
    expect(verifySlackSignature({ ...captured, nowSeconds: 100 })).toBe(true);
    expect(
      verifySlackSignature({ ...captured, nowSeconds: 100 + WINDOW + 1 }),
    ).toBe(false);
  });
});

describe("Slack signature edge cases", () => {
  const rawBody = SLACK_EVENT_BODIES.app_mention;
  const validSig = createSlackSignature(SECRET, TS, rawBody);

  it("rejects a missing signature", () => {
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        timestamp: TS,
        rawBody,
        nowSeconds: NOW,
      }),
    ).toBe(false);
  });

  it("rejects a missing timestamp", () => {
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        signature: validSig,
        rawBody,
        nowSeconds: NOW,
      }),
    ).toBe(false);
  });

  it("rejects a wrong-secret signature", () => {
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        timestamp: TS,
        signature: createSlackSignature(WRONG_SECRET, TS, rawBody),
        rawBody,
        nowSeconds: NOW,
      }),
    ).toBe(false);
  });

  it("rejects a truncated signature (length mismatch path)", () => {
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        timestamp: TS,
        signature: validSig.slice(0, -2),
        rawBody,
        nowSeconds: NOW,
      }),
    ).toBe(false);
  });

  it("rejects an over-length signature (length mismatch path)", () => {
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        timestamp: TS,
        signature: `${validSig}00`,
        rawBody,
        nowSeconds: NOW,
      }),
    ).toBe(false);
  });

  it("rejects a wrong version prefix (same length, constant-time path)", () => {
    // v1=... has identical length to v0=..., forcing the timingSafeEqual path.
    const wrongVersion = `v1=${validSig.slice(3)}`;
    expect(wrongVersion.length).toBe(validSig.length);
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        timestamp: TS,
        signature: wrongVersion,
        rawBody,
        nowSeconds: NOW,
      }),
    ).toBe(false);
  });

  it("rejects an empty signature string", () => {
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        timestamp: TS,
        signature: "",
        rawBody,
        nowSeconds: NOW,
      }),
    ).toBe(false);
  });

  it("rejects whitespace differences in the signature", () => {
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        timestamp: TS,
        signature: `${validSig} `,
        rawBody,
        nowSeconds: NOW,
      }),
    ).toBe(false);
  });

  it("signs and verifies an empty body deterministically", () => {
    const sig = createSlackSignature(SECRET, TS, "");
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        timestamp: TS,
        signature: sig,
        rawBody: "",
        nowSeconds: NOW,
      }),
    ).toBe(true);
    // Whitespace in the body must break the empty-body signature.
    expect(
      verifySlackSignature({
        signingSecret: SECRET,
        timestamp: TS,
        signature: sig,
        rawBody: " ",
        nowSeconds: NOW,
      }),
    ).toBe(false);
  });

  it("fails closed without a secret unless explicitly unsigned", () => {
    expect(verifySlackSignature({ rawBody })).toBe(false);
    expect(verifySlackSignature({ rawBody, allowUnsigned: true })).toBe(true);
  });
});

describe("Slack OAuth state replay/tamper", () => {
  const STATE_SECRET = "state-secret";
  const ISSUED = 1782320000;

  it("verifies a freshly issued state", () => {
    const state = createSlackOAuthState({
      stateSecret: STATE_SECRET,
      nowSeconds: ISSUED,
    });
    const result = verifySlackOAuthState({
      stateSecret: STATE_SECRET,
      state,
      nowSeconds: ISSUED + 1,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects an expired (replayed) state", () => {
    const state = createSlackOAuthState({
      stateSecret: STATE_SECRET,
      nowSeconds: ISSUED,
    });
    const result = verifySlackOAuthState({
      stateSecret: STATE_SECRET,
      state,
      nowSeconds: ISSUED + 60 * 10 + 1,
    });
    expect(result).toEqual({ ok: false, reason: expect.any(String) });
  });

  it("rejects a tampered payload segment", () => {
    const state = createSlackOAuthState({
      stateSecret: STATE_SECRET,
      nowSeconds: ISSUED,
    });
    const [version, payload, sig] = state.split(".");
    const tampered = `${version}.${payload.slice(0, -1)}${
      payload.endsWith("A") ? "B" : "A"
    }.${sig}`;
    expect(
      verifySlackOAuthState({
        stateSecret: STATE_SECRET,
        state: tampered,
        nowSeconds: ISSUED + 1,
      }).ok,
    ).toBe(false);
  });

  it("rejects a wrong-secret signed state", () => {
    const state = createSlackOAuthState({
      stateSecret: "other-secret",
      nowSeconds: ISSUED,
    });
    expect(
      verifySlackOAuthState({
        stateSecret: STATE_SECRET,
        state,
        nowSeconds: ISSUED + 1,
      }).ok,
    ).toBe(false);
  });
});

describe("Slack fuzz: malformed/adversarial bodies handled without throwing", () => {
  const adversarial: Array<{ label: string; value: unknown }> = [
    { label: "empty string", value: "" },
    { label: "whitespace", value: "   " },
    { label: "null", value: null },
    { label: "undefined", value: undefined },
    { label: "number", value: 42 },
    { label: "boolean", value: true },
    { label: "bare array", value: [] },
    { label: "nested array", value: [[[[[]]]]] },
    { label: "unicode soup", value: "🔥".repeat(100) },
    { label: "null byte", value: "{ }" },
    { label: "object without event", value: { type: "event_callback" } },
    { label: "event not an object", value: { event: "nope" } },
    { label: "event unknown type", value: { event: { type: "wat" } } },
    {
      label: "deeply nested object",
      value: deepNest(500),
    },
    {
      label: "huge string text",
      value: { event: { type: "app_mention", text: "x".repeat(100000) } },
    },
    {
      label: "unexpected types in fields",
      value: { event: { type: "app_mention", channel: 5, user: {}, text: [] } },
    },
    {
      label: "tokens_revoked bad tokens",
      value: { event: { type: "tokens_revoked", tokens: 7 } },
    },
  ];

  for (const { label, value } of adversarial) {
    it(`normalizeSlackEvent does not throw on ${label}`, () => {
      let result: ReturnType<typeof normalizeSlackEvent> | undefined;
      expect(() => {
        result = normalizeSlackEvent(value);
      }).not.toThrow();
      expect(typeof result?.type).toBe("string");
    });
  }

  const rawFuzz: Array<{ label: string; value: string }> = [
    { label: "empty", value: "" },
    { label: "not urlencoded", value: "%%%%" },
    { label: "payload not json", value: "payload=not-json" },
    {
      label: "payload empty object",
      value: `payload=${encodeURIComponent("{}")}`,
    },
    {
      label: "payload huge",
      value: `payload=${encodeURIComponent(JSON.stringify({ actions: "x".repeat(50000) }))}`,
    },
    {
      label: "payload actions wrong type",
      value: `payload=${encodeURIComponent(JSON.stringify({ actions: 5 }))}`,
    },
    {
      label: "payload null byte",
      value: `payload=${encodeURIComponent('{"a":" "}')}`,
    },
  ];

  for (const { label, value } of rawFuzz) {
    it(`parseSlackInteraction returns structured failure / no throw on ${label}`, () => {
      let result: ReturnType<typeof parseSlackInteraction> | undefined;
      expect(() => {
        result = parseSlackInteraction(value);
      }).not.toThrow();
      // Adversarial inputs must never be parsed as a real approval.
      expect(result?.type).toBe("unsupported");
    });

    it(`parseSlackCommand does not throw on ${label}`, () => {
      expect(() => parseSlackCommand(value)).not.toThrow();
    });
  }
});

function deepNest(depth: number): unknown {
  let value: unknown = { type: "app_mention" };
  for (let i = 0; i < depth; i += 1) {
    value = { event: value };
  }
  return value;
}
