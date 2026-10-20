# Video production script (< 3 minutes)

The Session submission needs a public article with **evidence of real use**
(screenshots, conversation logs, video, or a live link showing the chatbot
remembering across sessions). A short screen recording is the strongest
evidence. This script is timed to ~2:45. Record at 1080p; narrate as you go.
It doubles as the article's embedded demo.

## Pre-recording checklist

- [ ] Walrus Memory account funded on **mainnet**, `pnpm memwal:verify` → PASS.
- [ ] Demo data seeded (`pnpm seed`) — every seed memory is a real Walrus blob.
- [ ] App deployed on Fly.io (or `pnpm dev` locally — but a live URL is
      stronger for "deployed and used by real people").
- [ ] A Claude Code / Cursor window with Recall's MCP server connected
      (`/api/mcp`, see `docs/ops-agent.md`).

## The script

### 0:00–0:15 — Hook
> "Most chatbots forget you the moment you close the tab. This is Recall — a
> relationship-memory chatbot whose memory lives on Walrus: encrypted,
> portable, and verifiable. It remembers people across sessions, apps, even
> providers."

Show: the landing page, sign in as `demo@recall.app`.

### 0:15–0:30 — Before (the amnesia baseline)
> "Here's the same chatbot *without* memory. Watch it fail."

Show: a fresh session / memory toggle off. Ask *"Who's hiring React
engineers?"* → "I don't have a memory of that yet." This is your before/after
anchor — the judges explicitly score it.

### 0:30–1:00 — Capture
> "Now tell it who you met, in plain words. Watch what it extracts."

Paste: *"Met Sarah Chen at the AI meetup — founder at Nimbus, ex-Stripe, hiring
senior React engineers. Promised to intro her to Priya."*

> "It extracted the person, the facts, the commitment — and persisted the
> memory as an encrypted blob on Walrus. The follow-up just landed in the
> Today feed."

Show: the capture confirmation, then the Today card that appeared.

### 1:00–1:45 — Recall across sessions (the memory moment)
> "Now the real test. New session — nothing in context. And I'm going to ask
> with *none* of the same words."

Open a fresh session (or a different browser). Switch to the Recall tab. Ask:
*"Who did I meet that's hiring frontend people?"*

> "It found Sarah Chen — and shows the exact memory the answer came from.
> That's Walrus Memory doing semantic recall across sessions, and the citation
> means the answer is never invented. Click the name…"

Click through to Sarah's profile.

> "…and here's everything Recall knows about her, with a timeline. This memory
> isn't locked in this app — it's a portable blob my other agents can read
> too."

### 1:45–2:05 — Follow through
> "The Today feed is the proactive agent. These are follow-ups that are due —
> with a pre-drafted message I can copy in one tap. The daily nudge cron runs
> serverlessly, so Recall acts without being asked."

Show: a Today card, copy the draft.

### 2:05–2:30 — The second agent (MCP)
> "Recall doesn't just *have* memory — your own agents can *use* it. This is
> Claude Code connected to my memory through Recall's MCP server — read-only,
> scoped to me."

In Claude Code, ask: *"Which person has the most memories?"* then *"What did
I promise Marcus?"*

> "It answered from the same Walrus-backed memory the chatbot uses. One
> memory layer, every agent."

### 2:30–2:45 — Architecture + close
Show the architecture diagram (in the README / a slide).

> "The writer answers, Jev decides, Walrus remembers — encrypted blobs with
> per-user namespaces. Semantic recall with citations. Your agents read it over
> MCP. Deployed on Fly.io. That's Recall — a chatbot that actually
> remembers."

## After recording

- Embed the video (or GIFs + screenshots) in the Medium/Inkray article with
  the before/after comparison and the Walrus integration explanation.
- Link the live app + GitHub repo from the article.
- Keep the raw recording until winners are announced.
