import { NextResponse } from "next/server";
import { isMockAI } from "@/lib/env";
import { storeCounts, loadStore } from "@/lib/store";
import {
  isMemwalConfigured,
  userNamespace,
  walrusHealth,
  walrusRestore,
} from "@/lib/memwal";
import { getUserId } from "@/lib/auth";
import { isTatumConfigured, tatumCreditUsage, verifyMemoriesOnchain } from "@/lib/tatum";

/**
 * Health check (and human eyes). Reports the AI path, the local projection
 * counts, Walrus Memory status, and — when Tatum is configured — an
 * independent onchain verification of the memory layer through Sui RPC:
 * Walrus epoch, agent delegation, blob objects, and true expiry.
 *
 * GET /api/health
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const memwal = await walrusHealth();
  const configured = memwal.configured || isMemwalConfigured();
  const body: Record<string, unknown> = {
    status: "ok",
    timestamp: new Date().toISOString(),
    ai: isMockAI() ? "mock-fallback" : "bedrock",
    memory: "walrus",
    walrus: {
      configured,
      reachable: memwal.reachable,
      latencyMs: memwal.latencyMs,
      serverUrl:
        process.env.MEMWAL_SERVER_URL ?? "https://relayer.memory.walrus.xyz",
      account: process.env.MEMWAL_ACCOUNT_ID ?? null,
    },
    counts: storeCounts(),
  };

  // Independent source of truth: Sui RPC via Tatum. Never trust the relayer's
  // word for persistence when the chain can be asked directly.
  if (isTatumConfigured()) {
    try {
      const blobIds = loadStore()
        .memories.map((m) => m.walrus_blob_id)
        .filter((id): id is string => !!id);
      const onchain = await verifyMemoriesOnchain(blobIds);
      body.onchain = onchain
        ? {
            verified: onchain.verified,
            provider: "tatum",
            epoch: onchain.epoch,
            agentAuthorized: onchain.agentAuthorized,
            agentLabel: onchain.agentLabel,
            account: onchain.account,
            blobs: onchain.blobs,
            explorer: onchain.explorer,
            checkedAt: onchain.checkedAt,
            credits: tatumCreditUsage(),
          }
        : { verified: false, provider: "tatum", error: "rpc_unavailable" };
    } catch {
      body.onchain = { verified: false, provider: "tatum", error: "check_failed" };
    }
  } else {
    body.onchain = { verified: false, provider: null, note: "TATUM_API_KEY unset" };
  }

  // When called by a signed-in user, prove THEIR namespace specifically.
  try {
    const userId = await getUserId();
    if (userId) {
      const ns = userNamespace(userId);
      const restore = await walrusRestore(userId, 25);
      body.you = {
        namespace: ns,
        onChainBlobs: restore?.total ?? null,
        indexed: restore !== null,
      };
    }
  } catch {
    // Anonymous health check — fine.
  }

  return NextResponse.json(body, { status: 200 });
}
