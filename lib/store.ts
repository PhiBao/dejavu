import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  AppUser,
  Commitment,
  CommitmentStatus,
  Fact,
  Memory,
  MemoryKind,
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
 * overridable via RECALL_DATA_PATH). That keeps the app dependency-free and
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
  };
}

function dataPath(): string {
  const override = process.env.RECALL_DATA_PATH;
  if (override && override.length > 0) return override;
  return join(process.cwd(), "data", "recall.json");
}

// NOTE: no in-memory cache, by design. Next.js may bundle this module into
// more than one route chunk (we observed duplicated module state in container
// builds: one route wrote the user row while another kept reading an empty
// snapshot). The file is the single source of truth — every load re-reads it,
// so all readers converge regardless of bundling. Trade-off, documented:
// concurrent read-modify-write cycles can clobber each other (last write
// wins); fine for this scale, would need locking beyond it.
export function loadStore(): StoreData {
  const path = dataPath();
  try {
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StoreData>;
      return { ...emptyStore(), ...parsed };
    }
  } catch {
    // Corrupt/unreadable file degrades to empty rather than crashing requests.
  }
  return emptyStore();
}

export function saveStore(data: StoreData): void {
  const path = dataPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  writeFileSync(path, readFileSync(tmp, "utf8"), "utf8");
}

function now(): string {
  return new Date().toISOString();
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

// --- Memories ------------------------------------------------------------

export function addMemory(args: {
  userId: string;
  personId: string | null;
  kind: MemoryKind;
  content: string;
  blobId?: string | null;
}): Memory {
  const store = loadStore();
  const memory: Memory = {
    id: randomUUID(),
    user_id: args.userId,
    person_id: args.personId,
    kind: args.kind,
    content: args.content,
    walrus_blob_id: args.blobId ?? null,
    occurred_at: now(),
    created_at: now(),
  };
  store.memories.push(memory);
  saveStore(store);
  return memory;
}

export function setMemoryBlob(memoryId: string, blobId: string): void {
  const store = loadStore();
  const mem = store.memories.find((m) => m.id === memoryId);
  if (mem) {
    mem.walrus_blob_id = blobId;
    saveStore(store);
  }
}

export function recentMemories(
  userId: string,
  limit = 20,
): (Memory & { person_name: string | null })[] {
  const store = loadStore();
  const byId = new Map(store.people.map((p) => [p.id, p.name]));
  return store.memories
    .filter((m) => m.user_id === userId)
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
    .filter((m) => m.user_id === userId)
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
  const memories = loadStore().memories.filter((m) => m.walrus_blob_id);
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

/** Recall counts per memory id (missing = never recalled). */
export function memoryUsageMap(userId: string): Map<string, MemoryUsage> {
  const store = loadStore();
  const ids = new Set(
    store.memories.filter((m) => m.user_id === userId).map((m) => m.id),
  );
  const out = new Map<string, MemoryUsage>();
  for (const u of store.usage) {
    if (ids.has(u.memory_id)) out.set(u.memory_id, u);
  }
  return out;
}

// --- Facts ---------------------------------------------------------------

export function addFact(args: {
  userId: string;
  personId: string;
  attribute: string;
  value: string;
  sourceMemoryId: string | null;
}): Fact {
  const store = loadStore();
  const fact: Fact = {
    id: randomUUID(),
    user_id: args.userId,
    person_id: args.personId,
    attribute: args.attribute,
    value: args.value,
    source_memory_id: args.sourceMemoryId,
    created_at: now(),
  };
  store.facts.push(fact);
  saveStore(store);
  return fact;
}

export function getPersonFacts(userId: string, personId: string): Fact[] {
  return loadStore()
    .facts.filter((f) => f.user_id === userId && f.person_id === personId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
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
    facts: store.facts.length,
    commitments: store.commitments.length,
    open_commitments: store.commitments.filter((c) => c.status === "open").length,
    walrus_blobs: store.memories.filter((m) => m.walrus_blob_id).length,
  };
}
