import Link from "next/link";

export interface OnchainPanelData {
  verified: boolean;
  provider?: string | null;
  epoch: number | null;
  agentAuthorized: boolean;
  agentLabel: string | null;
  account: { objectId: string; owner: string; active: boolean; delegateCount: number } | null;
  blobs: {
    onchain: number;
    matched: number;
    missing: number;
    earliestEndEpoch: number | null;
    earliestExpiry: string | null;
    daysToEarliestExpiry: number | null;
  };
  explorer: { account: string; system: string };
  error?: string;
}

function Dot({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-block h-1.5 w-1.5 rounded-full ${ok ? "bg-emerald-500" : "bg-ink/25"}`}
      aria-hidden
    />
  );
}

/**
 * "Verified onchain" card. Everything here is read from Sui through Tatum's
 * RPC — an independent second source, not the memory relayer's own word.
 */
export function OnchainPanel({ data }: { data: OnchainPanelData | null }) {
  if (!data) {
    return (
      <div className="rounded-xl border border-dashed border-ink/15 p-3 text-xs text-ink/50">
        Onchain verification unavailable (Tatum not configured).
      </div>
    );
  }

  const expired =
    data.blobs.daysToEarliestExpiry !== null && data.blobs.daysToEarliestExpiry <= 0;
  const soon =
    data.blobs.daysToEarliestExpiry !== null &&
    data.blobs.daysToEarliestExpiry > 0 &&
    data.blobs.daysToEarliestExpiry < 60;

  return (
    <div className="rounded-xl border border-ink/10 bg-white p-3">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-ink/40">
          Verified onchain
        </h2>
        <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
          Tatum RPC
        </span>
      </div>

      <ul className="space-y-1.5 text-xs text-ink/70">
        <li className="flex items-center gap-2">
          <Dot ok={data.verified} />
          Memory stored on Walrus
          <span className="ml-auto font-mono text-ink/40">
            {data.blobs.matched}/{data.blobs.matched + data.blobs.missing}
          </span>
        </li>
        <li className="flex items-center gap-2">
          <Dot ok={data.agentAuthorized} />
          Agent authorized by account
          <span className="ml-auto text-ink/40">{data.agentLabel ?? "—"}</span>
        </li>
        <li className="flex items-center gap-2">
          <Dot ok={data.epoch !== null} />
          Walrus epoch
          <span className="ml-auto font-mono text-ink/40">{data.epoch ?? "—"}</span>
        </li>
        <li className="flex items-center gap-2">
          <Dot ok={!expired && !soon} />
          Storage paid until
          <span className="ml-auto text-ink/40">
            {data.blobs.earliestExpiry
              ? new Date(data.blobs.earliestExpiry).toISOString().slice(0, 10)
              : "—"}
          </span>
        </li>
      </ul>

      {soon && (
        <p className="mt-2 rounded-md bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800">
          Earliest memory expires in {data.blobs.daysToEarliestExpiry} days — renew
          before then or recall will silently lose it.
        </p>
      )}
      {expired && (
        <p className="mt-2 rounded-md bg-accent/10 px-2 py-1.5 text-[11px] text-accent">
          Storage for the earliest memory has expired.
        </p>
      )}

      <div className="mt-2 flex items-center justify-between text-[10px] text-ink/35">
        <span>{data.blobs.onchain} blob objects onchain</span>
        <Link
          href={data.explorer.account}
          target="_blank"
          rel="noreferrer"
          className="hover:text-accent"
        >
          View account ↗
        </Link>
      </div>
      {data.error && <p className="mt-1 text-[10px] text-accent">check: {data.error}</p>}
    </div>
  );
}
