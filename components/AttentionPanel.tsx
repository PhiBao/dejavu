"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { commitmentAction, reconnectAction } from "@/app/actions";
import type { AttentionFeed, AttentionItem } from "@/lib/types";

const KIND_LABEL: Record<AttentionItem["kind"], string> = {
  commitment: "promise",
  stale_person: "cold",
  expiring_memory: "expiring",
  fact_deadline: "deadline",
  changed_fact: "changed",
};

/**
 * The agent's inbox: what needs a human now, without being asked.
 *
 * Promises can be completed/snoozed/dismissed; cold relationships can be
 * snoozed into a real follow-up; drafts are composed from the person's facts
 * and history, not from a generic template.
 */
export function AttentionPanel({ feed }: { feed: AttentionFeed }) {
  const router = useRouter();
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const items = feed.items.filter((i) => !dismissed.has(i.id));

  function dismiss(id: string) {
    setDismissed((prev) => new Set(prev).add(id));
  }

  function actOnCommitment(item: AttentionItem, status: "done" | "snoozed" | "dismissed") {
    if (!item.commitmentId) return;
    setError(null);
    startTransition(async () => {
      const res = await commitmentAction(item.commitmentId as string, status);
      if (res.ok) {
        dismiss(item.id);
        router.refresh();
      } else {
        setError("Could not update that follow-up.");
      }
    });
  }

  function snoozeRelationship(item: AttentionItem) {
    if (!item.personId) return;
    setError(null);
    startTransition(async () => {
      const res = await reconnectAction(item.personId as string, 14);
      if (res.ok) {
        dismiss(item.id);
        router.refresh();
      } else {
        setError("Could not snooze that relationship.");
      }
    });
  }

  async function copyDraft(item: AttentionItem) {
    if (!item.draftMessage) return;
    try {
      await navigator.clipboard.writeText(item.draftMessage);
      setCopied(item.id);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard blocked — ignore */
    }
  }

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-ink/40">
          Attention
        </h2>
        <span className="text-[11px] text-ink/35">
          {items.length === 0 ? "all clear" : `${items.length} open`}
        </span>
      </div>

      <div className="rounded-xl bg-ink p-4 text-paper shadow-sm">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-paper/40">
          Daily brief
        </p>
        <p className="mt-1 text-sm leading-relaxed text-paper/90">{feed.brief}</p>
        {items.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {feed.counts.commitments > 0 && (
              <Badge label={`${feed.counts.commitments} promise${feed.counts.commitments === 1 ? "" : "s"}`} />
            )}
            {feed.counts.stale > 0 && <Badge label={`${feed.counts.stale} cold`} />}
            {feed.counts.expiring > 0 && <Badge label={`${feed.counts.expiring} expiring`} />}
            {feed.counts.deadlines > 0 && <Badge label={`${feed.counts.deadlines} date${feed.counts.deadlines === 1 ? "" : "s"}`} />}
            {feed.counts.changes > 0 && <Badge label={`${feed.counts.changes} changed`} />}
          </div>
        )}
      </div>

      {items.length === 0 ? (
        <p className="mt-3 rounded-xl border border-dashed border-ink/15 p-4 text-sm text-ink/50">
          Nothing needs attention. When you make a promise, a relationship goes
          cold, or a memory is about to expire, it appears here.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {items.map((item) => (
            <li
              key={item.id}
              className="animate-fade-up rounded-xl border border-ink/10 bg-white p-3 shadow-sm"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{item.title}</p>
                  <p className="mt-0.5 text-sm text-ink/70">{item.detail}</p>
                </div>
                <span
                  className={[
                    "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider",
                    item.urgency >= 0.9
                      ? "bg-accent/15 text-accent"
                      : "bg-ink/5 text-ink/45",
                  ].join(" ")}
                >
                  {KIND_LABEL[item.kind]}
                </span>
              </div>

              {item.draftMessage && (
                <button
                  onClick={() => copyDraft(item)}
                  className="mt-2 w-full rounded-lg border border-ink/10 bg-paper px-3 py-2 text-left text-xs text-ink/60 transition hover:border-accent/40"
                >
                  {copied === item.id
                    ? "Copied ✓"
                    : `“${item.draftMessage.slice(0, 78)}…” — copy draft`}
                </button>
              )}

              <div className="mt-2 flex flex-wrap items-center gap-2">
                {item.kind === "commitment" && item.commitmentId && (
                  <>
                    <button
                      onClick={() => actOnCommitment(item, "done")}
                      disabled={isPending}
                      className="rounded-lg bg-ink px-3 py-1.5 text-xs font-semibold text-paper transition hover:bg-ink/90 disabled:opacity-40"
                    >
                      Done
                    </button>
                    <button
                      onClick={() => actOnCommitment(item, "snoozed")}
                      disabled={isPending}
                      className="rounded-lg border border-ink/15 px-3 py-1.5 text-xs font-medium text-ink/70 transition hover:bg-paper disabled:opacity-40"
                    >
                      Snooze
                    </button>
                  </>
                )}

                {item.kind === "stale_person" && item.personId && (
                  <button
                    onClick={() => snoozeRelationship(item)}
                    disabled={isPending}
                    className="rounded-lg border border-ink/15 px-3 py-1.5 text-xs font-medium text-ink/70 transition hover:bg-paper disabled:opacity-40"
                  >
                    Remind me in 2 weeks
                  </button>
                )}

                {item.href && (
                  <Link
                    href={item.href}
                    className="rounded-lg px-2 py-1.5 text-xs font-medium text-accent transition hover:underline"
                  >
                    Open
                  </Link>
                )}

                <button
                  onClick={() => dismiss(item.id)}
                  disabled={isPending}
                  className="ml-auto rounded-lg px-2 py-1.5 text-xs text-ink/35 transition hover:text-ink disabled:opacity-40"
                >
                  Dismiss
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="mt-2 text-xs text-accent">{error}</p>}
    </section>
  );
}

function Badge({ label }: { label: string }) {
  return (
    <span className="rounded-full bg-paper/10 px-2 py-0.5 text-[10px] font-medium text-paper/70">
      {label}
    </span>
  );
}
