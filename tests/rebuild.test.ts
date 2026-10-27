import { describe, it, expect } from "vitest";
import { parseEnrichedBlob } from "@/lib/memory";

/**
 * The enriched blob format is the durable contract: if the local projection is
 * gone, these strings are all that remain. Parsing them back must preserve the
 * person, facts, dates, and follow-ups.
 */
describe("enriched Walrus blob parsing", () => {
  it("reconstructs a person memory with facts and dated follow-ups", () => {
    const text = `About: Sarah Chen — Founder @ Nimbus (meeting)
Met Sarah Chen at the SF AI meetup. She's hiring senior React engineers.
When: 2026-10-01
Facts: company=Nimbus; hiring_for=senior React engineers
Follow-ups: intro her to Priya (due 2026-11-01); send the deck (due in ~3d)`;

    const parsed = parseEnrichedBlob(text);
    expect(parsed).toMatchObject({
      personName: "Sarah Chen",
      headline: "Founder @ Nimbus",
      company: "Nimbus",
      kind: "meeting",
      occurredAt: "2026-10-01",
    });
    expect(parsed?.content).toContain("Met Sarah Chen");
    expect(parsed?.facts).toEqual([
      { attribute: "company", value: "Nimbus", date: null },
      { attribute: "hiring_for", value: "senior React engineers", date: null },
    ]);
    expect(parsed?.commitments).toEqual([
      { description: "intro her to Priya", dueDate: "2026-11-01" },
      { description: "send the deck", dueDate: null },
    ]);
  });

  it("reconstructs a person-less note with a dated expiry fact", () => {
    const text = `Note (note)
My passport expires in 7 weeks.
Facts: passport_expiry=in 7 weeks [2026-12-15]
Follow-ups: Renew passport before trip to Lisbon (due 2026-12-15)`;

    const parsed = parseEnrichedBlob(text);
    expect(parsed).toMatchObject({
      personName: null,
      kind: "note",
      occurredAt: null,
    });
    expect(parsed?.facts).toEqual([
      { attribute: "passport_expiry", value: "in 7 weeks", date: "2026-12-15" },
    ]);
    expect(parsed?.commitments).toEqual([
      { description: "Renew passport before trip to Lisbon", dueDate: "2026-12-15" },
    ]);
  });

  it("ignores manifests and briefs instead of turning them into memories", () => {
    expect(parseEnrichedBlob("Dejavu lifecycle manifest\nforgotten: abc")).toBeNull();
    expect(parseEnrichedBlob("Canonical brief — Sarah Chen\nFounder at Linear.")).toBeNull();
  });
});
