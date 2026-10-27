import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  captureMemory,
  correctFact,
  correctMemory,
  forgetMemory,
  getPersonFacts,
  getPersonMemories,
  factQuestionScore,
  mergePeople,
  recall,
  suggestDuplicatePeople,
} from "@/lib/memory";
import {
  addFact,
  addMemory,
  createUser,
  getMemoryFacts,
  listPeople,
  loadStore,
  upsertPerson,
} from "@/lib/store";
import {
  dateForFact,
  dueDateFromText,
  eventDateFromText,
  expiryFactFromText,
} from "@/lib/dates";

process.env.DEJAVU_DATA_PATH = join(tmpdir(), `recall-lifecycle-${process.pid}.json`);

beforeEach(() => {
  try {
    rmSync(process.env.DEJAVU_DATA_PATH as string, { force: true });
  } catch {
    /* ignore */
  }
});

const NOW = new Date("2026-10-27T12:00:00.000Z");

describe("deterministic date understanding", () => {
  it("reads a past event date instead of a future deadline", () => {
    expect(eventDateFromText("Met Sarah on March 3.", NOW)).toBe("2026-03-03");
    expect(eventDateFromText("Yesterday I met Sarah Chen.", NOW)).toBe("2026-10-26");
    expect(eventDateFromText("Send the deck by Friday.", NOW)).toBeNull();
  });

  it("resolves deadlines and month-only expiries", () => {
    expect(dueDateFromText("Send the deck by Friday.", NOW)).toBe("2026-10-30");
    expect(dueDateFromText("Renew the insurance before April 12.", NOW)).toBe(
      "2027-04-12",
    );
    // "expires in March 2027" means the end of March, not the first day.
    expect(dueDateFromText("My passport expires in March 2027.", NOW)).toBe(
      "2027-03-31",
    );
    expect(dateForFact("My passport expires in March 2027.", "passport_expiry", NOW)).toBe(
      "2027-03-31",
    );
    expect(expiryFactFromText("My passport expires in 7 weeks.", NOW)).toMatchObject({
      attribute: "passport_expiry",
      value: "in 7 weeks",
    });
  });
});

describe("facts change instead of accumulating", () => {
  it("supersedes an old employer and answers with the current one", async () => {
    const u = createUser("facts@test.dev");
    const first = await captureMemory(
      u.id,
      "Met Sarah Chen at the SF AI meetup. She's a founder at Nimbus.",
    );
    await new Promise((r) => setTimeout(r, 5));
    const second = await captureMemory(
      u.id,
      "Sarah Chen is now a founder at Linear.",
    );
    expect(second.person?.id).toBe(first.person?.id);

    const facts = await getPersonFacts(u.id, first.person!.id);
    const company = facts.filter((f) => f.key === "company");
    expect(company).toHaveLength(1);
    expect(company[0]?.value).toBe("Linear");

    const all = await getPersonFacts(u.id, first.person!.id, {
      includeSuperseded: true,
    });
    expect(all.some((f) => f.status === "superseded" && f.value === "Nimbus")).toBe(
      true,
    );

    const res = await recall(u.id, "where does Sarah Chen work?");
    expect(res.answer).toMatch(/linear/i);
    expect(res.answer).not.toMatch(/nimbus/i);
    // The stale source is not shown beside the current answer.
    expect(res.citations.every((c) => c.memoryId !== first.memory.id)).toBe(true);
  });

  it("prefers the belief the question actually asks about", () => {
    // "where does Sarah work" must prefer company over her role, even though
    // both changed in the same correction.
    expect(factQuestionScore("where does Sarah work?", "company")).toBeGreaterThan(
      factQuestionScore("where does Sarah work?", "role"),
    );
    // Naming the old value is the strongest possible signal.
    expect(
      factQuestionScore("is Sarah still at Nimbus?", "company", ["Nimbus"]),
    ).toBeGreaterThan(
      factQuestionScore("is Sarah still at Nimbus?", "role", ["founder at Nimbus"]),
    );
  });

  it("keeps multi-valued facts side by side", async () => {
    const u = createUser("multi@test.dev");
    const { person } = upsertPerson(u.id, {
      name: "Tomás Silva",
      headline: null,
      company: null,
      location: null,
    });
    addFact({
      userId: u.id,
      personId: person.id,
      attribute: "interest",
      value: "padel",
      sourceMemoryId: null,
    });
    addFact({
      userId: u.id,
      personId: person.id,
      attribute: "interest",
      value: "specialty coffee",
      sourceMemoryId: null,
    });
    const facts = await getPersonFacts(u.id, person.id);
    expect(facts.filter((f) => f.key === "interest")).toHaveLength(2);
  });
});

describe("forgetting is a tombstone, not a suggestion", () => {
  it("never cites a forgotten memory again", async () => {
    const u = createUser("forget@test.dev");
    const capture = await captureMemory(
      u.id,
      "Met Sarah Chen — founder at Nimbus, hiring senior React engineers.",
    );

    const before = await recall(u.id, "who is hiring react engineers");
    expect(before.citations.some((c) => c.memoryId === capture.memory.id)).toBe(true);

    expect(await forgetMemory(u.id, capture.memory.id)).toBe(true);
    const stored = loadStore().memories.find((m) => m.id === capture.memory.id);
    expect(stored?.status).toBe("forgotten");
    expect(stored?.forgotten_at).toBeTruthy();

    const after = await recall(u.id, "who is hiring react engineers");
    expect(after.citations.some((c) => c.memoryId === capture.memory.id)).toBe(false);
    expect(after.citations).toHaveLength(0);
    expect(await getPersonFacts(u.id, capture.person!.id)).toHaveLength(0);
  });
});

describe("correcting a memory retires the old version", () => {
  it("keeps history but recalls only the correction", async () => {
    const u = createUser("correct@test.dev");
    const old = await captureMemory(
      u.id,
      "Met Sarah Chen at the SF AI meetup. She's a founder at Nimbus.",
    );
    const corrected = await correctMemory(
      u.id,
      old.memory.id,
      "Sarah Chen is now a founder at Linear.",
    );
    expect(corrected).not.toBeNull();

    const store = loadStore();
    const oldRow = store.memories.find((m) => m.id === old.memory.id);
    expect(oldRow?.status).toBe("superseded");
    expect(oldRow?.superseded_by).toBe(corrected!.memory.id);

    const active = await getPersonMemories(u.id, old.person!.id);
    expect(active).toHaveLength(1);
    expect(active[0]?.id).toBe(corrected!.memory.id);

    const res = await recall(u.id, "where does Sarah work now?");
    expect(res.answer).toMatch(/linear/i);
    expect(res.answer).not.toMatch(/nimbus/i);
    expect(res.citations.some((c) => c.memoryId === old.memory.id)).toBe(false);
  });
});

describe("correcting a single fact", () => {
  it("creates a durable correction memory and a new current belief", async () => {
    const u = createUser("factfix@test.dev");
    const capture = await captureMemory(
      u.id,
      "Met Sarah Chen at the SF AI meetup. She's a founder at Nimbus.",
    );
    const fact = (await getPersonFacts(u.id, capture.person!.id)).find(
      (f) => f.key === "company",
    );
    expect(fact?.value).toBe("Nimbus");

    const result = await correctFact(u.id, fact!.id, "Linear");
    expect(result?.fact.value).toBe("Linear");
    expect(result?.memory.content).toMatch(/correction/i);
    expect(result?.memory.person_id).toBe(capture.person!.id);

    const current = await getPersonFacts(u.id, capture.person!.id);
    expect(current.filter((f) => f.key === "company")).toHaveLength(1);
    expect(current.find((f) => f.key === "company")?.value).toBe("Linear");
    expect(
      loadStore().people.find((p) => p.id === capture.person!.id)?.company,
    ).toBe("Linear");

    const res = await recall(u.id, "where does Sarah work?");
    expect(res.answer).toMatch(/linear/i);
  });
});

describe("duplicate people merge", () => {
  it("moves every memory and fact to the surviving profile", async () => {
    const u = createUser("merge@test.dev");
    const short = upsertPerson(u.id, {
      name: "Sarah",
      headline: null,
      company: "Nimbus",
      location: null,
    }).person;
    const full = upsertPerson(u.id, {
      name: "Sarah Chen",
      headline: "Founder",
      company: "Linear",
      location: "SF",
    }).person;

    const m1 = addMemory({
      userId: u.id,
      personId: short.id,
      kind: "note",
      content: "Sarah likes padel.",
    });
    const m2 = addMemory({
      userId: u.id,
      personId: full.id,
      kind: "meeting",
      content: "Met Sarah Chen at the conference.",
    });
    addFact({
      userId: u.id,
      personId: short.id,
      attribute: "company",
      value: "Nimbus",
      sourceMemoryId: m1.id,
    });
    await new Promise((r) => setTimeout(r, 5));
    addFact({
      userId: u.id,
      personId: full.id,
      attribute: "company",
      value: "Linear",
      sourceMemoryId: m2.id,
    });

    const suggestions = suggestDuplicatePeople(u.id, short.id);
    expect(suggestions.some((s) => s.person.id === full.id)).toBe(true);

    const merged = await mergePeople(u.id, short.id, full.id);
    expect(merged?.id).toBe(short.id);
    expect(listPeople(u.id)).toHaveLength(1);
    expect(merged?.headline).toBe("Founder");
    expect(merged?.location).toBe("SF");

    const store = loadStore();
    expect(store.memories.every((m) => m.person_id === short.id)).toBe(true);
    expect(store.facts.every((f) => f.person_id === short.id)).toBe(true);
    const companies = await getPersonFacts(u.id, short.id);
    expect(companies.filter((f) => f.key === "company")).toHaveLength(1);
    expect(companies.find((f) => f.key === "company")?.value).toBe("Linear");
    expect(suggestDuplicatePeople(u.id, short.id)).toHaveLength(0);
  });
});

describe("absolute dates are attached to facts and memories", () => {
  it("stores an expiry date as a date, not a string in prose", async () => {
    const u = createUser("dates@test.dev");
    const capture = await captureMemory(
      u.id,
      "My passport expires in March 2027.",
    );
    expect(capture.person).toBeNull();
    const facts = getMemoryFacts(u.id, [capture.memory.id]).get(capture.memory.id) ?? [];
    const expiry = facts.find((f) => f.key === "passport_expiry");
    expect(expiry?.value).toBe("March 2027");
    expect(expiry?.absolute_date).toBe("2027-03-31");
  });

  it("uses an absolute due date for a follow-up", async () => {
    const u = createUser("duedate@test.dev");
    const capture = await captureMemory(
      u.id,
      "Need to renew my passport before the trip in April.",
    );
    const commitment = loadStore().commitments.find(
      (c) => c.user_id === u.id && c.source_memory_id === capture.memory.id,
    );
    expect(commitment?.due_at).toBe("2027-04-01T12:00:00.000Z");
  });

  it("uses the event date when the note says when it happened", async () => {
    const u = createUser("eventdate@test.dev");
    const capture = await captureMemory(
      u.id,
      "Yesterday I met Sarah Chen at the AI meetup.",
    );
    const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
    expect(capture.memory.occurred_at.slice(0, 10)).toBe(yesterday);
  });
});
