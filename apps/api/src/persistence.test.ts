import { describe, expect, it } from "vitest";
import { selectStorageMode } from "./persistence";

describe("API persistence bootstrap", () => {
  it("defaults to memory when no database is configured", () => {
    expect(selectStorageMode({})).toBe("memory");
  });

  it("uses postgres when DATABASE_URL is present", () => {
    expect(
      selectStorageMode({
        DATABASE_URL: "postgres://bek:bek@localhost:5432/bek",
      }),
    ).toBe("postgres");
  });

  it("allows memory mode to override a local DATABASE_URL", () => {
    expect(
      selectStorageMode({
        DATABASE_URL: "postgres://bek:bek@localhost:5432/bek",
        BEK_STORAGE: "memory",
      }),
    ).toBe("memory");
  });

  it("rejects unknown storage modes", () => {
    expect(() => selectStorageMode({ BEK_STORAGE: "sqlite" })).toThrow(
      /BEK_STORAGE/i,
    );
  });
});
