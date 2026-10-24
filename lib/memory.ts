import {
  addCommitment,
  addFact,
  addMemory,
  audit,
  getPersonFacts as storeGetPersonFacts,
  getPerson as storeGetPerson,
  listPeople as storeListPeople,
  recentMemories as storeRecentMemories,
  searchMemories,
  setMemoryBlob,
  todayCommitments,
  updateCommitmentStatus as storeUpdateCommitmentStatus,
  upsertPerson,
} from "./store";
import { userNamespace, walrusAwaitBlob, walrusRecall, walrusRememberAsync } from "./memwal";
import { relianceBoost } from "./health";
import { memoryUsageMap, recordMemoryHit } from "./store";
import {
  CITATION_AUTO_ACCEPT,
  RELEVANCE_MIN_SCORE,
  findPersonSpans,
  isJudgeConfigured,
  resolvePersonName,
  scoreRelevance,
  verifyCitations,
} from "./judge";
import {
  extractMemory,
  rerankRecall,
  synthesizeRecall,
  ABSTAIN_TEXT,
} from "./ai";
import type {
  Commitment,
  Fact,
  Memory,
  Person,
  RecallAnswer,
  RecallCitation,
  TodayItem,
} from "./types";

/**
 * Memory domain service — the product logic that turns raw user text into
 * durable, queryable memory and answers questions from it.
 *
 * Durability lives in Walrus Memory (encrypted blobs on Walrus, semantic
 * search via the relayer, isolated per user with namespace
 * `recall-<userId>`). Structure lives in the local projection (lib/store.ts):
 * people, facts, commitments — the things the UI sorts, filters, and joins.
 *
 * Everything here is scoped by userId. Callers MUST pass the authenticated
 * user's id; there is no cross-user access path.
 */

const MAX_INPUT_CHARS = 4000;

export interface CaptureResult {
  memory: Memory;
  person: Person | null;
  factsAdded: number;
  commitmentsAdded: number;
  summary: string;
  /** Who resolved the person's identity: "jev" (calibrated) or "bedrock". */
  personSource: string;
  /** Jev's confidence in that identity, when it was used. */
  personConfidence: number | null;
  /** True when Jev asserted the memory is about nobody in particular. */
  personDeclined: boolean;
  /** Which model wrote the extraction ("bedrock · mistral.voxtral-mini-3b-2507"). */
  writtenBy: string;
  /**
   * Where the enriched record stands on Walrus.
   *  - "certified"   blob uploaded and certified on-chain
   *  - "pending"     accepted by the relayer, certification still in flight
   *  - "unavailable" the write did not land; the memory is still safe locally
   *                  and will be re-sent on the next capture
   * Never claim "certified" without a blob id — an honest status line is worth
   * more than a reassuring one.
   */
  walrusState: "certified" | "pending" | "unavailable";
  /** Number of remember attempts made (1 = accepted first time). */
  walrusAttempts: number;
}

/** Words that carry no evidence in a headline/company ("Founder @ Acme"). */
const GROUNDING_STOPWORDS = new Set([
  "at", "a", "an", "the", "and", "&", "ex", "of", "in", "on", "for", "with",
  "-", "–", "—", "|", "/", ",",
]);

/**
 * True when every significant token of `value` appears in the source text.
 *
 * The extraction model occasionally invents display titles ("Founder @ Loop"
 * for someone who "runs growth at Loop"). Anything not evidenced in the note
 * is dropped rather than displayed — a missing headline is honest, a wrong
 * one contradicts the user's own memory.
 */
export function isGroundedIn(value: string | null, text: string): boolean {
  if (!value) return false;
  const tokens = value
    .toLowerCase()
    .split(/[^a-zà-ÿ0-9]+/i)
    .filter(
      (t) =>
        !GROUNDING_STOPWORDS.has(t) &&
        // Keep numbers of any length: "8%" and "$40" are evidence too.
        (t.length > 2 || /^\d+$/.test(t)),
    );
  if (tokens.length === 0) return false;
  const hay = text.toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

/**
 * Display normalization for a grounded headline. The stricter prompt makes the
 * model quote the note verbatim ("runs growth @ Loop"), which reads badly
 * next to a name — uppercase the first letter ("Runs growth @ Loop").
 */
export function normalizeHeadline(headline: string | null): string | null {
  if (!headline) return null;
  return headline.replace(/[a-zà-ÿ]/i, (c) => c.toUpperCase());
}

/**
 * Ground an extraction against the note it came from. Returns headline and
 * company with ungrounded parts removed (null when nothing survives).
 */
export function groundProfile(
  extracted: { headline: string | null; company: string | null },
  text: string,
): { headline: string | null; company: string | null } {
  return {
    headline: isGroundedIn(extracted.headline, text) ? extracted.headline : null,
    company: isGroundedIn(extracted.company, text) ? extracted.company : null,
  };
}

/** The text actually persisted to Walrus: raw memory + its structured reading. */
function buildWalrusText(
  rawText: string,
  extracted: Awaited<ReturnType<typeof extractMemory>>,
): string {
  const lines: string[] = [];
  if (extracted.personName) {
    const who = [extracted.personName, extracted.headline ?? extracted.company]
      .filter(Boolean)
      .join(" — ");
    lines.push(`About: ${who} (${extracted.kind})`);
  } else {
    lines.push(`Note (${extracted.kind})`);
  }
  lines.push(rawText);
  if (extracted.facts.length > 0) {
    lines.push(
      `Facts: ${extracted.facts.map((f) => `${f.attribute}=${f.value}`).join("; ")}`,
    );
  }
  if (extracted.commitments.length > 0) {
    lines.push(
      `Follow-ups: ${extracted.commitments
        .map(
          (c) =>
            `${c.description}${c.dueInDays === null ? "" : ` (due in ~${c.dueInDays}d)`}`,
        )
        .join("; ")}`,
    );
  }
  return lines.join("\n");
}

/**
 * Capture a memory from raw user text:
 *  1. extract structured data (Bedrock prose)
 *  2. resolve the person (Jev verbatim selection, Bedrock fallback)
 *  3. submit the enriched memory to Walrus (accepted in ~500ms)
 *  4. store the projection rows (person link, facts, commitments)
 *  5. certify the blob — awaited inline by default; pass `defer` (e.g. Next's
 *     after()) to respond fast and backfill the blob id in the background.
 *
 * The raw memory is always saved locally even if Walrus is unreachable, so we
 * never lose what the user told us.
 */
export async function captureMemory(
  userId: string,
  rawText: string,
  opts?: { defer?: (task: Promise<void>) => void },
): Promise<CaptureResult> {
  const text = rawText.trim().slice(0, MAX_INPUT_CHARS);
  if (!text) throw new Error("Empty memory");

  // Generation and decision run CONCURRENTLY: Bedrock extracts structure while
  // Jev resolves identity from code-pre-parsed candidates. Jev's candidates are
  // the roster plus name-like spans — never dependent on Bedrock's output, so
  // there is no reason to serialize them.
  const spans = findPersonSpans(text);
  const roster = storeListPeople(userId).map((p) => p.name);
  const judgePromise = isJudgeConfigured()
    ? resolvePersonName(text, [...roster, ...spans])
    : Promise.resolve(null);

  const [extracted, picked] = await Promise.all([extractMemory(text), judgePromise]);

  // Person identity: Jev disposes it, Bedrock's proposal is the fallback.
  // Jev's answer is always a verbatim span from our own candidates, so it can
  // neither invent a name nor pick someone merely mentioned for an intro
  // (the "Ravi / David Okafor" class of mistake).
  let resolvedName = extracted.personName;
  let personSource = "bedrock";
  if (picked?.name) {
    resolvedName = picked.name;
    personSource = "jev";
  } else if (picked && picked.confidence >= 0.7) {
    resolvedName = null;
    personSource = "jev";
  }
  extracted.personName = resolvedName;

  // Ground the display profile in the note it came from. The extraction model
  // sometimes invents titles ("Founder @ Loop" for someone who "runs growth
  // at Loop"); anything not evidenced is dropped rather than displayed.
  const grounded = groundProfile(extracted, text);
  extracted.headline = normalizeHeadline(grounded.headline);
  extracted.company = grounded.company;

  let person: Person | null = null;
  if (resolvedName) {
    // Grounded values are fresh evidence, so they replace stale ones; nulls
    // never wipe what an earlier capture established.
    person = upsertPerson(
      userId,
      {
        name: resolvedName,
        headline: grounded.headline,
        company: grounded.company,
        location: extracted.location,
      },
      { overwriteProfile: true },
    ).person;
  }

  // 2. Submit to Walrus (fast accept), then store the raw memory immediately
  // so the user never waits on certification.
  const { jobId, attempts: walrusAttempts } = await walrusRememberAsync(
    userId,
    buildWalrusText(text, extracted),
  );

  // 3. Store the raw memory (source of truth for the UI).
  const memory = addMemory({
    userId,
    personId: person?.id ?? null,
    kind: extracted.kind,
    content: text,
    blobId: null,
  });

  // Backfill the blob id once certified. Inline by default (scripts); in a
  // request handler pass defer: after() so capture responds in seconds.
  const backfill: Promise<void> = (async () => {
    if (!jobId) return;
    try {
      const { blobId } = await walrusAwaitBlob(jobId);
      if (blobId) {
        setMemoryBlob(memory.id, blobId);
        // Also reflect it on the object we returned. Without this, any caller
        // holding the CaptureResult sees walrus_blob_id === null forever — it
        // reads a different snapshot than the one the backfill updated.
        memory.walrus_blob_id = blobId;
        audit(userId, "capture_certified", { memoryId: memory.id, walrusBlobId: blobId });
      }
    } catch {
      // Best effort: the blob still exists on Walrus under the namespace.
    }
  })();
  // Keep the non-deferred path behavior: scripts await certification.
  if (opts?.defer) opts.defer(backfill);
  else await backfill;

  // 4. Store derived facts (each cites this memory). Notes without a person
  //    still get structured facts — "passport expires in March" is useful
  //    whether or not a person is involved. Values must be grounded in the
  //    note: a fact the user never wrote is worse than a missing fact.
  let factsAdded = 0;
  for (const f of extracted.facts) {
    if (!isGroundedIn(f.value, text)) {
      audit(userId, "fact_dropped_ungrounded", {
        memoryId: memory.id,
        attribute: f.attribute,
        value: f.value.slice(0, 80),
      });
      continue;
    }
    addFact({
      userId,
      personId: person?.id ?? null,
      attribute: f.attribute,
      value: f.value,
      sourceMemoryId: memory.id,
    });
    factsAdded++;
  }

  // 5. Store commitments / follow-ups (drive the Today feed).
  let commitmentsAdded = 0;
  for (const c of extracted.commitments) {
    const dueAt =
      c.dueInDays === null
        ? null
        : new Date(Date.now() + c.dueInDays * 86400_000).toISOString();
    addCommitment({
      userId,
      personId: person?.id ?? null,
      description: c.description,
      dueAt,
      sourceMemoryId: memory.id,
    });
    commitmentsAdded++;
  }

  audit(userId, "capture_memory", {
    memoryId: memory.id,
    personId: person?.id ?? null,
    factsAdded,
    commitmentsAdded,
    walrusJobId: jobId,
    walrusNamespace: userNamespace(userId),
    personSource,
  });

  const summary = buildCaptureSummary(person, factsAdded, commitmentsAdded);
  return {
    memory,
    person,
    factsAdded,
    commitmentsAdded,
    summary,
    personSource,
    personConfidence: picked?.confidence ?? null,
    personDeclined: person === null,
    writtenBy: extracted.writtenBy ?? "local rules",
    walrusState: memory.walrus_blob_id
      ? "certified"
      : jobId
        ? "pending"
        : "unavailable",
    walrusAttempts,
  };
}

function buildCaptureSummary(
  person: Person | null,
  facts: number,
  commitments: number,
): string {
  const who = person ? person.name : "this";
  const bits: string[] = [`Got it — saved to your memory of ${who}.`];
  if (facts > 0) bits.push(`${facts} detail${facts > 1 ? "s" : ""} remembered.`);
  if (commitments > 0)
    bits.push(
      `${commitments} follow-up${commitments > 1 ? "s" : ""} added to Today.`,
    );
  return bits.join(" ");
}

/**
 * Dejavu: Walrus semantic shortlist → Jev calibrated ranking → Bedrock
 * synthesis → Jev citation verification.
 *
 * Fast search (Walrus) finds candidates; a Noul per pair ranks them with
 * calibrated probabilities; low-relevance pools abstain WITHOUT spending a
 * synthesis call; every shown citation carries a machine-checked verdict.
 * When Jev is unconfigured, the legacy Bedrock-rerank path applies.
 */
export async function recall(
  userId: string,
  question: string,
  limit = 6,
): Promise<RecallAnswer> {
  const q = question.trim().slice(0, MAX_INPUT_CHARS);
  if (!q) return { answer: "Ask me anything about the people you've met.", citations: [] };

  interface Cand {
    id: string;
    personId: string | null;
    personName: string | null;
    content: string;
    occurredAt: string;
    baseScore: number;
    /** False for Walrus hits with no local projection row (orphans). */
    matched?: boolean;
  }

  // 1. Candidate pool: Walrus semantic shortlist, else local recency pool.
  let pool: Cand[] = [];
  let fromWalrus = false;
  const hits = await walrusRecall(userId, q, limit);
  if (hits.length > 0) {
    fromWalrus = true;
    const byBlob = new Map(
      storeRecentMemories(userId, 500)
        .filter((m) => m.walrus_blob_id)
        .map((m) => [m.walrus_blob_id as string, m]),
    );
    const peopleById = new Map(storeListPeople(userId).map((p) => [p.id, p.name]));
    pool = hits.slice(0, limit).map((h) => {
      const local = h.blobId ? byBlob.get(h.blobId) : undefined;
      const personId = local?.person_id ?? null;
      const content = local?.content ?? h.text;
      return {
        id: local?.id ?? h.blobId ?? h.text.slice(0, 32),
        personId,
        personName: personId ? (peopleById.get(personId) ?? null) : null,
        content,
        occurredAt: local?.occurred_at ?? new Date().toISOString(),
        baseScore: Number((1 / (1 + h.distance)).toFixed(3)),
        matched: !!local,
      };
    });
    // Hygiene: blobs with no local projection row are orphans (e.g. a write
    // interrupted before bookkeeping). Drop them when matched memories exist
    // so they can't displace real citations; keep them only as a last resort
    // (empty projection after a redeploy — Walrus still remembers).
    const matched = pool.filter((p) => p.matched);
    if (matched.length > 0) pool = matched;
  } else {
    const recent = storeRecentMemories(userId, 12);
    if (recent.length === 0) {
      return { answer: ABSTAIN_TEXT, citations: [] };
    }
    pool = recent.map((r) => ({
      id: r.id,
      personId: r.person_id,
      personName: r.person_name,
      content: r.content,
      occurredAt: r.occurred_at,
      baseScore: 0,
    }));
  }

  // 2. Rank with calibrated judgments when available.
  // Counting/listing questions need breadth, not just the top hit: keep the
  // whole shortlist (ordered) so "how many founders" can count everyone.
  const isAggregate = /\bhow many\b|\blist all\b|\bwho all\b|\bcount\b/i.test(q);
  let ranked = pool;
  let judged = false;
  if (isJudgeConfigured()) {
    const scored = await scoreRelevance(
      q,
      pool.map((p) => ({
        id: p.id,
        text: `${p.personName ?? "unknown person"}: ${p.content}`,
      })),
    );
    if (scored) {
      judged = true;
      const byScore = new Map(scored.map((s) => [s.id, s.score]));
      // The learning loop: memories you have actually relied on get a small
      // tie-break boost. Relevance still decides what is shown — reliance can
      // only reorder equally relevant memories, never surface an irrelevant one.
      const usage = memoryUsageMap(userId);
      const ordered = pool
        .map((p) => ({
          ...p,
          judgeScore: Math.min(
            1,
            (byScore.get(p.id) ?? 0) + relianceBoost(usage.get(p.id)?.hits ?? 0),
          ),
        }))
        .sort((a, b) => b.judgeScore - a.judgeScore);
      ranked = (isAggregate ? ordered : ordered.filter((p) => p.judgeScore >= RELEVANCE_MIN_SCORE)).slice(
        0,
        limit,
      );
      if (ranked.length === 0) {
        // Calibrated abstention: nothing relevant — skip synthesis entirely.
        audit(userId, "recall_abstain", {
          reason: "no_candidate_above_threshold",
          threshold: RELEVANCE_MIN_SCORE,
          candidates: pool.length,
          topScore: scored[0]?.score ?? null,
        });
        return { answer: ABSTAIN_TEXT, citations: [] };
      }
    }
  }
  if (!judged && !fromWalrus) {
    // Legacy path: Bedrock generative rerank over the local pool.
    const topIds = await rerankRecall(
      q,
      pool.map((r) => ({ id: r.id, content: r.content })),
    );
    const byId = new Map(pool.map((r) => [r.id, r]));
    const reranked = topIds
      .map((id) => byId.get(id))
      .filter((r): r is Cand => r != null);
    ranked = (reranked.length > 0 ? reranked : searchMemories(userId, q, limit).map((r) => ({
      id: r.id,
      personId: r.person_id,
      personName: r.person_name,
      content: r.content,
      occurredAt: r.occurred_at,
      baseScore: 0,
    }))).slice(0, limit);
    if (ranked.length === 0) ranked = pool.slice(0, limit);
  } else {
    ranked = ranked.slice(0, limit);
  }

  // 3. Synthesize from ranked context (generation only — decisions are made).
  const { text: answer, writtenBy } = await synthesizeRecall(
    q,
    ranked.map((r) => ({
      id: r.id,
      personName: r.personName,
      content: r.content,
      occurredAt: r.occurredAt,
    })),
  );

  // Contradiction guard: the UI must never show sources next to "don't know".
  // Small models sometimes abstain out of caution despite relevant citations
  // (notably counting and yes/no questions). In that case answer extractively
  // from the citations instead of contradicting them.
  let finalAnswer = answer;
  if (answer.trim().startsWith(ABSTAIN_TEXT) && ranked.length > 0) {
    audit(userId, "recall_extractive_fallback", {
      candidates: ranked.length,
      question: q.slice(0, 120),
    });
    finalAnswer = buildExtractiveAnswer(
      ranked.map((r) => ({ personName: r.personName, content: r.content })),
    );
  }

  // 4. Verify every citation against its source memory (batched, one call).
  //    Verified citations are the ones the user actually saw — record the hit
  //    so the learning loop learns which memories earn their storage.
  let citations: RecallCitation[] = ranked.map((r, i) => ({
    memoryId: r.id,
    personId: r.personId,
    personName: r.personName,
    snippet: r.content.slice(0, 240),
    occurredAt: r.occurredAt,
    score:
      "judgeScore" in r && typeof (r as { judgeScore?: number }).judgeScore === "number"
        ? Number(((r as { judgeScore: number }).judgeScore).toFixed(3))
        : (r.baseScore || Number((1 / (1 + i * 0.25)).toFixed(3))),
    verified: null,
    checkConfidence: null,
  }));
  if (isJudgeConfigured() && !finalAnswer.trim().startsWith(ABSTAIN_TEXT)) {
    const verdicts = await verifyCitations(
      ranked.map((r) => ({ id: r.id, claim: finalAnswer, source: r.content })),
    );
    if (verdicts) {
      citations = citations
        .map((c) => {
          const v = verdicts[c.memoryId];
          // "verified" is an auto-accept claim: verdict + confidence above
          // threshold. Anything weaker shows without the badge.
          const verified: RecallCitation["verified"] =
            v?.verdict === "verified" && (v?.confidence ?? 0) >= CITATION_AUTO_ACCEPT
              ? "verified"
              : v?.verdict === "contradicted"
                ? "contradicted"
                : "unsupported";
          return {
            ...c,
            verified,
            checkConfidence: v?.confidence ?? 0,
          };
        })
        // A contradicted citation means synthesis drifted — never show it.
        .filter((c) => c.verified !== "contradicted");
      if (citations.length === 0) {
        audit(userId, "recall_abstain", { reason: "all_citations_contradicted" });
        return { answer: ABSTAIN_TEXT, citations: [] };
      }
    }
  }

  // Learning loop: the memories the user actually saw are the ones that
  // earned a hit. This is the signal the Memory Health panel acts on.
  for (const c of citations) {
    if (c.verified === "verified" || c.verified === null) {
      recordMemoryHit(c.memoryId);
    }
  }

  return { answer: finalAnswer, citations, writtenBy };
}

/**
 * Extractive fallback: state what the cited memories say, in plain words.
 * Exported for tests. Used only when synthesis abstained despite relevant
 * citations, so the UI can never show sources next to "I don't know".
 * Grounded by construction — every sentence comes from a shown citation.
 */
export function buildExtractiveAnswer(
  ranked: { personName: string | null; content: string }[],
): string {
  const parts = ranked.slice(0, 3).map((r) => {
    const who = r.personName ?? "A note";
    const what = r.content.trim().replace(/\s+/g, " ").slice(0, 220);
    return `${who}: ${what}`;
  });
  const n = ranked.length;
  return `Based on ${n} memor${n === 1 ? "y" : "ies"}: ${parts.join(" ")}`.slice(0, 700);
}

// --- People & profiles -----------------------------------------------------

export async function listPeople(userId: string): Promise<Person[]> {
  return storeListPeople(userId);
}

export async function getPerson(
  userId: string,
  personId: string,
): Promise<Person | null> {
  return storeGetPerson(userId, personId);
}

export async function getPersonFacts(
  userId: string,
  personId: string,
): Promise<Fact[]> {
  return storeGetPersonFacts(userId, personId);
}

export async function getPersonMemories(
  userId: string,
  personId: string,
): Promise<Memory[]> {
  return storeRecentMemories(userId, 500).filter((m) => m.person_id === personId);
}

// --- Today feed & commitments ---------------------------------------------

/**
 * Build the "Today" feed: open commitments that are due/overdue.
 * Ordered by urgency.
 */
export async function getTodayFeed(userId: string): Promise<TodayItem[]> {
  const due = todayCommitments(userId);
  const peopleById = new Map(storeListPeople(userId).map((p) => [p.id, p.name]));
  return due.map((c: Commitment) => {
    const personName = c.person_id ? (peopleById.get(c.person_id) ?? null) : null;
    const overdue = c.due_at ? new Date(c.due_at).getTime() < Date.now() : false;
    return {
      commitment: c,
      personName,
      reason: overdue ? "overdue" : "due",
      draftMessage: buildDraft(personName, c.description),
    } as TodayItem;
  });
}

function buildDraft(personName: string | null, description: string): string {
  const hi = personName ? `Hi ${personName},` : "Hi,";
  return `${hi} following up on ${description}. Would love to reconnect — do you have time this week?`;
}

export async function updateCommitmentStatus(
  userId: string,
  commitmentId: string,
  status: "done" | "snoozed" | "dismissed",
): Promise<void> {
  storeUpdateCommitmentStatus(userId, commitmentId, status);
  audit(userId, "commitment_status", { commitmentId, status });
}

export async function recentMemories(
  userId: string,
  limit = 20,
): Promise<(Memory & { person_name: string | null })[]> {
  return storeRecentMemories(userId, limit);
}

/** Record a late-arriving Walrus blob id on a memory saved while offline. */
export async function attachBlobId(memoryId: string, blobId: string): Promise<void> {
  setMemoryBlob(memoryId, blobId);
}
