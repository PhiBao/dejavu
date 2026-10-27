import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
  AppUser,
  Brief,
  Commitment,
  CommitmentStatus,
  Fact,
  FactStatus,
  Memory,
  MemoryFeedback,
  MemoryKind,
  MemoryStatus,
  Person,
} from "./types";
import type { ApiKey } from "./api-keys";

/**
 * Local projection store — the structured view over Walrus Memory.
 *
 * Walrus Memory (encrypted blobs on Walrus, semantic search via the relayer)
 * is the durable source of truth for memory *content*. This file keeps the
 * relational projection the UI needs and Walrus can't query: people profiles,
 * typed facts, commitments with due dates, users, API keys, audit log.
 *
 * Persistence is a single JSON file (defaults to ./data/recall.json,
 * overridable via DEJAVU_DATA_PATH). That keeps the app dependency-free and
 * one-command runnable — the right trade for a hackathon entry where Walrus
 * carries durability and this file carries structure. All functions are
 * synchronous; callers may still `await` them.
 */

export interface AuditEntry {
  id: string;
  user_id: string | null;
  action: string;
  detail: string | null;
  created_at: string;
}

/**
 * How often a memory was actually recalled, and when it was last used.
 * This is the signal the learning loop runs on: memories you keep asking
 * for are the ones worth protecting (and renewing) when storage runs out.
 */
export interface MemoryUsage {
  memory_id: string;
  hits: number;
  last_hit_at: string;
}

interface StoreData {
  users: AppUser[];
  people: Person[];
  memories: Memory[];
  facts: Fact[];
  commitments: Commitment[];
  apiKeys: ApiKey[];
  audit: AuditEntry[];
  usage: MemoryUsage[];
  feedback: MemoryFeedback[];
  briefs: Brief[];
}

function emptyStore(): StoreData {
  return {
    users: [],
    people: [],
    memories: [],
    facts: [],
    commitments: [],
    apiKeys: [],
    audit: [],
    usage: [],
    feedback: [],
    briefs: [],
  };
}

function dataPath(): string {
  const override = process.env.DEJAVU_DATA_PATH ?? process.env.RECALL_DATA_PATH;
  if (override && override.length > 0) return override;
  // Prefer the new name for fresh installs, but keep reading the legacy file
  // so a rebrand never looks like data loss on an existing deployment.
  const next = join(process.cwd(), "data", "dejavu.json");
  const legacy = join(process.cwd(), "data", "recall.json");
  return existsSync(next) || !existsSync(legacy) ? next : legacy;
}

// NOTE: no in-memory cache, by design. Next.js may bundle this module into
// more than one route chunk (we observed duplicated module state in container
// builds: one route wrote the user row while another kept reading an empty
// snapshot). The file is the single source of truth — every load re-reads it,
// so all readers converge regardless of bundling. Trade-off, documented:
// concurrent read-modify-write cycles can clobber each other (last write
// wins); fine for this scale, would need locking beyond it.
/**
 * Bring legacy projections forward without a migration step. Older files have
 * no lifecycle fields; treating every existing memory as active and every fact
 * as current is exactly the right reading of history.
 */
function normalizeStore(parsed: Partial<StoreData>): StoreData {
  const store = { ...emptyStore(), ...parsed };
  store.memories = store.memories.map((m) => ({
    ...m,
    status: (m.status ?? "active") as MemoryStatus,
    superseded_by: m.superseded_by ?? null,
    forgotten_at: m.forgotten_at ?? null,
    updated_at: m.updated_at ?? m.created_at,
  }));
  store.facts = store.facts.map((f) => ({
    ...f,
    key: f.key ?? factKey(f.attribute),
    status: (f.status ?? "current") as FactStatus,
    superseded_by: f.superseded_by ?? null,
    superseded_at: f.superseded_at ?? null,
    absolute_date: f.absolute_date ?? null,
    updated_at: f.updated_at ?? f.created_at,
  }));
  store.commitments = store.commitments.map((c) => ({
    ...c,
    updated_at: c.updated_at ?? c.created_at,
  }));
  return store;
}

export function loadStore(): StoreData {
  const path = dataPath();
  try {
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StoreData>;
      return normalizeStore(parsed);
    }
  } catch {
    // Corrupt/unreadable file degrades to empty rather than crashing requests.
  }
  return emptyStore();
}

function sleepSync(ms: number): void {
  // Synchronous sleep without a dependency. The store API is synchronous by
  // design; a short wait only happens when another writer holds the lock.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Best-effort single-machine write lock. The Fly app runs one machine, so a
 * lock file plus an atomic rename removes the last-write-wins clobbering that
 * the original two-write save had. A stale lock (crashed writer) expires.
 */
function acquireLock(path: string): string {
  const lockPath = `${path}.lock`;
  const started = Date.now();
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      closeSync(fd);
      return lockPath;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        const stat = statSync(lockPath);
        if (Date.now() - stat.mtimeMs > 10_000) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        // The lock disappeared between EEXIST and stat; retry immediately.
        continue;
      }
      if (Date.now() - started > 2_000) {
        // Never deadlock a request on a lock we cannot explain.
        try {
          unlinkSync(lockPath);
        } catch {
          /* ignore */
        }
        continue;
      }
      sleepSync(10);
    }
  }
}

export function saveStore(data: StoreData): void {
  const path = dataPath();
  mkdirSync(dirname(path), { recursive: true });
  const lockPath = acquireLock(path);
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    // Atomic replace: readers see the old complete file or the new complete
    // file, never a half-written JSON document.
    renameSync(tmp, path);
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      /* lock already gone */
    }
  }
}

function now(): string {
  return new Date().toISOString();
}

/** Stable key for update detection: "Hiring For" and "hiring_for" collide. */
export function factKey(attribute: string): string {
  return attribute
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9à-ÿ]+/gi, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Attributes that legitimately hold several values at once. "Into padel" and
 * "into specialty coffee" are both true; they must not supersede each other.
 */
const MULTI_VALUE_KEYS = new Set([
  "interest",
  "interests",
  "hiring_for",
  "skill",
  "skills",
  "hobby",
  "hobbies",
  "likes",
  "food",
  "music",
  "book",
  "books",
  "language",
  "languages",
  "pet",
  "pets",
  "project",
  "projects",
  "goal",
  "goals",
  "topic",
  "topics",
]);

export function isMultiValueFact(key: string): boolean {
  return MULTI_VALUE_KEYS.has(key) || key.startsWith("interest_");
}

// --- Users ---------------------------------------------------------------

export function findUserByEmail(email: string): AppUser | null {
  const normalized = email.trim().toLowerCase();
  return loadStore().users.find((u) => u.email === normalized) ?? null;
}

export function createUser(email: string, name?: string): AppUser {
  const store = loadStore();
  const user: AppUser = {
    id: randomUUID(),
    email: email.trim().toLowerCase(),
    name: name?.trim() || null,
    created_at: now(),
  };
  store.users.push(user);
  saveStore(store);
  return user;
}

export function getUser(id: string): AppUser | null {
  return loadStore().users.find((u) => u.id === id) ?? null;
}

// --- People --------------------------------------------------------------

export function upsertPerson(
  userId: string,
  profile: { name: string; headline: string | null; company: string | null; location: string | null },
  opts?: { overwriteProfile?: boolean },
): { person: Person; created: boolean } {
  const store = loadStore();
  const found =
    store.people.find(
      (p) => p.user_id === userId && p.name.toLowerCase() === profile.name.toLowerCase(),
    ) ?? null;
  if (found) {
    if (opts?.overwriteProfile) {
      // Grounded values are fresh evidence from a note: they replace stale
      // ones, while nulls never wipe what an earlier capture established.
      if (profile.headline !== null) found.headline = profile.headline;
      if (profile.company !== null) found.company = profile.company;
      if (profile.location !== null) found.location = profile.location;
    } else {
      // Enrich sparse fields without overwriting existing values.
      found.headline = found.headline ?? profile.headline;
      found.company = found.company ?? profile.company;
      found.location = found.location ?? profile.location;
    }
    found.last_interaction_at = now();
    found.updated_at = now();
    saveStore(store);
    return { person: found, created: false };
  }
  const person: Person = {
    id: randomUUID(),
    user_id: userId,
    name: profile.name,
    headline: profile.headline,
    company: profile.company,
    location: profile.location,
    last_interaction_at: now(),
    created_at: now(),
    updated_at: now(),
  };
  store.people.push(person);
  saveStore(store);
  return { person, created: true };
}

export function listPeople(userId: string): Person[] {
  return loadStore()
    .people.filter((p) => p.user_id === userId)
    .sort((a, b) => {
      const ta = a.last_interaction_at ?? "";
      const tb = b.last_interaction_at ?? "";
      if (ta !== tb) return tb.localeCompare(ta);
      return a.name.localeCompare(b.name);
    });
}

export function getPerson(userId: string, personId: string): Person | null {
  return (
    loadStore().people.find((p) => p.id === personId && p.user_id === userId) ?? null
  );
}

const HONORIFICS = new Set(["dr", "mr", "ms", "mrs", "prof"]);

/** Accent-, case-, and punctuation-insensitive name key. */
export function normalizePersonName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !HONORIFICS.has(t))
    .join(" ");
}

function nameTokens(name: string): string[] {
  return normalizePersonName(name).split(" ").filter(Boolean);
}

export interface DuplicateCandidate {
  person: Person;
  reason: string;
  score: number;
}

/**
 * Suggest people who are probably the same person. Deliberately conservative:
 * exact normalized names, a full name contained in a longer name, or a first
 * name paired with the same company. The user confirms every merge.
 */
export function findDuplicatePeople(
  userId: string,
  personId: string,
): DuplicateCandidate[] {
  const store = loadStore();
  const target = store.people.find(
    (p) => p.id === personId && p.user_id === userId,
  );
  if (!target) return [];
  const targetTokens = nameTokens(target.name);
  const targetNorm = normalizePersonName(target.name);
  const targetCompany = target.company ? normalizePersonName(target.company) : null;

  const out: DuplicateCandidate[] = [];
  for (const other of store.people) {
    if (other.user_id !== userId || other.id === target.id) continue;
    const otherTokens = nameTokens(other.name);
    const otherNorm = normalizePersonName(other.name);
    const otherCompany = other.company ? normalizePersonName(other.company) : null;

    if (targetNorm === otherNorm) {
      out.push({ person: other, reason: "same name", score: 1 });
      continue;
    }

    const shorter = targetTokens.length <= otherTokens.length ? targetTokens : otherTokens;
    const longer = shorter === targetTokens ? otherTokens : targetTokens;
    const contained = shorter.every((t) => longer.includes(t));
    if (contained) {
      if (shorter.length >= 2) {
        out.push({
          person: other,
          reason: "name is contained in the other",
          score: 0.9,
        });
        continue;
      }
      if (shorter.length === 1 && longer.length === 2) {
        out.push({
          person: other,
          reason: "first name matches",
          score: 0.75,
        });
        continue;
      }
    }

    if (
      targetTokens[0] &&
      targetTokens[0] === otherTokens[0] &&
      targetCompany &&
      otherCompany &&
      targetCompany === otherCompany
    ) {
      out.push({
        person: other,
        reason: "same first name and company",
        score: 0.65,
      });
    }
  }

  return out.sort((a, b) => b.score - a.score).slice(0, 5);
}

/**
 * Merge `duplicateId` into `primaryId`: every memory, fact, and commitment
 * moves to the surviving person, profile gaps are filled, and conflicting
 * current facts keep the newest value (the older one stays as history).
 */
export function mergePeople(
  userId: string,
  primaryId: string,
  duplicateId: string,
): Person | null {
  if (primaryId === duplicateId) return null;
  const store = loadStore();
  const primary = store.people.find(
    (p) => p.id === primaryId && p.user_id === userId,
  );
  const duplicate = store.people.find(
    (p) => p.id === duplicateId && p.user_id === userId,
  );
  if (!primary || !duplicate) return null;

  primary.headline = primary.headline ?? duplicate.headline;
  primary.company = primary.company ?? duplicate.company;
  primary.location = primary.location ?? duplicate.location;
  const last = [primary.last_interaction_at, duplicate.last_interaction_at]
    .filter((x): x is string => !!x)
    .sort()
    .at(-1);
  primary.last_interaction_at = last ?? primary.last_interaction_at;
  primary.created_at =
    primary.created_at < duplicate.created_at ? primary.created_at : duplicate.created_at;
  primary.updated_at = now();

  for (const m of store.memories) {
    if (m.user_id === userId && m.person_id === duplicateId) m.person_id = primaryId;
  }
  for (const f of store.facts) {
    if (f.user_id === userId && f.person_id === duplicateId) f.person_id = primaryId;
  }
  for (const c of store.commitments) {
    if (c.user_id === userId && c.person_id === duplicateId) c.person_id = primaryId;
  }

  // One current value per belief after the merge. Newest capture wins.
  const byKey = new Map<string, Fact[]>();
  for (const f of store.facts) {
    if (f.user_id !== userId || f.person_id !== primaryId || f.status !== "current") continue;
    const list = byKey.get(f.key) ?? [];
    list.push(f);
    byKey.set(f.key, list);
  }
  for (const list of byKey.values()) {
    if (list.length <= 1) continue;
    list.sort((a, b) => b.created_at.localeCompare(a.created_at));
    const winner = list[0]!;
    for (const loser of list.slice(1)) {
      loser.status = "superseded";
      loser.superseded_by = winner.id;
      loser.superseded_at = now();
      loser.updated_at = now();
    }
  }

  store.people = store.people.filter((p) => p.id !== duplicateId);
  saveStore(store);
  return primary;
}

// --- Memories ------------------------------------------------------------

export function addMemory(args: {
  userId: string;
  personId: string | null;
  kind: MemoryKind;
  content: string;
  blobId?: string | null;
  occurredAt?: string | null;
}): Memory {
  const store = loadStore();
  const memory: Memory = {
    id: randomUUID(),
    user_id: args.userId,
    person_id: args.personId,
    kind: args.kind,
    content: args.content,
    walrus_blob_id: args.blobId ?? null,
    occurred_at: args.occurredAt ?? now(),
    created_at: now(),
    updated_at: now(),
    status: "active",
    superseded_by: null,
    forgotten_at: null,
  };
  store.memories.push(memory);
  saveStore(store);
  return memory;
}

export function getMemory(userId: string, memoryId: string): Memory | null {
  return (
    loadStore().memories.find((m) => m.id === memoryId && m.user_id === userId) ??
    null
  );
}

export function setMemoryBlob(memoryId: string, blobId: string): void {
  const store = loadStore();
  const mem = store.memories.find((m) => m.id === memoryId);
  if (mem) {
    mem.walrus_blob_id = blobId;
    mem.updated_at = now();
    saveStore(store);
  }
}

export function setMemoryPerson(
  userId: string,
  memoryId: string,
  personId: string | null,
): void {
  const store = loadStore();
  const mem = store.memories.find((m) => m.id === memoryId && m.user_id === userId);
  if (mem) {
    mem.person_id = personId;
    mem.updated_at = now();
    saveStore(store);
  }
}

/**
 * Mark a memory replaced by a correction. Its facts and open commitments are
 * retired too: the new version is the truth, the old one is history.
 */
export function supersedeMemory(
  userId: string,
  memoryId: string,
  replacementId: string | null,
): void {
  const store = loadStore();
  const mem = store.memories.find((m) => m.id === memoryId && m.user_id === userId);
  if (!mem) return;
  mem.status = "superseded";
  mem.superseded_by = replacementId;
  mem.updated_at = now();
  for (const f of store.facts) {
    if (f.user_id === userId && f.source_memory_id === memoryId && f.status === "current") {
      f.status = "superseded";
      f.superseded_at = now();
    }
  }
  for (const c of store.commitments) {
    if (c.user_id === userId && c.source_memory_id === memoryId && c.status === "open") {
      c.status = "dismissed";
      c.updated_at = now();
    }
  }
  saveStore(store);
}

/**
 * Forget a memory. This is a tombstone, not a delete: the Walrus blob stays
 * (we cannot un-write a certified object), but it is never recalled or shown
 * again and its derived facts/commitments stop influencing answers.
 */
export function forgetMemory(
  userId: string,
  memoryId: string,
): { found: boolean; blobId: string | null } {
  const store = loadStore();
  const mem = store.memories.find((m) => m.id === memoryId && m.user_id === userId);
  if (!mem) return { found: false, blobId: null };
  mem.status = "forgotten";
  mem.forgotten_at = now();
  mem.updated_at = now();
  for (const f of store.facts) {
    if (f.user_id === userId && f.source_memory_id === memoryId) {
      f.status = "forgotten";
      f.updated_at = now();
    }
  }
  for (const c of store.commitments) {
    if (c.user_id === userId && c.source_memory_id === memoryId && c.status === "open") {
      c.status = "dismissed";
      c.updated_at = now();
    }
  }
  store.usage = store.usage.filter((u) => u.memory_id !== memoryId);
  saveStore(store);
  return { found: true, blobId: mem.walrus_blob_id };
}

interface MemoryQuery {
  includeSuperseded?: boolean;
  includeForgotten?: boolean;
}

function visibleMemories(memories: Memory[], opts?: MemoryQuery): Memory[] {
  if (opts?.includeForgotten) return memories;
  if (opts?.includeSuperseded) return memories.filter((m) => m.status !== "forgotten");
  return memories.filter((m) => m.status === "active");
}

export function recentMemories(
  userId: string,
  limit = 20,
  opts?: MemoryQuery,
): (Memory & { person_name: string | null })[] {
  const store = loadStore();
  const byId = new Map(store.people.map((p) => [p.id, p.name]));
  return visibleMemories(
    store.memories.filter((m) => m.user_id === userId),
    opts,
  )
    .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))
    .slice(0, limit)
    .map((m) => ({
      ...m,
      person_name: (m.person_id ? (byId.get(m.person_id) ?? null) : null),
    }));
}

/** Keyword search over the local projection (fallback when Walrus is offline). */
export function searchMemories(
  userId: string,
  q: string,
  limit = 25,
): (Memory & { person_name: string | null })[] {
  const terms = q.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  const store = loadStore();
  const byId = new Map(store.people.map((p) => [p.id, p.name]));
  const scored = store.memories
    .filter((m) => m.user_id === userId && m.status === "active")
    .map((m) => {
      const personName = m.person_id ? (byId.get(m.person_id) ?? "") : "";
      const hay = `${m.content} ${personName}`.toLowerCase();
      let score = 0;
      for (const t of terms) if (hay.includes(t)) score++;
      return { m, personName: personName || null, score };
    })
    .filter((r) => r.score > 0 || terms.length === 0)
    .sort(
      (a, b) => b.score - a.score || b.m.occurred_at.localeCompare(a.m.occurred_at),
    )
    .slice(0, limit);
  return scored.map((r) => ({ ...r.m, person_name: r.personName }));
}

export function countWalrusBlobs(userId?: string): number {
  const memories = loadStore().memories.filter(
    (m) => m.walrus_blob_id && m.status !== "forgotten",
  );
  if (userId) return memories.filter((m) => m.user_id === userId).length;
  return memories.length;
}

// --- Usage (the learning loop's signal) -------------------------------------

/** Record that a memory was recalled (used by the answer the user saw). */
export function recordMemoryHit(memoryId: string): void {
  const store = loadStore();
  const row = store.usage.find((u) => u.memory_id === memoryId);
  if (row) {
    row.hits += 1;
    row.last_hit_at = new Date().toISOString();
  } else {
    store.usage.push({
      memory_id: memoryId,
      hits: 1,
      last_hit_at: new Date().toISOString(),
    });
  }
  saveStore(store);
}

/** Dejavu counts per memory id (missing = never recalled). */
export function memoryUsageMap(userId: string): Map<string, MemoryUsage> {
  const store = loadStore();
  const ids = new Set(
    store.memories
      .filter((m) => m.user_id === userId && m.status === "active")
      .map((m) => m.id),
  );
  const out = new Map<string, MemoryUsage>();
  for (const u of store.usage) {
    if (ids.has(u.memory_id)) out.set(u.memory_id, u);
  }
  return out;
}

// --- Explicit feedback (the learning loop's strongest signal) --------------

export interface FeedbackCounts {
  useful: number;
  wrong: number;
  outdated: number;
}

export function addMemoryFeedback(args: {
  userId: string;
  memoryId: string;
  question: string | null;
  verdict: MemoryFeedback["verdict"];
}): MemoryFeedback {
  const store = loadStore();
  const memory = store.memories.find(
    (m) => m.id === args.memoryId && m.user_id === args.userId,
  );
  if (!memory) throw new Error("Memory not found");
  const existing = store.feedback.find(
    (f) =>
      f.user_id === args.userId &&
      f.memory_id === args.memoryId &&
      f.verdict === args.verdict &&
      f.question === args.question,
  );
  if (existing) return existing;
  const row: MemoryFeedback = {
    id: randomUUID(),
    user_id: args.userId,
    memory_id: args.memoryId,
    question: args.question,
    verdict: args.verdict,
    created_at: now(),
  };
  store.feedback.push(row);
  saveStore(store);
  return row;
}

export function feedbackMap(userId: string): Map<string, FeedbackCounts> {
  const out = new Map<string, FeedbackCounts>();
  for (const f of loadStore().feedback) {
    if (f.user_id !== userId) continue;
    const row = out.get(f.memory_id) ?? { useful: 0, wrong: 0, outdated: 0 };
    row[f.verdict] += 1;
    out.set(f.memory_id, row);
  }
  return out;
}

export function feedbackTotals(userId: string): FeedbackCounts {
  const totals: FeedbackCounts = { useful: 0, wrong: 0, outdated: 0 };
  for (const row of feedbackMap(userId).values()) {
    totals.useful += row.useful;
    totals.wrong += row.wrong;
    totals.outdated += row.outdated;
  }
  return totals;
}

// --- Consolidated briefs ---------------------------------------------------

export function addBrief(args: {
  userId: string;
  personId: string;
  content: string;
  sourceMemoryIds: string[];
}): Brief {
  const store = loadStore();
  const brief: Brief = {
    id: randomUUID(),
    user_id: args.userId,
    person_id: args.personId,
    content: args.content,
    source_memory_ids: args.sourceMemoryIds,
    walrus_blob_id: null,
    created_at: now(),
  };
  store.briefs.push(brief);
  saveStore(store);
  return brief;
}

export function setBriefBlob(briefId: string, blobId: string): void {
  const store = loadStore();
  const brief = store.briefs.find((b) => b.id === briefId);
  if (brief) {
    brief.walrus_blob_id = blobId;
    saveStore(store);
  }
}

export function getLatestBrief(userId: string, personId: string): Brief | null {
  return (
    loadStore()
      .briefs.filter((b) => b.user_id === userId && b.person_id === personId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null
  );
}

// --- Facts ---------------------------------------------------------------

export function addFact(args: {
  userId: string;
  personId: string | null;
  attribute: string;
  value: string;
  sourceMemoryId: string | null;
  absoluteDate?: string | null;
}): Fact {
  const store = loadStore();
  const key = factKey(args.attribute);
  const value = args.value.trim();
  const existing = store.facts.filter(
    (f) =>
      f.user_id === args.userId &&
      f.person_id === args.personId &&
      f.key === key &&
      f.status === "current",
  );

  // Re-asserting the same value is confirmation, not a new belief.
  const same = existing.find(
    (f) => f.value.trim().toLowerCase() === value.toLowerCase(),
  );
  if (same) {
    // Re-assertion is fresh evidence: point the belief at the newest source
    // so forgetting an older note cannot erase something just confirmed.
    if (args.sourceMemoryId) same.source_memory_id = args.sourceMemoryId;
    same.updated_at = now();
    if (!same.absolute_date && args.absoluteDate) same.absolute_date = args.absoluteDate;
    saveStore(store);
    return same;
  }

  const fact: Fact = {
    id: randomUUID(),
    user_id: args.userId,
    person_id: args.personId,
    attribute: args.attribute,
    key,
    value,
    source_memory_id: args.sourceMemoryId,
    created_at: now(),
    updated_at: now(),
    status: "current",
    superseded_by: null,
    superseded_at: null,
    absolute_date: args.absoluteDate ?? null,
  };

  // Single-valued facts supersede their predecessor. Multi-valued facts
  // (interests, skills, hiring roles) accumulate side by side.
  if (!isMultiValueFact(key)) {
    for (const old of existing) {
      old.status = "superseded";
      old.superseded_by = fact.id;
      old.superseded_at = now();
      old.updated_at = now();
    }
  }

  store.facts.push(fact);
  saveStore(store);
  return fact;
}

/**
 * Correct a fact directly (without re-capturing a note). The old value stays
 * in history; the new value becomes canonical. The caller supplies the
 * correction memory id so every belief has a citable source.
 */
export function correctFactValue(args: {
  userId: string;
  factId: string;
  value: string;
  sourceMemoryId: string;
}): Fact | null {
  const store = loadStore();
  const old = store.facts.find(
    (f) => f.id === args.factId && f.user_id === args.userId && f.status === "current",
  );
  if (!old) return null;

  const fact: Fact = {
    id: randomUUID(),
    user_id: old.user_id,
    person_id: old.person_id,
    attribute: old.attribute,
    key: old.key,
    value: args.value.trim(),
    source_memory_id: args.sourceMemoryId,
    created_at: now(),
    updated_at: now(),
    status: "current",
    superseded_by: null,
    superseded_at: null,
    absolute_date: old.absolute_date,
  };

  // Retire the old value and any duplicate current values for the same belief.
  for (const f of store.facts) {
    if (
      f.user_id === args.userId &&
      f.person_id === old.person_id &&
      f.key === old.key &&
      f.status === "current"
    ) {
      f.status = "superseded";
      f.superseded_by = fact.id;
      f.superseded_at = now();
      f.updated_at = now();
    }
  }
  store.facts.push(fact);
  saveStore(store);
  return fact;
}

export function getFact(userId: string, factId: string): Fact | null {
  return (
    loadStore().facts.find((f) => f.id === factId && f.user_id === userId) ?? null
  );
}

export function forgetFact(userId: string, factId: string): boolean {
  const store = loadStore();
  const fact = store.facts.find(
    (f) => f.id === factId && f.user_id === userId && f.status === "current",
  );
  if (!fact) return false;
  fact.status = "forgotten";
  fact.updated_at = now();
  saveStore(store);
  return true;
}

interface FactQuery {
  includeSuperseded?: boolean;
  includeForgotten?: boolean;
}

function visibleFacts(facts: Fact[], opts?: FactQuery): Fact[] {
  if (opts?.includeForgotten) return facts;
  if (opts?.includeSuperseded) return facts.filter((f) => f.status !== "forgotten");
  return facts.filter((f) => f.status === "current");
}

export function getPersonFacts(
  userId: string,
  personId: string,
  opts?: FactQuery,
): Fact[] {
  return visibleFacts(
    loadStore().facts.filter((f) => f.user_id === userId && f.person_id === personId),
    opts,
  ).sort((a, b) => {
    if (a.status !== b.status) return a.status === "current" ? -1 : 1;
    return b.created_at.localeCompare(a.created_at);
  });
}

/** Current facts for a set of people — the authoritative answer context. */
export function getCurrentFacts(
  userId: string,
  personIds?: string[],
): Fact[] {
  const wanted = personIds ? new Set(personIds) : null;
  return loadStore().facts.filter(
    (f) =>
      f.user_id === userId &&
      f.status === "current" &&
      (!wanted || (f.person_id !== null && wanted.has(f.person_id))),
  );
}

/** Facts derived from one note — works for note-level and person-level facts. */
export function getMemoryFacts(
  userId: string,
  memoryIds: string[],
  opts?: FactQuery,
): Map<string, Fact[]> {
  const wanted = new Set(memoryIds);
  const out = new Map<string, Fact[]>();
  for (const f of visibleFacts(loadStore().facts, opts)) {
    if (f.user_id !== userId || !f.source_memory_id) continue;
    if (!wanted.has(f.source_memory_id)) continue;
    const list = out.get(f.source_memory_id) ?? [];
    list.push(f);
    out.set(f.source_memory_id, list);
  }
  return out;
}

// --- Commitments ---------------------------------------------------------

export function addCommitment(args: {
  userId: string;
  personId: string | null;
  description: string;
  dueAt: string | null;
  sourceMemoryId: string | null;
}): Commitment {
  const store = loadStore();
  const commitment: Commitment = {
    id: randomUUID(),
    user_id: args.userId,
    person_id: args.personId,
    description: args.description,
    due_at: args.dueAt,
    status: "open",
    source_memory_id: args.sourceMemoryId,
    created_at: now(),
    updated_at: now(),
  };
  store.commitments.push(commitment);
  saveStore(store);
  return commitment;
}

/** Open commitments due/overdue (due within the next day), ordered by urgency. */
export function todayCommitments(userId: string): Commitment[] {
  const horizon = Date.now() + 24 * 3600_000;
  return loadStore()
    .commitments.filter(
      (c) =>
        c.user_id === userId &&
        c.status === "open" &&
        (c.due_at === null || new Date(c.due_at).getTime() <= horizon),
    )
    .sort((a, b) => (a.due_at ?? "9999").localeCompare(b.due_at ?? "9999"))
    .slice(0, 50);
}

export function updateCommitmentStatus(
  userId: string,
  commitmentId: string,
  status: CommitmentStatus,
): void {
  const store = loadStore();
  const c = store.commitments.find(
    (x) => x.id === commitmentId && x.user_id === userId,
  );
  if (!c) return;
  if (status === "snoozed") {
    // Snooze keeps it open but pushes the due date out 3 days.
    c.due_at = new Date(Date.now() + 3 * 86400_000).toISOString();
  } else {
    c.status = status;
  }
  c.updated_at = now();
  saveStore(store);
}

/** People gone cold (no interaction in `staleDays`) without an open reconnect nudge. */
export function stalePeople(
  userId: string | null,
  staleDays: number,
): { user_id: string; person_id: string; name: string; last_interaction_at: string | null }[] {
  const store = loadStore();
  const cutoff = Date.now() - staleDays * 86400_000;
  return store.people
    .filter((p) => (userId === null || p.user_id === userId))
    .filter((p) => {
      const t = p.last_interaction_at ? new Date(p.last_interaction_at).getTime() : 0;
      return t < cutoff;
    })
    .filter(
      (p) =>
        !store.commitments.some(
          (c) =>
            c.person_id === p.id &&
            c.status === "open" &&
            c.description.startsWith("Reconnect with"),
        ),
    )
    .slice(0, 500)
    .map((p) => ({
      user_id: p.user_id,
      person_id: p.id,
      name: p.name,
      last_interaction_at: p.last_interaction_at,
    }));
}

// --- API keys ------------------------------------------------------------

export function createApiKeyRecord(args: {
  userId: string;
  name: string;
  prefix: string;
  keyHash: string;
}): ApiKey {
  const store = loadStore();
  const key: ApiKey = {
    id: randomUUID(),
    user_id: args.userId,
    name: args.name,
    prefix: args.prefix,
    last_used_at: null,
    created_at: now(),
    revoked_at: null,
  };
  // The hash is kept alongside the record (never the raw key).
  (key as unknown as Record<string, unknown>).key_hash = args.keyHash;
  store.apiKeys.push(key);
  saveStore(store);
  return key;
}

export function listApiKeyRecords(userId: string): ApiKey[] {
  return loadStore()
    .apiKeys.filter((k) => k.user_id === userId && k.revoked_at === null)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function revokeApiKeyRecord(userId: string, keyId: string): void {
  const store = loadStore();
  const k = store.apiKeys.find(
    (x) => x.id === keyId && x.user_id === userId && x.revoked_at === null,
  );
  if (k) {
    k.revoked_at = now();
    saveStore(store);
  }
}

export function findApiKeyByHash(hash: string): ApiKey | null {
  return (
    loadStore().apiKeys.find(
      (k) =>
        (k as unknown as Record<string, unknown>).key_hash === hash &&
        k.revoked_at === null,
    ) ?? null
  );
}

export function touchApiKey(id: string): void {
  const store = loadStore();
  const k = store.apiKeys.find((x) => x.id === id);
  if (k) {
    k.last_used_at = now();
    try {
      saveStore(store);
    } catch {
      // Best-effort usage tracking; never fails auth.
    }
  }
}

// --- Audit + counts ------------------------------------------------------

export function audit(
  userId: string | null,
  action: string,
  detail: Record<string, unknown>,
): void {
  try {
    const store = loadStore();
    store.audit.push({
      id: randomUUID(),
      user_id: userId,
      action,
      detail: JSON.stringify(detail),
      created_at: now(),
    });
    saveStore(store);
  } catch {
    // Audit must never break the write path.
  }
}

export function storeCounts(): Record<string, number> {
  const store = loadStore();
  return {
    users: store.users.length,
    people: store.people.length,
    memories: store.memories.length,
    active_memories: store.memories.filter((m) => m.status === "active").length,
    superseded_memories: store.memories.filter((m) => m.status === "superseded").length,
    forgotten_memories: store.memories.filter((m) => m.status === "forgotten").length,
    facts: store.facts.length,
    current_facts: store.facts.filter((f) => f.status === "current").length,
    commitments: store.commitments.length,
    open_commitments: store.commitments.filter((c) => c.status === "open").length,
    feedback: store.feedback.length,
    briefs: store.briefs.length,
    walrus_blobs: store.memories.filter(
      (m) => m.walrus_blob_id && m.status !== "forgotten",
    ).length,
  };
}
