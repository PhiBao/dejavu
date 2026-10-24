/**
 * Re-ground every person profile in what their memories actually say.
 *
 * Early captures let the extraction model invent display titles
 * ("Founder @ Loop" for someone whose note says "runs growth at Loop").
 * This replays the FIXED extraction over each person's most recent memory,
 * keeps only headline/company evidenced in the note text, and writes the
 * result back. No new memories, no Walrus writes — profile repair only.
 *
 * Usage: DEJAVU_DATA_PATH=./data/recall.json pnpm exec tsx scripts/repair-headlines.ts
 */
import { loadEnv } from "./load-env";
loadEnv();

import { extractMemory } from "../lib/ai";
import { groundProfile, normalizeHeadline } from "../lib/memory";
import { loadStore, saveStore } from "../lib/store";

async function main() {
  const store = loadStore();
  let fixed = 0;
  for (const person of store.people) {
    const memories = store.memories
      .filter((m) => m.person_id === person.id)
      .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
    if (memories.length === 0) continue;
    const latest = memories[0]!.content;
    const extracted = await extractMemory(latest);
    const grounded = groundProfile(
      { headline: extracted.headline, company: extracted.company },
      latest,
    );
    grounded.headline = normalizeHeadline(grounded.headline);
    const before = `${person.headline ?? "—"} / ${person.company ?? "—"}`;
    const after = `${grounded.headline ?? "—"} / ${grounded.company ?? "—"}`;
    if (before !== after) {
      person.headline = grounded.headline;
      person.company = grounded.company;
      person.updated_at = new Date().toISOString();
      fixed++;
    }
    console.log(`[${person.name}] ${before}  →  ${after}`);
  }
  saveStore(store);
  console.log(`[repair] ${fixed} profile(s) corrected, ${store.people.length} total.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[repair] failed:", err);
  process.exit(1);
});
