/**
 * The demo story — one source of truth.
 *
 * Used by `pnpm seed`, the in-app "load demo" button, and the e2e verifier, so
 * the seeded data is identical everywhere. Every story goes through the REAL
 * capture pipeline (Bedrock extraction → Jev judgments → encrypted Walrus
 * blob), so loading the demo produces genuine mainnet blobs rather than
 * fixture rows.
 *
 * The stories are deliberately written the way people actually type (mixed
 * case, informal asides) because that is what broke the old name parser.
 */

export interface DemoStory {
  text: string;
  /** Shown in the UI so a judge knows what is about to happen. */
  label: string;
}

export const DEMO_STORIES: DemoStory[] = [
  {
    label: "Sarah Chen — founder, hiring",
    text: "Met Sarah Chen at the SF AI meetup. She's a founder at Nimbus, building AI eval tooling, ex-Stripe. She's hiring senior React engineers. Promised to intro her to my friend Priya who's looking.",
  },
  {
    label: "Marcus Webb — investor, owes a deck",
    text: "Coffee with Marcus Webb, a partner at Foundry Ventures. He invests in dev tools and infra at seed. Loves rock climbing. Said I'd send him our deck by Friday.",
  },
  {
    label: "Dr. Lena Ortiz — researcher",
    text: "Call with Dr. Lena Ortiz, research scientist at MIT working on retrieval systems. Interested in memory architectures for agents. Has a daughter named Mia starting college. Should follow up with the paper I mentioned.",
  },
  {
    label: "Tomás Silva — growth lead",
    text: "Ran into Tomás Silva at the conference. He runs growth at Loop, a fintech in Lisbon. Into padel and specialty coffee. Wants to compare notes on onboarding funnels. Need to schedule a working session.",
  },
  {
    label: "Aisha Khan — design lead",
    text: "DM'd with Aisha Khan, design lead at Vercel. She's exploring leaving to start something in creator tools. Big on accessibility. I said I'd share the founder community I'm in.",
  },
  {
    label: "Ravi Menon — eng manager",
    text: "Dinner with Ravi Menon, eng manager at Datadog. Hiring for a platform team. Kid just started playing chess. We talked about on-call culture. Owe him a referral for the SRE role.",
  },
  {
    label: "Priya Nair — staff designer",
    text: "Met Priya Nair at the design systems meetup. She's a staff designer at Linear, previously at Figma. Into AI prototyping tools and design engineering. Promised to send her the Vercel design engineering blog post this week.",
  },
  {
    label: "David Okafor — CTO (intro-mention trap)",
    text: "Had lunch with David Okafor, CTO at Paystack. He's scaling the eng org from 20 to 60 and worried about incident review culture. I promised to connect him with a friend to compare notes on on-call.",
  },
  {
    label: "Nadia Rahman — no promise (cold-relationship demo)",
    text: "Met Nadia Rahman at the design dinner. She's a product lead at Notion, into ceramics and trail running. We talked about design systems and her move from consulting.",
  },
  {
    label: "Passport renewal — dated fact",
    text: "My passport expires in 7 weeks. Need to renew it before the trip to Lisbon.",
  },
];

/** The questions that make the demo land: paraphrase, follow-up, abstention. */
export const DEMO_QUESTIONS = [
  "Who did I meet that's recruiting frontend people?",
  "what did I promise Marcus?",
  "who is hiring?",
];

export const DEMO_ABSTENTION_QUESTION =
  "Who do I know in Tokyo who plays competitive chess?";

/**
 * Capture every story through the real pipeline. Sequential on purpose: the
 * relayer batches per call, and parallel captures would fight the per-account
 * rate limit for no real speed-up on a demo.
 */
export async function seedDemoMemories(
  userId: string,
): Promise<{ captured: number; people: number; blobs: number }> {
  const { captureMemory, correctFact } = await import("./memory");
  const { loadStore, saveStore } = await import("./store");

  let captured = 0;
  for (const story of DEMO_STORIES) {
    try {
      await captureMemory(userId, story.text);
      captured++;
    } catch (err) {
      // One bad story must not abort the rest of the demo.
      console.error("[demo] story failed:", err);
    }
  }

  const store = loadStore();

  // Age the two oldest follow-ups so the Attention feed has overdue items.
  const ids = store.commitments
    .filter((c) => c.user_id === userId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .slice(0, 2)
    .map((c) => c.id);
  if (ids.length > 0) {
    const past = new Date(Date.now() - 2 * 86400_000).toISOString();
    for (const c of store.commitments) {
      if (ids.includes(c.id)) c.due_at = past;
    }
  }

  // Nadia has no promise, so she demonstrates the cold-relationship branch.
  const nadia = store.people.find(
    (p) => p.user_id === userId && p.name.toLowerCase().includes("nadia"),
  );
  if (nadia) {
    nadia.last_interaction_at = new Date(
      Date.now() - 35 * 86400_000,
    ).toISOString();
    nadia.updated_at = new Date().toISOString();
  }
  saveStore(store);

  // Show the lifecycle on the demo account: Sarah's employer changes, so the
  // old value becomes history and the Attention feed has a real "changed" item.
  const sarah = loadStore().people.find(
    (p) => p.user_id === userId && p.name === "Sarah Chen",
  );
  const sarahCompany = sarah
    ? loadStore().facts.find(
        (f) =>
          f.user_id === userId &&
          f.person_id === sarah.id &&
          f.key === "company" &&
          f.status === "current",
      )
    : null;
  if (sarahCompany && sarahCompany.value.toLowerCase() !== "linear") {
    try {
      await correctFact(userId, sarahCompany.id, "Linear");
    } catch (err) {
      console.error("[demo] correction failed:", err);
    }
  }

  const final = loadStore();
  return {
    captured,
    people: final.people.filter((p) => p.user_id === userId).length,
    blobs: final.memories.filter((m) => m.user_id === userId && m.walrus_blob_id).length,
  };
}
