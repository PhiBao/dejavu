import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { getUserId } from "@/lib/auth";
import {
  getPerson,
  getPersonBrief,
  getPersonFacts,
  getPersonMemories,
  suggestDuplicatePeople,
} from "@/lib/memory";
import { BlobChip } from "@/components/BlobChip";
import { FactList } from "@/components/FactList";
import { MergePeople } from "@/components/MergePeople";
import { MemoryActions } from "@/components/MemoryActions";
import { ConsolidateButton } from "@/components/ConsolidateButton";
import { getBlobProvenance } from "@/lib/tatum";

export default async function PersonPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const userId = await getUserId();
  if (!userId) redirect("/");
  const { id } = await params;

  const person = await getPerson(userId, id);
  if (!person) notFound();

  const [facts, memories, brief] = await Promise.all([
    getPersonFacts(userId, id, { includeSuperseded: true }),
    getPersonMemories(userId, id, { includeSuperseded: true }),
    getPersonBrief(userId, id),
  ]);
  const duplicates = suggestDuplicatePeople(userId, id);
  const provenance = await getBlobProvenance(
    memories
      .map((m) => m.walrus_blob_id)
      .filter((blobId): blobId is string => !!blobId),
  );
  const provenanceCheckedAt = new Date().toISOString();

  return (
    <main className="min-h-screen bg-paper">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <Link
          href="/workspace"
          className="text-sm text-ink/50 transition hover:text-ink"
        >
          ← Back
        </Link>

        <header className="mt-6 border-b border-ink/10 pb-6">
          <h1 className="text-3xl font-semibold tracking-tight">
            {person.name}
          </h1>
          {person.headline && (
            <p className="mt-1 text-ink/60">{person.headline}</p>
          )}
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink/50">
            {person.company && <span>🏢 {person.company}</span>}
            {person.location && <span>📍 {person.location}</span>}
            {person.last_interaction_at && (
              <span>
                🕑 Last:{" "}
                {new Date(person.last_interaction_at).toLocaleDateString()}
              </span>
            )}
          </div>
        </header>

        <MergePeople
          primaryId={person.id}
          candidates={duplicates.map((d) => ({
            id: d.person.id,
            name: d.person.name,
            reason: d.reason,
            score: d.score,
          }))}
        />

        {/* Facts */}
        <section className="mt-8">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink/40">
            What you know
          </h2>
          <FactList facts={facts} />
        </section>

        {/* Canonical brief */}
        <section className="mt-8">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-ink/40">
              Canonical brief
            </h2>
            {brief && (
              <span className="text-[11px] text-ink/35">
                {brief.source_memory_ids.length} source memor
                {brief.source_memory_ids.length === 1 ? "y" : "ies"}
              </span>
            )}
          </div>
          {brief ? (
            <div className="rounded-xl border border-ink/10 bg-white p-4">
              <p className="whitespace-pre-line text-sm leading-relaxed text-ink/80">
                {brief.content}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {brief.walrus_blob_id && (
                  <BlobChip blobId={brief.walrus_blob_id} />
                )}
                <span className="text-[11px] text-ink/35">
                  {new Date(brief.created_at).toLocaleString()}
                </span>
              </div>
            </div>
          ) : (
            <p className="text-sm text-ink/50">
              No consolidated brief yet. Consolidating distills this person’s
              current facts and memories into one durable summary on Walrus.
            </p>
          )}
          <ConsolidateButton personId={person.id} />
        </section>

        {/* Timeline */}
        <section className="mt-8">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink/40">
            Timeline
          </h2>
          {memories.length === 0 ? (
            <p className="text-sm text-ink/50">Nothing captured yet.</p>
          ) : (
            <ol className="space-y-3">
              {memories.map((m) => {
                const happened = new Date(m.occurred_at).toLocaleDateString();
                const captured = new Date(m.created_at).toLocaleDateString();
                return (
                  <li
                    key={m.id}
                    className={[
                      "rounded-xl border border-ink/5 bg-white p-4",
                      m.status === "superseded" ? "opacity-60" : "",
                    ].join(" ")}
                  >
                    <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-ink/40">
                      <span className="rounded bg-ink/5 px-1.5 py-0.5 capitalize">
                        {m.kind}
                      </span>
                      <span>
                        {happened === captured
                          ? captured
                          : `happened ${happened} · captured ${captured}`}
                      </span>
                      {m.status === "superseded" && (
                        <span className="rounded bg-ink/5 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-ink/40">
                          {m.superseded_by ? "replaced" : "retired"}
                        </span>
                      )}
                      {m.walrus_blob_id && <BlobChip blobId={m.walrus_blob_id} />}
                    </div>
                    <p className="text-sm text-ink/80">{m.content}</p>
                    {m.walrus_blob_id && (
                      <details className="mt-2 text-[11px] text-ink/40">
                        <summary className="cursor-pointer select-none hover:text-ink">
                          Provenance
                        </summary>
                        <div className="mt-1 space-y-0.5 font-mono">
                          <p className="break-all">blob {m.walrus_blob_id}</p>
                          {(() => {
                            const p = provenance.get(m.walrus_blob_id as string);
                            if (!p) {
                              return (
                                <p>
                                  onchain object not verified yet — the blob is
                                  still fetchable from Walrus
                                </p>
                              );
                            }
                            return (
                              <>
                                <p className="break-all">
                                  sui object{" "}
                                  <a
                                    href={`https://suiscan.xyz/mainnet/object/${p.objectId}`}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-accent hover:underline"
                                  >
                                    {p.objectId.slice(0, 10)}…{p.objectId.slice(-6)}
                                  </a>
                                </p>
                                <p>
                                  certified epoch {p.certifiedEpoch ?? "pending"} ·
                                  storage {p.startEpoch} → {p.endEpoch} ·{" "}
                                  {(p.sizeBytes / 1024).toFixed(1)} KB
                                </p>
                                <p>
                                  read via Tatum Sui gRPC{" "}
                                  {new Date(provenanceCheckedAt).toLocaleTimeString()}
                                </p>
                              </>
                            );
                          })()}
                        </div>
                      </details>
                    )}
                    {m.status === "active" && (
                      <MemoryActions memoryId={m.id} content={m.content} compact />
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      </div>
    </main>
  );
}
