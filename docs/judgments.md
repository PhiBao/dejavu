# Calibrated judgments — how Recall decides (TypeSafe Jev)

Generative LLMs write good words and make unaccountable choices. Recall
splits the two: **Jev decides, the writer only writes words.** Every decision in the
pipeline is a typed TypeSafe question with probabilities + confidence; code
owns the thresholds and the fallbacks. The prose writer (Qwen via Token
Factory) only ever generates
prose (extraction JSON, answer synthesis) from decided context.

## The four judgments (`lib/judge.ts`)

| # | Question | Type | Cookbook pattern | Fallback when Jev is off/fails |
|---|---|---|---|---|
| 1 | What does the user want? | Choice(remember \| recall) | intent routing | Manual Composer toggle |
| 2 | Which person is this memory about? | Choice over pre-parsed spans + none hatch | pre-parsed value extraction | the writer's `personName` |
| 3 | Does this memory answer the question? | Noul per pair, one batched call | reranking (fast search + rerank) | Walrus distance order / writer rerank |
| 4 | Does the source support the claim? | Choice(supports \| contradicts \| says_nothing), batched | citation check | Unverified citations (no badge) |

Candidates are always pre-parsed by code: roster names + regex spans for
people; Walrus shortlist for ranking. Jev selects — it never invents.

## Thresholds (`lib/judge.ts` constants)

| Constant | Value | Meaning | How to tune |
|---|---|---|---|
| `INTENT_MIN_CONFIDENCE` | 0.5 | Below → ignore routing, keep current tab | Raise if users report wrong-tab submits |
| `RELEVANCE_MIN_SCORE` | 0.35 | Below → memory never reaches synthesis; empty pool → abstain without a synthesis call | Lower if legit answers abstain; raise if filler citations appear |
| `CITATION_AUTO_ACCEPT` | 0.8 | `verified` + conf ≥ 0.8 → ✓ badge; weaker → shown without badge; `contradicted` → hidden, all-hidden → abstain | Start high per the citation-check cookbook; lower as trust builds |
| Person `none` hatch | 0.7 | High-conf "none" → no person; low-conf → trust the writer's proposal | Raise if real people go unattributed |

Pin `TYPESAFE_MODEL_ID` to a versioned id (e.g. `jev-1.13.0`) once thresholds
are tuned against it; `jev-latest` (default) can move under you.

## Cost & latency (measured Sep 2026)

- Jev: $0.042/Mtok input, output free. A full recall (rank 6 + verify 3)
  costs a fraction of a cent; each judgment round-trips in ~0.3–1s.
- Ranking + verification batch into single calls (parallel questions), so
  judgments add ~2 sequential calls to recall, ~1 to capture.
- Abstention *saves* a synthesis call whenever nothing is relevant.

## Evidence

- `pnpm judge:verify` — live proof: routing, the Ravi/David regression,
  paraphrase ranking, citation verdicts.
- Structured logs (`judge_route`, `judge_person`, `judge_rerank`,
  `judge_citations` with input tokens) — quote these in the article.
