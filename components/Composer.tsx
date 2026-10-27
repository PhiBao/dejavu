"use client";

import { useState, useRef, useTransition, useEffect } from "react";
import Link from "next/link";
import { captureAction, recallAction, routeAction } from "@/app/actions";
import type { RecallAnswer } from "@/lib/types";
import { RichText } from "./RichText";
import { CitationFeedback } from "./CitationFeedback";

type Mode = "capture" | "recall";

interface Entry {
  id: string;
  role: "user" | "recall";
  text: string;
  answer?: RecallAnswer;
  /** Decision provenance, shown so the judgment layer is visible not claimed. */
  provenance?: {
    person: string | null;
    source: string;
    confidence: number | null;
    facts: number;
    commitments: number;
    walrusState: "certified" | "pending" | "unavailable";
    writtenBy?: string;
  };
}

/**
 * The single core interaction: one text box, two intents.
 *  - "Remember" captures a memory.
 *  - "Recall" (the action) asks a question and shows a cited answer.
 * Results render as a lightweight conversation thread.
 */
export function Composer({ hasPeople }: { hasPeople: boolean }) {
  const [mode, setMode] = useState<Mode>("capture");
  // Until the user touches the toggle, Jev routes each submit automatically.
  const [touched, setTouched] = useState(false);
  const [autoRouted, setAutoRouted] = useState(false);
  const [value, setValue] = useState("");
  const [thread, setThread] = useState<Entry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  // Keep the latest message visible: the thread grows downward and the user
  // should never have to scroll after asking.
  useEffect(() => {
    threadRef.current?.scrollTo({
      top: threadRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [thread, isPending]);

  function pickMode(m: Mode) {
    setMode(m);
    setTouched(true);
    setAutoRouted(false);
  }

  function submit() {
    const text = value.trim();
    if (!text || isPending) return;
    setError(null);
    const entryId = crypto.randomUUID();
    setThread((t) => [...t, { id: entryId, role: "user", text }]);
    setValue("");

    startTransition(async () => {
      let effective = mode;
      let wasAuto = false;
      if (!touched) {
        const routed = await routeAction(text);
        if (routed.ok) {
          effective = routed.intent === "remember" ? "capture" : "recall";
          setMode(effective);
          wasAuto = true;
        }
      }
      setAutoRouted(wasAuto);
      if (effective === "capture") {
        const res = await captureAction(text);
        if (res.ok) {
          setThread((t) => [
            ...t,
            {
              id: crypto.randomUUID(),
              role: "recall",
              text: res.summary,
              provenance: {
                person: res.person,
                source: res.personSource,
                confidence: res.personConfidence,
                facts: res.factsAdded,
                commitments: res.commitmentsAdded,
                walrusState: res.walrusState,
                writtenBy: res.writtenBy,
              },
            },
          ]);
        } else {
          setError(res.error);
        }
      } else {
        const res = await recallAction(text);
        if (res.ok) {
          setThread((t) => [
            ...t,
            {
              id: crypto.randomUUID(),
              role: "recall",
              text: res.result.answer,
              answer: res.result,
            },
          ]);
        } else {
          setError(res.error);
        }
      }
      inputRef.current?.focus();
    });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  }

  const placeholder =
    mode === "capture"
      ? "e.g. Met Sarah Chen at the AI meetup — founder at Nimbus, hiring React engineers. Or: my passport expires in March, renew it."
      : hasPeople
        ? "e.g. Who was hiring React engineers? What did I promise Marcus?"
        : "Capture a memory first, then ask me anything about it.";

  return (
    <div className="rounded-2xl border border-ink/10 bg-white p-4 shadow-sm">
      {/* Mode toggle */}
      <div className="mb-3 inline-flex items-center gap-2">
        <div className="inline-flex rounded-lg bg-ink/5 p-1 text-sm">
          <button
            onClick={() => pickMode("capture")}
            className={tabClass(mode === "capture")}
          >
            Remember
          </button>
          <button
            onClick={() => pickMode("recall")}
            className={tabClass(mode === "recall")}
          >
            Recall
          </button>
        </div>
        {autoRouted && (
          <span
            className="rounded-md bg-accent/10 px-2 py-1 text-[11px] font-medium text-accent"
            title="Jev classified this message and routed it automatically. Tap a tab to override."
          >
            auto-routed
          </span>
        )}
      </div>

      {/* Thread */}
      {thread.length > 0 && (
        <div
          ref={threadRef}
          className="scroll-slim mb-3 max-h-80 space-y-3 overflow-y-auto pr-1"
        >
          {thread.map((e) => (
            <ThreadEntry key={e.id} entry={e} />
          ))}
        </div>
      )}

      {/* Input */}
      <textarea
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        rows={3}
        className="w-full resize-none rounded-xl border border-ink/10 bg-paper px-4 py-3 text-sm focus:border-accent focus:outline-none"
      />

      {error && <p className="mt-2 text-sm text-accent">{error}</p>}

      <div className="mt-2 flex items-center justify-between">
        <span className="text-xs text-ink/40">⌘/Ctrl + Enter</span>
        <button
          onClick={submit}
          disabled={isPending || !value.trim()}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white transition hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isPending
            ? mode === "capture"
              ? "Saving…"
              : "Thinking…"
            : mode === "capture"
              ? "Remember this"
              : "Recall"}
        </button>
      </div>
    </div>
  );
}

function ThreadEntry({ entry }: { entry: Entry }) {
  if (entry.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] animate-fade-up rounded-2xl rounded-br-sm bg-ink px-4 py-2 text-sm text-paper">
          {entry.text}
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] animate-fade-up space-y-2">
        <div className="rounded-2xl rounded-bl-sm bg-accent/10 px-4 py-2 text-sm text-ink">
          {entry.answer ? <RichText text={entry.text} /> : entry.text}
        </div>
        {entry.answer?.writtenBy && (
          <p
            className="pl-1 text-[11px] text-ink/35"
            title="Which model actually wrote this answer — shown so a fallback is never hidden."
          >
            written by {entry.answer.writtenBy}
          </p>
        )}
        {entry.provenance && (
          <p
            className="pl-1 text-[11px] text-ink/40"
            title="How this capture was decided: who resolved the person, and with what confidence."
          >
            {entry.provenance.person ? (
              <>
                person resolved by{" "}
                <span className="font-medium text-ink/60">
                  {entry.provenance.source === "jev" ? "Jev" : "Bedrock"}
                  {entry.provenance.source === "jev" &&
                    entry.provenance.confidence !== null &&
                    ` ${entry.provenance.confidence.toFixed(2)}`}
                </span>
                {" · "}
              </>
            ) : (
              <>no person matched{" · "}</>
            )}
            {entry.provenance.facts} fact
            {entry.provenance.facts === 1 ? "" : "s"} ·{" "}
            {entry.provenance.commitments} follow-up
            {entry.provenance.commitments === 1 ? "" : "s"} ·{" "}
            {entry.provenance.walrusState === "certified" ? (
              <span className="text-accent/80">⬡ encrypted on Walrus</span>
            ) : entry.provenance.walrusState === "pending" ? (
              <span className="text-ink/30">⬡ certifying on Walrus…</span>
            ) : (
              <span
                className="text-accent/70"
                title="The relayer did not accept this write (it rate-limits bursts). Your memory is safe locally and goes to Walrus on the next capture."
              >
                ⬡ Walrus write queued — saved locally
              </span>
            )}
            {entry.provenance.writtenBy && (
              <span className="text-ink/30"> · written by {entry.provenance.writtenBy}</span>
            )}
          </p>
        )}
        {entry.answer && entry.answer.citations.length > 0 && (
          <div className="space-y-1 pl-1">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-ink/40">
              From your memory
            </p>
            {entry.answer.citations.slice(0, 3).map((c) => (
              <div
                key={c.memoryId}
                className="rounded-lg border border-ink/5 bg-paper px-3 py-2 text-xs text-ink/70"
              >
                {c.personName && c.personId ? (
                  <Link
                    href={`/workspace/person/${c.personId}`}
                    className="font-medium text-accent hover:underline"
                  >
                    {c.personName}
                  </Link>
                ) : null}
                <span>
                  {c.personName ? " — " : ""}
                  {c.snippet}
                </span>
                <span className="ml-1 text-ink/30">
                  ({new Date(c.occurredAt).toLocaleDateString()})
                </span>
                <span
                  className="ml-1 font-mono text-ink/30"
                  title={
                    c.verified === "verified"
                      ? `Relevance ${c.score} — Jev verified this memory supports the answer (confidence ${(c.checkConfidence ?? 0).toFixed(2)})`
                      : `Relevance ${c.score}`
                  }
                >
                  {c.score.toFixed(2)}
                  {c.verified === "verified" ? " ✓" : ""}
                </span>
                <CitationFeedback memoryId={c.memoryId} question={entry.text} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function tabClass(active: boolean): string {
  return [
    "rounded-md px-3 py-1 font-medium transition",
    active ? "bg-white text-ink shadow-sm" : "text-ink/50 hover:text-ink",
  ].join(" ");
}
