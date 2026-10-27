"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { correctMemoryAction, forgetMemoryAction } from "@/app/actions";

/**
 * Correct or forget one memory.
 *
 * Correction is not an edit-in-place: the old version becomes history and the
 * corrected text goes through the real capture pipeline (extraction, facts,
 * a new Walrus blob). Forgetting is a tombstone — the blob stays onchain, but
 * it is never recalled or shown again.
 */
export function MemoryActions({
  memoryId,
  content,
  compact = false,
}: {
  memoryId: string;
  content: string;
  compact?: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(content);
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [isPending, startTransition] = useTransition();

  if (gone) return null;

  function save() {
    const next = value.trim();
    if (!next || isPending) return;
    setError(null);
    startTransition(async () => {
      const res = await correctMemoryAction(memoryId, next);
      if (res.ok) {
        setEditing(false);
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  function forget() {
    if (
      !window.confirm(
        "Forget this memory? It will never be cited again. The encrypted blob stays on Walrus, but Dejavu stops using it.",
      )
    ) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await forgetMemoryAction(memoryId);
      if (res.ok) {
        setGone(true);
        router.refresh();
      } else {
        setError("Could not forget that memory.");
      }
    });
  }

  if (editing) {
    return (
      <div className="mt-2 space-y-2">
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          rows={3}
          autoFocus
          className="w-full resize-none rounded-lg border border-accent/40 bg-paper px-3 py-2 text-sm focus:border-accent focus:outline-none"
        />
        <div className="flex items-center gap-2">
          <button
            onClick={save}
            disabled={isPending || !value.trim()}
            className="rounded-lg bg-ink px-3 py-1.5 text-xs font-semibold text-paper transition hover:bg-ink/90 disabled:opacity-40"
          >
            {isPending ? "Saving…" : "Save correction"}
          </button>
          <button
            onClick={() => {
              setEditing(false);
              setValue(content);
              setError(null);
            }}
            disabled={isPending}
            className="rounded-lg px-2 py-1.5 text-xs text-ink/50 transition hover:text-ink disabled:opacity-40"
          >
            Cancel
          </button>
          <span className="text-[11px] text-ink/35">
            the old version is kept as history
          </span>
        </div>
        {error && <p className="text-xs text-accent">{error}</p>}
      </div>
    );
  }

  return (
    <div className={compact ? "mt-1 flex gap-2" : "mt-2 flex gap-2"}>
      <button
        onClick={() => setEditing(true)}
        disabled={isPending}
        className="rounded px-1.5 py-0.5 text-[11px] text-ink/40 transition hover:bg-ink/5 hover:text-ink disabled:opacity-40"
      >
        Correct
      </button>
      <button
        onClick={forget}
        disabled={isPending}
        className="rounded px-1.5 py-0.5 text-[11px] text-ink/40 transition hover:bg-accent/5 hover:text-accent disabled:opacity-40"
      >
        Forget
      </button>
      {isPending && <span className="text-[11px] text-ink/30">working…</span>}
      {error && <span className="text-[11px] text-accent">{error}</span>}
    </div>
  );
}
