/**
 * Verify the Walrus Memory path end-to-end (staging or mainnet).
 *
 * Checks the relayer health, writes a test memory, waits for the blob,
 * recalls it back, and reports the account's blob proof state. Every seeded
 * or captured memory counts toward the Session's ≥10-blob requirement —
 * this script shows where you stand.
 *
 * Usage: pnpm memwal:verify
 * Requires: MEMWAL_PRIVATE_KEY + MEMWAL_ACCOUNT_ID in .env.local
 */
import { loadEnv } from "./load-env";
loadEnv();

import { MemWal } from "@mysten-incubation/memwal";
import { env } from "../lib/env";
import { countWalrusBlobs } from "../lib/store";

const PROBE_TEXT = `Dejavu verification probe ${new Date().toISOString()}: the demo user met Sarah Chen, founder at Nimbus, hiring senior React engineers.`;

async function main() {
  const e = env();
  if (!e.MEMWAL_PRIVATE_KEY || !e.MEMWAL_ACCOUNT_ID) {
    console.error(
      "[memwal] FAIL — MEMWAL_PRIVATE_KEY / MEMWAL_ACCOUNT_ID are not set.\n" +
        "  Generate an account at https://memory.walrus.xyz (mainnet) or\n" +
        "  https://staging.memory.walrus.xyz (testnet), then add both to .env.local.",
    );
    process.exit(1);
  }
  console.log(`[memwal] relayer=${e.MEMWAL_SERVER_URL}`);

  const client = MemWal.create({
    key: e.MEMWAL_PRIVATE_KEY,
    accountId: e.MEMWAL_ACCOUNT_ID,
    serverUrl: e.MEMWAL_SERVER_URL,
    namespace: "recall-verify",
  });

  const started = Date.now();
  await client.health();
  console.log(`[memwal] health OK (${Date.now() - started}ms)`);

  const accepted = await client.remember(PROBE_TEXT, "recall-verify");
  console.log(`[memwal] remember accepted job=${accepted.job_id}`);
  const done = await client.waitForRememberJob(accepted.job_id, { timeoutMs: 90_000 });
  console.log(`[memwal] blob certified: ${done.blob_id}`);

  const recalled = await client.recall({
    query: "Who is hiring React engineers?",
    limit: 3,
    namespace: "recall-verify",
  });
  const found = recalled.results.some((r) => r.blob_id === done.blob_id);
  console.log(
    `[memwal] recall returned ${recalled.results.length} hit(s); probe blob ${found ? "FOUND ✔" : "MISSING ✘"}`,
  );
  for (const r of recalled.results.slice(0, 3)) {
    console.log(`  - d=${r.distance.toFixed(3)} blob=${r.blob_id} :: ${r.text.slice(0, 90)}…`);
  }

  const local = countWalrusBlobs();
  console.log(`[memwal] local projection tracks ${local} Walrus blob(s) (need ≥10 at submission)`);
  if (!found) process.exit(1);
  console.log("[memwal] PASS ✔");
  process.exit(0);
}

main().catch((err) => {
  console.error("[memwal] FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
