import { createHash, randomBytes } from "node:crypto";
import {
  audit,
  createApiKeyRecord,
  findApiKeyByHash,
  listApiKeyRecords,
  revokeApiKeyRecord,
  touchApiKey,
} from "./store";

/**
 * Per-user API keys for Dejavu's MCP server.
 *
 * A signed-in user generates a key (`djav_<random>`); we store only its
 * SHA-256 hash and a short display prefix. The raw key is shown exactly once,
 * at creation. Authentication (via Bearer token) looks up the hash — so even a
 * store leak exposes no usable keys.
 */

export interface ApiKey {
  id: string;
  user_id: string;
  name: string;
  prefix: string;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

const PREFIX = "djav_";

function sha256(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Generate a fresh key for a user. Returns the raw key (show ONCE). */
export async function createApiKey(
  userId: string,
  name = "default",
): Promise<{ id: string; rawKey: string; prefix: string }> {
  const rawKey = `${PREFIX}${randomBytes(24).toString("base64url")}`;
  const prefix = `${PREFIX}${rawKey.slice(PREFIX.length, PREFIX.length + 6)}`;
  const record = createApiKeyRecord({
    userId,
    name: name.slice(0, 60),
    prefix,
    keyHash: sha256(rawKey),
  });
  audit(userId, "api_key_created", { keyId: record.id, name });
  return { id: record.id, rawKey, prefix };
}

/** List a user's non-revoked keys (no hashes). */
export async function listApiKeys(userId: string): Promise<ApiKey[]> {
  return listApiKeyRecords(userId);
}

export async function revokeApiKey(userId: string, keyId: string): Promise<void> {
  const before = listApiKeyRecords(userId).length;
  revokeApiKeyRecord(userId, keyId);
  if (listApiKeyRecords(userId).length < before) {
    audit(userId, "api_key_revoked", { keyId });
  }
}

/**
 * Resolve a raw bearer token to a user id + key id, or null if invalid.
 * Touches last_used_at on success.
 */
export async function authenticateApiKey(
  rawKey: string,
): Promise<{ userId: string; keyId: string } | null> {
  if (!rawKey.startsWith(PREFIX)) return null;
  const row = findApiKeyByHash(sha256(rawKey));
  if (!row) return null;
  // Best-effort usage tracking; never fails auth.
  touchApiKey(row.id);
  return { userId: row.user_id, keyId: row.id };
}
