# Total Recall submission checklist — Walrus × Tatum

Hackathon: **Total Recall** · Oct 20 → Nov 10, 2026, 17:00 UTC · $4,500
Rules: <https://thewalrussessions.wal.app/tatum-total-recall/index.html>
Submit: <https://recall-tatum-walrus.vercel.app>

## Hard requirements

- [ ] **Walrus Memory integrated, writing on mainnet.**
      One blob per capture in `recall-<userId>`; proof: `pnpm memwal:verify`,
      `GET /api/health` → `counts.walrus_blobs`.
- [ ] **Tatum RPC used for onchain data.**
      Walrus system epoch, MemWalAccount delegation, every `Blob` object and
      its storage window: `pnpm tatum:verify`, "Verified onchain" panel.
- [ ] **≥10 memories on mainnet.** Currently 60 blob objects under the
      operator account (14 matched to production memories).
- [ ] **Published blog post** — what it does, how it uses Tatum + Walrus, how it
      learned over time.
- [ ] **Working demo + public repo.**
      Live: <https://dejavu-memory.fly.dev> · Repo: this one.
- [ ] **Short demo video (2–3 min)** for the submission form.
- [ ] Optional: **Tatum AI Builder** app — skipped deliberately: one submission
      per person, and the prize requires a product built *primarily* with
      `ai.tatum.io`. See "Decision log" below.

## Submission form fields

- Email, Discord handle, LinkedIn
- How did you hear about this event?
- Is this your first Web3 project?
- **Tatum ID** — from the Tatum dashboard
- SUI address — `0x86E95581E41946ED84956433a8a9c836bCbA636c`
- Account ID (SUI) — `0xcabeee7879ba406f534995d42790b4b4e7004d322aa7ad6e20caf07d107653e5`
- MEMWAL_AGENT_ID — `ef0c967b7f85bafe9fd697aa26999c74afbc28dcb0d3e3f975b1f8de7a64eec4`
- Project description — see the README "Product" section
- Demo video link
- GitHub repo
- Experience with Walrus / Tatum AI Builder

## Track

**Smart Agents for Real Life** — agents that pick up where they left off across
tools and sessions.

## Prizes and how we address them

| Prize | Amount | How |
|---|---|---|
| Track (Smart Agents) | $500 / $300 / $200 | Core entry: memory that survives sessions, apps, and models |
| Best Walrus Memory | $500 | Learning loop: recall usage → explainable importance → ranking tie-break → renewal priority against onchain expiry |
| Tatum AI Builder | $500 | **Skipped** — see decision log |
| Mystery bounty | $500 | TBA on Discord |

## Judging criteria

| Criterion | Weight | Evidence |
|---|---|---|
| Walrus & Tatum integration | 30% | Blob per capture, per-user namespaces, `restore()`, native MCP; Tatum verifies blobs, delegation, expiry |
| Technical quality | 30% | 82 tests, `verify:e2e` (28 checks), `memwal:durability`, `tatum:verify`, grounding gates, citation verification |
| Creativity | 20% | Cited + verified answers, calibrated abstention, importance loop tied to storage economics |
| Presentation | 20% | Live app, one-click demo, `/api/health`, README, video |

## Decision log

- **AI Builder skipped.** The prize is for a product "built primarily with
  ai.tatum.io", and the rules allow one submission per person. Our entry is
  hand-built; a generated companion app would not qualify as "primarily" and
  would replace a stronger submission. Instead we use Tatum's first-party dev
  tooling (Blockchain MCP, Skills) during development.
- **Namespace prefix kept as `recall-<userId>`.** Renaming it after the brand
  change would orphan every existing mainnet blob. The prefix is an
  implementation detail, documented in the README.
- **Bedrock kept as a secondary writer.** Its hosted API keys expire; the
  primary writer is Qwen via Token Factory, with a visible provider chain.

## Proof commands

```bash
pnpm verify             # typecheck + tests + e2e + durability
pnpm tatum:verify       # onchain: system, delegation, blobs, expiry
pnpm memwal:verify      # Walrus round-trip
curl https://dejavu-memory.fly.dev/api/health
```
