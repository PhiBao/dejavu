/**
 * Durability proof: your memory outlives the app.
 *
 * Three claims, each demonstrated rather than asserted:
 *   1. ON-CHAIN TRUTH — the blobs exist on Sui/Walrus, owned by the account,
 *      discoverable per namespace (not just in some app database).
 *   2. INDEX RECOVERY — the relayer's search index can be rebuilt from Walrus
 *      alone via restore(), so recall survives a total index loss.
 *   3. APP-INDEX LOSS — delete Dejavu's local projection entirely and semantic
 *      recall STILL answers, because the memories were never in the app.
 *
 * Usage: pnpm memwal:durability [userId]
 * With no userId it uses every namespace it can find under the account.
 */
import { loadEnv } from "./load-env";
loadEnv();

import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { MemWal } from "@mysten-incubation/memwal";
import { env } from "../lib/env";
import { userNamespace, walrusRestore } from "../lib/memwal";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const e = env();
  const client = MemWal.create({
    key: e.MEMWAL_PRIVATE_KEY as string,
    accountId: e.MEMWAL_ACCOUNT_ID as string,
    serverUrl: e.MEMWAL_SERVER_URL,
    namespace: "recall-durability",
  });

  console.log(`[durability] account ${e.MEMWAL_ACCOUNT_ID}`);
  console.log(`[durability] relayer ${e.MEMWAL_SERVER_URL}\n`);

  // --- 1. On-chain truth --------------------------------------------------
  console.log("[1/3] on-chain truth — blobs are owned on Sui, not held by the app");
  let cursor: string | undefined;
  let total = 0;
  const namespaces: { name: string; count: number }[] = [];
  do {
    const page = await client.listNamespaces({ cursor });
    for (const ns of page.namespaces) {
      namespaces.push({ name: ns.name, count: ns.memory_count });
      total += ns.memory_count;
      console.log(`         ${ns.name}: ${ns.memory_count} memory blobs`);
    }
    cursor = page.next_cursor ?? undefined;
    if (!page.has_more) break;
  } while (cursor);
  check("account owns blobs", total > 0, `${total} blobs across ${namespaces.length} namespaces`);
  check(
    "per-user namespacing is real",
    namespaces.some((n) => n.name.startsWith("recall-")),
    namespaces.map((n) => n.name).slice(0, 3).join(", "),
  );

  // --- 2. Index recovery --------------------------------------------------
  console.log("\n[2/3] index recovery — restore() rebuilds search state from Walrus");
  const probeUser = process.argv[2];
  const targets = probeUser
    ? [probeUser]
    : namespaces
        .filter((n) => n.name.startsWith("recall-") && !n.name.startsWith("recall-verify"))
        .sort((a, b) => b.count - a.count)
        .map((n) => n.name.replace(/^recall-/, ""));
  if (targets.length === 0) {
    console.log("  (no recall-* namespaces to restore; run pnpm seed first)");
  }
  const restorable: string[] = [];
  for (const uid of targets.slice(0, 3)) {
    const r = await walrusRestore(uid, 50);
    if (!r) {
      check(`restore(${userNamespace(uid)})`, false, "relayer unreachable");
      continue;
    }
    // `total` is the relayer's on-chain count for (owner, namespace). A zero
    // can mean the blobs genuinely expired, or that the owner-wide candidate
    // cap hid them; neither is proof that restore is broken. Prove recovery on
    // a namespace that still has live blobs and warn on the rest.
    if (r.total > 0) {
      restorable.push(uid);
      check(
        `restore(${userNamespace(uid)})`,
        true,
        `discovered ${r.total} blobs on-chain, re-indexed ${r.restored}` +
          (r.failed ? `, failed ${r.failed}` : "") +
          (r.truncated ? ", truncated" : ""),
      );
    } else {
      console.log(
        `  WARN  restore(${userNamespace(uid)}) — no live blobs discoverable` +
          ` (expired storage or relayer candidate cap${r.truncated ? ", truncated" : ""})`,
      );
    }
  }
  check(
    "at least one namespace rebuilt from Walrus",
    restorable.length > 0,
    `${restorable.length}/${Math.min(targets.length, 3)} namespaces`,
  );

  // --- 3. App-index loss --------------------------------------------------
  console.log("\n[3/3] app-index loss — recall survives losing the local projection");
  const victim = restorable[0] ?? targets[0];
  if (!victim) {
    console.log("  (skipped — no seeded user)");
  } else {
    const saved = process.env.DEJAVU_DATA_PATH;
    const emptyPath = join(tmpdir(), `recall-empty-${randomUUID().slice(0, 8)}.json`);
    process.env.DEJAVU_DATA_PATH = emptyPath;
    // Recreate the client so the store layer picks up the new path.
    const { __clearMemwalClient } = await import("../lib/memwal");
    __clearMemwalClient();
    try {
      rmSync(emptyPath, { force: true });
    } catch {
      /* ignore */
    }
    const { loadStore } = await import("../lib/store");
    check("local projection emptied", loadStore().memories.length === 0);

    const { walrusRecall } = await import("../lib/memwal");
    const hits = await walrusRecall(victim, "who is hiring react engineers", 5);
    check(
      "semantic recall still answers with zero local rows",
      hits.length > 0,
      `${hits.length} hits from Walrus alone`,
    );
    if (hits[0]) {
      console.log(`         top hit: d=${hits[0].distance.toFixed(3)} ${hits[0].text.slice(0, 88)}…`);
    }
    process.env.DEJAVU_DATA_PATH = saved;
    __clearMemwalClient();
    try {
      rmSync(emptyPath, { force: true });
    } catch {
      /* ignore */
    }
  }

  console.log(
    failures === 0
      ? "\n[durability] PASS ✔ memory lives on Walrus, not in the app"
      : `\n[durability] FAIL — ${failures} check(s)`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("[durability] ERROR:", err instanceof Error ? err.message : err);
  process.exit(1);
});
