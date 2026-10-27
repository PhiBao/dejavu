/**
 * Recall evaluation — 50 questions over the demo memory.
 *
 * Categories: exact fact, paraphrase, count/list, temporal, abstention,
 * updated fact, contradiction, person-less note, older memory, follow-up.
 *
 * Usage:
 *   DEJAVU_DATA_PATH=/tmp/opencode/dejavu-prod.json pnpm eval:recall
 *   EVAL_LIMIT=10 ... pnpm eval:recall
 *
 * The script is intentionally honest: it reports misses, wrong citations,
 * false abstentions, and median latency instead of a single vanity score.
 */
import { loadEnv } from "./load-env";
loadEnv();

import { writeFileSync } from "node:fs";
import { join } from "node:path";

const { findUserByEmail, loadStore } = await import("../lib/store");
const { recall } = await import("../lib/memory");
const { ABSTAIN_TEXT } = await import("../lib/ai");

type Category =
  | "exact"
  | "paraphrase"
  | "count/list"
  | "temporal"
  | "abstention"
  | "updated"
  | "contradiction"
  | "person-less"
  | "older"
  | "follow-up";

interface EvalQuestion {
  id: number;
  category: Category;
  question: string;
  /** Answer must match this when not abstaining. */
  expect?: RegExp;
  /** Answer must NOT match this (stale/incorrect value). */
  reject?: RegExp;
  /** True when the only correct behavior is a grounded abstention. */
  abstain?: boolean;
  /** True when a non-abstaining answer should have at least one citation. */
  cited?: boolean;
}

const QUESTIONS: EvalQuestion[] = [
  // Exact fact (10)
  { id: 1, category: "exact", question: "Who is Sarah Chen?", expect: /sarah/i, cited: true },
  { id: 2, category: "exact", question: "Where does Marcus Webb work?", expect: /foundry/i, cited: true },
  { id: 3, category: "exact", question: "What does Tomás Silva do?", expect: /growth|loop/i, cited: true },
  { id: 4, category: "exact", question: "Where does Aisha Khan work?", expect: /vercel/i, cited: true },
  { id: 5, category: "exact", question: "Who is Ravi Menon?", expect: /ravi|datadog|engineer/i, cited: true },
  { id: 6, category: "exact", question: "What is Priya Nair's role?", expect: /designer|linear|figma/i, cited: true },
  { id: 7, category: "exact", question: "What is David Okafor's title?", expect: /cto|paystack/i, cited: true },
  { id: 8, category: "exact", question: "What is Nadia Rahman's role?", expect: /product|notion/i, cited: true },
  { id: 9, category: "exact", question: "What does Dr. Lena Ortiz research?", expect: /retrieval|memory|mit/i, cited: true },
  { id: 10, category: "exact", question: "When does my passport expire?", expect: /7 weeks|december|2026-12-15|dec/i, cited: true },

  // Paraphrase (8)
  { id: 11, category: "paraphrase", question: "Who did I meet that's recruiting frontend people?", expect: /sarah/i, cited: true },
  { id: 12, category: "paraphrase", question: "Which person invests in developer tools?", expect: /marcus|foundry/i, cited: true },
  { id: 13, category: "paraphrase", question: "Who works on retrieval systems?", expect: /lena|mit/i, cited: true },
  { id: 14, category: "paraphrase", question: "Who is into padel?", expect: /tom.s|silva/i, cited: true },
  { id: 15, category: "paraphrase", question: "Who is exploring creator tools?", expect: /aisha|vercel/i, cited: true },
  { id: 16, category: "paraphrase", question: "Who owes me a referral?", expect: /ravi|datadog|sre/i, cited: true },
  { id: 17, category: "paraphrase", question: "Who used to work at Figma?", expect: /priya|linear/i, cited: true },
  { id: 18, category: "paraphrase", question: "Who is scaling an engineering org?", expect: /david|paystack/i, cited: true },

  // Count/list (5)
  { id: 19, category: "count/list", question: "How many founders did I meet?", expect: /sarah|one|1/i, reject: /marcus.*founder/i, cited: true },
  { id: 20, category: "count/list", question: "List all the people I know.", expect: /sarah|marcus|lena|tom.s|aisha|ravi|priya|david|nadia/i, cited: true },
  { id: 21, category: "count/list", question: "Who is hiring?", expect: /sarah|ravi|react|platform/i, cited: true },
  { id: 22, category: "count/list", question: "Who works at a fintech?", expect: /tom.s|loop|sarah|linear|priya/i, cited: true },
  { id: 23, category: "count/list", question: "How many people work at Linear?", expect: /sarah|priya|two|2/i, cited: true },

  // Temporal (5)
  { id: 24, category: "temporal", question: "What did I promise Marcus?", expect: /deck/i, cited: true },
  { id: 25, category: "temporal", question: "What did I promise Priya?", expect: /blog|vercel|design/i, cited: true },
  { id: 26, category: "temporal", question: "What did I promise Sarah?", expect: /priya|intro/i, cited: true },
  { id: 27, category: "temporal", question: "What should I renew before Lisbon?", expect: /passport/i, cited: true },
  { id: 28, category: "temporal", question: "What is due in 7 weeks?", expect: /passport|expir/i, cited: true },

  // Abstention (5)
  { id: 29, category: "abstention", question: "Who do I know in Tokyo who plays competitive chess?", abstain: true },
  { id: 30, category: "abstention", question: "What is Sarah's favorite movie?", abstain: true },
  { id: 31, category: "abstention", question: "When did I last visit Berlin?", abstain: true },
  { id: 32, category: "abstention", question: "Who is my dentist?", abstain: true },
  { id: 33, category: "abstention", question: "What did I buy at the Apple Store?", abstain: true },

  // Updated fact (5)
  { id: 34, category: "updated", question: "Where does Sarah Chen work now?", expect: /linear/i, reject: /nimbus/i, cited: true },
  { id: 35, category: "updated", question: "Is Sarah still at Nimbus?", expect: /linear|no/i, reject: /yes.*nimbus/i, cited: true },
  { id: 36, category: "updated", question: "What is Sarah's current company?", expect: /linear/i, reject: /nimbus/i, cited: true },
  { id: 37, category: "updated", question: "Who is the founder at Linear?", expect: /sarah/i, cited: true },
  { id: 38, category: "updated", question: "What changed about Sarah?", expect: /linear|nimbus|company/i, cited: true },

  // Contradiction (3)
  { id: 39, category: "contradiction", question: "Is Tomás a founder?", expect: /growth|no|loop/i, reject: /yes.*founder/i, cited: true },
  { id: 40, category: "contradiction", question: "Does Marcus work at Nimbus?", expect: /foundry|no/i, reject: /yes.*nimbus/i, cited: true },
  { id: 41, category: "contradiction", question: "Is Priya a founder?", expect: /designer|no|figma|linear/i, reject: /yes.*founder/i, cited: true },

  // Person-less note (3)
  { id: 42, category: "person-less", question: "What expires in 7 weeks?", expect: /passport/i, cited: true },
  { id: 43, category: "person-less", question: "What do I need to renew?", expect: /passport/i, cited: true },
  { id: 44, category: "person-less", question: "What trip is the passport renewal for?", expect: /lisbon/i, cited: true },

  // Older memory (3)
  { id: 45, category: "older", question: "Who did I meet at the SF AI meetup?", expect: /sarah/i, cited: true },
  { id: 46, category: "older", question: "What did I discuss at the design dinner?", expect: /nadia|design|notion/i, cited: true },
  { id: 47, category: "older", question: "Who did I have lunch with?", expect: /david|paystack/i, cited: true },

  // Follow-up (3)
  { id: 48, category: "follow-up", question: "Tell me more about Sarah.", expect: /linear|react|priya|stripe/i, cited: true },
  { id: 49, category: "follow-up", question: "What else do I know about Marcus?", expect: /climb|foundry|deck|dev tools|seed/i, cited: true },
  { id: 50, category: "follow-up", question: "What should I do about the passport?", expect: /renew|passport|lisbon/i, cited: true },
];

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
    : sorted[mid]!;
}

async function main() {
  const email = process.env.EVAL_EMAIL ?? "demo@dejavu.app";
  const user = findUserByEmail(email);
  if (!user) {
    console.error(`[eval] no user ${email} in ${process.env.DEJAVU_DATA_PATH ?? "default store"}`);
    process.exit(1);
  }
  const limit = Number(process.env.EVAL_LIMIT ?? QUESTIONS.length);
  const questions = QUESTIONS.slice(0, Math.max(1, Math.min(limit, QUESTIONS.length)));
  const store = loadStore();
  const memories = store.memories.filter(
    (m) => m.user_id === user.id && m.status === "active",
  ).length;

  console.log(
    `[eval] user=${email} memories=${memories} questions=${questions.length} path=${process.env.DEJAVU_DATA_PATH ?? "default"}\n`,
  );

  const rows: Array<{
    id: number;
    category: Category;
    question: string;
    correct: boolean;
    abstained: boolean;
    citations: number;
    citedOk: boolean;
    latencyMs: number;
    answer: string;
  }> = [];

  for (const q of questions) {
    const started = Date.now();
    const res = await recall(user.id, q.question);
    const latencyMs = Date.now() - started;
    const abstained = res.answer.trim().startsWith(ABSTAIN_TEXT);
    const matches = q.expect ? q.expect.test(res.answer) : true;
    const rejected = q.reject ? q.reject.test(res.answer) : false;
    const correct = q.abstain ? abstained : !abstained && matches && !rejected;
    const citedOk = q.abstain
      ? res.citations.length === 0
      : q.cited
        ? res.citations.length > 0
        : true;
    rows.push({
      id: q.id,
      category: q.category,
      question: q.question,
      correct,
      abstained,
      citations: res.citations.length,
      citedOk,
      latencyMs,
      answer: res.answer.replace(/\s+/g, " ").slice(0, 180),
    });
    console.log(
      `${correct ? "PASS" : "FAIL"}  ${String(q.id).padStart(2, "0")} [${q.category}] ${q.question}\n      → ${res.answer.replace(/\s+/g, " ").slice(0, 150)}${res.citations.length ? ` (${res.citations.length} cites)` : ""} ${latencyMs}ms`,
    );
  }

  const total = rows.length;
  const correct = rows.filter((r) => r.correct).length;
  const abstentionRows = rows.filter((r) => r.category === "abstention");
  const correctAbstentions = abstentionRows.filter((r) => r.abstained).length;
  const answerable = rows.filter((r) => r.category !== "abstention");
  const citationPrecision =
    answerable.length === 0
      ? 0
      : answerable.filter((r) => r.citedOk).length / answerable.length;
  const falseAbstentions = answerable.filter((r) => r.abstained).length;
  const latencies = rows.map((r) => r.latencyMs);

  const byCategory = new Map<Category, { total: number; correct: number }>();
  for (const r of rows) {
    const row = byCategory.get(r.category) ?? { total: 0, correct: 0 };
    row.total++;
    if (r.correct) row.correct++;
    byCategory.set(r.category, row);
  }

  console.log("\n[eval] summary");
  console.log(`  correct: ${correct}/${total} (${Math.round((correct / total) * 100)}%)`);
  console.log(
    `  correct abstention: ${correctAbstentions}/${abstentionRows.length}`,
  );
  console.log(`  false abstention: ${falseAbstentions}/${answerable.length}`);
  console.log(
    `  citation presence: ${Math.round(citationPrecision * 100)}% of answerable questions`,
  );
  console.log(`  median latency: ${median(latencies)}ms`);
  for (const [category, row] of byCategory) {
    console.log(`  ${category}: ${row.correct}/${row.total}`);
  }

  const report = `# Recall evaluation — ${new Date().toISOString()}

User: \`${email}\` · active memories: ${memories} · questions: ${total}

| Metric | Result |
|---|---:|
| Correct answers | ${correct}/${total} (${Math.round((correct / total) * 100)}%) |
| Correct abstention | ${correctAbstentions}/${abstentionRows.length} |
| False abstention | ${falseAbstentions}/${answerable.length} |
| Citation presence | ${Math.round(citationPrecision * 100)}% |
| Median latency | ${median(latencies)} ms |

## By category

${[...byCategory.entries()].map(([c, r]) => `- **${c}**: ${r.correct}/${r.total}`).join("\n")}

## Questions

| # | Category | Question | Result | Cites | Latency | Answer |
|---:|---|---|---|---:|---:|---|
${rows
  .map(
    (r) =>
      `| ${r.id} | ${r.category} | ${r.question.replace(/\|/g, "\\|")} | ${r.correct ? "PASS" : "FAIL"} | ${r.citations} | ${r.latencyMs}ms | ${r.answer.replace(/\|/g, "\\|")} |`,
  )
  .join("\n")}
`;
  const out = join(process.cwd(), "docs", "eval-recall-report.md");
  writeFileSync(out, report, "utf8");
  console.log(`\n[eval] report: ${out}`);
  process.exit(correct === total ? 0 : 1);
}

main().catch((err) => {
  console.error("[eval] ERROR:", err instanceof Error ? err.message : err);
  process.exit(1);
});
