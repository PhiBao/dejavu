/**
 * Initializes Dejavu's local projection store (people, facts, commitments).
 *
 * Usage: pnpm store:init
 *
 * Durable memory lives in Walrus Memory — this only ensures the local JSON
 * projection file exists so the app can boot. Safe to re-run.
 */
import { loadEnv } from "./load-env";
loadEnv();

import { loadStore, saveStore, storeCounts } from "../lib/store";

async function main() {
  saveStore(loadStore());
  const counts = storeCounts();
  console.log("[store:init] projection store ready ✔");
  console.log(
    `  users=${counts.users} people=${counts.people} memories=${counts.memories} walrus_blobs=${counts.walrus_blobs}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
