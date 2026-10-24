/**
 * End-to-end verification against real Walrus Memory (mainnet).
 *
 * This is the regression net for the whole product path. Three production
 * incidents shared one root cause — a silent degradation that unit tests with
 * mocked AI could not see:
 *   1. a nested `app/app` route broke container builds
 *   2. the projection store cached per-route, so writes were invisible
 *   3. the name pre-parser gated person resolution, silently dropping
 *      people, facts and commitments
 *
 * So: a fresh user, real Bedrock extraction, real Jev judgments, real
 * encrypted Walrus blobs. Then assert the product actually remembers.
 *
 * Usage:  pnpm verify:e2e          (staging relayer)
 *         MEMWAL_SERVER_URL=https://relayer-staging.memory.walrus.xyz pnpm verify:e2e
 *
 * Exit 0 = healthy. Non-zero = something a judge would hit.
 */
import { loadEnv } from "./load-env";
loadEnv();

import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// Isolate from any local store BEFORE importing the domain layer.
const E2E_PATH = join(tmpdir(), `recall-e2e-${randomUUID().slice(0, 8)}.json`);
process.env.DEJAVU_DATA_PATH = E2E_PATH;

const { isMemwalConfigured } = await import("../lib/memwal");
const { isMockAI } = await import("../lib/env");
const store = await import("../lib/store");
const mem = await import("../lib/memory");

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  console.log("[e2e] configuration");
  check("Walrus configured", isMemwalConfigured());
  check("Bedrock prose configured (not mock)", !isMockAI());

  // A brand-new user: nothing pre-seeded, nothing cached.
  const email = `e2e-${randomUUID().slice(0, 8)}@recall.test`;
  const user = store.createUser(email, "E2E");
  const uid = user.id;
  check("fresh user created", !!uid);

  // --- 1. Capture: structure must survive --------------------------------
  console.log("\n[e2e] capture — structure must not be silently dropped");
  const story =
    "Met Sarah Chen at the SF AI meetup. She's a founder at Nimbus, ex-Stripe, and she's hiring senior React engineers. Promised to intro her to my friend Priya who's looking.";
  const cap = await mem.captureMemory(uid, story);
  check("person resolved", cap.person?.name === "Sarah Chen", `got ${cap.person?.name ?? "null"}`);
  check("facts extracted", cap.factsAdded > 0, `${cap.factsAdded} facts`);
  check("commitment extracted", cap.commitmentsAdded > 0, `${cap.commitmentsAdded}`);
  check(
    "blob landed on Walrus",
    cap.walrusState !== "unavailable",
    `${cap.walrusState}${cap.memory.walrus_blob_id ? ` ${cap.memory.walrus_blob_id}` : ""} (attempts=${cap.walrusAttempts})`,
  );

  // Casual phrasing: the incident-3 regression. A person must still be found.
  const casual = await mem.captureMemory(uid, "i meet Thomaz, he is a funny person");
  check("casual phrasing resolves a person", casual.person?.name === "Thomaz", `got ${casual.person?.name ?? "null"}`);

  // Intro-mention trap: the subject, not the person mentioned for an intro.
  const intro = await mem.captureMemory(
    uid,
    "Lunch with David Okafor, CTO at Paystack. Said I'd intro him to Ravi to compare notes on on-call.",
  );
  check("intro mention not mis-attributed", intro.person?.name === "David Okafor", `got ${intro.person?.name ?? "null"}`);

  const people = await mem.listPeople(uid);
  check("people list populated", people.length >= 3, `${people.length} people: ${people.map((p) => p.name).join(", ")}`);

  // --- 2. Dejavu: paraphrase, citations, verification ---------------------
  console.log("\n[e2e] recall — paraphrase must work, answers must be cited");
  const q = await mem.recall(uid, "Who did I meet that's recruiting frontend people?");
  check("paraphrase answer found Sarah", /sarah/i.test(q.answer), q.answer.slice(0, 90));
  check("answer is cited", q.citations.length > 0, `${q.citations.length} citations`);
  check("citation names the person", q.citations.some((c) => c.personName === "Sarah Chen"));
  check(
    "citation machine-verified",
    q.citations.some((c) => c.verified === "verified"),
    q.citations.map((c) => `${c.personName}:${c.score}${c.verified ? "/" + c.verified : ""}`).join(" "),
  );

  const promise = await mem.recall(uid, "what did I promise Priya?");
  check("commitment recallable", /priya/i.test(promise.answer), promise.answer.slice(0, 80));

  // --- 3. Abstention: no answer, no citations, no synthesis ---------------
  console.log("\n[e2e] abstention — unknown question must not hallucinate");
  const none = await mem.recall(uid, "Who do I know in Tokyo who plays competitive chess?");
  check("declines unknown question", /don't have a memory/i.test(none.answer), none.answer.slice(0, 80));
  check("no citations when abstaining", none.citations.length === 0);

  // --- 4. Today feed ------------------------------------------------------
  console.log("\n[e2e] projection — follow-ups and timeline");
  const today = await mem.getTodayFeed(uid);
  const all = store.loadStore();
  const openCommitments = all.commitments.filter((c) => c.user_id === uid && c.status === "open");
  check("commitments persisted", openCommitments.length > 0, `${openCommitments.length} open`);
  check("today feed renders", Array.isArray(today));
  check("draft message generated", today.every((t) => typeof t.draftMessage === "string" && t.draftMessage.length > 10));

  const sarah = people.find((p) => p.name === "Sarah Chen");
  const facts = sarah ? await mem.getPersonFacts(uid, sarah.id) : [];
  const timeline = sarah ? await mem.getPersonMemories(uid, sarah.id) : [];
  check("person facts linked", facts.length > 0, `${facts.length} facts`);
  check("memory timeline linked", timeline.length > 0, `${timeline.length} memories`);
  check(
    "facts cite their source memory",
    facts.every((f) => !!f.source_memory_id),
  );

  // --- 5. Isolation: another user must see nothing ------------------------
  console.log("\n[e2e] isolation — namespaces must not leak");
  const other = store.createUser(`e2e-other-${randomUUID().slice(0, 6)}@recall.test`, "Other");
  const otherRecall = await mem.recall(other.id, "Who did I meet that's recruiting frontend people?");
  check("other user cannot see memories", /don't have a memory/i.test(otherRecall.answer));
  check("other user has no people", (await mem.listPeople(other.id)).length === 0);

  // --- 6. Durability: the blobs outlive the local projection --------------
  console.log("\n[e2e] durability — Walrus is the source of truth");
  const { walrusRestore } = await import("../lib/memwal");
  const restore = await walrusRestore(uid, 25);
  check("relayer reachable for restore", restore !== null, restore ? `restored=${restore.restored} total=${restore.total}` : "");
  check("blobs discoverable on-chain", (restore?.total ?? 0) >= 3, `${restore?.total} blobs in namespace`);

  const counts = store.storeCounts();
  console.log(
    `\n[e2e] projection: people=${counts.people} memories=${counts.memories} facts=${counts.facts} commitments=${counts.commitments} blobs=${counts.walrus_blobs}`,
  );

  try {
    rmSync(E2E_PATH, { force: true });
  } catch {
    /* best effort */
  }

  console.log(failures === 0 ? "\n[e2e] PASS ✔ product path healthy" : `\n[e2e] FAIL — ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("[e2e] ERROR:", err instanceof Error ? err.message : err);
  process.exit(1);
});
