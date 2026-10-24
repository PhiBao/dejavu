import {
  listOwnedBlobs,
  daysRemaining,
  getMemWalAccount,
  getWalrusSystemState,
  type BlobOnchain,
} from "./tatum";
import {
  loadStore,
  memoryUsageMap,
  type MemoryUsage,
} from "./store";
import type { Memory } from "./types";

/**
 * Memory Health — the learning loop.
 *
 * Every recall is recorded, so Dejavu knows which memories actually earn
 * their storage. That signal changes the product in two visible ways:
 *
 *   1. RANKING — a memory you keep asking for is slightly boosted, so the
 *      answers you actually rely on surface first.
 *   2. STEWARDSHIP — combined with the onchain storage window (read from
 *      Sui via Tatum), it tells you which memories are worth renewing before
 *      their storage ends, and which are safe to let go.
 *
 * Importance is deliberately explainable: every point comes from a visible
 * reason, and the reason is returned with the number.
 */

export interface MemoryHealthRow {
  memoryId: string;
  personName: string | null;
  snippet: string;
  importance: number;
  reasons: string[];
  hits: number;
  lastHitAt: string | null;
  blobId: string | null;
  endEpoch: number | null;
  daysToExpiry: number | null;
  onchain: boolean;
  atRisk: boolean;
}

export interface MemoryHealth {
  epoch: number | null;
  rows: MemoryHealthRow[];
  topRelied: MemoryHealthRow[];
  atRisk: MemoryHealthRow[];
  /** One line a human can act on. */
  summary: string;
  verifiedBlobs: number;
  totalMemories: number;
}

const DAY_MS = 86_400_000;
const AT_RISK_DAYS = 90;

/** 0..1 recency score: full inside 7 days, decaying to 0 at 90. */
function recencyScore(lastHitAt: string | null, createdAt: string): number {
  const ref = lastHitAt ?? createdAt;
  const days = (Date.now() - new Date(ref).getTime()) / DAY_MS;
  if (days <= 7) return 1;
  if (days >= 90) return 0;
  return 1 - (days - 7) / 83;
}

/**
 * Explainable importance in 0..1.
 *   reliance 0.45 · recency 0.20 · relationship 0.20 · obligation 0.15
 */
export function importanceScore(input: {
  hits: number;
  lastHitAt: string | null;
  createdAt: string;
  hasPerson: boolean;
  hasCommitment: boolean;
}): { score: number; reasons: string[] } {
  const reasons: string[] = [];

  const reliance = Math.min(1, input.hits / 5);
  if (input.hits > 0) {
    reasons.push(
      `recalled ${input.hits} time${input.hits === 1 ? "" : "s"}`,
    );
  }
  const recency = recencyScore(input.lastHitAt, input.createdAt);
  if (recency >= 0.5) reasons.push("used recently");
  if (input.hasPerson) reasons.push("tied to a person");
  if (input.hasCommitment) reasons.push("something you owe");

  const score =
    0.45 * reliance + 0.2 * recency + 0.2 * (input.hasPerson ? 1 : 0) +
    0.15 * (input.hasCommitment ? 1 : 0);
  return { score: Math.round(score * 100) / 100, reasons };
}

/**
 * Ranking boost from recall history. Small on purpose: relevance decides
 * what is shown, reliance only breaks ties between equally relevant
 * memories — it can never surface an irrelevant one.
 */
export function relianceBoost(hits: number): number {
  return Math.min(0.1, Math.log2(1 + hits) * 0.03);
}

export async function computeMemoryHealth(
  userId: string,
): Promise<MemoryHealth> {
  const store = loadStore();
  const memories = store.memories.filter((m) => m.user_id === userId);
  const usage: Map<string, MemoryUsage> = memoryUsageMap(userId);
  const peopleById = new Map(store.people.map((p) => [p.id, p.name]));
  const commitmentMemoryIds = new Set(
    store.commitments
      .filter((c) => c.user_id === userId && c.source_memory_id)
      .map((c) => c.source_memory_id as string),
  );

  // Onchain storage windows (Tatum Sui gRPC). Null when unavailable.
  let epoch: number | null = null;
  let blobs: Map<string, BlobOnchain> = new Map();
  const account = await getMemWalAccount();
  if (account) {
    epoch = (await getWalrusSystemState())?.epoch ?? null;
    blobs = await listOwnedBlobs(account.owner);
  }

  const rows: MemoryHealthRow[] = memories.map((m: Memory) => {
    const use = usage.get(m.id);
    const hits = use?.hits ?? 0;
    const hasPerson = !!m.person_id;
    const hasCommitment = commitmentMemoryIds.has(m.id);
    const { score, reasons } = importanceScore({
      hits,
      lastHitAt: use?.last_hit_at ?? null,
      createdAt: m.created_at,
      hasPerson,
      hasCommitment,
    });
    const blob = m.walrus_blob_id ? blobs.get(m.walrus_blob_id) : undefined;
    const days =
      blob && epoch !== null ? daysRemaining(blob.endEpoch, epoch) : null;
    return {
      memoryId: m.id,
      personName: m.person_id ? (peopleById.get(m.person_id) ?? null) : null,
      snippet: m.content.slice(0, 140),
      importance: score,
      reasons,
      hits,
      lastHitAt: use?.last_hit_at ?? null,
      blobId: m.walrus_blob_id ?? null,
      endEpoch: blob?.endEpoch ?? null,
      daysToExpiry: days,
      onchain: !!blob,
      atRisk: days !== null && days <= AT_RISK_DAYS && score >= 0.3,
    };
  });

  const ranked = [...rows].sort((a, b) => b.importance - a.importance);
  const topRelied = ranked
    .filter((r) => r.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 3);
  const atRisk = rows
    .filter((r) => r.atRisk)
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 3);

  const verifiedBlobs = rows.filter((r) => r.onchain).length;
  const summary = buildSummary(rows, topRelied, atRisk, verifiedBlobs);

  return {
    epoch,
    rows: ranked,
    topRelied,
    atRisk,
    summary,
    verifiedBlobs,
    totalMemories: rows.length,
  };
}

function buildSummary(
  rows: MemoryHealthRow[],
  topRelied: MemoryHealthRow[],
  atRisk: MemoryHealthRow[],
  verifiedBlobs: number,
): string {
  if (rows.length === 0) {
    return "No memories yet — capture one and this panel starts learning what matters to you.";
  }
  const verified = `${verifiedBlobs}/${rows.length} verified onchain`;
  if (atRisk.length > 0) {
    const names = atRisk.map((r) => r.personName ?? "a note").join(", ");
    return `${atRisk.length} important memor${atRisk.length === 1 ? "y" : "ies"} expiring soon (${names}) — renew those first. ${verified}.`;
  }
  if (topRelied.length > 0) {
    const top = topRelied[0]!;
    const who = top.personName ?? "your most-used note";
    const days =
      top.daysToExpiry !== null
        ? ` Storage paid until epoch ${top.endEpoch}.`
        : "";
    return `You rely most on ${who} (${top.hits} recalls). ${verified}.${days}`;
  }
  return `Nothing recalled yet, so nothing has been judged important. ${verified}.`;
}
