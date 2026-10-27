import { computeMemoryHealth, type MemoryHealth } from "@/lib/health";

/**
 * Memory Health panel — the visible half of the learning loop.
 *
 * Shows what Dejavu has learned about which of your memories matter (recall
 * frequency, recency, whether they are tied to a person or an obligation you
 * owe) and what the chain says about their storage window.
 */
export function MemoryHealthPanel({ health }: { health: MemoryHealth | null }) {
  if (!health) {
    return (
      <div className="rounded-xl border border-dashed border-ink/15 p-3 text-xs text-ink/50">
        Memory health unavailable.
      </div>
    );
  }

  const rows = health.rows.slice(0, 4);

  return (
    <div className="rounded-xl border border-ink/10 bg-white p-3">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-ink/40">
          Memory health
        </h2>
        {health.epoch !== null && (
          <span className="font-mono text-[10px] text-ink/35">
            epoch {health.epoch}
          </span>
        )}
      </div>

      <p className="mb-2 text-xs text-ink/60">{health.summary}</p>

      {(health.feedback.useful > 0 ||
        health.feedback.wrong > 0 ||
        health.feedback.outdated > 0) && (
        <div className="mb-2 flex flex-wrap gap-x-3 gap-y-1 rounded-lg bg-paper px-2.5 py-1.5 text-[10px] text-ink/45">
          <span className="font-medium uppercase tracking-wider text-ink/35">
            What I learned
          </span>
          {health.feedback.useful > 0 && (
            <span className="text-emerald-700">
              {health.feedback.useful} useful
            </span>
          )}
          {health.feedback.wrong > 0 && (
            <span className="text-accent">{health.feedback.wrong} wrong</span>
          )}
          {health.feedback.outdated > 0 && (
            <span>{health.feedback.outdated} outdated</span>
          )}
        </div>
      )}

      {health.topUseful.length > 0 && (
        <p className="mb-2 text-[11px] text-ink/50">
          Most useful:{" "}
          {health.topUseful
            .map((r) => `${r.personName ?? "note"} (${r.useful}×)`)
            .join(", ")}
        </p>
      )}

      {rows.length > 0 && (
        <ul className="space-y-1.5">
          {rows.map((r) => (
            <li
              key={r.memoryId}
              className="rounded-lg border border-ink/5 bg-paper px-2.5 py-1.5"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-xs font-medium text-ink/80">
                  {r.personName ?? "note"}
                </span>
                <span
                  className="shrink-0 font-mono text-[10px] text-ink/40"
                  title={r.reasons.join(" · ")}
                >
                  {Math.round(r.importance * 100)}
                </span>
              </div>
              <p className="mt-0.5 truncate text-[11px] text-ink/50">
                {r.snippet}
              </p>
              <p className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] text-ink/35">
                {r.hits > 0 && <span>{r.hits} recalls</span>}
                {r.useful > 0 && (
                  <span className="text-emerald-700">{r.useful} useful</span>
                )}
                {r.onchain && r.daysToExpiry !== null && (
                  <span className={r.atRisk ? "text-accent/80" : undefined}>
                    {r.atRisk ? "renew soon · " : "paid until "}
                    {r.daysToExpiry}d left
                  </span>
                )}
                {!r.onchain && <span>not yet onchain</span>}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
