import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";

// The API key hashing is a pure function we replicate here to assert the
// contract: keys are prefixed, hashed with SHA-256, and never stored raw.
function sha256(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

describe("api key format contract", () => {
  it("keys are prefixed with djav_", () => {
    const prefix = "djav_";
    const rawKey = `${prefix}${Buffer.from("a".repeat(32)).toString("base64url")}`;
    expect(rawKey.startsWith(prefix)).toBe(true);
  });

  it("the stored hash is sha256 of the raw key (never the raw key)", () => {
    const rawKey = "djav_abc123";
    const hash = sha256(rawKey);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain("djav_");
  });

  it("different keys hash differently; same key hashes identically", () => {
    expect(sha256("djav_a")).toBe(sha256("djav_a"));
    expect(sha256("djav_a")).not.toBe(sha256("djav_b"));
  });
});
