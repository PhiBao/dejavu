"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { rebuildWorkspaceAction } from "@/app/actions";

/**
 * Rebuild the structured workspace from the enriched blobs on Walrus.
 * Lifecycle manifests keep forgotten/retired versions from coming back.
 */
export function RebuildFromWalrus() {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function run() {
    setError(null);
    setMessage("Scanning Walrus and rebuilding missing structure…");
    startTransition(async () => {
      const res = await rebuildWorkspaceAction();
      if (res.ok) {
        setMessage(
          `Rebuilt ${res.memories} memories, ${res.people} people, ${res.facts} facts, ${res.commitments} follow-ups from ${res.scanned} blobs (${res.skipped} already known).`,
        );
        router.refresh();
      } else {
        setError(res.error);
        setMessage(null);
      }
    });
  }

  return (
    <div className="rounded-xl border border-ink/10 bg-white p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-ink/40">
            Durability
          </h2>
          <p className="mt-1 text-[11px] text-ink/50">
            Rebuild people, facts, and follow-ups from Walrus blobs if the local
            index is ever lost.
          </p>
        </div>
        <button
          onClick={run}
          disabled={isPending}
          className="shrink-0 rounded-lg border border-ink/15 px-3 py-1.5 text-xs font-medium text-ink/70 transition hover:border-accent/40 disabled:opacity-40"
        >
          {isPending ? "Rebuilding…" : "Rebuild"}
        </button>
      </div>
      {message && <p className="mt-2 text-[11px] text-ink/50">{message}</p>}
      {error && <p className="mt-2 text-[11px] text-accent">{error}</p>}
    </div>
  );
}
