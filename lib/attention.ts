import { loadStore, stalePeople, todayCommitments } from "./store";
import type { MemoryHealth } from "./health";
import type {
  AttentionFeed,
  AttentionItem,
  Commitment,
  Fact,
  Memory,
  Person,
} from "./types";

/**
 * The Attention feed — Dejavu acting like an agent, not a search box.
 *
 * A memory product that only answers when asked is a database. This layer
 * looks at what the user already told it and decides what needs a human now:
 * overdue promises, relationships going cold, memories about to expire,
 * date-bearing facts coming due, and details that recently changed.
 *
 * Everything here is derived from the projection + the onchain health report;
 * no extra model calls happen on render. Drafts are composed from the
 * person's actual facts and history, so they read like a follow-up rather
 * than a mail-merge template.
 */

const DAY_MS = 86_400_000;
const STALE_DAYS = 21;
const EXPIRY_WINDOW_DAYS = 60;
const CHANGE_WINDOW_DAYS = 7;

function personFirst(name: string | null | undefined): string {
  const clean = (name ?? "").replace(/^(Dr|Mr|Ms|Mrs|Prof)\.?\s+/i, "");
  return clean.split(/\s+/)[0] || "there";
}

function lowerFirst(text: string): string {
  return text.length > 0 ? text[0]!.toLowerCase() + text.slice(1) : text;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Promise descriptions often repeat the person's name ("send our deck to
 * Marcus Webb"). Remove it so the draft reads like a person wrote it.
 */
function cleanCommitment(description: string, personName: string | null): string {
  let text = description;
  if (personName) {
    const cleanName = personName.replace(/^(Dr|Mr|Ms|Mrs|Prof)\.?\s+/i, "");
    text = text.replace(
      new RegExp(`\\b${escapeRegExp(cleanName)}\\b`, "gi"),
      "",
    );
    const first = cleanName.split(/\s+/)[0];
    if (first && first.length >= 3) {
      text = text.replace(new RegExp(`\\b${escapeRegExp(first)}\\b`, "gi"), "");
    }
  }
  text = text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s+(to|with|for|from)$/i, "")
    .trim();
  if (/^follow up\b/i.test(text)) {
    text = text.replace(/^follow up(?:\s+with)?\b/i, "the follow-up on");
  } else if (/^intro\b/i.test(text)) {
    text = text.replace(/^intro\b/i, "the intro");
  } else {
    const gerunds: Record<string, string> = {
      send: "sending",
      share: "sharing",
      connect: "connecting",
      schedule: "scheduling",
      renew: "renewing",
      book: "booking",
      buy: "buying",
      make: "making",
      write: "writing",
      review: "reviewing",
      prepare: "preparing",
    };
    const first = text.split(/\s+/)[0]?.toLowerCase() ?? "";
    if (gerunds[first]) {
      text = `${gerunds[first]} ${text.split(/\s+/).slice(1).join(" ")}`.trim();
    }
  }
  return lowerFirst(text);
}

function firstClause(text: string, max = 90): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const stop = clean.search(/[.!?]\s/);
  const clause = stop > 0 ? clean.slice(0, stop) : clean;
  return clause.length > max ? `${clause.slice(0, max - 1)}…` : clause;
}

function factValue(facts: Fact[], key: string): string | null {
  return facts.find((f) => f.key === key && f.status === "current")?.value ?? null;
}

function topicFor(
  person: Person,
  memories: Memory[],
  facts: Fact[],
  commitments: Commitment[],
): string | null {
  const open = commitments.find(
    (c) => c.person_id === person.id && c.status === "open",
  );
  if (open) return cleanCommitment(open.description, person.name);
  const interest = factValue(facts, "interest");
  if (interest) return interest;
  const company = factValue(facts, "company") ?? person.company;
  if (company) return `things at ${company}`;
  const memory = memories[0];
  return memory ? lowerFirst(firstClause(memory.content)) : null;
}

function draftForCommitment(
  person: Person | null,
  commitment: Commitment,
  facts: Fact[],
): string {
  const first = personFirst(person?.name);
  const company = factValue(facts, "company") ?? person?.company ?? null;
  const role = factValue(facts, "role") ?? person?.headline ?? null;
  const topic = cleanCommitment(commitment.description, person?.name ?? null);
  const bits = [`Hi ${first}, following up on ${topic}.`];
  if (company) bits.push(`Hope things at ${company} are going well.`);
  else if (role) bits.push(`Hope the ${role} work is going well.`);
  bits.push("Do you have time this week?");
  return bits.join(" ");
}

function draftForStalePerson(
  person: Person,
  memories: Memory[],
  facts: Fact[],
  commitments: Commitment[],
): string {
  const first = personFirst(person.name);
  const topic = topicFor(person, memories, facts, commitments);
  const company = factValue(facts, "company") ?? person.company;
  const bits = [`Hi ${first}, it's been a while${topic ? ` since we talked about ${topic}` : ""}.`];
  if (company && !topic?.includes(company)) {
    bits.push(`How are things at ${company}?`);
  } else {
    bits.push("How have you been?");
  }
  bits.push("Would love to catch up this week.");
  return bits.join(" ");
}

function itemPhrase(item: AttentionItem): string {
  const who = item.personName ?? "A follow-up";
  switch (item.kind) {
    case "commitment":
      return item.dueAt && new Date(item.dueAt).getTime() < Date.now()
        ? `${who} is overdue on ${lowerFirst(item.detail)}`
        : `${who}: ${lowerFirst(item.detail)}`;
    case "stale_person":
      return `${who} has gone quiet`;
    case "expiring_memory":
      return `${who === "A follow-up" ? "A memory" : `${who}'s memory`} expires soon`;
    case "fact_deadline":
      return `${who === "A follow-up" ? "" : `${who}'s `}${item.title.toLowerCase()} is coming up`;
    case "changed_fact":
      return `${who}'s ${item.title.toLowerCase()} changed`;
  }
}

function buildBrief(items: AttentionItem[]): string {
  if (items.length === 0) {
    return "Nothing needs attention right now. Capture something and I'll keep watch.";
  }
  const top = items.slice(0, 3).map(itemPhrase);
  const joined =
    top.length === 1
      ? top[0]
      : top.length === 2
        ? `${top[0]} and ${top[1]}`
        : `${top[0]}, ${top[1]}, and ${top[2]}`;
  const n = items.length;
  return `${n} thing${n === 1 ? "" : "s"} ${n === 1 ? "needs" : "need"} attention: ${joined}.`;
}

/**
 * Build the feed. Pass the already-computed health report from the workspace
 * page so the onchain expiry data is not fetched twice.
 */
export async function getAttentionFeed(
  userId: string,
  health?: MemoryHealth | null,
): Promise<AttentionFeed> {
  const store = loadStore();
  const peopleById = new Map(
    store.people.filter((p) => p.user_id === userId).map((p) => [p.id, p]),
  );
  const memoriesByPerson = new Map<string, Memory[]>();
  for (const m of store.memories) {
    if (m.user_id !== userId || m.status !== "active" || !m.person_id) continue;
    const list = memoriesByPerson.get(m.person_id) ?? [];
    list.push(m);
    memoriesByPerson.set(m.person_id, list);
  }
  for (const list of memoriesByPerson.values()) {
    list.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
  }
  const factsByPerson = new Map<string, Fact[]>();
  for (const f of store.facts) {
    if (f.user_id !== userId || f.status !== "current" || !f.person_id) continue;
    const list = factsByPerson.get(f.person_id) ?? [];
    list.push(f);
    factsByPerson.set(f.person_id, list);
  }
  const commitmentsByPerson = new Map<string, Commitment[]>();
  for (const c of store.commitments) {
    if (c.user_id !== userId || !c.person_id) continue;
    const list = commitmentsByPerson.get(c.person_id) ?? [];
    list.push(c);
    commitmentsByPerson.set(c.person_id, list);
  }

  const items: AttentionItem[] = [];
  const coveredPeople = new Set<string>();

  // 1. Due / overdue promises.
  for (const c of todayCommitments(userId)) {
    const person = c.person_id ? (peopleById.get(c.person_id) ?? null) : null;
    const overdue = c.due_at ? new Date(c.due_at).getTime() < Date.now() : false;
    const facts = person ? (factsByPerson.get(person.id) ?? []) : [];
    items.push({
      id: `commitment:${c.id}`,
      kind: "commitment",
      title: person?.name ?? "Follow-up",
      detail: c.description,
      personId: person?.id ?? null,
      personName: person?.name ?? null,
      dueAt: c.due_at,
      urgency: overdue ? 1 : c.due_at ? 0.85 : 0.55,
      commitmentId: c.id,
      draftMessage: draftForCommitment(person, c, facts),
      href: person ? `/workspace/person/${person.id}` : undefined,
    });
    if (person) coveredPeople.add(person.id);
  }

  // 2. Relationships going cold (already excludes open "Reconnect with" nudges).
  for (const row of stalePeople(userId, STALE_DAYS)) {
    if (coveredPeople.has(row.person_id)) continue;
    const person = peopleById.get(row.person_id);
    if (!person) continue;
    const days = row.last_interaction_at
      ? Math.floor((Date.now() - new Date(row.last_interaction_at).getTime()) / DAY_MS)
      : null;
    const memories = memoriesByPerson.get(person.id) ?? [];
    const facts = factsByPerson.get(person.id) ?? [];
    const commitments = commitmentsByPerson.get(person.id) ?? [];
    items.push({
      id: `stale:${person.id}`,
      kind: "stale_person",
      title: person.name,
      detail: days
        ? `No contact in ${days} days${person.company ? ` · ${person.company}` : ""}`
        : "No recent contact",
      personId: person.id,
      personName: person.name,
      dueAt: null,
      urgency: days ? Math.min(0.8, 0.45 + days / 180) : 0.5,
      draftMessage: draftForStalePerson(person, memories, facts, commitments),
      href: `/workspace/person/${person.id}`,
    });
    coveredPeople.add(person.id);
  }

  // 3. Important memories whose onchain storage is running out.
  if (health) {
    for (const row of health.atRisk) {
      if (row.daysToExpiry === null) continue;
      items.push({
        id: `expiring:${row.memoryId}`,
        kind: "expiring_memory",
        title: row.personName
          ? `${row.personName}'s memory`
          : "An important memory",
        detail: `${row.snippet} — storage ends in ${row.daysToExpiry} days`,
        personId: row.personId,
        personName: row.personName,
        dueAt: null,
        urgency: row.daysToExpiry <= 30 ? 0.9 : 0.7,
        memoryId: row.memoryId,
        href: row.personId
          ? `/workspace/person/${row.personId}`
          : "/workspace",
      });
    }
  }

  // 4. Date-bearing facts coming due (passport, insurance, renewals).
  const now = Date.now();
  for (const f of store.facts) {
    if (f.user_id !== userId || f.status !== "current" || !f.absolute_date) continue;
    const at = new Date(`${f.absolute_date}T12:00:00.000Z`).getTime();
    const days = Math.ceil((at - now) / DAY_MS);
    if (days > EXPIRY_WINDOW_DAYS) continue;
    const person = f.person_id ? (peopleById.get(f.person_id) ?? null) : null;
    const label = f.attribute.replace(/_/g, " ");
    items.push({
      id: `deadline:${f.id}`,
      kind: "fact_deadline",
      title: label,
      detail: `${person ? `${person.name}: ` : ""}${f.value} — ${
        days < 0 ? `passed ${Math.abs(days)} days ago` : `due in ${days} day${days === 1 ? "" : "s"}`
      }`,
      personId: person?.id ?? null,
      personName: person?.name ?? null,
      dueAt: `${f.absolute_date}T12:00:00.000Z`,
      urgency: days < 0 ? 0.95 : days <= 7 ? 0.9 : 0.7,
      factId: f.id,
      href: person ? `/workspace/person/${person.id}` : "/workspace",
    });
  }

  // 5. Details that changed recently — a quiet "did I get this right?".
  const changed = new Map<string, { current: Fact; old: Fact }>();
  const changeCutoff = now - CHANGE_WINDOW_DAYS * DAY_MS;
  for (const old of store.facts) {
    if (
      old.user_id !== userId ||
      old.status !== "superseded" ||
      !old.person_id ||
      !old.superseded_at ||
      new Date(old.superseded_at).getTime() < changeCutoff
    ) {
      continue;
    }
    const current = store.facts.find(
      (f) =>
        f.user_id === userId &&
        f.person_id === old.person_id &&
        f.key === old.key &&
        f.status === "current",
    );
    if (!current) continue;
    const key = `${old.person_id}:${old.key}`;
    if (changed.has(key)) continue;
    changed.set(key, { current, old });
  }
  for (const { current, old } of [...changed.values()].slice(0, 3)) {
    const person = current.person_id
      ? (peopleById.get(current.person_id) ?? null)
      : null;
    items.push({
      id: `changed:${current.id}`,
      kind: "changed_fact",
      title: current.attribute.replace(/_/g, " "),
      detail: `${person ? `${person.name}: ` : ""}now ${current.value} (was ${old.value})`,
      personId: person?.id ?? null,
      personName: person?.name ?? null,
      dueAt: null,
      urgency: 0.35,
      factId: current.id,
      href: person ? `/workspace/person/${person.id}` : "/workspace",
    });
  }

  // Deduplicate by id, then urgency; due dates break ties.
  const seen = new Set<string>();
  const sorted = items
    .filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)))
    .sort((a, b) => {
      if (b.urgency !== a.urgency) return b.urgency - a.urgency;
      return (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999");
    })
    .slice(0, 12);

  return {
    items: sorted,
    brief: buildBrief(sorted),
    counts: {
      commitments: sorted.filter((i) => i.kind === "commitment").length,
      stale: sorted.filter((i) => i.kind === "stale_person").length,
      expiring: sorted.filter((i) => i.kind === "expiring_memory").length,
      deadlines: sorted.filter((i) => i.kind === "fact_deadline").length,
      changes: sorted.filter((i) => i.kind === "changed_fact").length,
    },
    generatedAt: new Date().toISOString(),
  };
}
