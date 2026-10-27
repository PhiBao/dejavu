import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { getAttentionFeed } from "@/lib/attention";
import { snoozePerson } from "@/lib/memory";
import type { MemoryHealth } from "@/lib/health";
import {
  addCommitment,
  addFact,
  addMemory,
  createUser,
  loadStore,
  saveStore,
  upsertPerson,
} from "@/lib/store";

process.env.DEJAVU_DATA_PATH = join(tmpdir(), `recall-attention-${process.pid}.json`);

beforeEach(() => {
  try {
    rmSync(process.env.DEJAVU_DATA_PATH as string, { force: true });
  } catch {
    /* ignore */
  }
});

function seedPerson(userId: string, name = "Sarah Chen", company = "Nimbus") {
  const { person } = upsertPerson(userId, {
    name,
    headline: null,
    company,
    location: null,
  });
  return person;
}

describe("attention feed — the agent looks first", () => {
  it("surfaces an overdue promise with a draft grounded in the person", async () => {
    const u = createUser("attention-commit@test.dev");
    const person = seedPerson(u.id);
    addMemory({
      userId: u.id,
      personId: person.id,
      kind: "meeting",
      content: "Met Sarah Chen at the AI meetup. She's hiring React engineers.",
    });
    addCommitment({
      userId: u.id,
      personId: person.id,
      description: "intro her to Priya",
      dueAt: new Date(Date.now() - 86400_000).toISOString(),
      sourceMemoryId: null,
    });

    const feed = await getAttentionFeed(u.id);
    const item = feed.items.find((i) => i.kind === "commitment");
    expect(item).toBeTruthy();
    expect(item?.personName).toBe("Sarah Chen");
    expect(item?.urgency).toBe(1);
    expect(item?.draftMessage).toMatch(/Priya/i);
    expect(item?.draftMessage).toMatch(/Nimbus/i);
    expect(feed.brief).toMatch(/1 thing needs attention/i);
  });

  it("surfaces a cold relationship and snoozing it creates a real follow-up", async () => {
    const u = createUser("attention-stale@test.dev");
    const person = seedPerson(u.id, "Marcus Webb", "Foundry Ventures");
    const store = loadStore();
    const row = store.people.find((p) => p.id === person.id)!;
    row.last_interaction_at = new Date(Date.now() - 40 * 86400_000).toISOString();
    saveStore(store);

    const feed = await getAttentionFeed(u.id);
    const stale = feed.items.find((i) => i.kind === "stale_person");
    expect(stale).toBeTruthy();
    expect(stale?.detail).toMatch(/40 days/);
    expect(stale?.draftMessage).toMatch(/Marcus/);
    expect(stale?.draftMessage).toMatch(/Foundry Ventures/);

    expect(await snoozePerson(u.id, person.id, 14)).toBe(true);
    const after = await getAttentionFeed(u.id);
    expect(after.items.some((i) => i.kind === "stale_person")).toBe(false);
    const reconnect = loadStore().commitments.find(
      (c) => c.user_id === u.id && c.description === "Reconnect with Marcus Webb",
    );
    expect(reconnect?.status).toBe("open");
    expect(reconnect?.due_at).toBeTruthy();
  });

  it("surfaces a date-bearing fact before it comes due", async () => {
    const u = createUser("attention-deadline@test.dev");
    const person = seedPerson(u.id);
    addFact({
      userId: u.id,
      personId: person.id,
      attribute: "passport_expiry",
      value: "March 2027",
      sourceMemoryId: null,
      absoluteDate: new Date(Date.now() + 5 * 86400_000).toISOString().slice(0, 10),
    });

    const feed = await getAttentionFeed(u.id);
    const deadline = feed.items.find((i) => i.kind === "fact_deadline");
    expect(deadline).toBeTruthy();
    expect(deadline?.title).toBe("passport expiry");
    expect(deadline?.detail).toMatch(/due in 5 days/);
    expect(deadline?.urgency).toBeGreaterThanOrEqual(0.9);
  });

  it("flags a detail that changed recently without hiding the old value", async () => {
    const u = createUser("attention-change@test.dev");
    const person = seedPerson(u.id);
    addFact({
      userId: u.id,
      personId: person.id,
      attribute: "company",
      value: "Nimbus",
      sourceMemoryId: null,
    });
    await new Promise((r) => setTimeout(r, 5));
    addFact({
      userId: u.id,
      personId: person.id,
      attribute: "company",
      value: "Linear",
      sourceMemoryId: null,
    });

    const feed = await getAttentionFeed(u.id);
    const changed = feed.items.find((i) => i.kind === "changed_fact");
    expect(changed).toBeTruthy();
    expect(changed?.detail).toMatch(/now Linear \(was Nimbus\)/);
  });

  it("surfaces important memories that are about to expire", async () => {
    const u = createUser("attention-expiry@test.dev");
    const person = seedPerson(u.id);
    const health: MemoryHealth = {
      epoch: 42,
      rows: [],
      topRelied: [],
      topUseful: [],
      feedback: { useful: 0, wrong: 0, outdated: 0 },
      atRisk: [
        {
          memoryId: "mem-1",
          personId: person.id,
          personName: person.name,
          snippet: "Met Sarah at the AI meetup",
          importance: 0.7,
          reasons: ["tied to a person"],
          hits: 3,
          lastHitAt: null,
          useful: 0,
          wrong: 0,
          outdated: 0,
          blobId: "blob-1",
          endEpoch: 50,
          daysToExpiry: 20,
          onchain: true,
          atRisk: true,
        },
      ],
      summary: "",
      verifiedBlobs: 1,
      totalMemories: 1,
    };

    const feed = await getAttentionFeed(u.id, health);
    const expiring = feed.items.find((i) => i.kind === "expiring_memory");
    expect(expiring).toBeTruthy();
    expect(expiring?.detail).toMatch(/storage ends in 20 days/);
    expect(expiring?.href).toBe(`/workspace/person/${person.id}`);
  });

  it("says all clear when nothing needs attention", async () => {
    const u = createUser("attention-empty@test.dev");
    const feed = await getAttentionFeed(u.id);
    expect(feed.items).toHaveLength(0);
    expect(feed.brief).toMatch(/Nothing needs attention/i);
  });
});
