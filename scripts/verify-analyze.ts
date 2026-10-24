/**
 * Trial: Walrus Memory's analyze() — extract facts server-side.
 *
 * We deliberately do NOT use this in the capture path, and this script exists
 * so that decision is a measured one rather than an oversight. It runs the
 * same sentence through analyze() and prints what comes back, next to what
 * Dejavu's own pipeline produces, so the trade-off is on the record.
 *
 * Usage: pnpm memwal:analyze
 */
import { loadEnv } from "./load-env";
loadEnv();

import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const P = join(tmpdir(), `recall-analyze-${randomUUID().slice(0, 8)}.json`);
process.env.DEJAVU_DATA_PATH = P;

const { MemWal } = await import("@mysten-incubation/memwal");
const { env } = await import("../lib/env");
const { createUser } = await import("../lib/store");
const { captureMemory } = await import("../lib/memory");
const { userNamespace } = await import("../lib/memwal");

const STORY =
  "Met Sarah Chen at the SF AI meetup. She's a founder at Nimbus, ex-Stripe, hiring senior React engineers. Promised to intro her to my friend Priya who's looking.";

async function main() {
  const e = env();
  const client = MemWal.create({
    key: e.MEMWAL_PRIVATE_KEY as string,
    accountId: e.MEMWAL_ACCOUNT_ID as string,
    serverUrl: e.MEMWAL_SERVER_URL,
    namespace: "recall",
  });

  const uid = createUser(`analyze-${randomUUID().slice(0, 6)}@test.dev`, "A").id;
  const ns = userNamespace(uid);

  console.log("[analyze] input:", STORY.slice(0, 80), "…\n");

  console.log("[analyze] A) Walrus Memory analyze() — server-side fact extraction");
  const t0 = Date.now();
  try {
    const res = await client.analyze(STORY, ns);
    const facts = res.facts ?? [];
    console.log(`     ${Date.now() - t0}ms · ${facts.length} extracted fact(s) · ${res.job_ids?.length ?? 0} job(s)`);
    for (const f of facts.slice(0, 8)) {
      console.log(`       - ${typeof f === "string" ? f : JSON.stringify(f).slice(0, 140)}`);
    }
    console.log("     → opaque to us: each fact becomes its own encrypted blob.");
  } catch (err) {
    console.log(`     unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log("\n[analyze] B) Dejavu's pipeline — Bedrock extraction + Jev identity");
  const t1 = Date.now();
  const cap = await captureMemory(uid, STORY);
  console.log(
    `     ${Date.now() - t1}ms · person=${cap.person?.name ?? "null"} · ${cap.factsAdded} facts · ${cap.commitmentsAdded} commitments`,
  );
  console.log("     → structured, attributed to a person, linked to the source memory.");

  console.log(
    "\n[analyze] VERDICT: we keep our own extraction. analyze() gives untyped,",
  );
  console.log(
    "unattributed facts as separate blobs; Dejavu needs a resolved person, a",
  );
  console.log(
    "source-memory citation, and commitments with due dates — and it must all",
  );
  console.log("live in ONE blob per capture so a recall returns a coherent record.");

  try {
    rmSync(P, { force: true });
  } catch {
    /* best effort */
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("[analyze] ERROR:", err);
  process.exit(1);
});
