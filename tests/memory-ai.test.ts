import { describe, it, expect } from "vitest";
import { extractMemory } from "@/lib/ai";

// AI_PROVIDER=mock is set in vitest.config.ts, so these exercise the
// deterministic local paths — no AWS credentials required.

describe("extractMemory (mock path)", () => {
  it("extracts a person name from a 'met with' sentence", async () => {
    const r = await extractMemory(
      "Met Sarah Chen at the SF AI meetup. She's a founder at Nimbus.",
    );
    expect(r.personName).toBe("Sarah Chen");
  });

  it("extracts a company via 'at @' pattern", async () => {
    const r = await extractMemory(
      "Coffee with Marcus Webb, a partner at Foundry Ventures",
    );
    expect(r.company).toBe("Foundry Ventures");
  });

  it("extracts a hiring fact when present", async () => {
    const r = await extractMemory(
      "Met Sarah — she's hiring senior React engineers.",
    );
    expect(r.facts).toContainEqual(
      expect.objectContaining({
        attribute: "hiring_for",
        value: "senior React engineers",
      }),
    );
  });

  it("extracts a commitment from a promise phrase", async () => {
    const r = await extractMemory(
      "Promised to intro her to my friend Priya.",
    );
    expect(r.commitments.length).toBeGreaterThan(0);
    expect(r.commitments[0]?.description).toMatch(/intro her to my friend Priya/i);
  });

  it("classifies kind based on keywords", async () => {
    expect(
      (await extractMemory("Call with Dr. Lena Ortiz about the paper")).kind,
    ).toBe("call");
    expect(
      (await extractMemory("DM'd with Aisha Khan about design")).kind,
    ).toBe("message");
    expect(
      (await extractMemory("Meeting with Tomás Silva at the conference")).kind,
    ).toBe("meeting");
  });

  it("returns null personName when no person is identifiable", async () => {
    const r = await extractMemory(
      "Had a great day at the park walking the dog.",
    );
    expect(r.personName).toBeNull();
  });

  it("always returns a valid shape even for thin input", async () => {
    const r = await extractMemory("hi");
    expect(r).toHaveProperty("personName");
    expect(r).toHaveProperty("kind");
    expect(Array.isArray(r.facts)).toBe(true);
    expect(Array.isArray(r.commitments)).toBe(true);
  });
});
