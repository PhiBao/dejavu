import { env } from "./env";
import { log } from "./log";

/**
 * Tatum Sui RPC — independent onchain verification for Dejavu's memory layer.
 *
 * Why this exists: Walrus Memory's relayer is trustworthy, but "trust me" is
 * not proof. Everything Dejavu claims about persistence can be checked
 * directly on Sui through a second provider:
 *
 *   1. WALRUS SYSTEM  — current epoch, shard count, capacity, storage price.
 *   2. MEMWAL ACCOUNT — owner, active flag, and the delegate keys registered
 *      onchain (we verify OUR configured key is one of them).
 *   3. BLOB OBJECTS   — every memory's Walrus `Blob` object: certification
 *      epoch, storage window (start → end), size, deletability, object id.
 *
 * That turns three product claims into verifiable facts:
 *   "stored on Walrus"      → the Blob object exists onchain
 *   "the agent is allowed"  → its public key is in MemWalAccount.delegate_keys
 *   "memory won't vanish"   → the storage end_epoch, converted to a real date
 *
 * Degrades gracefully: with no TATUM_API_KEY (or on RPC failure) every helper
 * returns null and the app keeps working on the relayer's word alone.
 */

const MAINNET_RPC = "https://sui-mainnet.gateway.tatum.io";
const MAINNET_WALRUS_SYSTEM =
  "0x2134d52768ea07e8c43570ef975eb3e4c27a39fa6396bef985b5abc58d03ddd2";
/** Walrus mainnet epochs are 2 weeks; the chain doesn't expose the constant. */
export const EPOCH_DAYS = 14;
const BLOB_TYPE_SUFFIX = "::blob::Blob";

const CALL_TIMEOUT_MS = 15_000;
/**
 * Free plan: 3 RPS, shared across the plan ("strategy=shared"), so bursts can
 * 429 even under the nominal limit. Pace at ~2 RPS and back off on 429.
 */
const MIN_REQUEST_SPACING_MS = 500;
const MAX_ATTEMPTS = 4;

export interface TatumConfig {
  apiKey: string;
  rpcUrl: string;
  systemObjectId: string;
  accountId: string;
}

export function tatumConfig(): TatumConfig | null {
  try {
    const e = env();
    if (!e.TATUM_API_KEY) return null;
    return {
      apiKey: e.TATUM_API_KEY,
      rpcUrl: e.TATUM_SUI_RPC_URL,
      systemObjectId: e.TATUM_WALRUS_SYSTEM_OBJECT_ID,
      accountId: e.MEMWAL_ACCOUNT_ID ?? "",
    };
  } catch {
    return null;
  }
}

export function isTatumConfigured(): boolean {
  const c = tatumConfig();
  return !!c?.apiKey;
}

// --- JSON-RPC ---------------------------------------------------------------

interface RpcEnvelope<T> {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: { code: number; message: string };
}

/**
 * One paced queue for EVERY Tatum request (single and batch). The free plan is
 * 3 RPS and *shared* across the plan, so unqueued bursts are the fastest way
 * to a 429 that silently degrades the product.
 */
let requestQueue: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = requestQueue.then(fn);
  requestQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function pace(): Promise<void> {
  const wait = lastRequestAt + MIN_REQUEST_SPACING_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

async function rpc<T>(method: string, params: unknown[]): Promise<T | null> {
  const cfg = tatumConfig();
  if (!cfg) return null;
  return enqueue(() => performRpc<T>(cfg, method, params));
}

async function performRpc<T>(
  cfg: TatumConfig,
  method: string,
  params: unknown[],
): Promise<T | null> {
  let lastError = "unknown";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await pace();

    try {
      const res = await fetch(cfg.rpcUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": cfg.apiKey,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after") ?? 0);
        const backoff = retryAfter > 0 ? retryAfter * 1000 : Math.min(5000, 900 * 2 ** attempt);
        lastError = "HTTP 429 (rate limited)";
        log.warn("tatum_rate_limited", { method, backoffMs: backoff });
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        continue;
      }

      const json = (await res.json()) as RpcEnvelope<T>;
      if (json.error) {
        lastError = json.error.message;
        continue;
      }
      return json.result ?? null;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  log.warn("tatum_rpc_failed", { method, error: lastError });
  return null;
}


// --- Blob id codec ----------------------------------------------------------

/**
 * Walrus blob ids are the uint256 content id encoded as 32 little-endian
 * bytes, base64url, no padding. Verified empirically against mainnet blob
 * objects and the public aggregator.
 */
export function blobIdToDecimal(blobId: string): string | null {
  try {
    const b64 =
      blobId.replace(/-/g, "+").replace(/_/g, "/") +
      "=".repeat((4 - (blobId.length % 4)) % 4);
    const bytes = Buffer.from(b64, "base64");
    if (bytes.length === 0 || bytes.length > 32) return null;
    return BigInt("0x" + Buffer.from([...bytes].reverse()).toString("hex")).toString();
  } catch {
    return null;
  }
}

export function decimalToBlobId(decimal: string): string | null {
  try {
    let n = BigInt(decimal);
    const bytes = Buffer.alloc(32);
    for (let i = 0; i < 32; i++) {
      bytes[i] = Number(n & BigInt(255));
      n >>= BigInt(8);
    }
    return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  } catch {
    return null;
  }
}

// --- Onchain shapes ---------------------------------------------------------

export interface WalrusSystemState {
  epoch: number;
  nShards: number;
  totalCapacityBytes: number;
  usedCapacityBytes: number;
  storagePricePerUnit: number;
  writePricePerUnit: number;
  epochDays: number;
}

export interface DelegateKeyOnchain {
  label: string;
  publicKeyHex: string;
  suiAddress: string;
  createdAt: number;
}

export interface MemWalAccountOnchain {
  objectId: string;
  owner: string;
  active: boolean;
  quarantined: boolean;
  createdAt: number;
  delegates: DelegateKeyOnchain[];
}

export interface BlobOnchain {
  objectId: string;
  blobId: string;
  sizeBytes: number;
  registeredEpoch: number;
  certifiedEpoch: number | null;
  startEpoch: number;
  endEpoch: number;
  deletable: boolean;
}

// --- Credit budget ---------------------------------------------------------
// The free plan carries 100K credits (lifetime, not monthly) and auto-upgrades
// when exhausted, so an unbounded poller could spend the user's money. This
// keeps Dejavu inside the free tier by construction: a hard hourly request
// budget, after which we serve the last known good values instead of asking.

const CREDIT_BUDGET_PER_HOUR = 120;
let creditsThisHour = 0;
let budgetWindowStart = Date.now();

function takeCredit(): boolean {
  const now = Date.now();
  if (now - budgetWindowStart > 3600_000) {
    budgetWindowStart = now;
    creditsThisHour = 0;
  }
  if (creditsThisHour >= CREDIT_BUDGET_PER_HOUR) return false;
  creditsThisHour++;
  return true;
}

/** Credits spent in the current hour (for the health endpoint). */
export function tatumCreditUsage(): { used: number; budget: number; window: number } {
  return {
    used: creditsThisHour,
    budget: CREDIT_BUDGET_PER_HOUR,
    window: Math.max(0, 3600_000 - (Date.now() - budgetWindowStart)),
  };
}

// --- TTL cache --------------------------------------------------------------
// Epochs change every two weeks and delegation rarely changes, so re-reading
// them per request would burn the free plan's credits (and 3 RPS) for nothing.

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry<unknown>>();

async function cached<T>(key: string, ttlMs: number, load: () => Promise<T | null>): Promise<T | null> {
  const hit = cache.get(key) as CacheEntry<T> | undefined;
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  if (!takeCredit()) {
    // Budget spent: serve the stale value rather than spending more.
    return hit?.value ?? null;
  }
  const value = await load();
  if (value !== null) cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

/** Test/ops helper: clear the onchain cache. */
export function clearTatumCache(): void {
  cache.clear();
}

// --- Walrus system state ----------------------------------------------------

interface MoveObject<T> {
  data?: {
    objectId: string;
    content?: { type: string; fields: T };
  };
}

async function getMoveFields<T>(objectId: string): Promise<T | null> {
  const res = await rpc<MoveObject<T>>("sui_getObject", [
    objectId,
    { showContent: true },
  ]);
  return res?.data?.content?.fields ?? null;
}

/**
 * The Walrus system object wraps a versioned state object exposed as a
 * dynamic field. Read that field to get the live epoch and prices.
 * Cached: the epoch advances every two weeks.
 */
export async function getWalrusSystemState(): Promise<WalrusSystemState | null> {
  const cfg = tatumConfig();
  if (!cfg) return null;
  return cached("walrus:system", 15 * 60_000, () => loadWalrusSystemState(cfg));
}

async function loadWalrusSystemState(cfg: TatumConfig): Promise<WalrusSystemState | null> {
  const dyn = await rpc<{
    data?: { objectId: string; objectType?: string }[];
  }>("suix_getDynamicFields", [cfg.systemObjectId, null, 10]);
  const stateField = dyn?.data?.find(
    (f) => typeof f.objectType === "string" && f.objectType.includes("SystemStateInner"),
  );
  if (!stateField) return null;

  const wrapper = await getMoveFields<{
    value?: { fields?: Record<string, unknown> };
  }>(stateField.objectId);
  const inner = wrapper?.value?.fields;
  if (!inner) return null;

  const committee = inner.committee as
    | { fields?: { epoch?: number; n_shards?: number } }
    | undefined;
  const committeeFields = committee?.fields ?? (committee as never);
  const epoch = Number(committeeFields?.epoch ?? NaN);
  if (!Number.isFinite(epoch)) return null;

  return {
    epoch,
    nShards: Number(committeeFields?.n_shards ?? 0),
    totalCapacityBytes: Number(inner.total_capacity_size ?? 0),
    usedCapacityBytes: Number(inner.used_capacity_size ?? 0),
    storagePricePerUnit: Number(inner.storage_price_per_unit_size ?? 0),
    writePricePerUnit: Number(inner.write_price_per_unit_size ?? 0),
    epochDays: EPOCH_DAYS,
  };
}

// --- MemWal account + delegate verification ---------------------------------

export async function getMemWalAccount(): Promise<MemWalAccountOnchain | null> {
  const cfg = tatumConfig();
  if (!cfg?.accountId) return null;
  return cached("memwal:account", 15 * 60_000, () => loadMemWalAccount(cfg));
}

async function loadMemWalAccount(cfg: TatumConfig): Promise<MemWalAccountOnchain | null> {
  const fields = await getMoveFields<{
    owner?: string;
    active?: boolean;
    admin_quarantined?: boolean;
    created_at?: number | string;
    delegate_keys?: {
      fields?: {
        label?: string;
        public_key?: number[];
        sui_address?: string;
        created_at?: number | string;
      };
    }[];
  }>(cfg.accountId);
  if (!fields) return null;

  const delegates: DelegateKeyOnchain[] = (fields.delegate_keys ?? []).map((d) => {
    const f = d.fields ?? {};
    const bytes = Array.isArray(f.public_key) ? f.public_key : [];
    return {
      label: String(f.label ?? ""),
      publicKeyHex: Buffer.from(bytes).toString("hex"),
      suiAddress: String(f.sui_address ?? ""),
      createdAt: Number(f.created_at ?? 0),
    };
  });

  return {
    objectId: cfg.accountId,
    owner: String(fields.owner ?? ""),
    active: fields.active !== false,
    quarantined: fields.admin_quarantined === true,
    createdAt: Number(fields.created_at ?? 0),
    delegates,
  };
}

export interface DelegateCheck {
  registered: boolean;
  matchedAddress: string | null;
  matchedLabel: string | null;
}

/** Is this delegate public key / address registered on the account onchain? */
export function checkDelegate(
  account: MemWalAccountOnchain,
  publicKeyHex: string,
  suiAddress: string,
): DelegateCheck {
  const pk = publicKeyHex.toLowerCase();
  const addr = suiAddress.toLowerCase();
  const hit = account.delegates.find(
    (d) => d.publicKeyHex.toLowerCase() === pk || d.suiAddress.toLowerCase() === addr,
  );
  return {
    registered: !!hit,
    matchedAddress: hit?.suiAddress ?? null,
    matchedLabel: hit?.label ?? null,
  };
}

// --- Blob objects -----------------------------------------------------------

interface OwnedObject {
  data?: {
    objectId: string;
    type?: string;
    content?: {
      fields?: {
        blob_id?: string;
        size?: string;
        registered_epoch?: number;
        certified_epoch?: number | null;
        deletable?: boolean;
        storage?: { fields?: { start_epoch?: number; end_epoch?: number } };
      };
    };
  };
}

/**
 * Every Walrus Blob object owned by `owner`, with metadata.
 *
 * One paged `suix_getOwnedObjects` call with `showContent` returns the Blob
 * fields directly — 60 objects cost two HTTP requests. (Batched JSON-RPC is a
 * paid-plan feature, so the free plan must not rely on it.)
 *
 * Returns a Map keyed by the base64url Walrus blob id.
 */
export async function listOwnedBlobs(owner: string): Promise<Map<string, BlobOnchain>> {
  if (!owner) return new Map();
  const hit = await cached(`blobs:${owner}`, 15 * 60_000, async () => loadOwnedBlobs(owner));
  return hit ?? new Map();
}

async function loadOwnedBlobs(owner: string): Promise<Map<string, BlobOnchain>> {
  const out = new Map<string, BlobOnchain>();
  let cursor: string | null = null;

  for (let page = 0; page < 20; page++) {
    const res: {
      data?: OwnedObject[];
      nextCursor?: string | null;
      hasNextPage?: boolean;
    } | null = await rpc<{
      data?: OwnedObject[];
      nextCursor?: string | null;
      hasNextPage?: boolean;
    }>("suix_getOwnedObjects", [
      owner,
      { options: { showType: true, showContent: true } },
      cursor,
      50,
    ]);

    for (const o of res?.data ?? []) {
      const data = o.data;
      const f = data?.content?.fields;
      if (!data?.objectId || !f?.blob_id) continue;
      const blobId = decimalToBlobId(String(f.blob_id));
      if (!blobId) continue;
      out.set(blobId, {
        objectId: data.objectId,
        blobId,
        sizeBytes: Number(f.size ?? 0),
        registeredEpoch: Number(f.registered_epoch ?? 0),
        certifiedEpoch:
          f.certified_epoch === null || f.certified_epoch === undefined
            ? null
            : Number(f.certified_epoch),
        startEpoch: Number(f.storage?.fields?.start_epoch ?? 0),
        endEpoch: Number(f.storage?.fields?.end_epoch ?? 0),
        deletable: f.deletable === true,
      });
    }

    if (!res?.hasNextPage) break;
    cursor = res.nextCursor ?? null;
    if (!cursor) break;
  }

  return out;
}

// --- Derived helpers --------------------------------------------------------

export function epochsRemaining(endEpoch: number, currentEpoch: number): number {
  return Math.max(0, endEpoch - currentEpoch);
}

export function daysRemaining(endEpoch: number, currentEpoch: number): number {
  return epochsRemaining(endEpoch, currentEpoch) * EPOCH_DAYS;
}

/** ISO date at which storage ends, anchored to now + remaining epochs. */
export function expiryDate(endEpoch: number, currentEpoch: number): string {
  const ms = Date.now() + daysRemaining(endEpoch, currentEpoch) * 86400_000;
  return new Date(ms).toISOString();
}

export interface OnchainSummary {
  verified: boolean;
  checkedAt: string;
  epoch: number | null;
  /** True when Tatum answered and our delegate key is registered onchain. */
  agentAuthorized: boolean;
  agentLabel: string | null;
  account: {
    objectId: string;
    owner: string;
    active: boolean;
    delegateCount: number;
  } | null;
  blobs: {
    onchain: number;
    /** Blobs in the app's projection that were found onchain. */
    matched: number;
    missing: number;
    earliestEndEpoch: number | null;
    earliestExpiry: string | null;
    daysToEarliestExpiry: number | null;
  };
  explorer: { account: string; system: string };
}

/**
 * Cross-check the app's memories against chain state in one call.
 * Used by /api/health and the Memory Health panel.
 */
export async function verifyMemoriesOnchain(
  appBlobIds: string[],
): Promise<OnchainSummary | null> {
  if (!isTatumConfigured()) return null;
  const [system, account] = await Promise.all([
    getWalrusSystemState(),
    getMemWalAccount(),
  ]);
  if (!system || !account) return null;

  const blobs = await listOwnedBlobs(account.owner);
  let matched = 0;
  let earliestEndEpoch: number | null = null;
  for (const id of appBlobIds) {
    const b = blobs.get(id);
    if (!b) continue;
    matched++;
    if (earliestEndEpoch === null || b.endEpoch < earliestEndEpoch) {
      earliestEndEpoch = b.endEpoch;
    }
  }

  return {
    verified: true,
    checkedAt: new Date().toISOString(),
    epoch: system.epoch,
    agentAuthorized: account.active && !account.quarantined && account.delegates.length > 0,
    agentLabel: account.delegates[0]?.label ?? null,
    account: {
      objectId: account.objectId,
      owner: account.owner,
      active: account.active,
      delegateCount: account.delegates.length,
    },
    blobs: {
      onchain: blobs.size,
      matched,
      missing: appBlobIds.length - matched,
      earliestEndEpoch,
      earliestExpiry:
        earliestEndEpoch === null ? null : expiryDate(earliestEndEpoch, system.epoch),
      daysToEarliestExpiry:
        earliestEndEpoch === null ? null : daysRemaining(earliestEndEpoch, system.epoch),
    },
    explorer: {
      account: `https://suiscan.xyz/mainnet/object/${account.objectId}`,
      system: `https://suiscan.xyz/mainnet/object/${tatumConfig()?.systemObjectId ?? MAINNET_WALRUS_SYSTEM}`,
    },
  };
}

export { MAINNET_RPC, MAINNET_WALRUS_SYSTEM };
