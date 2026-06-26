import { describe, expect, it } from "vitest";
import {
  getCredentialLastUsed,
  InMemoryCredentialLastUsedTracker,
  redactCredentialPayload,
  type CredentialMetadataRecord,
} from "./index";

const credential: CredentialMetadataRecord = {
  id: "cred_slack_bot",
  orgId: "org_demo",
  name: "Slack bot token",
  provider: "slack",
  secretRef: "vault://prod/slack/bot-token",
  status: "active",
  scopeSummary: "chat:write",
};

describe("credential last-used tracking", () => {
  it("records usage with an injected clock and bumps the use count", () => {
    let now = new Date("2026-06-24T18:00:00.000Z");
    const tracker = new InMemoryCredentialLastUsedTracker({ now: () => now });

    const first = tracker.record({
      credentialId: "cred_slack_bot",
      usedByIdentityId: "ident_agent",
      action: "slack.chat.postMessage",
    });
    expect(first).toEqual({
      credentialId: "cred_slack_bot",
      lastUsedAt: "2026-06-24T18:00:00.000Z",
      useCount: 1,
      lastUsedByIdentityId: "ident_agent",
      lastAction: "slack.chat.postMessage",
    });

    now = new Date("2026-06-24T18:05:00.000Z");
    const second = tracker.record({
      credentialId: "cred_slack_bot",
      usedByIdentityId: "ident_other",
      action: "slack.conversations.history",
    });
    expect(second).toEqual({
      credentialId: "cred_slack_bot",
      lastUsedAt: "2026-06-24T18:05:00.000Z",
      useCount: 2,
      lastUsedByIdentityId: "ident_other",
      lastAction: "slack.conversations.history",
    });
  });

  it("accepts an explicit usage time and never regresses lastUsedAt", () => {
    const tracker = new InMemoryCredentialLastUsedTracker({
      now: () => new Date("2026-06-24T18:00:00.000Z"),
    });

    tracker.record({
      credentialId: "cred_slack_bot",
      at: new Date("2026-06-24T18:10:00.000Z"),
    });
    // An out-of-order (earlier) event still counts but does not move lastUsedAt.
    const stale = tracker.record({
      credentialId: "cred_slack_bot",
      at: new Date("2026-06-24T18:01:00.000Z"),
    });

    expect(stale.lastUsedAt).toBe("2026-06-24T18:10:00.000Z");
    expect(stale.useCount).toBe(2);
  });

  it("retains the prior identity and action when not supplied", () => {
    const tracker = new InMemoryCredentialLastUsedTracker({
      now: () => new Date("2026-06-24T18:00:00.000Z"),
    });
    tracker.record({
      credentialId: "cred_slack_bot",
      usedByIdentityId: "ident_agent",
      action: "slack.chat.postMessage",
    });
    const next = tracker.record({ credentialId: "cred_slack_bot" });
    expect(next.lastUsedByIdentityId).toBe("ident_agent");
    expect(next.lastAction).toBe("slack.chat.postMessage");
    expect(next.useCount).toBe(2);
  });

  it("omits optional fields entirely when never provided", () => {
    const tracker = new InMemoryCredentialLastUsedTracker({
      now: () => new Date("2026-06-24T18:00:00.000Z"),
    });
    const record = tracker.record({ credentialId: "cred_slack_bot" });
    expect(record).toEqual({
      credentialId: "cred_slack_bot",
      lastUsedAt: "2026-06-24T18:00:00.000Z",
      useCount: 1,
    });
    expect("lastUsedByIdentityId" in record).toBe(false);
    expect("lastAction" in record).toBe(false);
  });

  it("normalizes ids/identities/actions and rejects empty credential ids", () => {
    const tracker = new InMemoryCredentialLastUsedTracker({
      now: () => new Date("2026-06-24T18:00:00.000Z"),
    });
    const record = tracker.record({
      credentialId: "  cred_slack_bot  ",
      usedByIdentityId: "   ",
      action: "  slack.chat.postMessage  ",
    });
    expect(record.credentialId).toBe("cred_slack_bot");
    expect("lastUsedByIdentityId" in record).toBe(false);
    expect(record.lastAction).toBe("slack.chat.postMessage");

    expect(() => tracker.record({ credentialId: "   " })).toThrow(
      "credentialId is required.",
    );
  });

  it("get and list return clones sorted most-recent first", () => {
    const tracker = new InMemoryCredentialLastUsedTracker();
    tracker.record({
      credentialId: "cred_a",
      at: new Date("2026-06-24T18:00:00.000Z"),
    });
    tracker.record({
      credentialId: "cred_b",
      at: new Date("2026-06-24T18:05:00.000Z"),
    });

    const listed = tracker.list();
    expect(listed.map((r) => r.credentialId)).toEqual(["cred_b", "cred_a"]);

    // Mutating returned clones must not affect tracker state.
    const got = tracker.get("cred_a");
    expect(got).toBeDefined();
    got!.useCount = 999;
    expect(tracker.get("cred_a")?.useCount).toBe(1);
    expect(tracker.get("cred_missing")).toBeUndefined();
  });

  it("resolves a record from a credential metadata record or id", () => {
    const tracker = new InMemoryCredentialLastUsedTracker({
      now: () => new Date("2026-06-24T18:00:00.000Z"),
    });
    tracker.record({ credentialId: credential.id });
    expect(getCredentialLastUsed(tracker, credential)?.credentialId).toBe(
      credential.id,
    );
    expect(getCredentialLastUsed(tracker, credential.id)?.useCount).toBe(1);
    expect(getCredentialLastUsed(tracker, "cred_missing")).toBeUndefined();
  });

  it("stores no secret material that could leak when redacted", () => {
    const tracker = new InMemoryCredentialLastUsedTracker({
      now: () => new Date("2026-06-24T18:00:00.000Z"),
    });
    tracker.record({
      credentialId: credential.id,
      usedByIdentityId: "ident_agent",
      action: "slack.chat.postMessage",
    });
    const record = tracker.get(credential.id);
    expect(JSON.stringify(record)).not.toContain(credential.secretRef);
    expect(JSON.stringify(record)).not.toContain("vault://");
    // Redaction is a no-op because no secret-shaped fields are present.
    expect(redactCredentialPayload(record)).toEqual(record);
  });
});
