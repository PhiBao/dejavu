import {
  addBrief,
  addCommitment,
  addFact,
  addMemory,
  addMemoryFeedback,
  audit,
  correctFactValue,
  factKey,
  findDuplicatePeople as storeFindDuplicatePeople,
  forgetFact as storeForgetFact,
  forgetMemory as storeForgetMemory,
  getCurrentFacts,
  getFact as storeGetFact,
  getLatestBrief,
  getMemory as storeGetMemory,
  getPersonFacts as storeGetPersonFacts,
  getPerson as storeGetPerson,
  listPeople as storeListPeople,
  loadStore,
  mergePeople as storeMergePeople,
  recentMemories as storeRecentMemories,
  searchMemories,
  setBriefBlob,
  setMemoryBlob,
  setMemoryPerson,
  supersedeMemory as storeSupersedeMemory,
  todayCommitments,
  updateCommitmentStatus as storeUpdateCommitmentStatus,
  upsertPerson,
} from "./store";
import {
  userNamespace,
  walrusAwaitBlob,
  walrusRecall,
  walrusRememberAsync,
  walrusRestore,
} from "./memwal";
import { feedbackBoost, relianceBoost } from "./health";
import { feedbackMap, memoryUsageMap, recordMemoryHit } from "./store";
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
  buildPersonBrief,
  extractMemory,
  rerankRecall,
  synthesizePersonBrief,
  synthesizeRecall,
  ABSTAIN_TEXT,
} from "./ai";
import { dateAtNoon, expiryFactFromText } from "./dates";
import type { DuplicateCandidate } from "./store";
import type {
  Brief,
  Commitment,
  Fact,
  FeedbackVerdict,
  Memory,
  MemoryKind,
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
  if (extracted.occurredAt) {
    lines.push(`When: ${extracted.occurredAt}`);
  }
  if (extracted.facts.length > 0) {
    lines.push(
      `Facts: ${extracted.facts
        .map(
          (f) =>
            `${f.attribute}=${f.value}${f.date ? ` [${f.date}]` : ""}`,
        )
        .join("; ")}`,
    );
  }
  if (extracted.commitments.length > 0) {
    lines.push(
      `Follow-ups: ${extracted.commitments
        .map(
          (c) =>
            `${c.description}${
              c.dueDate
                ? ` (due ${c.dueDate})`
                : c.dueInDays === null
                  ? ""
                  : ` (due in ~${c.dueInDays}d)`
            }`,
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
  opts?: {
    defer?: (task: Promise<void>) => void;
    /** When this capture is a correction, the memory version it replaces. */
    correctsMemoryId?: string;
  },
): Promise<CaptureResult> {
  const text = rawText.trim().slice(0, MAX_INPUT_CHARS);
  if (!text) throw new Error("Empty memory");

  const previous = opts?.correctsMemoryId
    ? storeGetMemory(userId, opts.correctsMemoryId)
    : null;

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
  // A correction inherits the person from the version it replaces when the
  // corrected text doesn't restate the name. Otherwise "she moved to Linear"
  // would detach the correction from Sarah entirely.
  if (!resolvedName && previous?.person_id) {
    const inherited = storeGetPerson(userId, previous.person_id);
    if (inherited) {
      resolvedName = inherited.name;
      personSource = "correction";
    }
  }
  extracted.personName = resolvedName;

  // Ground the display profile in the note it came from. The extraction model
  // sometimes invents titles ("Founder @ Loop" for someone who "runs growth
  // at Loop"); anything not evidenced is dropped rather than displayed.
  const grounded = groundProfile(extracted, text);
  extracted.headline = normalizeHeadline(grounded.headline);
  extracted.company = grounded.company;

  // The profile is a fact too. Add grounded company/location to the structured
  // facts so an employer change supersedes the old value even when the prose
  // model omitted it from its fact list.
  for (const [attribute, value] of [
    ["company", grounded.company],
    ["location", extracted.location],
  ] as const) {
    if (!value) continue;
    if (
      extracted.facts.some(
        (f) => factKey(f.attribute) === attribute && isGroundedIn(f.value, text),
      )
    ) {
      continue;
    }
    extracted.facts.push({ attribute, value, date: null });
  }

  // Expiry facts are too important to leave to the model: "my passport
  // expires in 7 weeks" must become a dated belief even if extraction drops it.
  const deterministicExpiry = expiryFactFromText(text);
  if (
    deterministicExpiry &&
    !extracted.facts.some((f) => {
      const key = factKey(f.attribute);
      return (
        (key === deterministicExpiry.attribute || key.includes("expir")) &&
        isGroundedIn(f.value, text)
      );
    })
  ) {
    extracted.facts.push(deterministicExpiry);
  }

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
    occurredAt: extracted.occurredAt ? dateAtNoon(extracted.occurredAt) : null,
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
      absoluteDate: f.date,
    });
    factsAdded++;
  }

  // 5. Store commitments / follow-ups (drive the Today feed). Absolute dates
  //    win over relative day counts: "by Friday" is a calendar fact, not a
  //    number that drifts every time the note is read.
  let commitmentsAdded = 0;
  for (const c of extracted.commitments) {
    const dueAt = c.dueDate
      ? dateAtNoon(c.dueDate)
      : c.dueInDays === null
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

  // A correction retires the version it replaces only after the new version
  // is safely stored. Its facts and open follow-ups are retired with it.
  if (previous && previous.status === "active") {
    storeSupersedeMemory(userId, previous.id, memory.id);
  }
  if (previous?.person_id && !memory.person_id) {
    setMemoryPerson(userId, memory.id, previous.person_id);
    memory.person_id = previous.person_id;
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

// --- Correction, forgetting, and merge --------------------------------------

/**
 * Replace a memory with a corrected version. The old version is kept as
 * history (never recalled), and the new version goes through the same
 * extraction → facts → Walrus pipeline as any other capture.
 */
export async function correctMemory(
  userId: string,
  memoryId: string,
  rawText: string,
): Promise<CaptureResult | null> {
  const old = storeGetMemory(userId, memoryId);
  if (!old || old.status !== "active") return null;
  const result = await captureMemory(userId, rawText, {
    correctsMemoryId: memoryId,
  });
  await writeLifecycleManifest(userId);
  audit(userId, "correct_memory", {
    oldMemoryId: memoryId,
    newMemoryId: result.memory.id,
    personId: result.person?.id ?? null,
  });
  return result;
}

/** Forget a memory: tombstone it and stop every derived belief from surfacing. */
export async function forgetMemory(
  userId: string,
  memoryId: string,
): Promise<boolean> {
  const res = storeForgetMemory(userId, memoryId);
  if (!res.found) return false;
  await writeLifecycleManifest(userId);
  audit(userId, "forget_memory", { memoryId, walrusBlobId: res.blobId });
  return true;
}

/**
 * Correct one fact without re-capturing the whole note. A short correction
 * memory is written to Walrus so the new belief has a citable, durable source
 * — corrections are part of memory, not an overlay that vanishes on rebuild.
 */
export async function correctFact(
  userId: string,
  factId: string,
  value: string,
): Promise<{ fact: Fact; memory: Memory } | null> {
  const old = storeGetFact(userId, factId);
  if (!old || old.status !== "current") return null;
  const trimmed = value.trim().slice(0, 500);
  if (!trimmed) return null;

  const person = old.person_id ? storeGetPerson(userId, old.person_id) : null;
  const subject = person ? person.name : "your note";
  const content = `Correction — ${subject}: ${old.attribute.replace(/_/g, " ")} is now ${trimmed}.`;

  const { jobId } = await walrusRememberAsync(userId, content);
  const memory = addMemory({
    userId,
    personId: old.person_id,
    kind: "note",
    content,
    blobId: null,
  });
  if (jobId) {
    try {
      const { blobId } = await walrusAwaitBlob(jobId);
      if (blobId) {
        setMemoryBlob(memory.id, blobId);
        memory.walrus_blob_id = blobId;
      }
    } catch {
      // The correction is still safe locally; certification retries later.
    }
  }

  const fact = correctFactValue({
    userId,
    factId,
    value: trimmed,
    sourceMemoryId: memory.id,
  });
  if (!fact) return null;

  // Keep the profile in sync when a profile-shaped fact is corrected.
  if (person && ["company", "location", "role", "headline"].includes(old.key)) {
    upsertPerson(
      userId,
      {
        name: person.name,
        headline:
          old.key === "role" || old.key === "headline"
            ? trimmed
            : person.headline,
        company: old.key === "company" ? trimmed : person.company,
        location: old.key === "location" ? trimmed : person.location,
      },
      { overwriteProfile: true },
    );
  }

  audit(userId, "correct_fact", {
    factId,
    newFactId: fact.id,
    memoryId: memory.id,
    personId: old.person_id,
  });
  return { fact, memory };
}

export async function forgetFact(userId: string, factId: string): Promise<boolean> {
  const ok = storeForgetFact(userId, factId);
  if (ok) audit(userId, "forget_fact", { factId });
  return ok;
}

/** Merge a duplicate person into the surviving profile. */
export async function mergePeople(
  userId: string,
  primaryId: string,
  duplicateId: string,
): Promise<Person | null> {
  const person = storeMergePeople(userId, primaryId, duplicateId);
  if (person) {
    audit(userId, "merge_people", { primaryId, duplicateId });
  }
  return person;
}

export function suggestDuplicatePeople(
  userId: string,
  personId: string,
): DuplicateCandidate[] {
  return storeFindDuplicatePeople(userId, personId);
}

// --- Rebuild from Walrus ----------------------------------------------------

export interface ParsedEnrichedBlob {
  personName: string | null;
  headline: string | null;
  company: string | null;
  location: string | null;
  kind: MemoryKind;
  content: string;
  occurredAt: string | null;
  facts: { attribute: string; value: string; date: string | null }[];
  commitments: { description: string; dueDate: string | null }[];
}

const BLOB_KINDS = new Set<MemoryKind>(["note", "meeting", "message", "call"]);

/**
 * Parse the enriched text Dejavu writes to Walrus. This is the inverse of
 * buildWalrusText, used when the local projection is gone.
 */
export function parseEnrichedBlob(text: string): ParsedEnrichedBlob | null {
  const lines = text.split("\n");
  const header = lines[0] ?? "";
  if (!header.startsWith("About: ") && !header.startsWith("Note (")) {
    return null;
  }

  const kindMatch = header.match(/\((note|meeting|message|call)\)\s*$/);
  const kind: MemoryKind =
    kindMatch && BLOB_KINDS.has(kindMatch[1] as MemoryKind)
      ? (kindMatch[1] as MemoryKind)
      : "note";

  let personName: string | null = null;
  let headline: string | null = null;
  if (header.startsWith("About: ")) {
    const rest = header.slice(7).replace(/\s*\((?:note|meeting|message|call)\)\s*$/, "");
    const dash = rest.lastIndexOf(" — ");
    if (dash >= 0) {
      personName = rest.slice(0, dash).trim() || null;
      headline = rest.slice(dash + 3).trim() || null;
    } else {
      personName = rest.trim() || null;
    }
  }

  let company: string | null = null;
  let location: string | null = null;
  let occurredAt: string | null = null;
  const contentLines: string[] = [];
  const facts: ParsedEnrichedBlob["facts"] = [];
  const commitments: ParsedEnrichedBlob["commitments"] = [];

  for (const line of lines.slice(1)) {
    if (line.startsWith("When: ")) {
      const date = line.slice(6).trim();
      occurredAt = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
      continue;
    }
    if (line.startsWith("Facts: ")) {
      for (const part of line.slice(7).split(";")) {
        const piece = part.trim();
        const eq = piece.indexOf("=");
        if (eq <= 0) continue;
        let value = piece.slice(eq + 1).trim();
        let date: string | null = null;
        const dateMatch = value.match(/\s+\[(\d{4}-\d{2}-\d{2})\]$/);
        if (dateMatch) {
          date = dateMatch[1]!;
          value = value.slice(0, dateMatch.index).trim();
        }
        const attribute = piece.slice(0, eq).trim();
        if (!attribute || !value) continue;
        if (factKey(attribute) === "company") company = value;
        if (factKey(attribute) === "location") location = value;
        facts.push({ attribute, value, date });
      }
      continue;
    }
    if (line.startsWith("Follow-ups: ")) {
      for (const part of line.slice(12).split(";")) {
        let description = part.trim();
        if (!description) continue;
        let dueDate: string | null = null;
        const due = description.match(/\s+\(due (\d{4}-\d{2}-\d{2})\)$/);
        if (due) {
          dueDate = due[1]!;
          description = description.slice(0, due.index).trim();
        } else {
          description = description.replace(/\s+\(due in ~\d+d\)$/i, "").trim();
        }
        if (description) commitments.push({ description, dueDate });
      }
      continue;
    }
    contentLines.push(line);
  }

  const content = contentLines.join("\n").trim();
  if (!content) return null;
  return {
    personName,
    headline,
    company,
    location,
    kind,
    content,
    occurredAt,
    facts,
    commitments,
  };
}

export interface RebuildResult {
  memories: number;
  people: number;
  facts: number;
  commitments: number;
  skipped: number;
  scanned: number;
}

function parseManifest(text: string): {
  forgotten: string[];
  superseded: string[];
} | null {
  if (!text.startsWith("Dejavu lifecycle manifest")) return null;
  const forgotten: string[] = [];
  const superseded: string[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("forgotten: ")) {
      forgotten.push(
        ...line
          .slice(11)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
    }
    if (line.startsWith("superseded: ")) {
      for (const entry of line.slice(12).split(",")) {
        const old = entry.split("->")[0]?.trim();
        if (old) superseded.push(old);
      }
    }
  }
  return { forgotten, superseded };
}

/**
 * Rebuild the structured workspace from the enriched blobs on Walrus.
 *
 * The relayer's semantic index is restored first, then several broad queries
 * are used to enumerate the namespace. Lifecycle manifests (written on forget,
 * correction, and negative feedback) keep tombstoned versions from coming back.
 */
export async function rebuildWorkspaceFromWalrus(
  userId: string,
): Promise<RebuildResult> {
  await walrusRestore(userId, 100);

  const queries = [
    "person meeting call message note",
    "deadline expiry passport renewal trip",
    "promise follow up intro send",
    "Dejavu lifecycle manifest",
    "Dejavu lifecycle manifest forgotten superseded",
  ];
  const hits = new Map<string, { text: string; blobId: string | null }>();
  for (const q of queries) {
    const found = await walrusRecall(userId, q, 100);
    for (const hit of found) {
      const key = hit.blobId ?? hit.text.slice(0, 120);
      if (!hits.has(key)) hits.set(key, hit);
    }
  }

  const forgotten = new Set<string>();
  const superseded = new Set<string>();
  for (const hit of hits.values()) {
    const manifest = parseManifest(hit.text);
    if (!manifest) continue;
    for (const id of manifest.forgotten) forgotten.add(id);
    for (const id of manifest.superseded) superseded.add(id);
  }

  const existing = storeRecentMemories(userId, 2000, { includeForgotten: true });
  const knownBlobs = new Set(
    existing.filter((m) => m.walrus_blob_id).map((m) => m.walrus_blob_id as string),
  );
  const knownContent = new Set(existing.map((m) => m.content));

  let memories = 0;
  let people = 0;
  let facts = 0;
  let commitments = 0;
  let skipped = 0;

  for (const hit of hits.values()) {
    if (parseManifest(hit.text)) {
      skipped++;
      continue;
    }
    if (hit.text.startsWith("Canonical brief — ")) {
      skipped++;
      continue;
    }
    if (hit.blobId && (forgotten.has(hit.blobId) || superseded.has(hit.blobId))) {
      skipped++;
      continue;
    }
    if (hit.blobId && knownBlobs.has(hit.blobId)) {
      skipped++;
      continue;
    }
    const parsed = parseEnrichedBlob(hit.text);
    if (!parsed || knownContent.has(parsed.content)) {
      skipped++;
      continue;
    }

    let person: Person | null = null;
    if (parsed.personName) {
      const upserted = upsertPerson(
        userId,
        {
          name: parsed.personName,
          headline: parsed.headline,
          company: parsed.company,
          location: parsed.location,
        },
        { overwriteProfile: false },
      );
      person = upserted.person;
      if (upserted.created) people++;
    }
    const memory = addMemory({
      userId,
      personId: person?.id ?? null,
      kind: parsed.kind,
      content: parsed.content,
      blobId: hit.blobId,
      occurredAt: parsed.occurredAt ? dateAtNoon(parsed.occurredAt) : null,
    });
    memories++;
    for (const f of parsed.facts) {
      addFact({
        userId,
        personId: person?.id ?? null,
        attribute: f.attribute,
        value: f.value,
        sourceMemoryId: memory.id,
        absoluteDate: f.date,
      });
      facts++;
    }
    for (const c of parsed.commitments) {
      addCommitment({
        userId,
        personId: person?.id ?? null,
        description: c.description,
        dueAt: c.dueDate ? dateAtNoon(c.dueDate) : null,
        sourceMemoryId: memory.id,
      });
      commitments++;
    }
    knownBlobs.add(hit.blobId ?? memory.id);
    knownContent.add(parsed.content);
  }

  audit(userId, "rebuild_from_walrus", {
    scanned: hits.size,
    memories,
    people,
    facts,
    commitments,
    skipped,
  });
  return {
    memories,
    people,
    facts,
    commitments,
    skipped,
    scanned: hits.size,
  };
}

/**
 * Write the current tombstone state as a small manifest blob. Without this,
 * a rebuild from Walrus would resurrect memories the user forgot or retired.
 */
async function writeLifecycleManifest(userId: string): Promise<void> {
  const store = loadStore();
  const mine = store.memories.filter(
    (m) => m.user_id === userId && m.walrus_blob_id,
  );
  const forgotten = mine
    .filter((m) => m.status === "forgotten")
    .map((m) => m.walrus_blob_id as string);
  const superseded = mine
    .filter((m) => m.status === "superseded")
    .map((m) => {
      const replacement = m.superseded_by
        ? store.memories.find((x) => x.id === m.superseded_by)
        : null;
      return `${m.walrus_blob_id}->${replacement?.walrus_blob_id ?? "retired"}`;
    });
  if (forgotten.length === 0 && superseded.length === 0) return;
  const text = `Dejavu lifecycle manifest
updated: ${new Date().toISOString()}
forgotten: ${forgotten.join(", ")}
superseded: ${superseded.join(", ")}`;
  try {
    const { jobId } = await walrusRememberAsync(userId, text);
    // Wait for certification: a tombstone that only exists as an accepted job
    // would be lost if the local projection disappeared immediately after.
    if (jobId) await walrusAwaitBlob(jobId);
  } catch {
    // Best effort: the projection still has the tombstone.
  }
}

/**
 * Explicit feedback on a cited memory.
 *
 *  - useful   boosts its importance and ranking immediately
 *  - wrong    retires it from future answers (the source was incorrect)
 *  - outdated retires it from future answers (the world moved on)
 *
 * Retirement is a tombstone in the projection, not a delete: the blob stays
 * onchain, but Dejavu stops citing it and its facts stop being current.
 */
export async function recordMemoryFeedback(
  userId: string,
  memoryId: string,
  verdict: FeedbackVerdict,
  question?: string | null,
): Promise<boolean> {
  const memory = storeGetMemory(userId, memoryId);
  if (!memory || memory.status !== "active") return false;
  addMemoryFeedback({
    userId,
    memoryId,
    question: question?.trim().slice(0, 500) || null,
    verdict,
  });
  if (verdict === "useful") {
    audit(userId, "feedback_useful", { memoryId, question: question ?? null });
    return true;
  }
  storeSupersedeMemory(userId, memoryId, null);
  await writeLifecycleManifest(userId);
  audit(userId, `feedback_${verdict}`, {
    memoryId,
    question: question ?? null,
  });
  return true;
}

/**
 * Grounding guard for generated briefs. Proper nouns and numbers in the brief
 * must appear somewhere in the source facts/memories; otherwise the model is
 * embellishing ("based in San Francisco" from "SF AI meetup"). The deterministic
 * brief is used instead.
 */
export function briefIsGrounded(
  text: string,
  input: {
    personName: string;
    headline: string | null;
    company: string | null;
    location: string | null;
    facts: { attribute: string; value: string; absoluteDate: string | null }[];
    memories: { content: string; occurredAt: string }[];
    commitments: { description: string; dueAt: string | null }[];
  },
): boolean {
  const hay = [
    input.personName,
    input.headline,
    input.company,
    input.location,
    ...input.facts.map((f) => `${f.attribute} ${f.value}`),
    ...input.memories.map((m) => m.content),
    ...input.commitments.map((c) => c.description),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const stop = new Set([
    "the", "she", "he", "they", "his", "her", "their", "this", "that",
    "and", "but", "in", "at", "on", "for", "with", "current", "open",
    "most", "recent", "canonical", "brief", "based", "works", "work",
    "founder", "role", "details", "follow", "ups", "note", "memory",
  ]);
  const proper = text.match(/\b[A-ZÀ-Ý][a-zà-ÿ]{2,}\b/g) ?? [];
  for (const token of proper) {
    const lower = token.toLowerCase();
    if (stop.has(lower)) continue;
    if (!hay.includes(lower)) return false;
  }
  return true;
}

/**
 * Consolidate everything known about a person into one canonical brief and
 * write that brief back to Walrus as its own blob. The raw memories stay the
 * source of truth; the brief is the durable, distilled view.
 */
export async function consolidatePerson(
  userId: string,
  personId: string,
): Promise<Brief | null> {
  const person = storeGetPerson(userId, personId);
  if (!person) return null;
  const allMemories = storeRecentMemories(userId, 500).filter(
    (m) => m.person_id === personId,
  );
  const facts = storeGetPersonFacts(userId, personId);
  const history = storeGetPersonFacts(userId, personId, {
    includeSuperseded: true,
  });
  const superseded = history.filter((f) => f.status === "superseded");
  const staleSources = new Set(
    superseded
      .map((f) => f.source_memory_id)
      .filter((id): id is string => !!id),
  );
  const staleValues = superseded
    .map((f) => f.value.toLowerCase().trim())
    .filter((v) => v.length >= 3);

  // A consolidated brief must never quote a value the user has superseded.
  // Drop the source memories and guard the generated text against stale values.
  const memories = allMemories.filter(
    (m) =>
      !staleSources.has(m.id) &&
      !staleValues.some((v) => m.content.toLowerCase().includes(v)),
  );
  const commitments = loadStore().commitments.filter(
    (c) => c.user_id === userId && c.person_id === personId && c.status === "open",
  );
  if (memories.length === 0 && facts.length === 0) return null;

  // Current facts beat the profile cache: a fact correction may be newer than
  // the denormalized person row (and the profile is updated by correctFact too).
  const currentCompany =
    facts.find((f) => f.key === "company")?.value ?? person.company;
  const rawRole =
    facts.find((f) => /role|title|headline/.test(f.key))?.value ??
    person.headline;
  const currentRole =
    rawRole?.replace(/\s+at\s+.+$/i, "").trim() || rawRole;
  const currentLocation =
    facts.find((f) => f.key === "location")?.value ?? person.location;

  const input = {
    personName: person.name,
    headline: currentRole,
    company: currentCompany,
    location: currentLocation,
    facts: facts.map((f) => ({
      attribute: f.attribute,
      value: f.value,
      absoluteDate: f.absolute_date,
    })),
    memories: memories.map((m) => ({
      content: m.content,
      occurredAt: m.occurred_at,
    })),
    commitments: commitments.map((c) => ({
      description: c.description,
      dueAt: c.due_at,
    })),
  };
  const { text, writtenBy } = await synthesizePersonBrief(input);
  const guarded =
    staleValues.some((v) => text.toLowerCase().includes(v)) ||
    !briefIsGrounded(text, input)
      ? buildPersonBrief(input)
      : text;

  const content = `Canonical brief — ${person.name}\n${guarded}`;
  const { jobId } = await walrusRememberAsync(userId, content);
  const brief = addBrief({
    userId,
    personId,
    content,
    sourceMemoryIds: memories.map((m) => m.id),
  });
  if (jobId) {
    try {
      const { blobId } = await walrusAwaitBlob(jobId);
      if (blobId) {
        setBriefBlob(brief.id, blobId);
        brief.walrus_blob_id = blobId;
      }
    } catch {
      // The brief is safe locally; certification can be retried.
    }
  }
  audit(userId, "consolidate_person", {
    personId,
    briefId: brief.id,
    sources: brief.source_memory_ids.length,
    writtenBy,
  });
  return brief;
}

export async function getPersonBrief(
  userId: string,
  personId: string,
): Promise<Brief | null> {
  return getLatestBrief(userId, personId);
}

/**
 * "Remind me to reach out later." Creates a real follow-up so the person
 * leaves the stale list now and reappears in Today when the nudge is due.
 */
export async function snoozePerson(
  userId: string,
  personId: string,
  days = 14,
): Promise<boolean> {
  const person = storeGetPerson(userId, personId);
  if (!person) return false;
  addCommitment({
    userId,
    personId,
    description: `Reconnect with ${person.name}`,
    dueAt: new Date(Date.now() + days * 86400_000).toISOString(),
    sourceMemoryId: null,
  });
  audit(userId, "snooze_person", { personId, days });
  return true;
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
  //    Forgotten and superseded versions are filtered by blob id BEFORE
  //    ranking: Walrus cannot know that a blob was tombstoned, so the
  //    projection decides what is still true.
  let pool: Cand[] = [];
  let fromWalrus = false;
  const localRows = storeRecentMemories(userId, 500, { includeForgotten: true });
  const hiddenBlobs = new Set(
    localRows
      .filter((m) => m.status !== "active" && m.walrus_blob_id)
      .map((m) => m.walrus_blob_id as string),
  );
  const hits = (await walrusRecall(userId, q, limit)).filter(
    (h) => !h.blobId || !hiddenBlobs.has(h.blobId),
  );
  if (hits.length > 0) {
    fromWalrus = true;
    const byBlob = new Map(
      localRows
        .filter((m) => m.walrus_blob_id && m.status === "active")
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
      const feedback = feedbackMap(userId);
      const ordered = pool
        .map((p) => ({
          ...p,
          judgeScore: Math.min(
            1,
            (byScore.get(p.id) ?? 0) +
              relianceBoost(usage.get(p.id)?.hits ?? 0) +
              feedbackBoost(feedback.get(p.id)?.useful ?? 0),
          ),
        }))
        .sort((a, b) => b.judgeScore - a.judgeScore);
      ranked = (isAggregate ? ordered : ordered.filter((p) => p.judgeScore >= RELEVANCE_MIN_SCORE)).slice(
        0,
        limit,
      );
      // Do not abstain yet: a current-fact answer may exist even when no
      // single memory clears the semantic threshold ("founder at Linear").
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

  // 2b. Current facts are authoritative. When the question targets a belief
  //     that has actually changed, answer from the current value and make the
  //     correction memory a citation — never let the old value win because it
  //     happened to rank higher.
  const people = storeListPeople(userId);
  const peopleById = new Map(people.map((p) => [p.id, p]));
  // Canonical answers are allowed to use every current fact: the multi-hop
  // "founder at Linear" case may have no single memory above threshold.
  const allCurrentFacts = getCurrentFacts(userId);
  const factHistory = loadStore().facts.filter((f) => f.user_id === userId);
  const canonical =
    findCanonicalFactAnswer(q, allCurrentFacts, factHistory, peopleById) ??
    findFactMentionAnswer(q, allCurrentFacts, peopleById);
  if (canonical) {
    for (const fact of [canonical.fact, canonical.extra].filter(
      (f): f is Fact => !!f,
    )) {
      if (!fact.source_memory_id) continue;
      const source = storeGetMemory(userId, fact.source_memory_id);
      if (
        source &&
        source.status === "active" &&
        !ranked.some((r) => r.id === source.id)
      ) {
        ranked = [
          {
            id: source.id,
            personId: source.person_id,
            personName: source.person_id
              ? (peopleById.get(source.person_id)?.name ?? null)
              : null,
            content: source.content,
            occurredAt: source.occurred_at,
            baseScore: 1,
          },
          ...ranked,
        ].slice(0, limit + 2);
      }
    }
  }

  const personIds = [
    ...new Set(ranked.map((r) => r.personId).filter((id): id is string => !!id)),
  ];
  const currentFacts = allCurrentFacts.filter(
    (f) => f.person_id !== null && personIds.includes(f.person_id),
  );

  if (ranked.length === 0 && !canonical) {
    // Calibrated abstention: nothing relevant and no current-fact answer.
    audit(userId, "recall_abstain", {
      reason: "no_candidate_above_threshold",
      threshold: RELEVANCE_MIN_SCORE,
      candidates: pool.length,
    });
    return { answer: ABSTAIN_TEXT, citations: [] };
  }

  // Unknown-attribute guard: the right person is not enough — if the note
  // never mentions the requested attribute, abstain rather than pad.
  if (!canonical) {
    const probe = unsupportedAttributeProbe(q, ranked, currentFacts);
    if (probe) {
      audit(userId, "recall_abstain", {
        reason: "unsupported_attribute",
        probe,
      });
      return { answer: ABSTAIN_TEXT, citations: [] };
    }
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
    currentFacts.map((f) => ({
      personName: f.person_id ? (peopleById.get(f.person_id)?.name ?? null) : null,
      attribute: f.attribute,
      value: f.value,
      absoluteDate: f.absolute_date,
    })),
  );

  // Contradiction guard: the UI must never show sources next to "don't know".
  // Small models sometimes abstain out of caution despite relevant citations
  // (notably counting and yes/no questions). In that case answer extractively
  // from the citations instead of contradicting them.
  let finalAnswer = answer;
  let usedExtractiveFallback = false;
  if (answer.trim().startsWith(ABSTAIN_TEXT) && ranked.length > 0) {
    audit(userId, "recall_extractive_fallback", {
      candidates: ranked.length,
      question: q.slice(0, 120),
    });
    finalAnswer = buildExtractiveAnswer(
      ranked.map((r) => ({ personName: r.personName, content: r.content })),
    );
    usedExtractiveFallback = true;
  }
  if (canonical) {
    finalAnswer = canonical.answer;
    audit(userId, "recall_canonical_fact", {
      factId: canonical.fact.id,
      personId: canonical.fact.person_id,
      key: canonical.fact.key,
    });
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
  const preVerification = citations;
  if (
    isJudgeConfigured() &&
    !canonical &&
    !finalAnswer.trim().startsWith(ABSTAIN_TEXT)
  ) {
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
        // The verifier rejected every synthesized claim. Rather than say
        // "I don't know" while holding relevant sources, quote them directly
        // and mark them unsupported (no ✓ badge). A wrong synthesis is never
        // shown; a grounded quote is.
        finalAnswer = buildExtractiveAnswer(
          ranked.map((r) => ({ personName: r.personName, content: r.content })),
        );
        citations = preVerification.map((c) => ({
          ...c,
          verified: "unsupported",
          checkConfidence: 0,
        }));
        audit(userId, "recall_extractive_sources_kept", {
          sources: citations.length,
          synthesizedAnswerRejected: true,
          wasExtractive: usedExtractiveFallback,
        });
      }
    }
  }

  // When the answer is the canonical current value, do not show the stale
  // source beside it. The old version stays in history, not in the answer.
  if (canonical) {
    const staleSources = new Set(
      factHistory
        .filter(
          (f) =>
            f.person_id === canonical.fact.person_id &&
            f.key === canonical.fact.key &&
            f.status === "superseded" &&
            f.source_memory_id,
        )
        .map((f) => f.source_memory_id as string),
    );
    citations = citations.filter(
      (c) =>
        !staleSources.has(c.memoryId) ||
        c.memoryId === canonical.fact.source_memory_id,
    );
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

function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function questionMentionsPerson(question: string, person: Person): boolean {
  const q = normalizeForMatch(question);
  const name = normalizeForMatch(person.name);
  if (q.includes(name)) return true;
  const first = name.split(/\s+/)[0] ?? "";
  return first.length >= 3 && new RegExp(`\\b${escapeRegExp(first)}\\b`).test(q);
}

/**
 * How strongly does the question ask about this belief? Specificity matters:
 * "where does Sarah work" must prefer company over role, and naming an old
 * value ("is she still at Nimbus?") is the strongest signal of all.
 */
export function factQuestionScore(
  question: string,
  key: string,
  oldValues: string[] = [],
): number {
  const q = normalizeForMatch(question);
  const words = key.split("_").filter((w) => w.length >= 3);
  let score = words.some((w) => new RegExp(`\\b${escapeRegExp(w)}`).test(q))
    ? 10
    : 0;

  if (
    oldValues.some(
      (v) => v.length >= 3 && q.includes(normalizeForMatch(v)),
    )
  ) {
    score += 20;
  }

  if (
    /company|employer/.test(key) &&
    /\b(company|employer|work|works|working|job)\b/.test(q)
  ) {
    score += 9;
  }
  if (
    /location|city|based|address/.test(key) &&
    /\b(where|live|lives|living|based|location|city|address)\b/.test(q)
  ) {
    score += 8;
  }
  if (
    /role|title|headline/.test(key) &&
    /\b(role|title|what|do|does)\b/.test(q)
  ) {
    score += 5;
  }
  if (
    /expir|deadline|due|renew|valid|until/.test(key) &&
    /\b(expir\w*|deadline|due|renew\w*|valid|until|when)\b/.test(q)
  ) {
    score += 8;
  }
  if (
    /birthday|born|age/.test(key) &&
    /\b(birthday|born|age|old)\b/.test(q)
  ) {
    score += 8;
  }
  if (
    /email|phone|contact/.test(key) &&
    /\b(email|mail|phone|number|contact|reach)\b/.test(q)
  ) {
    score += 8;
  }
  if (
    /amount|salary|compensation|price|cost/.test(key) &&
    /\b(paid|pay|salary|compensation|how much|amount|price|cost)\b/.test(q)
  ) {
    score += 8;
  }
  if (
    /allerg|diet|eat/.test(key) &&
    /\b(allerg\w*|diet|eat|food)\b/.test(q)
  ) {
    score += 8;
  }
  return score;
}

export function questionTargetsFact(question: string, key: string): boolean {
  return factQuestionScore(question, key) > 0;
}

/**
 * If the question targets a fact that has been superseded, the current value
 * is the answer. This is deliberately deterministic: a memory that cannot
 * answer "where does Sarah work now?" correctly after an update is not
 * trustworthy, regardless of how good the prose model is.
 */
export interface CanonicalAnswer {
  fact: Fact;
  answer: string;
  /** A second fact that contributed to a multi-hop answer (company + role). */
  extra?: Fact;
}

export function findCanonicalFactAnswer(
  question: string,
  currentFacts: Fact[],
  history: Fact[],
  peopleById: Map<string, Person>,
): CanonicalAnswer | null {
  // Historical questions deserve the old value, not the current one.
  if (/\b(used to|previously|formerly|before|old|history|was)\b/i.test(question)) {
    return null;
  }
  for (const person of peopleById.values()) {
    if (!questionMentionsPerson(question, person)) continue;
    const candidates = currentFacts
      .filter((f) => f.person_id === person.id)
      .map((fact) => {
        const oldValues = history
          .filter(
            (f) =>
              f.person_id === person.id &&
              f.key === fact.key &&
              f.status === "superseded",
          )
          .map((f) => f.value);
        return {
          fact,
          oldValues,
          score: factQuestionScore(question, fact.key, oldValues),
        };
      })
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score);

    for (const { fact, oldValues } of candidates) {
      if (oldValues.length === 0) continue;
      return { fact, answer: canonicalFactAnswerText(person, fact) };
    }
  }
  return null;
}

/**
 * Answer "who is the founder at Linear?" by joining two current facts:
 * a company/location anchor mentioned in the question, and the person's role.
 * This is the multi-hop case a single memory often cannot answer.
 */
export function findFactMentionAnswer(
  question: string,
  currentFacts: Fact[],
  peopleById: Map<string, Person>,
): CanonicalAnswer | null {
  const q = normalizeForMatch(question);
  if (!/\b(who|which person|whose)\b/.test(q)) return null;
  const anchors = currentFacts.filter(
    (f) =>
      (f.key === "company" || f.key === "location") &&
      f.value.length >= 3 &&
      q.includes(normalizeForMatch(f.value)),
  );
  // Pass 1: a role fact that actually answers the question ("founder").
  // This must run across all anchors before the generic "works at" fallback,
  // otherwise the first company match wins even if it is the wrong person.
  for (const anchor of anchors) {
    const person = anchor.person_id ? peopleById.get(anchor.person_id) : null;
    if (!person) continue;
    const anchorWords = new Set(
      normalizeForMatch(anchor.value).split(/\s+/).filter(Boolean),
    );
    const role = currentFacts.find((f) => {
      if (
        f.person_id !== person.id ||
        f.id === anchor.id ||
        /company|location|employer/.test(f.key)
      ) {
        return false;
      }
      return normalizeForMatch(f.value)
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !anchorWords.has(w))
        .some((w) => q.includes(w));
    });
    if (role) {
      const roleText = role.value.replace(/\s+at\s+.+$/i, "").trim() || role.value;
      return {
        fact: role,
        extra: anchor,
        answer: `${person.name} is ${roleText} at ${anchor.value}.`,
      };
    }
  }

  // Pass 2: generic "who works at / is based in X".
  for (const anchor of anchors) {
    const person = anchor.person_id ? peopleById.get(anchor.person_id) : null;
    if (!person) continue;
    if (anchor.key === "location") {
      return {
        fact: anchor,
        answer: `${person.name} is based in ${anchor.value}.`,
      };
    }
    if (/\b(work|works|working|based|at)\b/.test(q)) {
      return {
        fact: anchor,
        answer: `${person.name} works at ${anchor.value}.`,
      };
    }
  }
  return null;
}

/**
 * If the question asks for a specific attribute the retrieved memories never
 * mention ("Sarah's favorite movie"), abstain instead of padding the answer
 * with unrelated facts about the right person.
 */
export function unsupportedAttributeProbe(
  question: string,
  ranked: { content: string }[],
  facts: Fact[],
): string | null {
  const q = normalizeForMatch(question);
  const hay = `${ranked.map((r) => r.content).join(" ")} ${facts
    .map((f) => `${f.key} ${f.value}`)
    .join(" ")}`.toLowerCase();

  const dynamic = q.match(/\bfavorite\s+([a-z]+)/);
  if (dynamic?.[1] && !hay.includes(dynamic[1])) return dynamic[0];

  const groups: Array<{ probe: RegExp; words: string[] }> = [
    {
      probe: /\b(movie|film|book|song|food|color|colour)\b/,
      words: ["movie", "film", "book", "song", "food", "color", "colour"],
    },
    {
      probe: /\b(salary|compensation|income|net worth)\b/,
      words: ["salary", "compensation", "income", "paid", "net worth"],
    },
    {
      probe: /\b(dentist|doctor|therapist|lawyer)\b/,
      words: ["dentist", "doctor", "therapist", "lawyer"],
    },
    {
      probe: /\b(phone|email|address)\b/,
      words: ["phone", "email", "address"],
    },
    {
      probe: /\b(birthday|born|age)\b/,
      words: ["birthday", "born", "age"],
    },
    {
      probe: /\b(wife|husband|kids?|children|daughter|son)\b/,
      words: ["wife", "husband", "kid", "child", "daughter", "son"],
    },
  ];
  for (const group of groups) {
    const match = q.match(group.probe);
    if (!match) continue;
    if (!group.words.some((w) => hay.includes(w))) return match[0];
  }
  return null;
}

function canonicalFactAnswerText(person: Person, fact: Fact): string {
  const value = fact.absolute_date
    ? `${fact.value} (${fact.absolute_date})`
    : fact.value;
  if (fact.key === "company" || fact.key === "employer") {
    return `${person.name} works at ${value}.`;
  }
  if (fact.key === "location") {
    return `${person.name} is based in ${value}.`;
  }
  if (fact.key === "role" || fact.key === "title") {
    return `${person.name}'s role is ${value}.`;
  }
  return `${person.name}'s ${fact.attribute.replace(/_/g, " ")} is ${value}.`;
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
  opts?: { includeSuperseded?: boolean; includeForgotten?: boolean },
): Promise<Fact[]> {
  return storeGetPersonFacts(userId, personId, opts);
}

export async function getPersonMemories(
  userId: string,
  personId: string,
  opts?: { includeSuperseded?: boolean },
): Promise<Memory[]> {
  return storeRecentMemories(userId, 500, opts).filter(
    (m) => m.person_id === personId,
  );
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
  opts?: { includeSuperseded?: boolean; includeForgotten?: boolean },
): Promise<(Memory & { person_name: string | null })[]> {
  return storeRecentMemories(userId, limit, opts);
}

/** Record a late-arriving Walrus blob id on a memory saved while offline. */
export async function attachBlobId(memoryId: string, blobId: string): Promise<void> {
  setMemoryBlob(memoryId, blobId);
}
