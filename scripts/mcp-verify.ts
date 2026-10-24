/**
 * Verify Dejavu's own MCP server with your own key.
 *
 * A signed-in user generates an API key in the app (djav_...), which scopes
 * the MCP tools to THEIR Walrus-backed memory.
 *   export DEJAVU_MCP_API_KEY="<your-recall-key>"
 *   pnpm exec tsx scripts/mcp-verify.ts
 *
 * You can also run a semantic search after verifying:
 *   DEJAVU_MCP_QUERY="who is hiring react engineers" pnpm exec tsx scripts/mcp-verify.ts
 */
import { loadEnv } from "./load-env";
loadEnv();

const token = process.env.DEJAVU_MCP_API_KEY ?? "";
const ENDPOINT = `${process.env.APP_URL ?? "http://localhost:3000"}/api/mcp`;

async function mcpFetch(
  sessionId: string | null,
  body: Record<string, unknown>,
  token: string,
): Promise<{ sessionId: string | null; result: unknown }> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const nextSession = res.headers.get("mcp-session-id");
  const raw = (await res.text()).trim();
  // Notifications (e.g. notifications/initialized) return an empty 202.
  if (!raw) return { sessionId: nextSession, result: null };
  // Responses can be SSE (event-stream) or JSON. Handle both.
  let payload: unknown;
  if (raw.startsWith("event:")) {
    const dataLine = raw
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("");
    payload = JSON.parse(dataLine || "{}");
  } else {
    payload = JSON.parse(raw);
  }
  return { sessionId: nextSession, result: payload };
}

async function main() {
  if (!token) {
    console.error(
      '[mcp] Provide a key to verify.\n  export DEJAVU_MCP_API_KEY="<your-recall-key>" (generate one in the app)',
    );
    process.exit(1);
  }

  console.log("[mcp] connecting to", ENDPOINT, "(Bearer key present)");

  // 1. initialize
  let { sessionId, result } = await mcpFetch(
    null,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "dejavu-mcp-verify", version: "2.0.0" },
      },
    },
    token,
  );
  console.log("[mcp] initialize OK", JSON.stringify(result).slice(0, 160));

  // 2. notifications/initialized (fire and forget)
  await mcpFetch(sessionId, { jsonrpc: "2.0", method: "notifications/initialized" }, token);

  // 3. tools/list
  ({ sessionId, result } = await mcpFetch(
    sessionId,
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    token,
  ));
  const tools = (result as { result?: { tools?: { name: string }[] } })?.result?.tools ?? [];
  console.log("[mcp] tools available:");
  for (const t of tools) console.log("   -", t.name);

  // 4. optional semantic search over the user's Walrus memory
  const query = process.env.DEJAVU_MCP_QUERY;
  if (query) {
    console.log(`[mcp] search_memories: ${query}`);
    ({ sessionId, result } = await mcpFetch(
      sessionId,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "search_memories", arguments: { q: query, limit: 5 } },
      },
      token,
    ));
    console.log("[mcp] result:", JSON.stringify(result).slice(0, 800));
  }

  console.log("[mcp] connection verified ✔  Now add it to your AI tool (see docs/ops-agent.md).");
}

main().catch((err) => {
  console.error("[mcp] FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
