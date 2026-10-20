/** Shared domain types for Recall. */

export type MemoryKind = "note" | "meeting" | "message" | "call";
export type CommitmentStatus = "open" | "done" | "snoozed" | "dismissed";

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
  occurred_at: string;
  created_at: string;
}

export interface Fact {
  id: string;
  user_id: string;
  person_id: string;
  attribute: string;
  value: string;
  source_memory_id: string | null;
  created_at: string;
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
  facts: { attribute: string; value: string }[];
  commitments: { description: string; dueInDays: number | null }[];
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
