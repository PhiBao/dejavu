"use client";

import { useState, useTransition } from "react";
import { feedbackAction } from "@/app/actions";

type Verdict = "useful" | "wrong" | "outdated";

/**
 * One-tap feedback on a cited memory. Useful strengthens the memory; wrong
 * and outdated retire it from future answers immediately.
 */
export function CitationFeedback({
  memoryId,
  question,
}: {
  memoryId: string;
  question: string;
}) {
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [isPending, startTransition] = useTransition();

  function send(next: Verdict) {
    if (verdict || isPending) return;
    setVerdict(next);
    startTransition(async () => {
      const res = await feedbackAction(memoryId, next, question);
      if (!res.ok) setVerdict(null);
    });
  }

  if (verdict) {
    return (
      <p className="mt-1 text-[10px] text-ink/40">
        {verdict === "useful"
          ? "Thanks — this memory will rank higher."
          : "Retired — it won't be cited in future answers."}
      </p>
    );
  }

  return (
    <span className="mt-1 flex flex-wrap items-center gap-1 text-[10px] text-ink/35">
      <span className="mr-0.5">Was this useful?</span>
      <button
        onClick={() => send("useful")}
        disabled={isPending}
        className="rounded px-1.5 py-0.5 transition hover:bg-emerald-50 hover:text-emerald-700 disabled:opacity-40"
      >
        Useful
      </button>
      <button
        onClick={() => send("wrong")}
        disabled={isPending}
        className="rounded px-1.5 py-0.5 transition hover:bg-accent/5 hover:text-accent disabled:opacity-40"
      >
        Wrong
      </button>
      <button
        onClick={() => send("outdated")}
        disabled={isPending}
        className="rounded px-1.5 py-0.5 transition hover:bg-ink/5 hover:text-ink disabled:opacity-40"
      >
        Outdated
      </button>
    </span>
  );
}
