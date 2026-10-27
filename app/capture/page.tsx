import { redirect } from "next/navigation";
import Link from "next/link";
import { getUserId } from "@/lib/auth";
import { recentMemories } from "@/lib/memory";
import { QuickCapture } from "@/components/QuickCapture";
import { BlobChip } from "@/components/BlobChip";

/**
 * The daily capture surface: one field, voice input, and a share target.
 * Deliberately smaller than the workspace — the point is to capture in
 * seconds, not to browse.
 */
export default async function CapturePage({
  searchParams,
}: {
  searchParams: Promise<{ text?: string }>;
}) {
  const userId = await getUserId();
  if (!userId) redirect("/");
  const { text } = await searchParams;
  const recent = await recentMemories(userId, 5);

  return (
    <main className="min-h-screen bg-paper">
      <div className="mx-auto max-w-xl px-5 py-8">
        <header className="flex items-center justify-between">
          <Link href="/workspace" className="text-sm text-ink/50 hover:text-ink">
            ← Workspace
          </Link>
          <span className="flex items-center gap-1.5 text-sm font-semibold tracking-tight">
            <span>🪳</span> Dejavu
          </span>
        </header>

        <div className="mt-8">
          <h1 className="text-2xl font-semibold tracking-tight">
            What should I remember?
          </h1>
          <p className="mt-1 text-sm text-ink/55">
            One sentence. It becomes structured memory on Walrus.
          </p>
          <div className="mt-5">
            <QuickCapture initialText={text ?? ""} />
          </div>
        </div>

        {recent.length > 0 && (
          <section className="mt-10">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink/40">
              Just captured
            </h2>
            <ul className="space-y-2">
              {recent.map((m) => (
                <li
                  key={m.id}
                  className="rounded-xl border border-ink/5 bg-white p-3 text-sm"
                >
                  <p className="text-ink/75">
                    {m.person_name && (
                      <span className="font-medium">{m.person_name} — </span>
                    )}
                    {m.content.slice(0, 160)}
                    {m.content.length > 160 ? "…" : ""}
                  </p>
                  {m.walrus_blob_id && (
                    <span className="mt-1 block">
                      <BlobChip blobId={m.walrus_blob_id} />
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        <p className="mt-10 text-center text-[11px] text-ink/30">
          Add Dejavu to your home screen, then share anything into it.
        </p>
      </div>
    </main>
  );
}
