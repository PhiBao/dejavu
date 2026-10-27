"use server";

import { after } from "next/server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  findOrCreateUser,
  setSessionCookie,
  clearSessionCookie,
  requireUserId,
} from "@/lib/auth";
import {
  captureMemory,
  consolidatePerson,
  correctFact,
  correctMemory,
  forgetFact,
  forgetMemory,
  mergePeople,
  recall,
  rebuildWorkspaceFromWalrus,
  recordMemoryFeedback,
  snoozePerson,
  updateCommitmentStatus,
} from "@/lib/memory";
import { userActionLimiter } from "@/lib/rate-limit";
import { log } from "@/lib/log";
import { createApiKey, revokeApiKey } from "@/lib/api-keys";
import { INTENT_MIN_CONFIDENCE, isJudgeConfigured, routeIntent } from "@/lib/judge";
import type { RecallAnswer } from "@/lib/types";

/**
 * Server actions — the only write path from the UI. Every action that touches
 * data first resolves the authenticated user id and scopes all work to it.
 */

const emailSchema = z.string().email().max(254);
const nameSchema = z.string().min(1).max(120).optional();

export async function signInAction(formData: FormData): Promise<void> {
  const email = emailSchema.safeParse(formData.get("email"));
  if (!email.success) {
    redirect("/?error=invalid_email");
  }
  const name = nameSchema.safeParse(formData.get("name") || undefined);
    const userId = await findOrCreateUser(
      email.data,
      name.success ? name.data : undefined,
    );
    await setSessionCookie(userId);
    log.info("sign_in", { userId });
    redirect("/workspace");
}

export async function signOutAction(): Promise<void> {
  await clearSessionCookie();
  redirect("/");
}

const captureSchema = z.string().min(1).max(4000);

export async function captureAction(rawText: string): Promise<
  | {
      ok: true;
      summary: string;
      person: string | null;
      personSource: string;
      personConfidence: number | null;
      factsAdded: number;
      commitmentsAdded: number;
      walrusState: "certified" | "pending" | "unavailable";
      writtenBy: string;
    }
  | { ok: false; error: string }
> {
  const userId = await requireUserId();
  try {
    if (!userActionLimiter.check(userId)) {
      return { ok: false, error: "You're saving memories quickly — please slow down a moment." };
    }
    const parsed = captureSchema.safeParse(rawText);
    if (!parsed.success) return { ok: false, error: "Please write a little more." };
    // Fast capture: respond after the Walrus accept (~500ms); the blob
    // certification backfills via after() without blocking the user.
    const result = await captureMemory(userId, parsed.data, {
      defer: (task) => after(() => task),
    });
    revalidatePath("/workspace");
    log.info("capture", { userId, memoryId: result.memory.id, facts: result.factsAdded, commitments: result.commitmentsAdded });
    return {
      ok: true,
      summary: result.summary,
      person: result.person?.name ?? null,
      personSource: result.personSource,
      personConfidence: result.personConfidence,
      factsAdded: result.factsAdded,
      commitmentsAdded: result.commitmentsAdded,
      walrusState: result.walrusState,
      writtenBy: result.writtenBy,
    };
  } catch (err) {
    log.error("capture_failed", { userId, error: err instanceof Error ? err.message : String(err) });
    return { ok: false, error: "Something went wrong saving that memory." };
  }
}

/**
 * Load the eight demo stories through the real capture pipeline.
 *
 * Each one is a genuine capture: Bedrock extraction, Jev judgments, and an
 * encrypted blob on Walrus mainnet under this user's namespace. Guarded so it
 * only runs for an account with nothing to show yet.
 */
export async function seedDemoAction(): Promise<
  | { ok: true; captured: number; people: number; blobs: number }
  | { ok: false; error: string }
> {
  const userId = await requireUserId();
  try {
    if (!userActionLimiter.check(userId)) {
      return { ok: false, error: "Slow down — try the demo again in a moment." };
    }
    const { recentMemories } = await import("@/lib/memory");
    if ((await recentMemories(userId, 1)).length > 0) {
      return { ok: false, error: "You already have memories — nothing to load." };
    }
    const { seedDemoMemories } = await import("@/lib/demo-stories");
    const res = await seedDemoMemories(userId);
    log.info("seed_demo", { userId, ...res });
    revalidatePath("/workspace");
    return { ok: true, ...res };
  } catch (err) {
    log.error("seed_demo_failed", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: "Could not load the demo. Try again." };
  }
}

const recallSchema = z.string().min(1).max(4000);

export async function routeAction(
  rawText: string,
): Promise<{ ok: true; intent: "remember" | "recall"; confidence: number } | { ok: false }> {
  try {
    await requireUserId();
    if (!isJudgeConfigured()) return { ok: false };
    const text = recallSchema.parse(rawText);
    const routed = await routeIntent(text);
    if (!routed || routed.confidence < INTENT_MIN_CONFIDENCE) return { ok: false };
    return { ok: true, intent: routed.intent, confidence: routed.confidence };
  } catch {
    return { ok: false };
  }
}

export async function recallAction(
  question: string,
): Promise<{ ok: true; result: RecallAnswer } | { ok: false; error: string }> {
  const userId = await requireUserId();
  try {
    if (!userActionLimiter.check(userId)) {
      return { ok: false, error: "You're asking a lot of questions — give it a beat." };
    }
    const parsed = recallSchema.safeParse(question);
    if (!parsed.success) return { ok: false, error: "Please ask a question." };
    const result = await recall(userId, parsed.data);
    log.info("recall", { userId, citations: result.citations.length });
    return { ok: true, result };
  } catch (err) {
    log.error("recall_failed", { userId, error: err instanceof Error ? err.message : String(err) });
    return { ok: false, error: "Something went wrong searching your memory." };
  }
}

const idSchema = z.string().uuid();
const valueSchema = z.string().min(1).max(500);

/**
 * Correct a memory. The old version is retired (kept as history) and the new
 * text goes through the full capture pipeline, including a fresh Walrus blob.
 */
export async function correctMemoryAction(
  memoryId: string,
  rawText: string,
): Promise<{ ok: true; summary: string } | { ok: false; error: string }> {
  const userId = await requireUserId();
  try {
    if (!userActionLimiter.check(userId)) {
      return { ok: false, error: "Slow down — try again in a moment." };
    }
    const id = idSchema.parse(memoryId);
    const parsed = captureSchema.safeParse(rawText);
    if (!parsed.success) return { ok: false, error: "Please write a little more." };
    const result = await correctMemory(userId, id, parsed.data);
    if (!result) return { ok: false, error: "That memory can no longer be corrected." };
    revalidatePath("/workspace", "layout");
    if (result.person) revalidatePath(`/workspace/person/${result.person.id}`);
    log.info("correct_memory", { userId, memoryId: id, newMemoryId: result.memory.id });
    return { ok: true, summary: result.summary };
  } catch (err) {
    log.error("correct_memory_failed", {
      userId,
      memoryId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: "Could not correct that memory." };
  }
}

export async function forgetMemoryAction(
  memoryId: string,
): Promise<{ ok: boolean }> {
  const userId = await requireUserId();
  try {
    const id = idSchema.parse(memoryId);
    const ok = await forgetMemory(userId, id);
    revalidatePath("/workspace", "layout");
    log.info("forget_memory", { userId, memoryId: id, ok });
    return { ok };
  } catch (err) {
    log.error("forget_memory_failed", {
      userId,
      memoryId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false };
  }
}

/** Correct one current fact. Creates a durable correction memory on Walrus. */
export async function correctFactAction(
  factId: string,
  value: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const userId = await requireUserId();
  try {
    if (!userActionLimiter.check(userId)) {
      return { ok: false, error: "Slow down — try again in a moment." };
    }
    const id = idSchema.parse(factId);
    const parsed = valueSchema.safeParse(value);
    if (!parsed.success) return { ok: false, error: "Enter a value to save." };
    const result = await correctFact(userId, id, parsed.data);
    if (!result) return { ok: false, error: "That detail can no longer be corrected." };
    revalidatePath("/workspace", "layout");
    log.info("correct_fact", { userId, factId: id, newFactId: result.fact.id });
    return { ok: true };
  } catch (err) {
    log.error("correct_fact_failed", {
      userId,
      factId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: "Could not correct that detail." };
  }
}

export async function forgetFactAction(
  factId: string,
): Promise<{ ok: boolean }> {
  const userId = await requireUserId();
  try {
    const id = idSchema.parse(factId);
    const ok = await forgetFact(userId, id);
    revalidatePath("/workspace", "layout");
    log.info("forget_fact", { userId, factId: id, ok });
    return { ok };
  } catch (err) {
    log.error("forget_fact_failed", {
      userId,
      factId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false };
  }
}

/** Merge a duplicate person into the current profile. */
export async function mergePeopleAction(
  primaryId: string,
  duplicateId: string,
): Promise<{ ok: true; personId: string } | { ok: false; error: string }> {
  const userId = await requireUserId();
  try {
    const primary = idSchema.parse(primaryId);
    const duplicate = idSchema.parse(duplicateId);
    if (primary === duplicate) {
      return { ok: false, error: "Those are the same person." };
    }
    const person = await mergePeople(userId, primary, duplicate);
    if (!person) return { ok: false, error: "Could not merge those people." };
    revalidatePath("/workspace", "layout");
    revalidatePath(`/workspace/person/${primary}`);
    log.info("merge_people", { userId, primaryId: primary, duplicateId: duplicate });
    return { ok: true, personId: person.id };
  } catch (err) {
    log.error("merge_people_failed", {
      userId,
      primaryId,
      duplicateId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: "Could not merge those people." };
  }
}

const feedbackSchema = z.enum(["useful", "wrong", "outdated"]);

/**
 * Explicit feedback on a citation. "Useful" boosts the memory; "wrong" and
 * "outdated" retire it from future answers.
 */
export async function feedbackAction(
  memoryId: string,
  verdict: string,
  question?: string,
): Promise<{ ok: boolean; retired?: boolean }> {
  const userId = await requireUserId();
  try {
    const id = idSchema.parse(memoryId);
    const v = feedbackSchema.parse(verdict);
    const ok = await recordMemoryFeedback(
      userId,
      id,
      v,
      question?.slice(0, 500) ?? null,
    );
    revalidatePath("/workspace", "layout");
    log.info("memory_feedback", { userId, memoryId: id, verdict: v, ok });
    return { ok, retired: v !== "useful" };
  } catch (err) {
    log.error("memory_feedback_failed", {
      userId,
      memoryId,
      verdict,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false };
  }
}

const statusSchema = z.enum(["done", "snoozed", "dismissed"]);

export async function commitmentAction(
  commitmentId: string,
  status: string,
): Promise<{ ok: boolean }> {
  const userId = await requireUserId();
  try {
    const s = statusSchema.parse(status);
    const id = z.string().uuid().parse(commitmentId);
    await updateCommitmentStatus(userId, id, s);
    revalidatePath("/workspace");
    log.info("commitment_status", { userId, commitmentId: id, status: s });
    return { ok: true };
  } catch (err) {
    log.error("commitment_status_failed", { userId, commitmentId, status, error: err instanceof Error ? err.message : String(err) });
    return { ok: false };
  }
}

/** Consolidate a person into a canonical brief and write it back to Walrus. */
export async function consolidatePersonAction(
  personId: string,
): Promise<
  | { ok: true; briefId: string; blobId: string | null }
  | { ok: false; error: string }
> {
  const userId = await requireUserId();
  try {
    if (!userActionLimiter.check(userId)) {
      return { ok: false, error: "Slow down — try again in a moment." };
    }
    const id = idSchema.parse(personId);
    const brief = await consolidatePerson(userId, id);
    if (!brief) return { ok: false, error: "There is nothing to consolidate yet." };
    revalidatePath("/workspace", "layout");
    log.info("consolidate_person", {
      userId,
      personId: id,
      briefId: brief.id,
      blobId: brief.walrus_blob_id,
    });
    return { ok: true, briefId: brief.id, blobId: brief.walrus_blob_id };
  } catch (err) {
    log.error("consolidate_person_failed", {
      userId,
      personId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: "Could not consolidate that person." };
  }
}

/** Rebuild people/facts/follow-ups from the enriched blobs on Walrus. */
export async function rebuildWorkspaceAction(): Promise<
  | {
      ok: true;
      memories: number;
      people: number;
      facts: number;
      commitments: number;
      skipped: number;
      scanned: number;
    }
  | { ok: false; error: string }
> {
  const userId = await requireUserId();
  try {
    if (!userActionLimiter.check(userId)) {
      return { ok: false, error: "Slow down — try again in a moment." };
    }
    const result = await rebuildWorkspaceFromWalrus(userId);
    revalidatePath("/workspace", "layout");
    log.info("rebuild_from_walrus", { userId, ...result });
    return { ok: true, ...result };
  } catch (err) {
    log.error("rebuild_from_walrus_failed", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, error: "Could not rebuild from Walrus." };
  }
}

/** Snooze a stale relationship: create a real follow-up in 14 days. */
export async function reconnectAction(
  personId: string,
  days = 14,
): Promise<{ ok: boolean }> {
  const userId = await requireUserId();
  try {
    const id = idSchema.parse(personId);
    const wait = Math.min(Math.max(Math.trunc(days), 1), 90);
    const ok = await snoozePerson(userId, id, wait);
    revalidatePath("/workspace", "layout");
    log.info("snooze_person", { userId, personId: id, days: wait, ok });
    return { ok };
  } catch (err) {
    log.error("snooze_person_failed", {
      userId,
      personId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false };
  }
}

const apiKeyNameSchema = z.string().min(1).max(60).optional();

/** Generate a new API key. The raw key is returned once — show it to the user. */
export async function generateApiKeyAction(
  name?: string,
): Promise<{ ok: true; rawKey: string; prefix: string } | { ok: false; error: string }> {
  const userId = await requireUserId();
  try {
    if (!userActionLimiter.check(userId)) {
      return { ok: false, error: "Slow down — you're doing too much right now." };
    }
    const parsed = apiKeyNameSchema.safeParse(name);
    const label = parsed.success && parsed.data ? parsed.data : "default";
    const key = await createApiKey(userId, label);
    revalidatePath("/workspace");
    return { ok: true, rawKey: key.rawKey, prefix: key.prefix };
  } catch (err) {
    log.error("api_key_generate_failed", { userId, error: err instanceof Error ? err.message : String(err) });
    return { ok: false, error: "Could not create an API key." };
  }
}

/** Revoke an API key. */
export async function revokeApiKeyAction(
  keyId: string,
): Promise<{ ok: boolean }> {
  const userId = await requireUserId();
  try {
    const id = z.string().uuid().parse(keyId);
    await revokeApiKey(userId, id);
    revalidatePath("/workspace");
    return { ok: true };
  } catch (err) {
    log.error("api_key_revoke_failed", { userId, keyId, error: err instanceof Error ? err.message : String(err) });
    return { ok: false };
  }
}
