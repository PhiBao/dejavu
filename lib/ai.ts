import { z } from "zod";
import { env, isMockAI } from "./env";
import { findStrongPersonSpans } from "./judge";
import { log } from "./log";
import { dateForFact, dueDateFromText, eventDateFromText, parseModelDate } from "./dates";
import type { ExtractedMemory, MemoryKind } from "./types";

/**
 * The prose layer. Two capabilities, both through an OpenAI-compatible
 * Chat Completions endpoint:
 *   1. extractMemory    — raw user text → structured person + facts + commitments
 *   2. synthesizeRecall — grounded answer from retrieved memories ONLY
 *   (+ rerankRecall — generative fallback ranker when Jev is unavailable)
 *
 * Jev (lib/judge.ts) owns every decision; this module only writes words.
 * Embeddings live in Walrus Memory's relayer — there is no local vector
 * code here. With no LLM auth (or AI_PROVIDER=mock), deterministic local
 * implementations keep the product fully runnable for local dev.
 *
 * PROVIDERS: Bedrock's hosted API keys are short-lived and expire without
 * warning — a demo that silently degrades to the mock writer is worse than a
 * failed one. So the prose layer is provider-agnostic and falls back along a
 * chain: primary provider → secondary provider → deterministic mock. Every
 * provider is OpenAI-compatible, so switching is one env var.
 */

const REQUEST_TIMEOUT_MS = 60_000;

export interface LlmProvider {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Configured providers, in fallback order. */
export function llmProviders(): LlmProvider[] {
  const e = env();
  const out: LlmProvider[] = [];

  // 1. Nebius Token Factory — our primary writer (open-weight Qwen).
  if (e.TOKENFACTORY_API_KEY) {
    out.push({
      name: "token-factory",
      baseUrl: e.TOKENFACTORY_BASE_URL,
      apiKey: e.TOKENFACTORY_API_KEY,
      model: e.TOKENFACTORY_MODEL,
    });
  }
  // 2. Any other OpenAI-compatible provider.
  if (e.LLM_PROVIDER === "openai-compatible" && e.LLM_API_KEY) {
    out.push({
      name: e.LLM_PROVIDER_NAME || "openai-compatible",
      baseUrl: e.LLM_BASE_URL,
      apiKey: e.LLM_API_KEY,
      model: e.LLM_MODEL,
    });
  }
  // 3. Bedrock Mantle (Mistral Voxtral Mini 3B) — AWS-native, short-lived keys.
  if (e.BEDROCK_API_KEY) {
    out.push({
      name: "bedrock",
      baseUrl: `https://bedrock-mantle.${e.AWS_REGION}.api.aws/v1`,
      apiKey: e.BEDROCK_API_KEY,
      model: e.BEDROCK_TEXT_MODEL_ID,
    });
  }
  // 4. Explicit secondary.
  if (e.LLM_FALLBACK_API_KEY) {
    out.push({
      name: e.LLM_FALLBACK_NAME || "fallback",
      baseUrl: e.LLM_FALLBACK_BASE_URL,
      apiKey: e.LLM_FALLBACK_API_KEY,
      model: e.LLM_FALLBACK_MODEL,
    });
  }
  // Last resort: a keyless, open-weights gateway (GPT-OSS 20B on OVH). It
  // exists so a demo never falls back to regex-written prose, and the UI
  // always shows which model actually answered.
  if (e.LLM_EMERGENCY_FALLBACK !== "off") {
    out.push({
      name: "gpt-oss-20b",
      baseUrl: "https://text.pollinations.ai/openai",
      apiKey: "",
      model: "openai-fast",
    });
  }
  return out;
}

export function primaryProviderName(): string {
  return llmProviders()[0]?.name ?? "mock";
}

/**
 * One chat completion. Tries each configured provider in order; returns the
 * first success plus which provider actually answered (so the UI can show it
 * — a demo that silently used a different model than claimed is a lie we
 * refuse to tell).
 */
async function chatJSON(
  system: string,
  user: string,
): Promise<{ text: string; provider: string; model: string }> {
  const providers = llmProviders();
  if (providers.length === 0) {
    throw new Error("No LLM provider configured");
  }
  let lastError: unknown = null;
  for (const p of providers) {
    try {
      const text = await chatWith(p, system, user);
      return { text, provider: p.name, model: p.model };
    } catch (err) {
      lastError = err;
      log.warn("llm_provider_failed", {
        provider: p.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  throw lastError instanceof Error ? lastError : new Error("All LLM providers failed");
}

async function chatWith(
  p: LlmProvider,
  system: string,
  user: string,
): Promise<string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // Keyless gateways (the emergency fallback) must not send an empty bearer.
  if (p.apiKey) headers.Authorization = `Bearer ${p.apiKey}`;
  const res = await fetch(`${p.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: p.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: 1024,
      temperature: 0,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`${p.name} ${res.status}: ${detail.slice(0, 200)}`);
  }
  const json = await res.json();
  const text = (json?.choices?.[0]?.message?.content ?? "").trim();
  if (!text) throw new Error(`${p.name} returned an empty completion`);
  return text;
}

/**
 * Liveness probe: does the configured provider actually answer? Cached, so
 * the health endpoint can report the truth without spending money per hit.
 */
let llmCheck: { at: number; ok: boolean; provider: string; error?: string } | null =
  null;

export async function checkLlm(): Promise<{
  ok: boolean;
  provider: string;
  error?: string;
  checkedAt: string;
}> {
  const providers = llmProviders();
  if (providers.length === 0) {
    return {
      ok: false,
      provider: "mock",
      error: "no provider configured",
      checkedAt: new Date().toISOString(),
    };
  }
  if (llmCheck && Date.now() - llmCheck.at < 60_000) {
    return {
      ok: llmCheck.ok,
      provider: llmCheck.provider,
      error: llmCheck.error,
      checkedAt: new Date(llmCheck.at).toISOString(),
    };
  }
  let ok = false;
  let error: string | undefined;
  let provider = providers[0]!.name;
  for (const p of providers) {
    try {
      await chatWith(
        p,
        "You are a health check. Reply with the single word: ok",
        "ping",
      );
      ok = true;
      provider = p.name;
      break;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }
  llmCheck = { at: Date.now(), ok, provider, error };
  return { ok, provider, error, checkedAt: new Date().toISOString() };
}

// --- Schemas for validating model output ----------------------------------

const extractionSchema = z.object({
  personName: z.string().nullable(),
  headline: z.string().nullable(),
  company: z.string().nullable(),
  location: z.string().nullable(),
  kind: z.enum(["note", "meeting", "message", "call"]),
  occurredAt: z.string().nullable().optional(),
  facts: z.array(
    z.object({
      attribute: z.string(),
      value: z.string(),
      date: z.string().nullable().optional(),
    }),
  ),
  commitments: z.array(
    z.object({
      description: z.string(),
      dueInDays: z.number().nullable(),
      dueDate: z.string().nullable().optional(),
    }),
  ),
});

function safeParseJSON(raw: string): unknown {
  // Models sometimes wrap JSON in prose or fences. Extract the first {...}.
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Like safeParseJSON but for a top-level JSON array (e.g. a ranked list). */
function safeParseArray(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? raw;
  const start = candidate.indexOf("[");
  const end = candidate.lastIndexOf("]");
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

const EXTRACT_SYSTEM = `You extract structured memory from anything a user wants to remember: a person they met, a meeting, an idea, a decision, a purchase, a plan, a fact about their own life — or a mix.
Return ONLY a JSON object with this exact shape:
{
  "personName": string | null,       // the OTHER person's name, when the note is about someone specific
  "headline": string | null,         // short role/summary e.g. "Founder @ Acme, ex-Stripe"
  "company": string | null,
  "location": string | null,
  "kind": "note" | "meeting" | "message" | "call",
  "occurredAt": string | null,       // YYYY-MM-DD when the note states when it happened ("yesterday", "last Friday"); null otherwise
  "facts": [ { "attribute": string, "value": string, "date": string | null } ],   // date = YYYY-MM-DD when this fact is date-bearing (expiry, deadline, birthday)
  "commitments": [ { "description": string, "dueInDays": number | null, "dueDate": string | null } ]  // things the USER should do; dueDate = YYYY-MM-DD when stated
}
Rules:
- Extract only what is stated or clearly implied. Do NOT invent facts or dates.
- personName is null when the note is not about a specific person. That is normal: facts still belong to the note.
- headline MUST be the person's current role/title exactly as stated in the note (e.g. if the note says "runs growth", the headline is about growth — never upgrade it to "Founder", "CEO", or any title not in the text).
- company MUST be just the organization name (e.g. "MIT", not "MIT working on retrieval systems").
- Every word in headline/company/fact values should appear in (or be a direct shortening of) the note text.
- attributes should be short, GENERIC snake_case keys (e.g. "role", "interest", "hiring_for", "passport_expiry", "amount", "trip_month") — never invented proper nouns from the note.
- Dates: use ISO YYYY-MM-DD. Resolve relative dates against the "Today is" date in the user message. If no date is stated, use null — never guess.
- Output JSON only, no prose.`;

// --- Public API -----------------------------------------------------------

export async function extractMemory(text: string): Promise<ExtractedMemory> {
  if (isMockAI()) return { ...mockExtract(text), writtenBy: "local rules" };
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { text: raw, provider, model } = await chatJSON(
      EXTRACT_SYSTEM,
      `Today is ${today}.\n\n${text}`,
    );
    const parsed = extractionSchema.safeParse(safeParseJSON(raw));
    if (parsed.success) {
      return {
        ...normalizeExtraction(text, parsed.data),
        writtenBy: `${provider} · ${model}`,
      };
    }
    // Model returned unexpected shape — fall back to a minimal capture so we
    // NEVER lose the user's raw memory.
    return { ...degradedExtract(text), writtenBy: `${provider} · ${model}` };
  } catch (err) {
    console.error("[ai] extractMemory failed, degrading:", errMsg(err));
    return { ...degradedExtract(text), writtenBy: "local rules" };
  }
}

/**
 * Dates are decided in code. The model's date fields are accepted only as a
 * fallback and only when the year it names actually appears in the note —
 * a plausible-looking invented date is worse than no date.
 */
function normalizeExtraction(
  text: string,
  data: z.infer<typeof extractionSchema>,
): ExtractedMemory {
  const deterministicEvent = eventDateFromText(text);
  const modelEvent = parseModelDate(data.occurredAt);
  const occurredAt =
    deterministicEvent ??
    (modelEvent && text.includes(modelEvent.slice(0, 4)) ? modelEvent : null);

  const deterministicDue = dueDateFromText(text);
  const facts = data.facts.map((f) => ({
    attribute: f.attribute,
    value: f.value,
    date:
      dateForFact(text, f.attribute) ??
      (() => {
        const modelDate = parseModelDate(f.date);
        return modelDate && text.includes(modelDate.slice(0, 4)) ? modelDate : null;
      })(),
  }));

  const commitments = data.commitments.map((c) => {
    const modelDate = parseModelDate(c.dueDate);
    const dueDate =
      deterministicDue ??
      (modelDate && text.includes(modelDate.slice(0, 4)) ? modelDate : null);
    return { ...c, dueDate };
  });

  return { ...data, occurredAt, facts, commitments };
}

const RECALL_SYSTEM = `You are the user's relationship memory. Answer the user's question using ONLY the provided memories and current facts.
- Be concise and specific.
- CURRENT FACTS are the user's latest known values. They override any conflicting older memory. If a current fact answers the question, use it and never repeat the outdated value.
- Consider ALL the provided memories, not just the first one.
- Counting questions ("how many founders..."): count ONLY distinct people whose stated role matches, then name them. Never include a non-matching person in the number — if someone is a partner or runs growth, say "One — Sarah Chen" and mention the non-matching person separately (e.g. "Marcus is a partner, not a founder").
- Yes/no questions ("is X a founder?"): answer from what the memories state. If they don't say it, say what they DO say about X instead of claiming ignorance of X entirely (e.g. "Your notes don't say Tomás founded anything — they say he runs growth at Loop.").
- If the memories truly contain nothing relevant to the question, say "I don't have a memory of that yet." Do NOT guess or invent.
- Refer to people by name. Do not mention memory IDs.`;
export const ABSTAIN_TEXT = "I don't have a memory of that yet.";

const RERANK_SYSTEM = `You rank memories by relevance to a question.
Return ONLY a JSON array of the indices (0-based) of the memories most relevant to the question, most relevant first, up to 5. Example: [2, 0, 4]
Rules:
- Use semantic meaning, not just keyword overlap (e.g. "recruiting backend devs" matches "hiring senior React engineers").
- If nothing is relevant, return [].
- Output JSON only, no prose.`;

/**
 * Generative reranker — the fallback ranker when Jev is unavailable.
 *
 * The text model understands meaning (paraphrases match), works via the
 * Bedrock API key alone, and needs no vector index — the same "hybrid
 * retrieval" pattern production RAG systems use. Jev's calibrated Noul
 * ranking (lib/judge.ts) is preferred whenever configured.
 */
export async function rerankRecall(
  question: string,
  memories: { id: string; content: string }[],
): Promise<string[]> {
  if (memories.length <= 3) return memories.map((m) => m.id);
  if (isMockAI()) return memories.slice(0, 3).map((m) => m.id);
  try {
    const context = memories
      .map((m, i) => `[${i}] ${m.content}`)
      .join("\n");
    const { text: raw } = await chatJSON(
      RERANK_SYSTEM,
      `Question: ${question}\n\nMemories:\n${context}`,
    );
    const parsed = safeParseJSON(raw) ?? safeParseArray(raw);
    const indices = Array.isArray(parsed) ? parsed : null;
    if (!indices) return memories.slice(0, 3).map((m) => m.id);
    const ids = indices
      .filter((i) => Number.isInteger(i) && i >= 0 && i < memories.length)
      .map((i) => memories[i]!.id);
    return ids.length > 0 ? ids : memories.slice(0, 3).map((m) => m.id);
  } catch (err) {
    console.error("[ai] rerankRecall failed, using top candidates:", errMsg(err));
    return memories.slice(0, 3).map((m) => m.id);
  }
}

/** A grounded answer plus which model actually wrote it. */
export interface SynthesizedAnswer {
  text: string;
  writtenBy: string;
}

export interface CurrentFactContext {
  personName: string | null;
  attribute: string;
  value: string;
  absoluteDate: string | null;
}

export async function synthesizeRecall(
  question: string,
  memories: { id: string; personName: string | null; content: string; occurredAt: string }[],
  currentFacts: CurrentFactContext[] = [],
): Promise<SynthesizedAnswer> {
  if (memories.length === 0 && currentFacts.length === 0) {
    return { text: ABSTAIN_TEXT, writtenBy: "no context" };
  }
  if (isMockAI()) {
    return { text: mockRecall(question, memories), writtenBy: "local rules" };
  }
  try {
    const context = memories
      .map(
        (m, i) =>
          `[#${i + 1}] (${m.personName ?? "unknown"}, ${m.occurredAt}): ${m.content}`,
      )
      .join("\n");
    const facts =
      currentFacts.length > 0
        ? `\n\nCurrent facts (authoritative):\n${currentFacts
            .map(
              (f) =>
                `- ${f.personName ?? "the user"} — ${f.attribute.replace(/_/g, " ")}: ${f.value}${f.absoluteDate ? ` (dated ${f.absoluteDate})` : ""}`,
            )
            .join("\n")}`
        : "";
    const user = `Memories:\n${context}${facts}\n\nQuestion: ${question}`;
    const { text, provider, model } = await chatJSON(RECALL_SYSTEM, user);
    const trimmed = text.trim();
    if (!trimmed) {
      return { text: mockRecall(question, memories), writtenBy: `${provider} · ${model}` };
    }
    return { text: trimmed, writtenBy: `${provider} · ${model}` };
  } catch (err) {
    console.error("[ai] synthesizeRecall failed, degrading:", errMsg(err));
    return { text: mockRecall(question, memories), writtenBy: "local rules" };
  }
}

// --- Consolidation ---------------------------------------------------------

export interface BriefInput {
  personName: string;
  headline: string | null;
  company: string | null;
  location: string | null;
  facts: { attribute: string; value: string; absoluteDate: string | null }[];
  memories: { content: string; occurredAt: string }[];
  commitments: { description: string; dueAt: string | null }[];
}

/**
 * Deterministic fallback for a person brief. Every sentence is grounded in a
 * fact, an open promise, or a memory the user actually captured.
 */
export function buildPersonBrief(input: BriefInput): string {
  const lines: string[] = [];
  const role = [input.headline, input.company].filter(Boolean).join(" · ");
  lines.push(`${input.personName}${role ? ` — ${role}` : ""}.`);
  if (input.location) lines.push(`Based in ${input.location}.`);

  const facts = input.facts
    .filter((f) => !["company", "role", "headline", "location"].includes(f.attribute))
    .slice(0, 6)
    .map(
      (f) =>
        `${f.attribute.replace(/_/g, " ")}: ${f.value}${f.absoluteDate ? ` (${f.absoluteDate})` : ""}`,
    );
  if (facts.length > 0) lines.push(`Current details — ${facts.join("; ")}.`);

  if (input.commitments.length > 0) {
    lines.push(
      `Open follow-ups: ${input.commitments
        .slice(0, 3)
        .map((c) => c.description)
        .join("; ")}.`,
    );
  }
  if (input.memories.length > 0) {
    const latest = input.memories[0]!;
    const snippet = latest.content.replace(/\s+/g, " ").slice(0, 180);
    lines.push(`Most recent note (${latest.occurredAt.slice(0, 10)}): ${snippet}`);
  }
  return lines.join(" ");
}

const BRIEF_SYSTEM = `You write a compact canonical brief about one person from the user's memory.
- Use ONLY the provided current facts, open follow-ups, and recent memories.
- Current facts are authoritative; never repeat a superseded value.
- 3-5 sentences. No bullet points. No invented details. No memory IDs.
- Start with the person's name and current role/company.`;

export async function synthesizePersonBrief(
  input: BriefInput,
): Promise<{ text: string; writtenBy: string }> {
  const fallback = buildPersonBrief(input);
  if (isMockAI()) return { text: fallback, writtenBy: "local rules" };
  try {
    const facts = input.facts
      .map(
        (f) =>
          `- ${f.attribute.replace(/_/g, " ")}: ${f.value}${f.absoluteDate ? ` (${f.absoluteDate})` : ""}`,
      )
      .join("\n");
    const commitments = input.commitments
      .map((c) => `- ${c.description}${c.dueAt ? ` (due ${c.dueAt.slice(0, 10)})` : ""}`)
      .join("\n");
    const memories = input.memories
      .slice(0, 8)
      .map((m) => `- (${m.occurredAt.slice(0, 10)}) ${m.content}`)
      .join("\n");
    const user = `Person: ${input.personName}
Headline: ${input.headline ?? "unknown"}
Company: ${input.company ?? "unknown"}
Location: ${input.location ?? "unknown"}

Current facts:
${facts || "(none)"}

Open follow-ups:
${commitments || "(none)"}

Recent memories:
${memories || "(none)"}`;
    const { text, provider, model } = await chatJSON(BRIEF_SYSTEM, user);
    return { text: text.trim() || fallback, writtenBy: `${provider} · ${model}` };
  } catch (err) {
    console.error("[ai] synthesizePersonBrief failed, using local brief:", errMsg(err));
    return { text: fallback, writtenBy: "local rules" };
  }
}

// --- Deterministic mock implementations (local dev / no AWS) ---------------

function mockExtract(text: string): ExtractedMemory {
  // Single source of truth for name candidates: the same over-finding
  // pre-parser Jev sees (lib/judge.ts). Previously this used its own narrow
  // regex, so the no-credentials fallback dropped people the production path
  // keeps — the two paths must agree.
  const spans = findStrongPersonSpans(text);
  // Longest strong span is the best guess offline (full names beat surnames).
  // In production Jev makes this call; this is the no-credentials fallback.
  const personName =
    spans.length > 0
      ? spans.reduce((a, b) => (b.length > a.length ? b : a))
      : null;

  const companyMatch = text.match(/\b(?:at|@)\s+([A-Z][A-Za-z0-9&.\- ]{1,30})/);
  const kind: MemoryKind =
    /\bcall(?:ed)?\b|\bphone\b/i.test(text)
      ? "call"
      : /\b(met|meet|meeting|saw|lunch|dinner|coffee|hang|grabbed)\b/i.test(text)
        ? "meeting"
        : /\b(dm|dmd|texted|messaged|emailed|pinged)\b/i.test(text)
          ? "message"
          : "note";

  const facts: { attribute: string; value: string; date: string | null }[] = [];
  const hiring = text.match(
    /\b(?:hiring|recruiting|looking for)(?:\s+for)?\s+([A-Za-z0-9 ,\-]{3,40})/i,
  );
  if (hiring?.[1]) {
    facts.push({ attribute: "hiring_for", value: hiring[1].trim(), date: null });
  }
  const interest = text.match(
    /(?:into|interested in|likes|loves|into)\s+([A-Za-z0-9 ,\-]{3,40})/i,
  );
  if (interest?.[1]) {
    facts.push({ attribute: "interest", value: interest[1].trim(), date: null });
  }

  // Date-bearing facts: "my passport expires in March 2027". The attribute is
  // derived from the subject so a later passport note supersedes this one
  // instead of creating a second, conflicting expiry.
  const expiry = text.match(
    /\b([A-Za-z][A-Za-z ]{1,24}?)\s+(?:expires?|expiry|renewal)\b/i,
  );
  const datePhrase = text.match(
    /\b(?:expires?|expiry|renewal)\s+(?:in|on|by|before)?\s*((?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+\d{4}|(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+\d{1,2}|\d{4}-\d{2}-\d{2}|\d+\s+(?:days?|weeks?|months?|years?)|next\s+(?:week|month|year)|tomorrow|today)/i,
  );
  if (expiry?.[1] && datePhrase?.[1]) {
    const subject = expiry[1]
      .trim()
      .replace(/^(my|the|our)\s+/i, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_");
    const attribute = `${subject}_expiry`;
    facts.push({
      attribute,
      value: datePhrase[1].trim(),
      date: dateForFact(text, attribute),
    });
  }

  const dueDate = dueDateFromText(text);
  const commitments: {
    description: string;
    dueInDays: number | null;
    dueDate: string | null;
  }[] = [];
  const promise = text.match(
    /(?:promised?|said i'?d|need to|should|will|must|owe|follow up|intro)\s+([A-Za-z0-9 ,'\-]{4,60})/i,
  );
  if (promise?.[1]) {
    const desc = promise[1].trim();
    // Don't create a follow-up that just echoes the person name.
    if (desc && desc.toLowerCase() !== (personName ?? "").toLowerCase()) {
      commitments.push({
        description: desc,
        dueInDays: dueDate ? null : 3,
        dueDate,
      });
    }
  }

  const company =
    companyMatch?.[1]?.trim().replace(/[.,;:!?]+$/, "") ?? null;
  if (company) {
    facts.push({ attribute: "company", value: company, date: null });
  }
  return {
    personName,
    headline: company ? `at ${company}` : null,
    company,
    location: null,
    kind,
    occurredAt: eventDateFromText(text),
    facts,
    commitments,
  };
}

/** Minimal, never-lose-data extraction when the model output can't be parsed. */
function degradedExtract(text: string): ExtractedMemory {
  const mock = mockExtract(text);
  return { ...mock, facts: mock.facts, commitments: mock.commitments };
}

function mockRecall(
  question: string,
  memories: { personName: string | null; content: string }[],
): string {
  const top = memories.slice(0, 3);
  const names = Array.from(
    new Set(top.map((m) => m.personName).filter(Boolean)),
  ).join(", ");
  const lead = names ? `Based on what you told me about ${names}: ` : "";
  return `${lead}${top.map((m) => m.content).join(" ")}`.slice(0, 600);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
