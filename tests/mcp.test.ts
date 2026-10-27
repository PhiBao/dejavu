import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/mcp/route";
import { createApiKey } from "@/lib/api-keys";
import { createUser, loadStore } from "@/lib/store";

process.env.DEJAVU_DATA_PATH = join(tmpdir(), `dejavu-mcp-${process.pid}.json`);

beforeEach(() => {
  try {
    rmSync(process.env.DEJAVU_DATA_PATH as string, { force: true });
  } catch {
    /* ignore */
  }
});

async function call(
  rawKey: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const req = new NextRequest("http://localhost/api/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${rawKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const res = await POST(req);
  return (await res.json()) as Record<string, unknown>;
}

describe("MCP write path", () => {
  it("lists capture_memory and writes into the same user namespace", async () => {
    const u = createUser("mcp-write@test.dev", "MCP");
    const key = await createApiKey(u.id, "test");

    const listed = await call(key.rawKey, "tools/list");
    const tools = (listed.result as { tools: { name: string }[] }).tools;
    expect(tools.some((t) => t.name === "capture_memory")).toBe(true);

    const captured = await call(key.rawKey, "tools/call", {
      name: "capture_memory",
      arguments: {
        text: "Met Sarah Chen at the AI meetup. She's a founder at Nimbus, hiring React engineers.",
      },
    });
    const text = (
      captured.result as { content: { text: string }[] }
    ).content[0]?.text;
    expect(text).toMatch(/person: Sarah Chen/);
    expect(text).toMatch(/walrus: unavailable/);

    const store = loadStore();
    const memories = store.memories.filter((m) => m.user_id === u.id);
    expect(memories).toHaveLength(1);
    expect(memories[0]?.content).toMatch(/Sarah Chen/);
    expect(store.people.some((p) => p.user_id === u.id && p.name === "Sarah Chen")).toBe(
      true,
    );
  });

  it("rejects a missing bearer token", async () => {
    const req = new NextRequest("http://localhost/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });
});
