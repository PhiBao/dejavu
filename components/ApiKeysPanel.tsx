"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { generateApiKeyAction, revokeApiKeyAction } from "@/app/actions";
import type { ApiKey } from "@/lib/api-keys";

/**
 * API Keys panel: let the user generate keys for Dejavu's MCP server.
 * The raw key is shown once (copy it), then only the prefix is retained.
 */
export function ApiKeysPanel({ keys }: { keys: ApiKey[] }) {
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [isPending, startTransition] = useTransition();
  const mcpUrl =
    typeof window !== "undefined" && window.location.hostname !== "localhost"
      ? `${window.location.origin}/api/mcp`
      : "https://recall-walrus-memory.fly.dev/api/mcp";

  function generate() {
    startTransition(async () => {
      const res = await generateApiKeyAction();
      if (res.ok) setNewKey(res.rawKey);
    });
  }

  function revoke(id: string) {
    if (!confirm("Revoke this API key? Agents using it will lose access.")) return;
    startTransition(async () => {
      await revokeApiKeyAction(id);
    });
  }

  async function copyKey() {
    if (!newKey) return;
    try {
      await navigator.clipboard.writeText(newKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  return (
    <div>
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink/40">
        API keys · MCP access
      </h2>

      <p className="mb-3 text-xs text-ink/50">
        Generate a key to let your own agent (Claude Code, Cursor, …) read your
        memory through Dejavu&apos;s MCP server — scoped to you only.{" "}
        <Link href="/guide" className="font-medium text-accent hover:underline">
          How to connect →
        </Link>
      </p>

      <button
        onClick={generate}
        disabled={isPending}
        className="mb-3 w-full rounded-lg bg-ink px-3 py-2 text-xs font-semibold text-paper transition hover:bg-ink/90 disabled:opacity-40"
      >
        {isPending ? "Generating…" : "Generate API key"}
      </button>

      {newKey && (
        <div className="mb-3 rounded-lg border border-accent/40 bg-accent/5 p-3">
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-accent">
            Copy this now — shown only once
          </p>
          <code className="block break-all rounded bg-paper px-2 py-1.5 text-xs text-ink">
            {newKey}
          </code>
          <button
            onClick={copyKey}
            className="mt-2 rounded-lg border border-accent/40 px-2 py-1 text-[11px] font-medium text-accent hover:bg-accent/10"
          >
            {copied ? "Copied ✓" : "Copy key"}
          </button>
        </div>
      )}

      {newKey && (
        <div className="mb-3 rounded-lg border border-ink/10 bg-white p-3">
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-ink/40">
            Connect your agent (Claude Code)
          </p>
          <code className="block break-all rounded bg-paper px-2 py-1.5 font-mono text-[11px] leading-relaxed text-ink/70">
            {`claude mcp add dejavu ${mcpUrl} --transport http --header "Authorization: Bearer ${newKey}"`}
          </code>
          <p className="mt-2 text-[11px] leading-relaxed text-ink/50">
            Then ask: <i>&quot;which person is hiring React engineers?&quot;</i>{" "}
            <Link href="/guide" className="font-medium text-accent hover:underline">
              Step-by-step guide →
            </Link>
          </p>
        </div>
      )}

      {keys.length > 0 ? (
        <ul className="space-y-2">
          {keys.map((k) => (
            <li
              key={k.id}
              className="flex items-center justify-between rounded-lg border border-ink/10 bg-white px-3 py-2 text-xs"
            >
              <div>
                <p className="font-medium text-ink">{k.name}</p>
                <p className="font-mono text-ink/40">{k.prefix}…</p>
              </div>
              <button
                onClick={() => revoke(k.id)}
                className="rounded px-2 py-1 text-[11px] text-ink/40 transition hover:text-accent"
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      ) : (
        !newKey && (
          <p className="rounded-xl border border-dashed border-ink/15 p-3 text-xs text-ink/50">
            No keys yet. Generate one to connect your agent.
          </p>
        )
      )}
    </div>
  );
}
