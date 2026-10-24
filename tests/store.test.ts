import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { userNamespace, isMemwalConfigured } from "@/lib/memwal";
import {
  addCommitment,
  addMemory,
  createUser,
  findUserByEmail,
  listPeople,
  recentMemories,
  searchMemories,
  storeCounts,
  todayCommitments,
  upsertPerson,
} from "@/lib/store";

// Isolate the projection store per test file run.
process.env.DEJAVU_DATA_PATH = join(
  tmpdir(),
  `recall-test-${process.pid}.json`,
);

beforeEach(() => {
  try {
    rmSync(process.env.DEJAVU_DATA_PATH as string, { force: true });
  } catch {
    /* ignore */
  }
  // No in-memory cache: deleting the file fully resets state.
});

describe("projection store", () => {
  it("creates and finds users by normalized email", () => {
    const u = createUser("Alex@Example.com", "Alex");
    expect(u.email).toBe("alex@example.com");
    expect(findUserByEmail("  ALEX@example.com ")).toMatchObject({ id: u.id });
  });

  it("upserts people without duplicating, enriching sparse fields", () => {
    const u = createUser("a@test.dev");
    const first = upsertPerson(u.id, {
      name: "Sarah Chen",
      headline: null,
      company: "Nimbus",
      location: null,
    });
    expect(first.created).toBe(true);
    const second = upsertPerson(u.id, {
      name: "sarah chen",
      headline: "Founder",
      company: null,
      location: "SF",
    });
    expect(second.created).toBe(false);
    expect(second.person.id).toBe(first.person.id);
    expect(second.person.headline).toBe("Founder");
    expect(second.person.company).toBe("Nimbus");
    expect(listPeople(u.id)).toHaveLength(1);
  });

  it("stores memories with blob ids and searches them by keyword", () => {
    const u = createUser("b@test.dev");
    const { person } = upsertPerson(u.id, {
      name: "Sarah Chen",
      headline: null,
      company: null,
      location: null,
    });
    addMemory({
      userId: u.id,
      personId: person.id,
      kind: "meeting",
      content: "Met Sarah, hiring senior React engineers",
      blobId: "blob123",
    });
    addMemory({
      userId: u.id,
      personId: null,
      kind: "note",
      content: "Buy milk",
    });
    expect(storeCounts().walrus_blobs).toBe(1);
    const hits = searchMemories(u.id, "hiring react");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.person_name).toBe("Sarah Chen");
    expect(recentMemories(u.id, 5)).toHaveLength(2);
  });

  it("builds the Today feed from due commitments", () => {
    const u = createUser("c@test.dev");
    addCommitment({
      userId: u.id,
      personId: null,
      description: "Send the deck",
      dueAt: new Date(Date.now() - 3600_000).toISOString(),
      sourceMemoryId: null,
    });
    addCommitment({
      userId: u.id,
      personId: null,
      description: "Far future",
      dueAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
      sourceMemoryId: null,
    });
    const today = todayCommitments(u.id);
    expect(today).toHaveLength(1);
    expect(today[0]?.description).toBe("Send the deck");
  });
});

describe("walrus namespace isolation", () => {
  it("derives a deterministic per-user namespace", () => {
    const a = userNamespace("user-123");
    expect(a).toBe(userNamespace("user-123"));
    expect(a).not.toBe(userNamespace("user-456"));
    expect(a.startsWith("recall-")).toBe(true);
  });

  it("reports unconfigured when credentials are absent", () => {
    // vitest env has no MEMWAL_* set — the app must degrade gracefully.
    expect(isMemwalConfigured()).toBe(false);
  });
});

describe("grounded profiles (no invented titles)", () => {
  const TOMAS =
    "Ran into Tomás Silva at the conference. He runs growth at Loop, a fintech in Lisbon.";
  const SARAH =
    "Met Sarah Chen at the SF AI meetup. She's a founder at Nimbus, building AI eval tooling, ex-Stripe.";

  it("overwrites stale headlines with fresh grounded evidence", () => {
    const u = createUser("overwrite@test.dev");
    const first = upsertPerson(u.id, {
      name: "Tomás Silva",
      headline: "Founder @ Loop",
      company: "Loop",
      location: null,
    });
    expect(first.created).toBe(true);
    // A later capture with grounded values replaces the stale headline;
    // nulls never wipe established values.
    const second = upsertPerson(
      u.id,
      { name: "Tomás Silva", headline: "Growth @ Loop", company: null, location: "Lisbon" },
      { overwriteProfile: true },
    );
    expect(second.created).toBe(false);
    expect(second.person.headline).toBe("Growth @ Loop");
    expect(second.person.company).toBe("Loop");
    expect(second.person.location).toBe("Lisbon");
  });

  it("rejects a title the note never states", async () => {
    const { isGroundedIn, groundProfile } = await import("@/lib/memory");
    expect(isGroundedIn("Founder @ Loop", TOMAS)).toBe(false);
    expect(groundProfile({ headline: "Founder @ Loop", company: "Loop" }, TOMAS)).toEqual({
      headline: null,
      company: "Loop",
    });
  });

  it("keeps titles the note does state", async () => {
    const { groundProfile } = await import("@/lib/memory");
    expect(
      groundProfile({ headline: "Founder @ Nimbus, ex-Stripe", company: "Nimbus" }, SARAH),
    ).toEqual({ headline: "Founder @ Nimbus, ex-Stripe", company: "Nimbus" });
  });

  it("normalizes a grounded verbatim headline for display", async () => {
    const { normalizeHeadline } = await import("@/lib/memory");
    expect(normalizeHeadline("runs growth @ Loop")).toBe("Runs growth @ Loop");
    expect(normalizeHeadline("Partner @ Foundry")).toBe("Partner @ Foundry");
    expect(normalizeHeadline(null)).toBeNull();
  });

  it("capture never stores an ungrounded headline", async () => {    const { __setJudgeClientForTests } = await import("@/lib/judge");
    __setJudgeClientForTests({
      systemOne: async () => {
        throw new Error("offline");
      },
    } as never);
    const { captureMemory } = await import("@/lib/memory");
    const u = createUser("ground@test.dev");
    const res = await captureMemory(u.id, TOMAS);
    expect(res.person?.name).toBe("Tomás Silva");
    // The mock extractor finds no headline pattern here — and crucially,
    // nothing invents "Founder".
    expect(res.person?.headline).not.toMatch(/founder/i);
  });
});

describe("fast capture (deferred certification)", () => {
  it("saves the memory immediately and hands certification to defer", async () => {
    // Deterministic: force the Bedrock fallback path regardless of shell env.
    const { __setJudgeClientForTests } = await import("@/lib/judge");
    __setJudgeClientForTests({
      systemOne: async () => {
        throw new Error("offline");
      },
    } as never);
    const { captureMemory } = await import("@/lib/memory");
    const u = createUser("defer@test.dev");
    let deferred: Promise<void> | null = null;
    const res = await captureMemory(
      u.id,
      "Met Sarah Chen at the AI meetup — founder at Nimbus.",
      { defer: (task) => { deferred = task; } },
    );
    // Memory + projection rows exist before certification completes.
    expect(res.memory.content).toContain("Sarah Chen");
    expect(res.person?.name).toBe("Sarah Chen");
    expect(deferred).not.toBeNull();
    await deferred;
    // Walrus unconfigured in tests → no blob, but nothing lost.
    expect(res.memory.walrus_blob_id).toBeNull();
    expect(recentMemories(u.id, 5)).toHaveLength(1);
  });
});
