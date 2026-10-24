import { TypeSafeClient, choice, noul } from "@typesafe-ai/sdk";
import { env } from "./env";
import { log } from "./log";

/**
 * Calibrated judgments (TypeSafe Jev) — every *decision* in Dejavu's pipeline.
 *
 * Thesis: a generative LLM is good at writing words and bad at being
 * accountable for choices. So Jev decides and Voxtral only writes:
 *
 *   - routeIntent ......... Choice(remember | recall) — drives the Composer
 *   - resolvePersonName .... Choice over roster + detected spans (+ none hatch)
 *   - scoreRelevance ....... one batched Noul per (question, memory) pair
 *   - verifyCitations ...... one batched Choice per (claim, source) pair
 *
 * Every answer carries probabilities + confidence, so code — not vibes —
 * controls behavior: low-confidence routes fall back, low-relevance memories
 * never reach synthesis, and every citation ships a machine-checked verdict.
 *
 * All functions return null when TypeSafe is unconfigured or fails; callers
 * MUST fall back to the Bedrock generative paths. Nothing here may throw.
 */

let client: TypeSafeClient | null = null;

/** Test seam: inject a fake client (or null to reset). */
export function __setJudgeClientForTests(c: TypeSafeClient | null): void {
  client = c;
}

export function isJudgeConfigured(): boolean {
  try {
    return !!env().TYPESAFE_API_KEY;
  } catch {
    return false;
  }
}

function getClient(): TypeSafeClient | null {
  if (client) return client; // injected in tests, or already created
  if (!isJudgeConfigured()) return null;
  try {
    client = new TypeSafeClient({
      apiKey: env().TYPESAFE_API_KEY,
      defaultModel: env().TYPESAFE_MODEL_ID,
    });
  } catch {
    return null;
  }
  return client;
}

const CALL_TIMEOUT_MS = 30_000;

// --- Thresholds (tuned starting points; see docs/judgments.md) --------------

export const INTENT_MIN_CONFIDENCE = 0.5;
export const RELEVANCE_MIN_SCORE = 0.35;
export const CITATION_AUTO_ACCEPT = 0.8;

// --- 1. Intent routing ------------------------------------------------------

export type Intent = "remember" | "recall";

export async function routeIntent(
  text: string,
): Promise<{ intent: Intent; confidence: number } | null> {
  const c = getClient();
  if (!c) return null;
  try {
    const { answers, usage } = await c.systemOne(
      {
        state: text.slice(0, 2000),
        questions: {
          intent: choice("What does the user want to do?", {
            remember:
              "The user reports something that happened or someone they met — a note, meeting, call, or message to save to memory.",
            recall:
              "The user asks a question about people they know and expects an answer from memory.",
          }),
        },
      },
      { timeout: CALL_TIMEOUT_MS },
    );
    const a = answers.intent;
    log.info("judge_route", {
      intent: a.choice,
      confidence: a.confidence,
      inputTokens: usage.input_tokens,
    });
    return { intent: a.choice as Intent, confidence: a.confidence };
  } catch (err) {
    log.warn("judge_route_failed", { error: String(err) });
    return null;
  }
}

// --- 2. Person resolution (pre-parsed selection) ----------------------------

export const NO_MATCH = "none_of_these";

const NAME_CORE = "[A-ZÀ-Ý][a-zà-ÿ]+(?:\\s+[A-ZÀ-Ý][a-zà-ÿ]+)?";
const HONORIFIC = "(?:Dr\\.?|Mr\\.?|Ms\\.?|Mrs\\.?|Prof\\.?)\\s+";

/**
 * Words that are capitalized by position or convention but are never a person.
 * Deliberately broad: over-filling candidates is free (Jev picks), while a
 * missing candidate silently drops the whole relationship record.
 */
const NAME_STOPLIST = new Set([
  // pronouns / determiners / interjections
  "i", "im", "ive", "id", "ill", "a", "an", "the", "my", "our", "we", "us", "me",
  "you", "your", "yours", "he", "she", "it", "they", "them", "their", "his", "her",
  "this", "that", "these", "those", "there", "here", "what", "who", "whom", "whose",
  "when", "where", "why", "how", "which", "and", "but", "or", "so", "if", "then",
  "just", "also", "very", "really", "still", "now", "today", "yesterday", "tomorrow",
  "tonight", "later", "soon", "again", "well", "yeah", "yes", "no", "ok", "okay",
  "hey", "hi", "hello", "thanks", "thank", "please", "sorry", "sure", "cool", "nice",
  // time / quantifiers / misc capitalized in notes
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december", "am", "pm", "monday",
  // interaction verbs that get capitalized after a sentence break
  "met", "meet", "meeting", "saw", "see", "seen", "talked", "talk", "spoke", "speak",
  "called", "call", "coffee", "lunch", "lunches", "dinner", "dinners", "breakfast",
  "ran", "run", "running", "grabbed", "grab", "hung", "caught", "catch", "chatted",
  "chat", "introduced", "intro", "emailed", "email", "dmed", "dm", "texted", "text",
  "messaged", "pinged", "followed", "follow", "connected", "connected", "introed",
  "hangout", "hang", "sync", "standup", "demo", "onboard", "interview", "hired",
  "hiring", "promised", "promote", "todo", "note", "notes", "quick", "update",
  "followup", "follow-up", "reminder", "nudge", "nudges", "lessons", "idea", "ideas",
  // filler particles that follow "w/" and similar
  "up", "out", "off", "over", "back", "down", "away", "in", "on", "at", "to", "of",
  "for", "with", "about", "from", "by", "as", "is", "was", "are", "were", "be",
  "am", "im", "dont", "doesnt", "didnt", "cant", "wont", "isnt", "arent", "wasnt",
  "got", "get", "gets", "getting", "went", "going", "gone", "came", "coming",
  "wanna", "gonna", "lemme", "lets", "let", "us", "ur", "pls", "plz", "thx", "asap",
  // auxiliaries / very common sentence-initial verbs (capitalized after ". " or
  // at the start of a quick note, but never a person)
  "had", "have", "has", "having", "been", "being", "does", "did", "doing",
  "can", "could", "will", "would", "should", "shall", "may", "might", "must",
  "need", "needs", "needed", "want", "wants", "wanted", "make", "makes", "made",
  "take", "takes", "took", "give", "gives", "gave", "find", "finds", "found",
  "think", "thinks", "thought", "know", "knows", "knew", "seem", "seems",
  "feel", "feels", "felt", "keep", "keeps", "kept", "put", "puts", "try",
  "tries", "tried", "ask", "asks", "asked", "seem", "help", "helps", "helped",
  "met", "meet", "meeting", "saw", "see", "heard", "hear", "told", "tell",
  "spent", "spend", "left", "leave", "lost", "lose", "won", "win", "bought",
  "buy", "sold", "sell", "built", "build", "sent", "send", "read", "write",
  "wrote", "woken", "worked", "works", "working", "looking", "look", "looked",
  "trying", "use", "used", "using", "need", "needs", "wanted", "thanks",
].map((w) => w.toLowerCase()));

/**
 * Interaction verbs, matched case-insensitively by writing explicit character
 * classes instead of using the /i flag. Reason: NAME_CORE appears inside the
 * same pattern and MUST stay case-sensitive — with /i, "saw Priya today"
 * captured "Priya today" as a single span, which corrupts the copied value.
 */
const INTERACTION_VERBS = [
  "[Mm][Ee][Tt]", "[Mm][Ee][Tt]ing with", "[Ss][Aa][Ww]", "[Ss][Ee][Ee]",
  "[Gg][Rr][Aa][Bb][Bb]?[Ee][Dd] coffee", "[Cc][Oo][Ff][Ff][Ee][Ee] with",
  "[Ll][Uu][Nn][Cc][Hh](?:[Ee][Dd])? with", "[Dd][Ii][Nn][Nn][Ee][Rr](?:[Ee][Dd])? with",
  "[Hh][Aa][Nn][Gg](?:[Ii][Nn][Gg])? out with", "[Hh][Uu][Nn][Gg] out with",
  "[Rr][Aa][Nn] into", "[Tt][Aa][Ll][Kk][Ee][Dd] to",
  "[Ss][Pp][Oo][Kk][Ee] (?:to|with)", "[Cc][Hh][Aa][Tt][Tt][Ee][Dd] (?:to|with)",
  "[Cc][Aa][Uu][Gg][Hh][Tt] up with", "[Ii][Nn][Tt][Rr][Oo][Dd][Uu][Cc][Ee][Dd] to",
  "[Cc][Oo][Nn][Nn][Ee][Cc][Tt][Ee][Dd] with", "[Dd][Mm]'?[Dd]",
  "[Ee][Mm][Aa][Ii][Ll][Ee][Dd]", "[Cc][Aa][Ll][Ll][Ee][Dd]",
  "[Tt][Ee][Xx][Tt][Ee][Dd]", "[Mm][Ee][Ss][Ss][Aa][Gg][Ee][Dd]", "[Pp][Ii][Nn][Gg][Ee][Dd]",
].join("|");

/** A token that is a name-ish candidate: 2+ letters, not a stopword, not a number. */
function isCandidateToken(token: string): boolean {
  const bare = token.replace(/[^\p{L}\s'-]/gu, "").trim();
  if (bare.length < 2) return false;
  if (/^\d+$/.test(bare)) return false;
  return !NAME_STOPLIST.has(bare.toLowerCase());
}

/**
 * Code-side candidate finder for the Jev person-resolution question.
 *
 * Design: **over-find, never gate.** A false positive costs one wasted option;
 * a false negative silently drops the person's facts, commitments and profile
 * (observed in production). So this returns every plausible name-ish span —
 * honorific-prefixed runs, capitalized runs of 1-3 tokens, and verb-adjacent
 * spans — and lets Jev choose among them (the pre-parsed value-extraction
 * pattern: the model selects, code copies verbatim).
 */
export function findPersonSpans(text: string): string[] {
  const { strong, weak } = collectSpans(text);
  const seen = new Set(strong.map((s) => s.toLowerCase()));
  return [...strong, ...weak.filter((w) => !seen.has(w.toLowerCase()))];
}

/**
 * High-precision spans only (interaction verb, honorific, or a person
 * predicate like "X runs/leads/is"). Used by the no-judge fallback, where
 * there is no model to reject a place name or a sentence-initial verb.
 */
export function findStrongPersonSpans(text: string): string[] {
  return collectSpans(text).strong;
}

function collectSpans(text: string): { strong: string[]; weak: string[] } {
  const seen = new Set<string>();
  const strong: string[] = [];
  const weak: string[] = [];
  const push = (raw: string | undefined, tier: "strong" | "weak") => {
    let span = (raw ?? "").replace(/\s+/g, " ").trim().replace(/^[-–—,:;.!?]+\s*/, "");
    if (!span) return;
    const words = span.split(" ").filter(Boolean);
    // Drop stopwords from the FRONT only ("up w/ Dr. Lena" -> "Dr. Lena Ortiz").
    while (words.length > 1 && !isCandidateToken(words[0] as string)) words.shift();
    if (words.length === 0) return;
    span = words.join(" ");
    if (!isCandidateToken(span)) return;
    const key = span.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    (tier === "strong" ? strong : weak).push(span);
  };

  // 1. Interaction verbs (informal variants included — "met up w/", "saw").
  const verbRe = new RegExp(
    `\\b(?:${INTERACTION_VERBS})\\s+(?:up\\s+with\\s+|out\\s+with\\s+|w/\\s*)?((?:${HONORIFIC})?${NAME_CORE})`,
    "g",
  );
  for (const m of text.matchAll(verbRe)) push(m[1], "strong");

  // 2. Honorific is a strong signal even without a verb: "Dr. Lena Ortiz called".
  const honorificRe = new RegExp(`(${HONORIFIC}${NAME_CORE})`, "g");
  for (const m of text.matchAll(honorificRe)) push(m[1], "strong");

  // 3. "X is / works / runs / said / …" subjects (up to two tokens so that
  //    "Tomás Silva runs" yields "Tomás Silva", not just "Silva").
  const subjRe = new RegExp(
    `\\b((?:${HONORIFIC})?[A-ZÀ-Ý][a-zà-ÿ]+(?:\\s+[A-ZÀ-Ý][a-zà-ÿ]+)?)\\s+(?:is|was|works?|said|mentioned|runs?|leads?|founded|started|joined|left|owns?|builds?|wants?|prefers?|hiring|needs?)`,
    "g",
  );
  for (const m of text.matchAll(subjRe)) push(m[1], "strong");

  // 4. Dejavu net: ANY capitalized token or capitalized run (1-3 tokens).
  //    Sentence-initial single tokens are kept too — Jev decides; over-finding
  //    is cheap, and "Priya today - she's hiring" starts with a name.
  const runRe = new RegExp(
    `[A-ZÀ-Ý][a-zà-ÿ]+(?:\\s+(?:van|von|de|del|da|di|bin|al)?\\s*[A-ZÀ-Ý][a-zà-ÿ]+){0,2}`,
    "g",
  );
  for (const m of text.matchAll(runRe)) push(m[0], "weak");

  return { strong, weak };
}

/**
 * Pick which person a memory is primarily about.
 *
 * Candidates MUST be pre-parsed by code: existing roster names + name-like
 * spans detected in the text. The answer is always one of those spans copied
 * verbatim (or the none hatch) — Jev cannot invent a name.
 */
export async function resolvePersonName(
  text: string,
  candidates: string[],
): Promise<{ name: string | null; confidence: number } | null> {
  const c = getClient();
  if (!c) return null;
  const seen = new Set<string>();
  const options = candidates
    .map((s) => s.trim())
    .filter((s) => s.length > 1 && !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase()))
    .slice(0, 60);
  if (options.length === 0) return null;
  const criteria: Record<string, string | null> = {};
  for (const o of options) criteria[o] = null;
  criteria[NO_MATCH] =
    "The memory is not primarily about any listed person (no identifiable person, or someone not listed).";
  try {
    const { answers, usage } = await c.systemOne(
      {
        state: text.slice(0, 2000),
        questions: {
          person: choice(
            "Which person is this memory primarily about — the person the user met, spoke with, or is reporting on? Do NOT pick someone who is merely mentioned for an intro, referral, or comparison.",
            criteria,
          ),
        },
      },
      { timeout: CALL_TIMEOUT_MS },
    );
    const a = answers.person;
    log.info("judge_person", {
      choice: a.choice,
      confidence: a.confidence,
      candidates: options.length,
      inputTokens: usage.input_tokens,
    });
    if (a.choice === NO_MATCH) return { name: null, confidence: a.confidence };
    return { name: a.choice, confidence: a.confidence };
  } catch (err) {
    log.warn("judge_person_failed", { error: String(err) });
    return null;
  }
}

// --- 3. Relevance ranking (one batched call) ---------------------------------

export interface ScoredCandidate {
  id: string;
  score: number;
}

/**
 * Score each candidate memory against the question — one systemOne call with
 * one Noul per pair, sorted highest-first. This replaces the generative
 * reranker: calibrated probabilities instead of a parsed index list.
 */
export async function scoreRelevance(
  question: string,
  candidates: { id: string; text: string }[],
): Promise<ScoredCandidate[] | null> {
  const c = getClient();
  if (!c) return null;
  const pool = candidates.slice(0, 12);
  if (pool.length === 0) return [];
  const questions: Record<string, ReturnType<typeof noul>> = {};
  pool.forEach((_m, i) => {
    questions[`rel_${i}`] = noul(
      `Consider ONLY the memory at \`memories[${i}]\`. Does that memory answer the question at \`question\`, or identify a person the question asks about? A memory that merely mentions a related topic without answering does NOT count.`,
    );
  });
  try {
    const { answers, usage } = await c.systemOne(
      {
        state: {
          question: question.slice(0, 1000),
          memories: pool.map((m, i) => ({ key: `rel_${i}`, text: m.text.slice(0, 800) })),
        },
        questions,
      },
      { timeout: CALL_TIMEOUT_MS },
    );
    const scored = pool.map((m, i) => ({
      id: m.id,
      score: (answers[`rel_${i}`]?.noul ?? 0) as number,
    }));
    scored.sort((a, b) => b.score - a.score);
    log.info("judge_rerank", {
      candidates: pool.length,
      top: scored[0]?.score ?? null,
      inputTokens: usage.input_tokens,
    });
    return scored;
  } catch (err) {
    log.warn("judge_rerank_failed", { error: String(err) });
    return null;
  }
}

// --- 4. Citation verification (one batched call) ------------------------------

export type CitationVerdict = "verified" | "contradicted" | "unsupported";

export async function verifyCitations(
  items: { id: string; claim: string; source: string }[],
): Promise<Record<string, { verdict: CitationVerdict; confidence: number }> | null> {
  const c = getClient();
  if (!c || items.length === 0) return items.length === 0 ? {} : null;
  const pool = items.slice(0, 8);
  const questions: Record<string, ReturnType<typeof choice>> = {};
  pool.forEach((_item, i) => {
    questions[`cite_${i}`] = choice(
      `Consider ONLY the pair at \`pairs[${i}]\`. How does its source text relate to the answer?`,
      {
        supports:
          "The source is consistent with the answer and contributes evidence for it. For a multi-part answer (a count, a list, several people), the source only needs to support the part about the person or fact it mentions.",
        contradicts:
          "The source contradicts the answer — it says something incompatible with what the answer claims.",
        says_nothing:
          "The source neither supports nor contradicts the answer; it is about something else.",
      },
    );
  });
  try {
    const { answers, usage } = await c.systemOne(
      {
        state: {
          pairs: pool.map((item, i) => ({
            key: `cite_${i}`,
            claim: item.claim.slice(0, 600),
            source: item.source.slice(0, 1200),
          })),
        },
        questions,
      },
      { timeout: CALL_TIMEOUT_MS },
    );
    const out: Record<string, { verdict: CitationVerdict; confidence: number }> = {};
    pool.forEach((item, i) => {
      const a = answers[`cite_${i}`];
      const verdict =
        a?.choice === "supports"
          ? "verified"
          : a?.choice === "contradicts"
            ? "contradicted"
            : "unsupported";
      out[item.id] = { verdict, confidence: a?.confidence ?? 0 };
    });
    log.info("judge_citations", {
      checked: pool.length,
      verified: Object.values(out).filter((v) => v.verdict === "verified").length,
      inputTokens: usage.input_tokens,
    });
    return out;
  } catch (err) {
    log.warn("judge_citations_failed", { error: String(err) });
    return null;
  }
}
