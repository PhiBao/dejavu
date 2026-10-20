# Walrus Session 8 submission checklist — "Chatbots That Remember"

Session: Sep 18 → Oct 9, 2026 · $2,500 WAL · DeepSurge `c0141a4a-…`
Full rules: `thewalrussessions.wal.app/chatbots`

## Eligibility (all required)

- [ ] **Registered on DeepSurge**, application contains: project name, chatbot
      description (what / who-for / problem), primary contact, GitHub account.
- [ ] **Airtable submission form submitted once**:
      `airtable.com/appoDAKpC74UOqoDa/shro5iVzzjoWfZlPK`
- [ ] **On mainnet, submitted on DeepSurge.**
- [ ] **Working chatbot + Walrus Memory** (Recall, retrofitted — any use case
      eligible; relationship-memory for networkers).
- [ ] **Deployed and reachable** — Fly.io URL (see `docs/deploy-fly.md`).
- [ ] **All memory on Walrus, mainnet. ≥10 blobs at submission.** Proof:
      agent ID + blob count in the DeepSurge form. Source of truth:
      `GET /api/health` → `counts.walrus_blobs`; `pnpm memwal:verify`.
- [ ] **Public GitHub repo + setup instructions** (this repo; README updated).
- [ ] **LLM stated**: Qwen3-30B-A3B (open weights) via Nebius Token Factory
      (→ also qualifies for **Beyond the Big Two**).
- [ ] **Dedicated Sessions wallet** created for the Session.
      **[action]** Create it, fund with WAL+SUI, generate the MemWal account at
      `memory.walrus.xyz`, put `MEMWAL_*` in `.env.local` + Amplify env.
- [ ] **Article on Medium or Inkray**: what it does, Walrus Memory integration,
      **before/after behavior**, evidence of real use (video/screenshots/logs).
      **[action]** Follow `docs/video-script.md`, publish, link repo + live app.
- [ ] **Feedback form completed** (≥1 bug + ≥1 improvement; file GitHub issues
      on `MystenLabs/MemWal` first). Working draft: `docs/walrus-feedback.md`.
- [ ] **Joined Walrus Discord**: `discord.com/invite/walrusprotocol`.
- [ ] **Shared article on X** tagging `@WalrusProtocol` under the session
      announcement with `#WalrusMemory`.

## Prize tracks (stackable — chase all marked ★)

- [ ] ★ **Best Chatbot** (500/250/150) — judged on all four criteria below.
- [ ] ★ **Beyond the Big Two** (150×2) — primary LLM is Qwen3-30B-A3B (open
      weights) via Nebius Token Factory; secondary is Mistral Voxtral Mini 3B on
      AWS Bedrock. Documented in README + submission form with integration notes.
- [ ] ★ **Best Article** (100×3) — clarity, honesty, usefulness to a Walrus
      Memory newcomer.
- [ ] ★ **Promo Prize** (100×5) — share the article in a third-party community
      OUTSIDE Sui/Walrus (X / r/sui / r/walrus don't count). Link in form.
- [ ] ★ **Bug Bounty** (100×5) — quality GitHub issues on `MystenLabs/MemWal`
      during Sep 18–Oct 9 (repro steps, expected/actual, env).

## Judging criteria — how Recall maps

| Criterion | Where it's addressed |
|---|---|
| **Does it actually remember?** | Capture in one sentence → Walrus blob; cross-session paraphrase recall ("hiring frontend people" → Sarah Chen) with citations; before/after video. |
| **Real-world use** | Live Amplify URL + seeded demo user + real-user conversation logs in the article; Today feed proves memory changes behavior (follow-ups). |
| **Build quality** | One-command local run (no DB), `pnpm store:init && pnpm seed && pnpm dev`; `pnpm memwal:verify` + `pnpm judge:verify` round-trip proofs; tests (32 passing); per-user namespaces; graceful offline fallback. |
| **Best article** | Before/after narrative, integration code (`lib/memwal.ts`, `lib/memory.ts`), blob proof, "clone and run" instructions. |

## Operational proof commands (for the article + form)

```bash
pnpm memwal:verify   # relayer health → probe blob → semantic recall round-trip
pnpm seed             # 6 real Walrus blobs (counts toward the ≥10)
curl /api/health     # counts.walrus_blobs + walrus.reachable
```
