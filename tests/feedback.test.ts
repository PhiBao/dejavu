import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  briefIsGrounded,
  consolidatePerson,
  getPersonBrief,
  recordMemoryFeedback,
  recall,
} from "@/lib/memory";
import { buildPersonBrief } from "@/lib/ai";
import { computeMemoryHealth } from "@/lib/health";
import {
  addCommitment,
  addFact,
  addMemory,
  createUser,
  getPersonFacts,
  loadStore,
  upsertPerson,
} from "@/lib/store";

process.env.DEJAVU_DATA_PATH = join(tmpdir(), `recall-feedback-${process.pid}.json`);

beforeEach(() => {
  try {
    rmSync(process.env.DEJAVU_DATA_PATH as string, { force: true });
  } catch {
    /* ignore */
  }
});

function seedPerson(userId: string, name = "Sarah Chen") {
  return upsertPerson(userId, {
    name,
    headline: "Founder",
    company: "Linear",
    location: "SF",
  }).person;
}

describe("explicit feedback changes what Dejavu believes", () => {
  it("useful feedback raises importance and shows up in health", async () => {
    const u = createUser("useful@test.dev");
    const person = seedPerson(u.id);
    const memory = addMemory({
      userId: u.id,
      personId: person.id,
      kind: "meeting",
      content: "Met Sarah Chen — she's hiring React engineers.",
    });
    const before = await computeMemoryHealth(u.id);
    const beforeRow = before.rows.find((r) => r.memoryId === memory.id);
    expect(beforeRow).toBeTruthy();

    expect(await recordMemoryFeedback(u.id, memory.id, "useful", "who is hiring?")).toBe(
      true,
    );
    const after = await computeMemoryHealth(u.id);
    const afterRow = after.rows.find((r) => r.memoryId === memory.id);
    expect(afterRow?.useful).toBe(1);
    expect(afterRow?.importance).toBeGreaterThan(beforeRow!.importance);
    expect(after.feedback.useful).toBe(1);
    expect(after.topUseful.some((r) => r.memoryId === memory.id)).toBe(true);
    expect(afterRow?.reasons).toContain("marked useful 1 time");
  });

  it("outdated feedback retires the memory and its facts from recall", async () => {
    const u = createUser("outdated@test.dev");
    const person = seedPerson(u.id);
    const memory = addMemory({
      userId: u.id,
      personId: person.id,
      kind: "meeting",
      content: "Met Sarah Chen at Nimbus. She's hiring React engineers.",
    });
    addFact({
      userId: u.id,
      personId: person.id,
      attribute: "company",
      value: "Nimbus",
      sourceMemoryId: memory.id,
    });

    const before = await recall(u.id, "where does Sarah work?");
    expect(before.citations.some((c) => c.memoryId === memory.id)).toBe(true);

    expect(await recordMemoryFeedback(u.id, memory.id, "outdated", "where does she work?")).toBe(
      true,
    );
    const stored = loadStore().memories.find((m) => m.id === memory.id);
    expect(stored?.status).toBe("superseded");
    expect(stored?.superseded_by).toBeNull();
    expect(await getPersonFacts(u.id, person.id)).toHaveLength(0);

    const after = await recall(u.id, "where does Sarah work?");
    expect(after.citations.some((c) => c.memoryId === memory.id)).toBe(false);
    expect(after.citations).toHaveLength(0);
  });

  it("wrong feedback retires the memory too", async () => {
    const u = createUser("wrong@test.dev");
    const person = seedPerson(u.id);
    const memory = addMemory({
      userId: u.id,
      personId: person.id,
      kind: "note",
      content: "Sarah's birthday is in May.",
    });
    expect(await recordMemoryFeedback(u.id, memory.id, "wrong")).toBe(true);
    expect(loadStore().memories.find((m) => m.id === memory.id)?.status).toBe(
      "superseded",
    );
  });
});

describe("consolidation writes a durable canonical brief", () => {
  it("builds a grounded deterministic brief", () => {
    const text = buildPersonBrief({
      personName: "Sarah Chen",
      headline: "Founder",
      company: "Linear",
      location: "SF",
      facts: [
        { attribute: "company", value: "Linear", absoluteDate: null },
        { attribute: "interest", value: "AI eval tooling", absoluteDate: null },
      ],
      memories: [
        {
          content: "Met Sarah at the AI meetup. She's hiring React engineers.",
          occurredAt: "2026-10-27T12:00:00.000Z",
        },
      ],
      commitments: [
        { description: "intro her to Priya", dueAt: "2026-11-01T12:00:00.000Z" },
      ],
    });
    expect(text).toMatch(/Sarah Chen/);
    expect(text).toMatch(/Linear/);
    expect(text).toMatch(/AI eval tooling/);
    expect(text).toMatch(/intro her to Priya/);
  });

  it("never quotes a superseded value in a brief", async () => {
    const u = createUser("brief-stale@test.dev");
    const person = seedPerson(u.id);
    const old = addMemory({
      userId: u.id,
      personId: person.id,
      kind: "meeting",
      content: "Met Sarah Chen — founder at Nimbus.",
    });
    addFact({
      userId: u.id,
      personId: person.id,
      attribute: "company",
      value: "Nimbus",
      sourceMemoryId: old.id,
    });
    await new Promise((r) => setTimeout(r, 5));
    const current = addMemory({
      userId: u.id,
      personId: person.id,
      kind: "note",
      content: "Sarah Chen is now a founder at Linear.",
    });
    addFact({
      userId: u.id,
      personId: person.id,
      attribute: "company",
      value: "Linear",
      sourceMemoryId: current.id,
    });

    const brief = await consolidatePerson(u.id, person.id);
    expect(brief?.content).toMatch(/Linear/);
    expect(brief?.content).not.toMatch(/Nimbus/);
    expect(brief?.source_memory_ids).toContain(current.id);
    expect(brief?.source_memory_ids).not.toContain(old.id);
  });

  it("rejects invented proper nouns in a generated brief", () => {
    const input = {
      personName: "Sarah Chen",
      headline: "Founder",
      company: "Linear",
      location: null,
      facts: [
        { attribute: "company", value: "Linear", absoluteDate: null },
        { attribute: "interest", value: "AI eval tooling", absoluteDate: null },
      ],
      memories: [
        {
          content: "Met Sarah Chen at the SF AI meetup. She's hiring React engineers.",
          occurredAt: "2026-10-27T12:00:00.000Z",
        },
      ],
      commitments: [],
    };
    expect(briefIsGrounded("Sarah Chen works at Linear.", input)).toBe(true);
    expect(
      briefIsGrounded("Sarah Chen is based in San Francisco.", input),
    ).toBe(false);
  });

  it("stores a brief with its source memories and reads it back", async () => {
    const u = createUser("brief@test.dev");
    const person = seedPerson(u.id);
    const memory = addMemory({
      userId: u.id,
      personId: person.id,
      kind: "meeting",
      content: "Met Sarah Chen — founder at Linear, hiring React engineers.",
    });
    addFact({
      userId: u.id,
      personId: person.id,
      attribute: "company",
      value: "Linear",
      sourceMemoryId: memory.id,
    });
    addCommitment({
      userId: u.id,
      personId: person.id,
      description: "intro her to Priya",
      dueAt: null,
      sourceMemoryId: memory.id,
    });

    const brief = await consolidatePerson(u.id, person.id);
    expect(brief).toBeTruthy();
    expect(brief?.content).toMatch(/Canonical brief — Sarah Chen/);
    expect(brief?.content).toMatch(/Linear/);
    expect(brief?.source_memory_ids).toContain(memory.id);
    // Walrus is unconfigured in tests; the brief is still stored locally.
    expect(brief?.walrus_blob_id).toBeNull();

    const latest = await getPersonBrief(u.id, person.id);
    expect(latest?.id).toBe(brief?.id);
  });
});
