/**
 * Seed the demo user with the eight demo stories, through the real pipeline.
 *
 * Usage: pnpm seed
 * Sign in as demo@dejavu.app (or your own email via SEED_EMAIL) to see it.
 *
 * Every story becomes a genuine encrypted blob in Walrus Memory — this is the
 * same capture path the app uses, so the ≥10-blob Session proof is real
 * rather than fixture data.
 */
import { loadEnv } from "./load-env";
loadEnv();

import { createUser, findUserByEmail, loadStore } from "../lib/store";
import { seedDemoMemories } from "../lib/demo-stories";

const EMAIL = process.env.SEED_EMAIL ?? "demo@dejavu.app";
const NAME = process.env.SEED_NAME ?? "Alex Rivera";
const USER_ID = process.env.SEED_USER_ID;

function getOrCreateDemoUser(): string {
  if (USER_ID) return USER_ID;
  const existing = findUserByEmail(EMAIL);
  if (existing) return existing.id;
  return createUser(EMAIL, NAME).id;
}

async function main() {
  const userId = getOrCreateDemoUser();
  const existing = loadStore().memories.filter((m) => m.user_id === userId).length;
  if (existing > 0) {
    console.log(
      `[seed] ${EMAIL} already has ${existing} memories — skipping. Sign in as ${EMAIL}.`,
    );
    process.exit(0);
  }

  console.log(`[seed] capturing the demo story for ${EMAIL} (namespace recall-${userId})…`);
  const res = await seedDemoMemories(userId);
  console.log(
    `[seed] done ✔  ${res.captured} memories, ${res.people} people, ${res.blobs} Walrus blobs`,
  );
  console.log(`[seed] sign in as ${EMAIL} and try: "Who did I meet that's recruiting frontend people?"`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[seed] failed:", err);
  process.exit(1);
});
