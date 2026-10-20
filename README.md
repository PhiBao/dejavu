# 🪳 Recall — Remember Every Person

**Recall is a relationship-memory chatbot built on Walrus.** You tell it, in
plain words, about the people you meet ("Met Sarah at the AI meetup, she's
hiring React devs, I promised to intro her to Priya") — and every memory
becomes an **encrypted blob on Walrus**, recalled semantically across
sessions through **Walrus Memory**. Ask questions in natural language, get
answers grounded in the *exact* memories they came from, and get a daily
**"Today" feed** so relationships never quietly go cold.

Built for **Walrus Session 8: Chatbots That Remember**. Recall's thesis: an AI
that helps you remember people is only useful if its memory is **durable,
portable, and trustworthy** — memory that survives sessions, moves across
apps, and never gets invented. Walrus is that layer; everything else in this
repo exists to serve it.

> ### 🚀 Live demo
> **https://recall-walrus-memory.fly.dev** — deployed on Fly.io
> (single 256MB machine + persistent volume), backed by Walrus Memory on
> mainnet. Sign in with any email (or `demo@recall.app` for seeded data).
> Health + blob proof: `GET /api/health` → `counts.walrus_blobs`.

---

## The problem

People with large networks — founders, salespeople, recruiters, investors,
community builders — forget names, context, and promises every day. The pain
is frequent and emotionally charged (embarrassment, lost deals, relationships
quietly going cold), and existing tools fail on both sides: CRMs demand
form-filling nobody sustains; note apps store text but never *answer*
anything. Nobody has closed the loop — conversational capture, cited recall,
proactive follow-up — in one product.

## What it does

- **Remember:** one sentence in — *"Met Sarah at the AI meetup, she's hiring
  React devs, I promised to intro her to Priya."* Recall extracts the person,
  the durable facts, and the follow-ups, and persists the enriched record as
  an encrypted Walrus blob. People are the wedge, not the ceiling: a note
  with no name is still stored, recalled, and cited.
- **Recall:** ask in plain language, get a natural-language answer grounded in
  the *exact* memories it came from — each with a relevance score and a
  machine-checked ✓ verdict. Unknown questions get an honest "I don't have a
  memory of that yet" instead of a hallucination.
- **Follow through:** every promise becomes a Today-feed item with a
  pre-drafted reconnect message, and stale relationships resurface through a
  daily nudge. Memory that changes what you *do*, not just what you read.

---

## How Walrus powers Recall (the core of the entry)

Walrus is not a feature here — it is the memory. The local process keeps only
a thin structured projection (people, facts, due dates); every word the user
said lives in Walrus:

- **Capture** (`lib/memory.ts: captureMemory`): the writer extracts person +
  facts + commitments → Jev resolves *which* person (Choice over roster +
  spans, never invented) → the enriched text is persisted via Walrus Memory
  into the user's namespace (`recall-<userId>`) → the returned **blob id**
  lands on the local memory row. One capture = one certified mainnet blob.
- **Recall** (`lib/memory.ts: recall`): `memwal.recall()` searches the user's
  namespace by meaning — *"who's hiring frontend people?"* finds *"hiring
  senior React engineers"* — then Jev ranks the shortlist with calibrated
  0–1 scores, sub-threshold pools **abstain without a synthesis call**, and
  every shown citation carries a machine-checked verdict (✓ verified,
  contradicted hidden).
- **Recovery** (`pnpm memwal:durability`): the relayer's index is rebuildable
  from Walrus alone via `restore()`, and semantic recall still answers **with
  the local projection deleted** — because the memories were never in the app.
- **Verified, not asserted** (`lib/tatum.ts`): Tatum's Sui RPC independently
  confirms each memory's Walrus `Blob` object, the MemWal account's delegate
  keys, and the **real** storage window. Measured today: blobs registered at
  epoch 40 with storage through epoch 55 (196 days, to **2027-05-04**) — the
  relayer buys 15 epochs, not the SDK's default 50. `/api/health` and the
  Memory Health card show the chain's answer, so a wrong assumption can't
  quietly become a lost memory.
- **Multi-tenant isolation** (`lib/memwal.ts`): one operator MemWalAccount
  pays for storage (no per-user funding); each app user gets a deterministic
  namespace. Recall is scoped per account + namespace; the delegate key never
  leaves the server.
- **Portable by construction:** the same namespace is readable from the web
  app *and* from any agent via Recall's per-user MCP server (`/api/mcp`) —
  web-captured memories answer Claude Code questions with zero re-entry.
- **Resilient by design:** if Walrus is unreachable (or unconfigured in local
  dev), capture still saves locally and recall falls back to keyword search +
  generative rerank — the product never loses what you told it. `restore()`
  rebuilds the relayer index from Walrus blobs at any time.

Every recall answer returns **citations** to the source memories, so the
answer is auditable and never fabricated.

### Recall's own MCP server, per user

Every signed-in user can generate an API key in the app and connect their
agent to *their own* Walrus-backed memory at `/api/mcp` (read-only,
auto-scoped by user): `list_people`, `search_memories`, `ask_memory`,
`get_person`, `get_today`, `recent_memories`. See
**[docs/ops-agent.md](docs/ops-agent.md)** for the exact steps, per-tool
configs, and example prompts.

### Your agent reads the same blobs — no export

Because the memories *are* Walrus blobs, an agent connected to **Walrus
Memory's own MCP server** (first-party `memwal_recall` / `memwal_remember`
tools) recalls everything typed into the web app, with **zero re-entry**:

```bash
claude plugin marketplace add https://github.com/MystenLabs/MemWal.git
claude plugin install memwal@memwal-plugins -s user
```

Then: capture someone in the browser, and in Claude Code ask *"Who did I met
that's hiring React engineers?"* — same encrypted blob, different client.
That is the portability claim, demonstrated rather than asserted.

### Calibrated judgments: Jev decides, the writer only writes words

A generative LLM writes good words and makes unaccountable choices. Recall
splits the two — every *decision* is a typed TypeSafe (Jev) judgment with
probabilities + confidence, and the generative model only renders prose from
decided context (`lib/judge.ts`, see **[docs/judgments.md](docs/judgments.md)**).
Jev is TypeSafe's own model and the writer is Qwen (via Nebius Token
Factory) — neither is Anthropic or OpenAI, so the *Beyond the Big Two* track
holds. Every judgment degrades gracefully to generative fallbacks when
unconfigured.

### Prose renderer: provider-agnostic, and never silently swapped

The LLM only writes words; Jev decides. The writer is a **chain**, because
hosted API keys expire without warning and a demo that quietly answers from a
regex is worse than one that fails loudly:

```
primary  Nebius Token Factory — Qwen3-30B-A3B (open weights)
  → any OpenAI-compatible API (OpenRouter, Together, …)
  → Bedrock Mantle (Mistral Voxtral Mini 3B)
  → secondary provider
  → keyless open-weights gateway (GPT-OSS 20B)
  → deterministic local rules (last resort, dev only)
```

Every answer and every capture shows **which model actually wrote it**, and
`GET /api/health` actively calls the model and reports `status: degraded`
when the writer is unavailable. A fallback is never hidden.

**Why this matters for a memory product:** the memories are the durable part;
the writer is interchangeable. Recall survives its writer changing — which is
the same promise the Walrus layer makes about the app.

---

## Architecture

```mermaid
flowchart TB
    User(["User"]) --> UI["Recall UI<br/>(Next.js Composer)"]
    UI --> Route{"Jev route<br/>remember | recall"}

    Route -->|remember| Cap["captureMemory"]
    Cap --> Person{"Jev resolve<br/>person?"}
    Person --> WalrusW["memwal.remember<br/>namespace recall-userId"]
    WalrusW --> Blob[("Walrus blob<br/>Seal-encrypted")]
    Cap --> Proj[("Projection<br/>people / facts / due dates")]

    Route -->|recall| Fast["memwal.recall<br/>semantic shortlist"]
    Blob -.-> Fast
    Fast --> Rank{"Jev Noul rank<br/>≥ 0.35?"}
    Rank -->|none pass| Abstain["abstain<br/>no synthesis call"]
    Rank --> Synth["Writer synthesis<br/>words only"]
    Synth --> Verify{"Jev citation check<br/>supports?"}
    Verify -->|contradicted| Hide["hidden / withheld"]
    Verify --> Cited["cited answer ✓"]

    Blob -.->|same namespace| MCP["MCP agent<br/>Claude / Cursor"]
    Proj -.-> MCP
```

```
app/                     Next.js 15 App Router (React 19, server components)
  page.tsx               Landing + passwordless sign-in
  workspace/page.tsx   Main workspace: Composer + Today feed + People
  workspace/person/[id]/ Person profile: facts + memory timeline + blob links
  actions.ts             Server actions (only write path; auth-scoped)
components/
  Composer.tsx           One box, auto-routed: Remember / Recall (cited ✓)
  TodayCard.tsx          Follow-up card: Done / Snooze / copy draft
lib/
  memwal.ts              Walrus Memory client + per-user namespaces
  judge.ts               TypeSafe judgments: route, resolve, rank, verify
  store.ts               Local projection (people/facts/commitments/users)
  memory.ts              Domain logic: captureMemory() + recall()
  ai.ts                  Prose writer (Qwen via Token Factory) + provider chain
  auth.ts                Signed httpOnly session; strict per-user isolation
  env.ts                 Zod-validated, fail-fast config (no DB, no IAM)
scripts/
  verify-memwal.ts       Prove the Walrus round-trip (pnpm memwal:verify)
  verify-durability.ts   Prove memory outlives the app (pnpm memwal:durability)
  verify-e2e.ts          25-check product-path verifier (pnpm verify:e2e)
  verify-judge.ts        Prove the judgments live (pnpm judge:verify)
  seed.ts                Seed demo memories (pnpm seed — real Walrus blobs)
  run-nudges.ts          Daily reconnect nudges (pnpm nudge:run)
docs/
  ops-agent.md           MCP server workflow + demo script
  judgments.md           Judgment thresholds, fallbacks, cost/latency
  submission-checklist.md Walrus Session 8 eligibility + prize tracks
  video-script.md        Before/after demo recording script
  walrus-feedback.md     Session feedback draft + bug-bounty tracker
```
---

## Vision & roadmap

Memory should be infrastructure, not a feature: portable across sessions,
apps, and providers; encrypted by default; owned by the user, not the app.
Recall is the first client of that thesis — a companion whose store outlives
it (delete the local index and it still answers; `pnpm memwal:durability`
proves it).

Post-session roadmap: multi-turn conversation; Sui-wallet sign-in alongside
email; shared team/family namespaces; proactive digests (email/Telegram)
instead of pull-only Today; a Telegram/WhatsApp channel so capture happens
where life happens; blob-expiry renewal UX ahead of the ~2-year horizon.

## GTM plan

1. **Wedge where forgetting costs most:** founder, sales, recruiting, and
   community-builder circles — the article and promo go to those communities,
   not crypto channels.
2. **Single-player value first:** one user, one namespace, compounding memory.
   No team sale, no onboarding call, no admin panel.
3. **Distribution through agents:** native Walrus MCP (`memwal_*`) plus
   Recall's per-user MCP server put the same memory inside Claude Code and
   Cursor, where builders already live.
4. **Monetization later:** hosted namespaces with renewal guarantees for pros
   and teams; Walrus stays the store.

---

## Getting started

### 1. Prerequisites
- Node ≥ 20 (tested on 22), `pnpm`
- A Walrus Memory account: generate one at
  [memory.walrus.xyz](https://memory.walrus.xyz) (mainnet — required for the
  Session's ≥10-blob proof) or
  [staging.memory.walrus.xyz](https://staging.memory.walrus.xyz) (testnet).
  No database to install — the structured projection is a local JSON file.

### 2. Configure
```bash
cp .env.example .env.local
# set AUTH_SECRET (openssl rand -base64 48)
# set MEMWAL_PRIVATE_KEY + MEMWAL_ACCOUNT_ID (from the dashboard above)
# optional: BEDROCK_API_KEY + TYPESAFE_API_KEY — or AI_PROVIDER=mock for zero-cred demo
```

### 3. Install, init, prove, seed
```bash
pnpm install
pnpm store:init         # ensure the local projection file exists
pnpm memwal:verify      # prove the Walrus round-trip (health → blob → recall)
pnpm judge:verify       # prove the judgments live (route → resolve → rank → verify)
pnpm seed               # optional: demo user with realistic memories (real blobs)
```

### 3b. Prove the whole thing (before you demo it)
```bash
pnpm verify             # typecheck + unit tests + verify:e2e + memwal:durability
pnpm verify:e2e         # 25 checks: capture structure, cited recall, abstention, isolation
pnpm memwal:durability  # blobs owned on Sui; recall survives losing the local index
```

### 4. Run
```bash
pnpm dev             # http://localhost:3000
```
Sign in with any email (passwordless — a private memory space is created
instantly). If you seeded, sign in as **`demo@recall.app`**.

---

## Try it (90-second demo script — the before/after judges score)

1. **Before (amnesia baseline):** in a fresh session with no memories, ask
   *"Who do I know that's hiring React engineers?"* → "I don't have a memory
   of that yet."
2. **Remember:** paste
   *"Met Sarah Chen at the AI meetup — founder at Nimbus, ex-Stripe, hiring senior
   React engineers. Promised to intro her to Priya."*
   → Recall confirms what it saved (as a Walrus blob) and adds the follow-up
   to **Today**.
3. Add two more people the same way.
4. **Recall (new session, different words):** ask
   *"Who did I meet that's hiring frontend people?"*
   → You get a natural-language answer **plus the exact memory it came from**,
   scored (e.g. 0.95) and ✓-verified — click the name to open the person's
   profile + timeline. Same question the amnesiac bot failed — now answered
   from portable memory.
5. **Follow through:** in the **Today** panel, hit *Done* / *Snooze*, or copy the
   pre-drafted reconnect message.

---

## Security & privacy

Security is treated as an engineering requirement:

- **Memory is encrypted before storage** (Seal) and owned by the operator
  account; per-user isolation is enforced server-side via namespaces — the
  delegate key never reaches the browser.
- **Per-user isolation:** every projection query is scoped by the authenticated
  `user_id`; there is no cross-user read/write path. Server actions resolve
  the user before any data access.
- **Sessions** are signed (HS256, `jose`), `httpOnly`, `sameSite=lax`, `secure`
  in production.
- **Grounded AI:** recall answers are constrained to retrieved memories and cite
  their sources; citations are machine-verified and contradictions are
  withheld, never shown.
- **Audit log:** captures, recalls, abstentions, and status changes are
  recorded in the projection.
- **Rate limiting:** capture and recall are bounded per user (token bucket,
  30 req/min) so a runaway client can't exhaust quotas or spam Walrus.
- **Structured logging:** every sign-in, capture, recall, judgment, and status
  change emits one JSON line (`lib/log.ts`) — ready for CloudWatch Logs
  indexing, no prose parsing.
- **Fail-fast config:** `lib/env.ts` validates env at startup so misconfiguration
  can't silently ship.

**MVP non-goals (documented, not accidental):** email magic-link *verification*
is stubbed (sign-in issues a session directly) for a frictionless demo; add a
one-time-link step before production. Per-field encryption at rest in the local
projection is future work (Walrus blobs are already Seal-encrypted).

---

### Deliberate non-uses (measured, not assumed)

- **`analyze()`** — Walrus Memory's server-side fact extraction works well
  (`pnpm memwal:analyze` shows the output), but it returns each fact as its
  own unattributed blob. Recall needs a *resolved person*, a *source-memory
  citation*, and *commitments with due dates*, all in **one** record so a
  recall returns something coherent. We keep our own extraction and store the
  enriched record as a single blob.
- **Walrus Sites / Oyster / Seal-direct** — out of scope: this is a chatbot
  whose memory layer matters, not a static site host.

## Services used

- **Walrus Memory (mainnet)** — the memory layer: encrypted blobs, semantic
  recall, per-user namespaces. Blob proof: `GET /api/health` →
  `counts.walrus_blobs`.
- **Tatum (Sui RPC)** — independent onchain verification: Walrus epoch and
  capacity, MemWalAccount delegation (is our agent's key registered?), every
  memory's `Blob` object, and the real storage expiry. Proof:
  `pnpm tatum:verify`.
- **TypeSafe (Jev)** — every decision: intent, identity, relevance, citation
  verdicts. Proof: `pnpm judge:verify`.
- **Nebius Token Factory** (OpenAI-compatible, `Qwen/Qwen3-30B-A3B-Instruct-2507`,
  open weights — *Beyond the Big Two* track): the prose writer, behind a
  provider chain that degrades loudly rather than silently.
- **Amazon Bedrock — Mantle endpoint** (Mistral Voxtral Mini 3B): secondary
  writer on the same chain.
- **Fly.io**: hosts the live demo URL (single shared-1x 256MB machine,
  scale-to-zero, 1GB volume for the projection) — see `docs/deploy-fly.md`.
- **AWS Lambda + EventBridge** *(optional)*: runs the daily nudge cron
  serverlessly (see `infra/nudge-lambda.ts`).

## Tech
Next.js 15 · React 19 · TypeScript (strict) · Tailwind · Walrus Memory
(portable encrypted memory + semantic recall · per-user namespaces · MCP
server) · TypeSafe Jev (calibrated judgments: route, resolve, rank, verify) ·
Nebius Token Factory (Qwen3-30B-A3B, prose) · AWS Bedrock (secondary) · AWS Lambda · Fly.io
Hosting · `jose` · Zod.

## License
MIT — see [LICENSE](./LICENSE).
