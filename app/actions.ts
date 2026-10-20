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
  recall,
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
