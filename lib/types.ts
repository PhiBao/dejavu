/** Shared domain types for Dejavu. */

export type MemoryKind = "note" | "meeting" | "message" | "call";
export type CommitmentStatus = "open" | "done" | "snoozed" | "dismissed";

/**
 * Memory lifecycle. A memory is never silently overwritten:
 *  - active      the current version of what the user told us
 *  - superseded  replaced by a correction; kept for history, never recalled
 *  - forgotten   explicitly removed; tombstoned, never recalled or shown
 */
export type MemoryStatus = "active" | "superseded" | "forgotten";

/**
 * Fact lifecycle. Facts are beliefs, not rows: when a newer note says Sarah
 * works at Linear, the old "company: Nimbus" fact becomes superseded instead
 * of quietly sitting beside the new one. Recall reads current facts only.
 */
export type FactStatus = "current" | "superseded" | "forgotten";

/** Explicit user judgment on a memory that was cited in an answer. */
export type FeedbackVerdict = "useful" | "wrong" | "outdated";

export interface MemoryFeedback {
  id: string;
  user_id: string;
  memory_id: string;
  /** The question whose answer cited this memory, when available. */
  question: string | null;
  verdict: FeedbackVerdict;
  created_at: string;
}

/**
 * A consolidated, canonical summary of a person, derived from their current
 * facts and memories. Briefs are written back to Walrus as their own blob, so
 * the distilled view is as durable as the raw memories it came from.
 */
export interface Brief {
  id: string;
  user_id: string;
  person_id: string;
  content: string;
  source_memory_ids: string[];
  walrus_blob_id: string | null;
  created_at: string;
}

export interface AppUser {
  id: string;
  email: string;
  name: string | null;
  created_at: string;
}

export interface Person {
  id: string;
  user_id: string;
  name: string;
  headline: string | null;
  company: string | null;
  location: string | null;
  last_interaction_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Memory {
  id: string;
  user_id: string;
  person_id: string | null;
  kind: MemoryKind;
  content: string;
  /** Walrus blob id once the memory is persisted to Walrus Memory (null when offline). */
  walrus_blob_id: string | null;
  /** When the remembered event happened (extracted from the note when stated). */
  occurred_at: string;
  created_at: string;
  updated_at: string;
  status: MemoryStatus;
  /** The correction that replaced this memory, when superseded. */
  superseded_by: string | null;
  /** Set when the user explicitly forgot this memory (tombstone). */
  forgotten_at: string | null;
}

export interface Fact {
  id: string;
  user_id: string;
  /** Null for facts extracted from a general note (no person involved). */
  person_id: string | null;
  attribute: string;
  /** Normalized attribute used to detect updates (e.g. "company"). */
  key: string;
  value: string;
  source_memory_id: string | null;
  created_at: string;
  updated_at: string;
  status: FactStatus;
  /** The current fact that replaced this one, when superseded. */
  superseded_by: string | null;
  superseded_at: string | null;
  /** Absolute date the fact refers to (YYYY-MM-DD), e.g. an expiry. */
  absolute_date: string | null;
}

export interface Commitment {
  id: string;
  user_id: string;
  person_id: string | null;
  description: string;
  due_at: string | null;
  status: CommitmentStatus;
  source_memory_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Structured result of extracting a person + facts + commitments from raw text. */
export interface ExtractedMemory {
  personName: string | null;
  headline: string | null;
  company: string | null;
  location: string | null;
  kind: MemoryKind;
  /** YYYY-MM-DD when the note states when the remembered event happened. */
  occurredAt: string | null;
  facts: { attribute: string; value: string; date: string | null }[];
  commitments: {
    description: string;
    dueInDays: number | null;
    /** YYYY-MM-DD absolute deadline when the note states one. */
    dueDate: string | null;
  }[];
  /** Which model actually wrote this ("bedrock · mistral.voxtral-mini-3b-2507"). */
  writtenBy?: string;
}

/** A recall answer with citations to the memories that support it. */
export interface RecallAnswer {
  answer: string;
  citations: RecallCitation[];
  /** Which model actually wrote the answer. */
  writtenBy?: string;
}

export interface RecallCitation {
  memoryId: string;
  personId: string | null;
  personName: string | null;
  snippet: string;
  occurredAt: string;
  score: number;
  /** Machine-checked verdict: does the source memory support the answer? */
  verified?: "verified" | "contradicted" | "unsupported" | null;
  checkConfidence?: number | null;
}

/** An item in the "Today" follow-up feed. */
export interface TodayItem {
  commitment: Commitment;
  personName: string | null;
  reason: "due" | "overdue" | "stale";
  draftMessage?: string;
}

export type AttentionKind =
  | "commitment"
  | "stale_person"
  | "expiring_memory"
  | "fact_deadline"
  | "changed_fact";

/**
 * One thing the agent thinks the user should look at now. Items are
 * heterogeneous on purpose: a promise, a relationship going cold, a memory
 * about to expire, and a date-bearing fact all compete for attention.
 */
export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  title: string;
  detail: string;
  personId: string | null;
  personName: string | null;
  dueAt: string | null;
  /** 0..1 — higher means more urgent. */
  urgency: number;
  commitmentId?: string;
  memoryId?: string;
  factId?: string;
  draftMessage?: string;
  href?: string;
}

export interface AttentionFeed {
  items: AttentionItem[];
  /** One human sentence describing the top items. */
  brief: string;
  counts: {
    commitments: number;
    stale: number;
    expiring: number;
    deadlines: number;
    changes: number;
  };
  generatedAt: string;
}
