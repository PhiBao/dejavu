import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { captureMemory } from "@/lib/memory";
import { getMemoryFacts, loadStore } from "@/lib/store";
import { createUser } from "@/lib/store";

process.env.DEJAVU_DATA_PATH = join(tmpdir(), `recall-notes-${process.pid}.json`);

beforeEach(() => {
  try {
    rmSync(process.env.DEJAVU_DATA_PATH as string, { force: true });
  } catch {
    /* ignore */
  }
});

/**
 * Dejavu is a memory companion for everything, not only people. A note with
 * no person must still produce structure: facts attached to the note, and any
 * follow-up in the Today feed.
 */
describe("notes without a person are first-class", () => {
  it("captures a person-less note with facts", async () => {
    const u = createUser("notes@test.dev");
    // Mock extractor (tests are hermetic) understands interest/date facts but
    // not arbitrary prose; the plumbing under test is person-less fact storage.
    const res = await captureMemory(
      u.id,
      "My passport expires in March 2027. Interested in renewing it early this time.",
    );

    expect(res.person).toBeNull();
    expect(res.factsAdded).toBeGreaterThan(0);

    const facts = getMemoryFacts(u.id, [res.memory.id]).get(res.memory.id) ?? [];
    expect(facts.length).toBeGreaterThan(0);
    expect(facts.every((f) => f.person_id === null)).toBe(true);
    expect(facts.every((f) => f.source_memory_id === res.memory.id)).toBe(true);
  });

  it("still extracts follow-ups for a note", async () => {
    const u = createUser("notes2@test.dev");
    const res = await captureMemory(
      u.id,
      "Need to renew my passport before the trip in April.",
    );
    expect(res.commitmentsAdded).toBeGreaterThan(0);
    const open = loadStore().commitments.filter((c) => c.user_id === u.id);
    expect(open.length).toBeGreaterThan(0);
    expect(open[0]?.person_id).toBeNull();
  });

  it("attaches facts to the person when one is present", async () => {
    const u = createUser("notes3@test.dev");
    const res = await captureMemory(
      u.id,
      "Met Sarah Chen, founder at Nimbus, hiring senior React engineers.",
    );
    expect(res.person?.name).toBe("Sarah Chen");
    const facts = getMemoryFacts(u.id, [res.memory.id]).get(res.memory.id) ?? [];
    expect(facts.length).toBeGreaterThan(0);
    expect(facts.every((f) => f.person_id === res.person?.id)).toBe(true);
  });
});
