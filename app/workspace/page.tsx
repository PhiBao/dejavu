import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import {
  getTodayFeed,
  listPeople,
  recentMemories,
} from "@/lib/memory";
import { listApiKeys } from "@/lib/api-keys";
import { signOutAction } from "../actions";
import { Composer } from "@/components/Composer";
import { TodayCard } from "@/components/TodayCard";
import { ApiKeysPanel } from "@/components/ApiKeysPanel";
import { BlobChip } from "@/components/BlobChip";
import { DemoLoader } from "@/components/DemoLoader";
import { OnchainPanel } from "@/components/OnchainPanel";
import { MemoryHealthPanel } from "@/components/MemoryHealthPanel";
import { isTatumConfigured, verifyMemoriesOnchain } from "@/lib/tatum";
import { computeMemoryHealth } from "@/lib/health";
import { getMemoryFacts, loadStore } from "@/lib/store";

export default async function AppPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/");

  const [today, people, recent, keys] = await Promise.all([
    getTodayFeed(user.id),
    listPeople(user.id),
    recentMemories(user.id, 8),
    listApiKeys(user.id),
  ]);
  // Facts for notes are shown inline; people get their own profile page.
  const factsByMemory = getMemoryFacts(
    user.id,
    recent.map((m) => m.id),
  );

  // Independent onchain proof of this user's memories (Tatum Sui RPC).
  // Cached inside lib/tatum, so this is cheap on repeat renders.
  let onchain = null;
  if (isTatumConfigured()) {
    const blobIds = loadStore()
      .memories.filter((m) => m.user_id === user.id && m.walrus_blob_id)
      .map((m) => m.walrus_blob_id as string);
    onchain = await verifyMemoriesOnchain(blobIds);
  }

  // The learning loop's view: which memories actually earn their storage.
  const health = await computeMemoryHealth(user.id);

  const firstName = user.name?.split(" ")[0] ?? "there";

  return (
    <main className="min-h-screen bg-paper">
      <div className="mx-auto grid max-w-6xl grid-cols-1 gap-8 px-6 py-8 lg:grid-cols-[1fr_360px]">
        {/* Left: capture + recall conversation */}
        <section className="flex flex-col">
          <header className="mb-6 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-lg">🪳</span>
              <span className="font-semibold tracking-tight">Dejavu</span>
            </div>
            <form action={signOutAction}>
              <button className="text-sm text-ink/50 hover:text-ink">
                Sign out
              </button>
            </form>
          </header>

          <div className="mb-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              Hi {firstName}.
            </h1>
            <p className="mt-1 text-ink/60">
              Tell me anything worth remembering — a person, a note, a promise.
            </p>
          </div>

          <Composer hasPeople={people.length > 0} />

          {recent.length === 0 && (
            <div className="mt-4">
              <DemoLoader />
            </div>
          )}

          {recent.length > 0 && (
            <div className="mt-8">
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink/40">
                Recently remembered
              </h2>
              <ul className="space-y-2">
                {recent.map((m) => (
                  <li
                    key={m.id}
                    className="rounded-xl border border-ink/5 bg-white p-3 text-sm"
                  >
                    {!m.person_id && (
                      <span className="mb-1 inline-block rounded bg-ink/5 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-ink/40">
                        note
                      </span>
                    )}
                    {m.person_name && (
                      <Link
                        href={`/workspace/person/${m.person_id}`}
                        className="font-medium text-accent hover:underline"
                      >
                        {m.person_name}
                      </Link>
                    )}
                    <span className="text-ink/70">
                      {m.person_name ? " — " : ""}
                      {m.content.slice(0, 140)}
                      {m.content.length > 140 ? "…" : ""}
                    </span>
                    {!m.person_id && (factsByMemory.get(m.id) ?? []).length > 0 && (
                      <span className="mt-1 flex flex-wrap gap-1">
                        {(factsByMemory.get(m.id) ?? []).slice(0, 4).map((f) => (
                          <span
                            key={f.id}
                            className="rounded border border-ink/10 bg-paper px-1.5 py-0.5 text-[10px] text-ink/50"
                          >
                            {f.attribute.replace(/_/g, " ")}: {f.value}
                          </span>
                        ))}
                      </span>
                    )}
                    {m.walrus_blob_id && (
                      <span className="mt-1 block">
                        <BlobChip blobId={m.walrus_blob_id} />
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        {/* Right: Today feed + people */}
        <aside className="flex flex-col gap-8">
          <MemoryHealthPanel health={health} />
          <OnchainPanel data={onchain} />
          <div>
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink/40">
              Today · follow up
            </h2>
            {today.length === 0 ? (
              <p className="rounded-xl border border-dashed border-ink/15 p-4 text-sm text-ink/50">
                Nothing due. When you promise to follow up with someone, it
                shows up here.
              </p>
            ) : (
              <div className="space-y-3">
                {today.map((item) => (
                  <TodayCard key={item.commitment.id} item={item} />
                ))}
              </div>
            )}
          </div>

          <div>
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink/40">
              People ({people.length})
            </h2>
            {people.length === 0 ? (
              <p className="text-sm text-ink/50">No one yet.</p>
            ) : (
              <ul className="space-y-1">
                {people.slice(0, 12).map((p) => (
                  <li key={p.id}>
                    <Link
                      href={`/workspace/person/${p.id}`}
                      className="flex items-center justify-between rounded-lg px-3 py-2 text-sm hover:bg-white"
                    >
                      <span className="font-medium">{p.name}</span>
                      {p.headline && (
                        <span className="truncate pl-3 text-xs text-ink/40">
                          {p.headline}
                        </span>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <ApiKeysPanel keys={keys} />
        </aside>
      </div>
    </main>
  );
}
