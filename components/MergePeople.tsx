"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { mergePeopleAction } from "@/app/actions";

export interface MergeCandidate {
  id: string;
  name: string;
  reason: string;
  score: number;
}

/**
 * Duplicate-person suggestions. The user confirms every merge; nothing is
 * merged automatically, because two people can genuinely share a name.
 */
export function MergePeople({
  primaryId,
  candidates,
}: {
  primaryId: string;
  candidates: MergeCandidate[];
}) {
  const router = useRouter();
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const visible = candidates.filter((c) => !dismissed.has(c.id));
  if (visible.length === 0) return null;

  function merge(candidate: MergeCandidate) {
    if (
      !window.confirm(
        `Merge ${candidate.name} into this person? Every memory, fact, and follow-up moves over.`,
      )
    ) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await mergePeopleAction(primaryId, candidate.id);
      if (res.ok) {
        router.push(`/workspace/person/${res.personId}`);
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <section className="mt-6 rounded-xl border border-accent/20 bg-accent/5 p-4">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-accent/70">
        Possible duplicate
      </h2>
      <p className="mt-1 text-sm text-ink/60">
        These profiles may be the same person. Merging keeps all memories and
        picks the newest value when two facts disagree.
      </p>
      <ul className="mt-3 space-y-2">
        {visible.map((c) => (
          <li
            key={c.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white px-3 py-2"
          >
            <span className="text-sm">
              <span className="font-medium">{c.name}</span>
              <span className="ml-2 text-xs text-ink/40">{c.reason}</span>
            </span>
            <span className="flex gap-2">
              <button
                onClick={() => merge(c)}
                disabled={isPending}
                className="rounded-lg bg-ink px-3 py-1 text-xs font-semibold text-paper transition hover:bg-ink/90 disabled:opacity-40"
              >
                {isPending ? "Merging…" : "Merge"}
              </button>
              <button
                onClick={() =>
                  setDismissed((prev) => new Set(prev).add(c.id))
                }
                disabled={isPending}
                className="rounded-lg px-2 py-1 text-xs text-ink/40 transition hover:text-ink disabled:opacity-40"
              >
                Not the same
              </button>
            </span>
          </li>
        ))}
      </ul>
      {error && <p className="mt-2 text-xs text-accent">{error}</p>}
    </section>
  );
}
