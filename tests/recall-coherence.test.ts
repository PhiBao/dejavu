import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildExtractiveAnswer, captureMemory, recall } from "@/lib/memory";
import { ABSTAIN_TEXT } from "@/lib/ai";
import { createUser } from "@/lib/store";

// AI_PROVIDER=mock in vitest config: deterministic local paths, no network.
// Isolated projection per run.
process.env.DEJAVU_DATA_PATH = join(tmpdir(), `recall-contradict-${process.pid}.json`);

beforeEach(() => {
  try {
    rmSync(process.env.DEJAVU_DATA_PATH as string, { force: true });
  } catch {
    /* ignore */
  }
});

const STORIES = [
  "Met Sarah Chen at the SF AI meetup. She's a founder at Nimbus, ex-Stripe, hiring senior React engineers. Promised to intro her to Priya.",
  "Ran into Tomás Silva at the conference. He runs growth at Loop, a fintech in Lisbon. Into padel and specialty coffee.",
  "Coffee with Marcus Webb, a partner at Foundry Ventures. He invests in dev tools at seed. Said I'd send him our deck by Friday.",
];

async function seedUser(): Promise<string> {
  const u = createUser(`contradict-${Date.now()}@test.dev`, "Test");
  for (const s of STORIES) await captureMemory(u.id, s);
  return u.id;
}

describe("no contradictory abstention (citations + 'don't know')", () => {
  it("never returns abstention text alongside citations", async () => {
    const uid = await seedUser();
    for (const q of [
      "how many founders did I meet",
      "is Tomás a founder or not",
      "who is hiring",
      "list all the people I know",
      "what did I promise",
    ]) {
      const res = await recall(uid, q);
      const abstained = res.answer.trim().startsWith(ABSTAIN_TEXT);
      expect(
        !(abstained && res.citations.length > 0),
        `contradiction on "${q}": abstained with ${res.citations.length} citations`,
      ).toBe(true);
    }
  });

  it("counting question names the matching person", async () => {
    const uid = await seedUser();
    const res = await recall(uid, "how many founders did I meet");
    expect(res.answer).toMatch(/sarah chen/i);
  });

  it("yes/no question answers from what the memory states", async () => {
    const uid = await seedUser();
    const res = await recall(uid, "is Tomás a founder or not");
    // Memory says growth, not founder — either a direct answer or the
    // extractive fallback, but never bare abstention next to the citation.
    const mentionsTomas = /tom.s/i.test(res.answer);
    expect(mentionsTomas || res.citations.length === 0).toBe(true);
  });
});

describe("buildExtractiveAnswer", () => {
  it("names people and quotes their memories, capped in length", () => {
    const out = buildExtractiveAnswer([
      { personName: "Sarah Chen", content: "founder at Nimbus, hiring React engineers" },
      { personName: null, content: "buy milk tomorrow" },
    ]);
    expect(out).toMatch(/Sarah Chen/);
    expect(out).toMatch(/2 memories/);
    expect(out.length).toBeLessThanOrEqual(700);
  });

  it("handles a single memory with singular phrasing", () => {
    const out = buildExtractiveAnswer([{ personName: "Ravi", content: "owes me lunch" }]);
    expect(out).toMatch(/1 memory/);
  });
});
