import { SuiGrpcClient } from "@mysten/sui/grpc";
import { GrpcTransport } from "@protobuf-ts/grpc-transport";
import { ChannelCredentials } from "@grpc/grpc-js";
import { env } from "./env";
import { log } from "./log";

/**
 * Tatum Sui gRPC — independent onchain verification for Dejavu's memory layer.
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
 * Transport note: Sui deprecated JSON-RPC, and Tatum serves Sui over **native
 * gRPC** only. This module therefore talks gRPC (HTTP/2) with the API key in
 * call metadata — not JSON-RPC over fetch.
 *
 * Degrades gracefully: with no TATUM_API_KEY (or on RPC failure) every helper
 * returns null and the app keeps working on the relayer's word alone.
 */

const MAINNET_GRPC = "https://sui-mainnet-grpc.gateway.tatum.io";
const MAINNET_WALRUS_SYSTEM =
  "0x2134d52768ea07e8c43570ef975eb3e4c27a39fa6396bef985b5abc58d03ddd2";
/** Walrus mainnet epochs are 2 weeks; the chain doesn't expose the constant. */
export const EPOCH_DAYS = 14;

/**
 * Free plan: 3 RPS, shared across the plan, so bursts can 429 even under the
 * nominal limit. Pace at ~2 RPS and keep a hard hourly request budget.
 */
const MIN_REQUEST_SPACING_MS = 500;
const CREDIT_BUDGET_PER_HOUR = 120;

export interface TatumConfig {
  apiKey: string;
  grpcUrl: string;
  systemObjectId: string;
  accountId: string;
}

export function tatumConfig(): TatumConfig | null {
  try {
    const e = env();
    if (!e.TATUM_API_KEY) return null;
    return {
      apiKey: e.TATUM_API_KEY,
      grpcUrl: e.TATUM_SUI_GRPC_URL,
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

// --- gRPC client ------------------------------------------------------------

let client: SuiGrpcClient | null = null;

/** Turn https://host/path into the host:port that grpc-js expects. */
function grpcHost(url: string): string {
  try {
    const u = new URL(url);
    return u.port ? `${u.hostname}:${u.port}` : `${u.hostname}:443`;
  } catch {
    return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  }
}

function getClient(): SuiGrpcClient | null {
  const cfg = tatumConfig();
  if (!cfg) return null;
  if (client) return client;
  try {
    const transport = new GrpcTransport({
      host: grpcHost(cfg.grpcUrl),
      channelCredentials: ChannelCredentials.createSsl(),
      // Tatum authenticates gRPC with the key in call metadata.
      meta: { "x-api-key": cfg.apiKey },
    } as never);
    client = new SuiGrpcClient({ network: "mainnet", transport });
  } catch (err) {
    log.warn("tatum_client_init_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  return client;
}

/** Test/ops helper: drop the cached client. */
export function __clearTatumClient(): void {
  client = null;
}

// --- Pacing + budget --------------------------------------------------------

let requestQueue: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;
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

export function tatumCreditUsage(): { used: number; budget: number; window: number } {
  return {
    used: creditsThisHour,
    budget: CREDIT_BUDGET_PER_HOUR,
    window: Math.max(0, 3600_000 - (Date.now() - budgetWindowStart)),
  };
}

async function pace(): Promise<void> {
  const wait = lastRequestAt + MIN_REQUEST_SPACING_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

/**
 * Run one gRPC call through the paced queue with a single retry. Every call
 * counts against the free plan, so the budget is checked first.
 */
async function call<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  if (!takeCredit()) {
    log.warn("tatum_budget_exhausted", { label });
    return null;
  }
  const run = requestQueue.then(async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      await pace();
      try {
        return await fn();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("tatum_call_failed", { label, attempt, error: message });
        if (attempt === 0) await new Promise((r) => setTimeout(r, 900));
      }
    }
    return null;
  });
  requestQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// --- TTL cache --------------------------------------------------------------
// Epochs change every two weeks and delegation rarely changes, so re-reading
// them per request would burn the free plan's credits for nothing.

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry<unknown>>();

async function cached<T>(
  key: string,
  ttlMs: number,
  load: () => Promise<T | null>,
): Promise<T | null> {
  const hit = cache.get(key) as CacheEntry<T> | undefined;
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const value = await load();
  if (value !== null) cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

/** Test/ops helper: clear the onchain cache. */
export function clearTatumCache(): void {
  cache.clear();
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
    return bytes
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
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

interface GrpcObject {
  objectId: string;
  type?: string;
  json?: Record<string, unknown>;
}

async function getObjectJson(objectId: string): Promise<GrpcObject | null> {
  const c = getClient();
  if (!c) return null;
  return call(`getObject:${objectId.slice(0, 10)}`, async () => {
    const res = (await c.getObject({
      objectId,
      include: { json: true },
    })) as unknown as { object?: GrpcObject } & GrpcObject;
    const obj = res.object ?? res;
    if (!obj?.objectId) return null;
    return obj;
  });
}

// --- Walrus system state ----------------------------------------------------

/**
 * The Walrus system object wraps a versioned state object exposed as a dynamic
 * field. Resolve that field, then read the live epoch and prices from it.
 * Cached: the epoch advances every two weeks.
 */
export async function getWalrusSystemState(): Promise<WalrusSystemState | null> {
  const cfg = tatumConfig();
  if (!cfg) return null;
  return cached("walrus:system", 15 * 60_000, () => loadWalrusSystemState(cfg));
}

async function loadWalrusSystemState(cfg: TatumConfig): Promise<WalrusSystemState | null> {
  const c = getClient();
  if (!c) return null;

  const fields = await call("listDynamicFields", async () => {
    const res = (await c.listDynamicFields({
      parentId: cfg.systemObjectId,
      limit: 10,
    })) as unknown as {
      dynamicFields?: {
        objectId?: string;
        fieldId?: string;
        objectType?: string;
        valueType?: string;
        type?: string;
      }[];
    };
    const field = (res.dynamicFields ?? []).find((f) => {
      const t = f.valueType ?? f.objectType ?? f.type ?? "";
      return t.includes("SystemStateInner");
    });
    return field?.fieldId ?? field?.objectId ?? null;
  });
  if (!fields) return null;

  const wrapper = await getObjectJson(fields);
  const value = wrapper?.json?.value as
    | {
        committee?: { epoch?: number | string; n_shards?: number | string };
        total_capacity_size?: number | string;
        used_capacity_size?: number | string;
        storage_price_per_unit_size?: number | string;
        write_price_per_unit_size?: number | string;
      }
    | undefined;
  if (!value) return null;

  const epoch = Number(value.committee?.epoch ?? NaN);
  if (!Number.isFinite(epoch)) return null;

  return {
    epoch,
    nShards: Number(value.committee?.n_shards ?? 0),
    totalCapacityBytes: Number(value.total_capacity_size ?? 0),
    usedCapacityBytes: Number(value.used_capacity_size ?? 0),
    storagePricePerUnit: Number(value.storage_price_per_unit_size ?? 0),
    writePricePerUnit: Number(value.write_price_per_unit_size ?? 0),
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
  const obj = await getObjectJson(cfg.accountId);
  const fields = obj?.json as
    | {
        owner?: string;
        active?: boolean;
        admin_quarantined?: boolean;
        created_at?: number | string;
        delegate_keys?: {
          label?: string;
          public_key?: number[];
          sui_address?: string;
          created_at?: number | string;
        }[];
      }
    | undefined;
  if (!fields) return null;

  const delegates: DelegateKeyOnchain[] = (fields.delegate_keys ?? []).map((d) => {
    const bytes = Array.isArray(d.public_key) ? d.public_key : [];
    return {
      label: String(d.label ?? ""),
      publicKeyHex: Buffer.from(bytes).toString("hex"),
      suiAddress: String(d.sui_address ?? ""),
      createdAt: Number(d.created_at ?? 0),
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

/**
 * Every Walrus Blob object owned by `owner`, with metadata.
 *
 * One paged `listOwnedObjects` call with JSON content returns the Blob fields
 * directly — 60 objects cost two gRPC calls.
 *
 * Returns a Map keyed by the base64url Walrus blob id.
 */
export async function listOwnedBlobs(owner: string): Promise<Map<string, BlobOnchain>> {
  if (!owner) return new Map();
  const hit = await cached(`blobs:${owner}`, 15 * 60_000, () => loadOwnedBlobs(owner));
  return hit ?? new Map();
}

async function loadOwnedBlobs(owner: string): Promise<Map<string, BlobOnchain>> {
  const out = new Map<string, BlobOnchain>();
  const c = getClient();
  if (!c) return out;

  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const res = await call(`listOwnedObjects:${page}`, async () => {
      return (await c.listOwnedObjects({
        owner,
        include: { json: true },
        limit: 50,
        cursor,
      })) as unknown as {
        objects?: GrpcObject[];
        hasNextPage?: boolean;
        cursor?: string | null;
      };
    });
    if (!res) break;

    for (const obj of res.objects ?? []) {
      const f = obj.json as
        | {
            blob_id?: string;
            size?: string;
            registered_epoch?: number;
            certified_epoch?: number | null;
            deletable?: boolean;
            storage?: { start_epoch?: number; end_epoch?: number };
          }
        | undefined;
      if (!obj.objectId || !f?.blob_id) continue;
      const blobId = decimalToBlobId(String(f.blob_id));
      if (!blobId) continue;
      out.set(blobId, {
        objectId: obj.objectId,
        blobId,
        sizeBytes: Number(f.size ?? 0),
        registeredEpoch: Number(f.registered_epoch ?? 0),
        certifiedEpoch:
          f.certified_epoch === null || f.certified_epoch === undefined
            ? null
            : Number(f.certified_epoch),
        startEpoch: Number(f.storage?.start_epoch ?? 0),
        endEpoch: Number(f.storage?.end_epoch ?? 0),
        deletable: f.deletable === true,
      });
    }

    if (!res.hasNextPage) break;
    cursor = res.cursor ?? null;
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

export { MAINNET_GRPC, MAINNET_WALRUS_SYSTEM };
