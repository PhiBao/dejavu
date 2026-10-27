import { NextRequest, NextResponse } from "next/server";
import { authenticateApiKey } from "@/lib/api-keys";
import {
  captureMemory,
  getPerson,
  getPersonFacts,
  getPersonMemories,
  getTodayFeed,
  listPeople,
  recall,
  recentMemories,
} from "@/lib/memory";
import { getAttentionFeed } from "@/lib/attention";
import { userActionLimiter } from "@/lib/rate-limit";

/**
 * Dejavu's own MCP server — a scoped Model Context Protocol endpoint.
 *
 * A signed-in Dejavu user generates an API key (in the app), then any MCP
 * client (Claude Code, Cursor, ...) connects here with `Authorization: Bearer
 * <key>` and reads or captures THEIR memory. Every tool is scoped by the key's
 * user_id, so a key can never touch another user's data. `capture_memory` is
 * the only write; it runs the same extraction → Walrus pipeline as the app.
 *
 * Memory content lives in Walrus Memory (per-user namespace); structure
 * (people, facts, commitments) lives in the local projection. These tools
 * read both.
 *
 * Add to Claude Code:
 *   claude mcp add recall http://localhost:3000/api/mcp --transport http \
 *     --header "Authorization: Bearer <your-key>"
 * (in production: https://dejavu-memory.fly.dev/api/mcp)
 *
 * Implements the streamable-HTTP subset: initialize, tools/list, tools/call.
 */
export const dynamic = "force-dynamic";

const PROTOCOL_VERSION = "2025-03-26";

interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

const READ_TOOLS: Tool[] = [
  {
    name: "list_people",
    description:
      "List all people the user has captured memories about (name, headline, company).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "search_memories",
    description:
      "Semantic search over the user's Walrus-backed memory. Returns matching memories with the person, text, and date. This is the source of truth the product recalls from.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Search terms or a question" },
        limit: { type: "number", description: "Max results (default 10)" },
      },
      required: ["q"],
    },
  },
  {
    name: "ask_memory",
    description:
      "Ask a question about the people the user knows. Returns a grounded answer synthesized ONLY from retrieved Walrus memories, plus citations to the exact memories used.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "Question to answer" },
      },
      required: ["question"],
    },
  },
  {
    name: "get_person",
    description:
      "Get one person's profile: headline, company, structured facts, and memory timeline.",
    inputSchema: {
      type: "object",
      properties: {
        person_id: { type: "string", description: "Person id from list_people" },
      },
      required: ["person_id"],
    },
  },
  {
    name: "get_today",
    description:
      "Get the user's Today feed: open follow-ups that are due or overdue, with a draft reconnect message for each.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_attention",
    description:
      "Get the agent's Attention feed: a daily brief plus overdue promises, cold relationships, upcoming dated facts, and recently changed details. Use this when the user asks what needs attention or what they should do next.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "capture_memory",
    description:
      "Write a new memory into the user's Walrus namespace through the real capture pipeline. Use this when the user tells the agent something worth remembering from another tool or session.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "The memory to save, in the user's own words",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "recent_memories",
    description: "Get the user's most recent memories.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max results (default 10)" },
      },
    },
  },
];

function mcpError(id: unknown, message: string): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32603, message },
  };
}

function mcpResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function textResult(id: unknown, text: string): Record<string, unknown> {
  return mcpResult(id, { content: [{ type: "text", text }] });
}

async function handleCall(
  userId: string,
  id: unknown,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  try {
    switch (name) {
      case "list_people": {
        const people = await listPeople(userId);
        const text =
          people
            .map(
              (p) =>
                `${p.id} | ${p.name}${p.headline ? ` — ${p.headline}` : ""}${p.company ? ` @ ${p.company}` : ""}`,
            )
            .join("\n") || "(no people yet)";
        return textResult(id, text);
      }
      case "search_memories": {
        const q = String(args.q ?? "").trim();
        const limit = Math.min(Math.max(Number(args.limit ?? 10) || 10, 1), 25);
        if (!q) return mcpError(id, "q is required");
        const res = await recall(userId, q, limit);
        const text =
          res.citations
            .map(
              (c) =>
                `${c.personName ?? "note"} (${c.occurredAt}): ${c.snippet} [score ${c.score}${c.verified === "verified" ? ", ✓ verified" : ""}]`,
            )
            .join("\n") || "(no matching memories)";
        return textResult(id, text);
      }
      case "ask_memory": {
        const question = String(args.question ?? "").trim();
        if (!question) return mcpError(id, "question is required");
        const res = await recall(userId, question, 6);
        const cites = res.citations
          .map((c) => `- ${c.personName ?? "note"}: ${c.snippet}`)
          .join("\n");
        return textResult(
          id,
          `${res.answer}${cites ? `\n\nSources:\n${cites}` : ""}`,
        );
      }
      case "get_person": {
        const personId = String(args.person_id ?? "");
        if (!personId) return mcpError(id, "person_id is required");
        const person = await getPerson(userId, personId);
        if (!person) return mcpError(id, "Person not found");
        const [facts, memories] = await Promise.all([
          getPersonFacts(userId, personId),
          getPersonMemories(userId, personId),
        ]);
        const header = `${person.name}${person.headline ? ` — ${person.headline}` : ""}${person.company ? ` @ ${person.company}` : ""}${person.location ? ` (${person.location})` : ""}`;
        const factLines =
          facts.map((f) => `  - ${f.attribute}: ${f.value}`).join("\n") || "  (none)";
        const memLines =
          memories
            .slice(0, 10)
            .map((m) => `  - [${m.occurred_at}] ${m.content}`)
            .join("\n") || "  (none)";
        return textResult(
          id,
          `${header}\nFacts:\n${factLines}\nMemories:\n${memLines}`,
        );
      }
      case "get_today": {
        const feed = await getTodayFeed(userId);
        const text =
          feed
            .map(
              (item) =>
                `- [${item.reason}] ${item.personName ?? "someone"}: ${item.commitment.description} → draft: "${item.draftMessage ?? ""}"`,
            )
            .join("\n") || "(nothing due)";
        return textResult(id, text);
      }
      case "get_attention": {
        const feed = await getAttentionFeed(userId);
        const lines = feed.items
          .map(
            (item) =>
              `- [${item.kind}${item.personName ? ` · ${item.personName}` : ""}] ${item.title}: ${item.detail}${item.draftMessage ? `\n  draft: "${item.draftMessage}"` : ""}`,
          )
          .join("\n");
        return textResult(
          id,
          `Daily brief: ${feed.brief}${lines ? `\n\n${lines}` : ""}`,
        );
      }
      case "capture_memory": {
        const text = String(args.text ?? "").trim();
        if (!text) return mcpError(id, "text is required");
        if (text.length > 4000) return mcpError(id, "text is too long (max 4000)");
        if (!userActionLimiter.check(userId)) {
          return mcpError(id, "rate limited — try again in a moment");
        }
        const res = await captureMemory(userId, text);
        return textResult(
          id,
          `${res.summary}\nperson: ${res.person?.name ?? "none"}\nfacts: ${res.factsAdded}\nfollow-ups: ${res.commitmentsAdded}\nwalrus: ${res.walrusState}${res.memory.walrus_blob_id ? ` (${res.memory.walrus_blob_id})` : ""}`,
        );
      }
      case "recent_memories": {
        const limit = Math.min(Math.max(Number(args.limit ?? 10) || 10, 1), 25);
        const rows = await recentMemories(userId, limit);
        const text =
          rows
            .map((r) => `${r.person_name ?? "note"} (${r.occurred_at}): ${r.content}`)
            .join("\n") || "(no memories yet)";
        return textResult(id, text);
      }
      default:
        return mcpError(id, `Unknown tool: ${name}`);
    }
  } catch (err) {
    return mcpError(id, err instanceof Error ? err.message : String(err));
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Auth: Bearer API key.
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const key = token ? await authenticateApiKey(token) : null;
  if (!key) {
    return NextResponse.json(
      { error: "invalid_token", error_description: "Authorization required" },
      { status: 401 },
    );
  }
  const { userId } = key;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const method = typeof body.method === "string" ? body.method : "";
  const id = body.id ?? null;

  if (method === "initialize") {
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "dejavu-mcp", version: "2.0.0" },
        },
      },
      { headers: { "mcp-session-id": crypto.randomUUID() } },
    );
  }
  if (method === "notifications/initialized") {
    return new NextResponse(null, { status: 202 });
  }
  if (method === "tools/list") {
    return NextResponse.json(
      mcpResult(id, { tools: READ_TOOLS }),
      { headers: { "mcp-session-id": req.headers.get("mcp-session-id") ?? "" } },
    );
  }
  if (method === "tools/call") {
    const params = (body.params ?? {}) as Record<string, unknown>;
    const toolName = typeof params.name === "string" ? params.name : "";
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const res = await handleCall(userId, id, toolName, args);
    return NextResponse.json(res, {
      headers: { "mcp-session-id": req.headers.get("mcp-session-id") ?? "" },
    });
  }

  return NextResponse.json(mcpError(id, `Unsupported method: ${method}`), { status: 400 });
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    { error: "invalid_request", error_description: "This is an MCP endpoint. POST JSON-RPC here." },
    { status: 400 },
  );
}
