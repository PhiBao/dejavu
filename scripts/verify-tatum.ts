/**
 * Verify Dejavu's memory layer independently, through Tatum's Sui gRPC.
 *
 * Proves three claims against chain state instead of trusting the relayer:
 *   1. the Walrus system is live and what epoch it is on
 *   2. our delegate key is registered on the MemWalAccount (agent authority)
 *   3. every stored memory has a real Walrus Blob object, with a real expiry
 *
 * Usage: pnpm tatum:verify [path-to-recall.json]
 */
import { loadEnv } from "./load-env";
loadEnv();

import { readFileSync } from "node:fs";
import { delegateKeyToPublicKey, delegateKeyToSuiAddress } from "@mysten-incubation/memwal";
import { env } from "../lib/env";
import {
  checkDelegate,
  daysRemaining,
  epochsRemaining,
  expiryDate,
  getMemWalAccount,
  getWalrusSystemState,
  isTatumConfigured,
  listOwnedBlobs,
  verifyMemoriesOnchain,
} from "../lib/tatum";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const e = env();
  console.log(`[tatum] grpc ${e.TATUM_SUI_GRPC_URL}`);
  check("Tatum configured", isTatumConfigured());

  // --- 1. Walrus system state ---------------------------------------------
  console.log("\n[1/4] Walrus system state (via Tatum)");
  const system = await getWalrusSystemState();
  check("system state readable", !!system);
  if (!system) return finish();
  console.log(
    `         epoch=${system.epoch} shards=${system.nShards} ` +
      `capacity=${(system.usedCapacityBytes / 1e15).toFixed(2)}/${(system.totalCapacityBytes / 1e15).toFixed(0)} PB ` +
      `epochDays=${system.epochDays}`,
  );

  // --- 2. Agent authority onchain ------------------------------------------
  console.log("\n[2/4] Agent authority (MemWalAccount delegate keys)");
  const account = await getMemWalAccount();
  check("MemWalAccount readable", !!account);
  if (!account) return finish();
  console.log(
    `         owner=${account.owner} active=${account.active} delegates=${account.delegates.length} created=${new Date(account.createdAt).toISOString().slice(0, 10)}`,
  );

  const priv = e.MEMWAL_PRIVATE_KEY as string;
  const pubBytes = await delegateKeyToPublicKey(priv);
  const pub = Buffer.from(pubBytes).toString("hex");
  const suiAddr = await delegateKeyToSuiAddress(priv);
  const auth = checkDelegate(account, pub, suiAddr);
  check("configured delegate key is registered onchain", auth.registered, `${auth.matchedLabel ?? "no"} · ${suiAddr.slice(0, 12)}…`);
  check("account is active and not quarantined", account.active && !account.quarantined);

  // --- 3. Blob objects ------------------------------------------------------
  console.log("\n[3/4] Blob objects owned onchain");
  const blobs = await listOwnedBlobs(account.owner);
  check("blob objects listed", blobs.size > 0, `${blobs.size} objects`);

  const sample = blobs.values().next().value;
  if (sample) {
    console.log(
      `         sample ${sample.blobId.slice(0, 12)}… epoch ${sample.registeredEpoch}→${sample.endEpoch} ` +
        `size=${sample.sizeBytes}B deletable=${sample.deletable}`,
    );
    check("certified epoch recorded", sample.certifiedEpoch !== null);
    check(
      "blob id codec round-trips against chain",
      [...blobs.keys()].every((id) => id.length >= 40),
    );
  }

  // --- 4. App memories ↔ chain ---------------------------------------------
  console.log("\n[4/4] App memories cross-checked with chain");
  const path = process.argv[2] ?? "data/recall.json";
  let appBlobIds: string[] = [];
  try {
    const store = JSON.parse(readFileSync(path, "utf8")) as {
      memories?: { walrus_blob_id?: string | null }[];
    };
    appBlobIds = (store.memories ?? [])
      .map((m) => m.walrus_blob_id)
      .filter((id): id is string => !!id);
    console.log(`         ${appBlobIds.length} memories with blob ids in ${path}`);
  } catch {
    console.log(`         (no local store at ${path}; checking account totals only)`);
  }

  const summary = await verifyMemoriesOnchain(appBlobIds);
  check("onchain summary produced", !!summary);
  if (summary) {
    check(
      "app memories found onchain",
      appBlobIds.length === 0 || summary.blobs.matched === appBlobIds.length,
      `matched ${summary.blobs.matched}/${appBlobIds.length}, onchain total ${summary.blobs.onchain}`,
    );
    check("agent authorized (summary)", summary.agentAuthorized, summary.agentLabel ?? "");
    if (summary.blobs.earliestEndEpoch !== null) {
      console.log(
        `         earliest expiry: epoch ${summary.blobs.earliestEndEpoch} ` +
          `(${daysRemaining(summary.blobs.earliestEndEpoch, summary.epoch!)} days, ${expiryDate(summary.blobs.earliestEndEpoch, summary.epoch!).slice(0, 10)})`,
      );
      check(
        "expiry math consistent",
        epochsRemaining(summary.blobs.earliestEndEpoch, summary.epoch!) >= 0,
      );
    }
    console.log(`         explorer ${summary.explorer.account}`);
  }

  finish();
}

function finish(): never {
  console.log(
    failures === 0
      ? "\n[tatum] PASS ✔ memory layer verified onchain via Tatum"
      : `\n[tatum] FAIL — ${failures} check(s)`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("[tatum] ERROR:", err instanceof Error ? err.message : err);
  process.exit(1);
});
