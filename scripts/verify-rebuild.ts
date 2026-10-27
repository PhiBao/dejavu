/**
 * Durability proof: the workspace, not just semantic search, rebuilds from
 * Walrus.
 *
 *   capture → correct → forget → delete the local projection → rebuild
 *
 * The rebuilt workspace must contain the active memories and current facts,
 * must NOT resurrect the forgotten memory, and must still answer with the
 * corrected employer. Lifecycle manifests written to Walrus carry tombstones.
 */
import { loadEnv } from "./load-env";
loadEnv();

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PATH = join(tmpdir(), `dejavu-rebuild-${randomUUID().slice(0, 8)}.json`);
process.env.DEJAVU_DATA_PATH = PATH;

const store = await import("../lib/store");
const mem = await import("../lib/memory");

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const user = store.createUser(`rebuild-${randomUUID().slice(0, 8)}@dejavu.test`, "Rebuild");
  const uid = user.id;

  const first = await mem.captureMemory(
    uid,
    "Met Sarah Chen at the SF AI meetup. She's a founder at Nimbus, hiring senior React engineers. Promised to intro her to Priya.",
  );
  await new Promise((r) => setTimeout(r, 10));
  const second = await mem.captureMemory(
    uid,
    "Sarah Chen is now a founder at Linear.",
  );
  const forgotten = await mem.captureMemory(
    uid,
    "Temporary note: the restaurant on 5th was terrible, never go back.",
  );
  const dated = await mem.captureMemory(
    uid,
    "My passport expires in 7 weeks. Need to renew it before the trip to Lisbon.",
  );

  check("captured a person", first.person?.name === "Sarah Chen", first.person?.name ?? "null");
  check("captured a correction", second.person?.id === first.person?.id);
  check("forgot the temporary note", await mem.forgetMemory(uid, forgotten.memory.id));
  check("captured a dated fact", dated.factsAdded > 0, `${dated.factsAdded} facts`);

  const before = store.storeCounts();
  console.log(
    `[rebuild] before deletion: memories=${before.active_memories} people=${before.people} facts=${before.current_facts} blobs=${before.walrus_blobs}`,
  );

  // Simulate total local-index loss.
  rmSync(PATH, { force: true });
  check("local projection is empty", store.loadStore().memories.length === 0);

  const result = await mem.rebuildWorkspaceFromWalrus(uid);
  console.log(
    `[rebuild] restored: memories=${result.memories} people=${result.people} facts=${result.facts} commitments=${result.commitments} skipped=${result.skipped} scanned=${result.scanned}`,
  );

  const rebuilt = store.loadStore();
  const rows = rebuilt.memories.filter((m) => m.user_id === uid);
  check("memories restored", rows.length >= 3, `${rows.length} memories`);
  check("people restored", rebuilt.people.filter((p) => p.user_id === uid).length >= 1);
  check(
    "forgotten memory did not come back",
    !rows.some((m) => m.content.includes("restaurant on 5th")),
  );
  check(
    "correction survived",
    rows.some((m) => /Linear/.test(m.content)),
  );
  const sarah = rebuilt.people.find(
    (p) => p.user_id === uid && p.name === "Sarah Chen",
  );
  const company = sarah
    ? rebuilt.facts.find(
        (f) =>
          f.user_id === uid &&
          f.person_id === sarah.id &&
          f.key === "company" &&
          f.status === "current",
      )
    : null;
  check("current employer is Linear", company?.value === "Linear", company?.value ?? "missing");
  check(
    "passport expiry restored with a date",
    rebuilt.facts.some(
      (f) => f.user_id === uid && f.key === "passport_expiry" && !!f.absolute_date,
    ),
  );

  const answer = await mem.recall(uid, "Where does Sarah Chen work now?");
  check(
    "recall still answers with the current employer",
    /linear/i.test(answer.answer) && !/nimbus/i.test(answer.answer),
    answer.answer.slice(0, 100),
  );

  try {
    rmSync(PATH, { force: true });
  } catch {
    /* ignore */
  }

  console.log(
    failures === 0
      ? "\n[rebuild] PASS ✔ the workspace rebuilds from Walrus"
      : `\n[rebuild] FAIL — ${failures} check(s) failed`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("[rebuild] ERROR:", err instanceof Error ? err.message : err);
  process.exit(1);
});
