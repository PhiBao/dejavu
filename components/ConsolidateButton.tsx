"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { consolidatePersonAction } from "@/app/actions";

/**
 * Consolidate everything known about a person into one canonical brief and
 * write it back to Walrus as a new blob. This is the visible learning loop:
 * the distilled view is durable, not a UI-only summary.
 */
export function ConsolidateButton({ personId }: { personId: string }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function run() {
    setError(null);
    setMessage("Reading memories and writing the brief to Walrus…");
    startTransition(async () => {
      const res = await consolidatePersonAction(personId);
      if (res.ok) {
        setMessage(
          res.blobId
            ? "Brief written to Walrus ✓"
            : "Brief saved locally — Walrus write queued",
        );
        router.refresh();
      } else {
        setError(res.error);
        setMessage(null);
      }
    });
  }

  return (
    <div className="mt-3">
      <button
        onClick={run}
        disabled={isPending}
        className="rounded-lg border border-ink/15 bg-white px-3 py-1.5 text-xs font-medium text-ink/70 transition hover:border-accent/40 disabled:opacity-40"
      >
        {isPending ? "Consolidating…" : "Consolidate memory"}
      </button>
      {message && <p className="mt-1 text-[11px] text-ink/40">{message}</p>}
      {error && <p className="mt-1 text-[11px] text-accent">{error}</p>}
    </div>
  );
}
