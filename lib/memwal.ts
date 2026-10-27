import { MemWal } from "@mysten-incubation/memwal";
import { env } from "./env";
import { log } from "./log";

/**
 * Walrus Memory client — the durable memory layer.
 *
 * One operator MemWalAccount (created once at https://memory.walrus.xyz)
 * pays for storage and owns all blobs. Per-user isolation follows the
 * multi-tenant cookbook: every app user gets their own namespace
 * (`recall-<userId>`), and the server maps the authenticated session to the
 * namespace on every call. The delegate key never leaves the server.
 *
 * When credentials are absent (local dev without a Walrus account, CI), every
 * helper degrades gracefully: writes resolve with `blobId: null` and reads
 * return `[]`, so the app keeps running on its local projection. The domain
 * layer (lib/memory.ts) falls back to keyword search in that case.
 */

let client: MemWal | null = null;

export function isMemwalConfigured(): boolean {
  try {
    const e = env();
    return !!(e.MEMWAL_PRIVATE_KEY && e.MEMWAL_ACCOUNT_ID);
  } catch {
    return false;
  }
}

/** Deterministic per-user namespace. Dejavu/restore match it exactly. */
export function userNamespace(userId: string): string {
  return `recall-${userId.toLowerCase()}`;
}

function getClient(): MemWal | null {
  if (!isMemwalConfigured()) return null;
  if (!client) {
    const e = env();
    client = MemWal.create({
      key: e.MEMWAL_PRIVATE_KEY as string,
      accountId: e.MEMWAL_ACCOUNT_ID as string,
      serverUrl: e.MEMWAL_SERVER_URL,
      namespace: "recall",
    });
  }
  return client;
}

/** Test helper: drop the cached client (e.g. after changing env). */
export function __clearMemwalClient(): void {
  client = null;
}

// --- Blob links ------------------------------------------------------------
// Mysten Labs reference aggregators (docs.wal.app network reference).
// Anyone can GET a blob; ours are Seal-encrypted, so fetching proves
// existence while reading requires the owner's delegate key.

const MAINNET_AGGREGATOR = "https://aggregator.walrus-mainnet.walrus.space";
const TESTNET_AGGREGATOR = "https://aggregator.walrus-testnet.walrus.space";

/** Public read URL for a blob id (returns ciphertext for our memories). */
export function walrusBlobUrl(blobId: string): string {
  const serverUrl = (() => {
    try {
      return env().MEMWAL_SERVER_URL;
    } catch {
      return MAINNET_AGGREGATOR;
    }
  })();
  const base = serverUrl.includes("staging") ? TESTNET_AGGREGATOR : MAINNET_AGGREGATOR;
  return `${base}/v1/blobs/${blobId}`;
}

/** Short display form of a blob id, e.g. "aQsNm9…XZs". */
export function shortBlobId(blobId: string): string {
  return blobId.length > 12 ? `${blobId.slice(0, 6)}…${blobId.slice(-3)}` : blobId;
}

/**
 * Fast path: submit a memory and return the job id immediately (~1s) without
 * waiting for certification. Pair with walrusAwaitBlob() — in a request
 * handler, hand the wait to after() so the user never blocks on it.
 *
 * Retries once on failure: the relayer rate-limits per account (a burst of
 * demo captures can trip it), and silently losing a blob to a transient
 * rejection is exactly the kind of degradation this product must not have.
 */
export async function walrusRememberAsync(
  userId: string,
  text: string,
): Promise<{ jobId: string | null; attempts: number }> {
  const c = getClient();
  if (!c) return { jobId: null, attempts: 0 };
  let attempts = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    attempts++;
    try {
      const accepted = await c.remember(text, userNamespace(userId));
      if (attempt > 0) log.info("walrus_remember_recovered", { attempts });
      return { jobId: accepted.job_id ?? null, attempts };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn("walrus_remember_attempt_failed", { attempt, error: message });
      if (attempt === 0) await new Promise((r) => setTimeout(r, 1200));
    }
  }
  return { jobId: null, attempts };
}

/** Wait for an accepted remember job to certify; null when it fails. */
export async function walrusAwaitBlob(
  jobId: string,
  timeoutMs = 90_000,
): Promise<{ blobId: string | null }> {
  const c = getClient();
  if (!c) return { blobId: null };
  try {
    const res = await c.waitForRememberJob(jobId, { timeoutMs });
    const blobId = res.blob_id && res.blob_id.length > 0 ? res.blob_id : null;
    return { blobId };
  } catch (err) {
    log.warn("walrus_await_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { blobId: null };
  }
}

export interface WalrusHit {
  text: string;
  blobId: string | null;
  distance: number;
}

/** Semantic recall over the user's Walrus namespace. Empty when offline. */
export async function walrusRecall(
  userId: string,
  query: string,
  limit = 6,
): Promise<WalrusHit[]> {
  const c = getClient();
  if (!c) return [];
  try {
    const res = await c.recall({
      query,
      limit,
      namespace: userNamespace(userId),
    });
    return res.results.map((m) => ({
      text: m.text,
      blobId: m.blob_id ?? null,
      distance: typeof m.distance === "number" ? m.distance : 1,
    }));
  } catch (err) {
    log.warn("walrus_recall_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

export interface WalrusRestoreResult {
  restored: number;
  skipped: number;
  failed: number;
  total: number;
  /** True when the relayer knows the restore was incomplete (cap or transient). */
  truncated: boolean;
}

/** Rebuild the relayer index for a user's namespace from Walrus blobs. */
export async function walrusRestore(
  userId: string,
  limit = 50,
): Promise<WalrusRestoreResult | null> {
  const c = getClient();
  if (!c) return null;
  try {
    const res = await c.restore(userNamespace(userId), limit);
    return {
      restored: res.restored,
      skipped: res.skipped ?? 0,
      failed: res.failed ?? 0,
      total: res.total,
      truncated: res.truncated ?? false,
    };
  } catch (err) {
    log.warn("walrus_restore_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function walrusHealth(): Promise<{
  configured: boolean;
  reachable: boolean;
  latencyMs: number | null;
}> {
  if (!isMemwalConfigured()) {
    return { configured: false, reachable: false, latencyMs: null };
  }
  const c = getClient();
  if (!c) return { configured: true, reachable: false, latencyMs: null };
  const started = Date.now();
  try {
    await c.health();
    return { configured: true, reachable: true, latencyMs: Date.now() - started };
  } catch {
    return { configured: true, reachable: false, latencyMs: null };
  }
}
