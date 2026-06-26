// Embeddings pipeline. The `MemoryEmbedder` interface is the swappable seam: a
// deterministic, dependency-free local embedder ships today (zero credentials),
// and a real provider-backed embedder can implement the same interface later
// without touching callers (memory retrieval ranking).

export interface MemoryEmbedder {
  /** Stable identifier for the embedder (so stored vectors can be matched). */
  readonly id: string;
  readonly dimensions: number;
  embed(text: string): number[];
}

export interface RankedBySimilarity<T> {
  item: T;
  score: number;
}

/** Cosine similarity of two equal-length vectors (0 when either is zero). */
export function cosineSimilarity(
  a: readonly number[],
  b: readonly number[],
): number {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

// FNV-1a 32-bit hash — deterministic, fast, dependency-free.
function fnv1a(token: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * A deterministic bag-of-words embedder: each token is hashed into a bucket
 * with a hash-derived sign, accumulated, then L2-normalized. Texts that share
 * tokens land close together under cosine similarity, so retrieval ranking is
 * meaningful without any external model. Same input → identical vector.
 */
export function createDeterministicEmbedder(dimensions = 64): MemoryEmbedder {
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error("dimensions must be a positive integer.");
  }
  return {
    id: `deterministic-bow-${dimensions}`,
    dimensions,
    embed(text: string): number[] {
      const vector = new Array<number>(dimensions).fill(0);
      for (const token of tokenize(text)) {
        const hash = fnv1a(token);
        const bucket = hash % dimensions;
        const sign = (hash & 1) === 0 ? 1 : -1;
        vector[bucket] = (vector[bucket] ?? 0) + sign;
      }
      let norm = 0;
      for (const value of vector) {
        norm += value * value;
      }
      if (norm === 0) {
        return vector;
      }
      const inv = 1 / Math.sqrt(norm);
      return vector.map((value) => value * inv);
    },
  };
}

/**
 * Ranks items by cosine similarity of their text embedding to a query, highest
 * first. Pure and stable for a given embedder.
 */
export function rankBySimilarity<T>(
  embedder: MemoryEmbedder,
  query: string,
  items: readonly T[],
  toText: (item: T) => string,
): Array<RankedBySimilarity<T>> {
  const queryVector = embedder.embed(query);
  return items
    .map((item) => ({
      item,
      score: cosineSimilarity(queryVector, embedder.embed(toText(item))),
    }))
    .sort((left, right) => right.score - left.score);
}
