"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { correctFactAction, forgetFactAction } from "@/app/actions";
import { formatDate } from "@/lib/dates";
import type { FactStatus } from "@/lib/types";

export interface FactView {
  id: string;
  attribute: string;
  value: string;
  absolute_date: string | null;
  status: FactStatus;
  created_at: string;
}

/**
 * Current beliefs, with inline correction and forgetting. Superseded values
 * stay visible under "Earlier values" so the user can see that Dejavu changed
 * its mind — and why — instead of silently rewriting history.
 */
export function FactList({ facts }: { facts: FactView[] }) {
  const current = facts.filter((f) => f.status === "current");
  const history = facts.filter((f) => f.status === "superseded");

  if (current.length === 0 && history.length === 0) {
    return (
      <p className="text-sm text-ink/50">
        No structured details yet — they’ll appear as you capture more.
      </p>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {current.map((f) => (
          <FactChip key={f.id} fact={f} />
        ))}
        {current.length === 0 && (
          <p className="text-sm text-ink/50">No current details.</p>
        )}
      </div>

      {history.length > 0 && (
        <details className="mt-3 text-xs text-ink/50">
          <summary className="cursor-pointer select-none hover:text-ink">
            Earlier values ({history.length})
          </summary>
          <ul className="mt-2 space-y-1">
            {history.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center gap-1.5">
                <span className="text-ink/35 line-through">
                  {f.attribute.replace(/_/g, " ")}: {f.value}
                </span>
                {f.absolute_date && (
                  <span className="text-ink/30">{formatDate(f.absolute_date)}</span>
                )}
                <span className="rounded bg-ink/5 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-ink/35">
                  replaced
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function FactChip({ fact }: { fact: FactView }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(fact.value);
  const [gone, setGone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (gone) return null;

  function save() {
    const next = value.trim();
    if (!next || isPending) return;
    setError(null);
    startTransition(async () => {
      const res = await correctFactAction(fact.id, next);
      if (res.ok) {
        setEditing(false);
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  function forget() {
    if (!window.confirm("Forget this detail? It will no longer be used in answers.")) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await forgetFactAction(fact.id);
      if (res.ok) {
        setGone(true);
        router.refresh();
      } else {
        setError("Could not forget that detail.");
      }
    });
  }

  if (editing) {
    return (
      <span className="flex flex-wrap items-center gap-1 rounded-lg border border-accent/40 bg-white px-2 py-1 text-sm">
        <span className="text-ink/40">
          {fact.attribute.replace(/_/g, " ")}:
        </span>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
          className="min-w-[8rem] rounded border border-ink/15 px-1.5 py-0.5 text-sm focus:border-accent focus:outline-none"
        />
        <button
          onClick={save}
          disabled={isPending || !value.trim()}
          className="rounded bg-ink px-1.5 py-0.5 text-[11px] font-semibold text-paper disabled:opacity-40"
        >
          {isPending ? "…" : "Save"}
        </button>
        <button
          onClick={() => {
            setEditing(false);
            setValue(fact.value);
            setError(null);
          }}
          disabled={isPending}
          className="px-1 text-[11px] text-ink/40 hover:text-ink"
        >
          Cancel
        </button>
        {error && <span className="text-[11px] text-accent">{error}</span>}
      </span>
    );
  }

  return (
    <span
      className="group inline-flex items-center gap-1 rounded-lg border border-ink/10 bg-white px-3 py-1.5 text-sm"
      title={`Current belief · captured ${new Date(fact.created_at).toLocaleDateString()}`}
    >
      <span className="text-ink/40">
        {fact.attribute.replace(/_/g, " ")}:
      </span>{" "}
      <span className="font-medium">{fact.value}</span>
      {fact.absolute_date && (
        <span className="text-[11px] text-ink/40">
          · {formatDate(fact.absolute_date)}
        </span>
      )}
      <button
        onClick={() => setEditing(true)}
        disabled={isPending}
        title="Correct this detail"
        className="ml-1 rounded px-1 text-[11px] text-ink/25 transition hover:bg-ink/5 hover:text-ink disabled:opacity-40"
      >
        ✎
      </button>
      <button
        onClick={forget}
        disabled={isPending}
        title="Forget this detail"
        className="rounded px-1 text-[11px] text-ink/25 transition hover:bg-accent/5 hover:text-accent disabled:opacity-40"
      >
        ×
      </button>
      {error && <span className="text-[11px] text-accent">{error}</span>}
    </span>
  );
}
