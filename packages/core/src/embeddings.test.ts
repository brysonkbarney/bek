import { describe, expect, it } from "vitest";
import {
  cosineSimilarity,
  createDeterministicEmbedder,
  rankBySimilarity,
} from "./embeddings";

describe("deterministic embedder", () => {
  const embedder = createDeterministicEmbedder(64);

  it("is deterministic and normalized", () => {
    const a = embedder.embed("deploy the checkout service");
    const b = embedder.embed("deploy the checkout service");
    expect(a).toEqual(b);
    const norm = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1);
    expect(a).toHaveLength(64);
  });

  it("scores related text higher than unrelated text", () => {
    const query = embedder.embed("refund a customer order");
    const related = embedder.embed(
      "how do I issue a customer refund for an order",
    );
    const unrelated = embedder.embed("kubernetes pod autoscaling metrics");
    expect(cosineSimilarity(query, related)).toBeGreaterThan(
      cosineSimilarity(query, unrelated),
    );
  });

  it("ranks items by similarity to a query", () => {
    const items = [
      { id: "k8s", text: "kubernetes pod autoscaling" },
      { id: "refund", text: "process a customer refund" },
      { id: "slack", text: "post a slack message" },
    ];
    const ranked = rankBySimilarity(
      embedder,
      "customer refund request",
      items,
      (item) => item.text,
    );
    expect(ranked[0]?.item.id).toBe("refund");
    expect(ranked[0]?.score).toBeGreaterThanOrEqual(ranked[1]?.score ?? 0);
  });

  it("cosine of empty/zero vectors is 0", () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });
});
