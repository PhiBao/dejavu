/**
 * Deterministic date understanding for daily-life memory.
 *
 * A memory companion is only as good as its dates: "my passport expires in
 * March 2027", "I met Sarah yesterday", "send the deck by Friday". Language
 * models are good at prose and unreliable at calendar arithmetic, so dates are
 * parsed here — in code, against a clock we control — and the model's date
 * output is only ever a fallback.
 *
 * Everything is computed in UTC and returned as `YYYY-MM-DD`, which keeps the
 * projection portable and comparisons unambiguous. Display formatting happens
 * in the UI.
 */

const MONTHS: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  sept: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

const MONTH_PATTERN =
  "january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec";

const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

const WEEKDAY_PATTERN =
  "sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat";

export interface DateMention {
  /** Calendar date as YYYY-MM-DD (UTC). */
  iso: string;
  /** Character offset of the match in the source text. */
  index: number;
  /** The exact phrase that produced this date. */
  text: string;
  /** True for "March 2027" / "March" — no day-of-month stated. */
  monthOnly: boolean;
  /** True when the phrase named a year (or was relative to now). */
  hasYear: boolean;
  /**
   * Weak mentions are bare month names ("March"). They are only trusted for
   * deadlines when a deadline cue sits nearby, never for event dates.
   */
  weak: boolean;
}

const DAY_MS = 86_400_000;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function todayUtc(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/** Build a validated UTC date; returns null for impossible dates. */
function makeDate(year: number, month: number, day: number): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  return d;
}

function iso(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function addMonths(date: Date, months: number): Date {
  const normalized = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1),
  );
  const year = normalized.getUTCFullYear();
  const month = normalized.getUTCMonth() + 1;
  const day = Math.min(date.getUTCDate(), lastDayOfMonth(year, month));
  return new Date(Date.UTC(year, month - 1, day));
}

/** Next occurrence of a weekday at or after `from` (strict when `strict`). */
function weekdayOnOrAfter(from: Date, weekday: number, strict = false): Date {
  const delta = (weekday - from.getUTCDay() + 7) % 7;
  if (delta === 0 && strict) return addDays(from, 7);
  return addDays(from, delta);
}

/** Previous occurrence of a weekday strictly before `from`. */
function weekdayBefore(from: Date, weekday: number): Date {
  const delta = (from.getUTCDay() - weekday + 7) % 7 || 7;
  return addDays(from, -delta);
}

function monthFromName(name: string): number | null {
  return MONTHS[name.toLowerCase()] ?? null;
}

/**
 * Find every date-like phrase in `text`, most specific first. Overlapping
 * matches are discarded so "March 15, 2027" yields one mention, not three.
 */
export function findDateMentions(text: string, now = new Date()): DateMention[] {
  const today = todayUtc(now);
  const found: DateMention[] = [];
  const occupied: Array<[number, number]> = [];

  function add(
    match: RegExpMatchArray,
    date: Date | null,
    opts: { monthOnly?: boolean; hasYear?: boolean; weak?: boolean } = {},
  ): void {
    if (!date) return;
    const index = match.index ?? 0;
    const end = index + match[0].length;
    if (occupied.some(([s, e]) => index < e && end > s)) return;
    occupied.push([index, end]);
    found.push({
      iso: iso(date),
      index,
      text: match[0],
      monthOnly: opts.monthOnly ?? false,
      hasYear: opts.hasYear ?? false,
      weak: opts.weak ?? false,
    });
  }

  // 1. ISO dates: 2027-03-15 / 2027/03/15.
  for (const m of text.matchAll(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/g)) {
    add(m, makeDate(Number(m[1]), Number(m[2]), Number(m[3])), { hasYear: true });
  }

  // 2. Day month year: 15 March 2027.
  for (const m of text.matchAll(
    new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_PATTERN})\\s*,?\\s*(\\d{4})\\b`, "gi"),
  )) {
    const month = monthFromName(m[2]!);
    if (month) add(m, makeDate(Number(m[3]), month, Number(m[1])), { hasYear: true });
  }

  // 3. Month day year: March 15, 2027.
  for (const m of text.matchAll(
    new RegExp(`\\b(${MONTH_PATTERN})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*,?\\s*(\\d{4})\\b`, "gi"),
  )) {
    const month = monthFromName(m[1]!);
    if (month) add(m, makeDate(Number(m[3]), month, Number(m[2])), { hasYear: true });
  }

  // 4. Month year: March 2027 (first of the month; deadlines may extend it).
  for (const m of text.matchAll(
    new RegExp(`\\b(${MONTH_PATTERN})\\s*,?\\s*(\\d{4})\\b`, "gi"),
  )) {
    const month = monthFromName(m[1]!);
    if (month) add(m, makeDate(Number(m[2]), month, 1), { monthOnly: true, hasYear: true });
  }

  // 5. Month day, no year: April 12 (next occurrence).
  for (const m of text.matchAll(
    new RegExp(`\\b(${MONTH_PATTERN})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "gi"),
  )) {
    const month = monthFromName(m[1]!);
    if (!month) continue;
    const day = Number(m[2]);
    const candidate = makeDate(today.getUTCFullYear(), month, day);
    if (!candidate) continue;
    const date = candidate.getTime() < today.getTime()
      ? makeDate(today.getUTCFullYear() + 1, month, day)
      : candidate;
    add(m, date);
  }

  // 6. Relative days.
  for (const m of text.matchAll(/\b(yesterday|today|tomorrow)\b/gi)) {
    const word = m[1]!.toLowerCase();
    add(m, addDays(today, word === "yesterday" ? -1 : word === "tomorrow" ? 1 : 0), {
      hasYear: true,
    });
  }

  // 7. In N days/weeks/months/years.
  for (const m of text.matchAll(/\bin\s+(\d+)\s+(days?|weeks?|months?|years?)\b/gi)) {
    const n = Number(m[1]);
    const unit = m[2]!.toLowerCase();
    let date: Date;
    if (unit.startsWith("day")) date = addDays(today, n);
    else if (unit.startsWith("week")) date = addDays(today, n * 7);
    else if (unit.startsWith("month")) date = addMonths(today, n);
    else date = addMonths(today, n * 12);
    add(m, date, { hasYear: true });
  }

  // 8. next/last/this/coming/on/by/before + weekday.
  for (const m of text.matchAll(
    new RegExp(`\\b(next|last|this|coming|on|by|before)\\s+(${WEEKDAY_PATTERN})\\b`, "gi"),
  )) {
    const qualifier = m[1]!.toLowerCase();
    const weekday = WEEKDAYS[m[2]!.toLowerCase()];
    if (weekday === undefined) continue;
    const date =
      qualifier === "last"
        ? weekdayBefore(today, weekday)
        : qualifier === "next"
          ? weekdayOnOrAfter(today, weekday, true)
          : weekdayOnOrAfter(today, weekday);
    add(m, date, { hasYear: true });
  }

  // 9. next/last week|month|year.
  for (const m of text.matchAll(/\b(next|last)\s+(week|month|year)\b/gi)) {
    const dir = m[1]!.toLowerCase() === "next" ? 1 : -1;
    const unit = m[2]!.toLowerCase();
    const date =
      unit === "week"
        ? addDays(today, dir * 7)
        : unit === "month"
          ? addMonths(today, dir)
          : addMonths(today, dir * 12);
    add(m, date, { hasYear: true });
  }

  // 10. end of month.
  for (const m of text.matchAll(/\bend\s+of\s+(?:the\s+)?month\b/gi)) {
    add(m, new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0)), {
      hasYear: true,
    });
  }

  // 11. "in March" / "by March" — a month with a deadline cue, no year.
  for (const m of text.matchAll(
    new RegExp(`\\b(?:in|by|before|until|during|through)\\s+(${MONTH_PATTERN})\\b`, "gi"),
  )) {
    const month = monthFromName(m[1]!);
    if (!month) continue;
    const candidate = makeDate(today.getUTCFullYear(), month, 1);
    if (!candidate) continue;
    const date =
      candidate.getTime() < today.getTime()
        ? makeDate(today.getUTCFullYear() + 1, month, 1)
        : candidate;
    add(m, date, { monthOnly: true });
  }

  // 12. Bare month name — weak, only used near a deadline cue.
  for (const m of text.matchAll(new RegExp(`\\b(${MONTH_PATTERN})\\b`, "gi"))) {
    const month = monthFromName(m[1]!);
    if (!month) continue;
    const candidate = makeDate(today.getUTCFullYear(), month, 1);
    if (!candidate) continue;
    const date =
      candidate.getTime() < today.getTime()
        ? makeDate(today.getUTCFullYear() + 1, month, 1)
        : candidate;
    add(m, date, { monthOnly: true, weak: true });
  }

  return found.sort((a, b) => a.index - b.index);
}

const DEADLINE_CUE =
  /\b(by|before|due|deadline|expires?|expiry|until|renew|remind|end of|need to|should|must|owe|promised?|said i'?d|follow up|this week|next week)\b/i;

const EXPIRY_CUE = /\b(expires?|expiry|until|end of|valid through|deadline)\b/i;

function endOfMonth(isoDate: string): string {
  const [y, m] = isoDate.split("-").map(Number);
  return iso(new Date(Date.UTC(y!, m!, 0)));
}

/**
 * The date something HAPPENED, if the note says so. Future dates are ignored
 * here: "renew the passport before April 12" is not an event on April 12.
 */
export function eventDateFromText(text: string, now = new Date()): string | null {
  const today = iso(todayUtc(now));
  for (const m of findDateMentions(text, now)) {
    if (m.weak) continue;
    // A month/day without a year is resolved to its next occurrence for
    // deadlines. For an event ("met Sarah on March 3"), the past occurrence
    // is the right reading.
    let candidate = m.iso;
    if (candidate > today && !m.hasYear) {
      const [y, mo, d] = candidate.split("-").map(Number);
      candidate = `${y! - 1}-${pad(mo!)}-${pad(d!)}`;
    }
    if (candidate > today) continue;
    const around = text
      .slice(Math.max(0, m.index - 60), m.index + m.text.length)
      .toLowerCase();
    if (DEADLINE_CUE.test(around)) continue;
    return candidate;
  }
  return null;
}

/**
 * The date something is DUE, if the note says so. Prefers a date next to a
 * deadline cue; falls back to the first future date in the note.
 */
export function dueDateFromText(text: string, now = new Date()): string | null {
  const today = iso(todayUtc(now));
  const mentions = findDateMentions(text, now);

  function resolve(m: DateMention): string {
    if (!m.monthOnly) return m.iso;
    const around = text.slice(Math.max(0, m.index - 60), m.index + 60).toLowerCase();
    return EXPIRY_CUE.test(around) ? endOfMonth(m.iso) : m.iso;
  }

  for (const m of mentions) {
    if (m.weak || m.iso < today) continue;
    const around = text.slice(Math.max(0, m.index - 70), m.index + 70).toLowerCase();
    if (DEADLINE_CUE.test(around)) return resolve(m);
  }
  for (const m of mentions) {
    if (m.weak || m.iso < today) continue;
    return resolve(m);
  }
  // Bare month names are trusted only when an expiry cue is in the note.
  if (EXPIRY_CUE.test(text)) {
    for (const m of mentions) {
      if (!m.weak || m.iso < today) continue;
      return endOfMonth(m.iso);
    }
  }
  return null;
}

const DATE_LIKE_ATTRIBUTE =
  /expir|deadline|due|renew|birthday|anniversary|start|end|trip|travel|move|graduat|valid|until|date|when|schedule|renewal/i;

/**
 * Absolute date for a date-bearing fact ("passport_expiry: March 2027").
 * Only date-like attributes get one, so ordinary facts stay clean.
 */
export function dateForFact(
  text: string,
  attribute: string,
  now = new Date(),
): string | null {
  if (!DATE_LIKE_ATTRIBUTE.test(attribute)) return null;
  const today = iso(todayUtc(now));
  const mentions = findDateMentions(text, now);
  const future = mentions.filter((m) => !m.weak && m.iso >= today);
  if (future.length > 0) {
    const m = future[0]!;
    if (m.monthOnly && EXPIRY_CUE.test(text)) return endOfMonth(m.iso);
    return m.iso;
  }
  const past = mentions.filter((m) => !m.weak);
  return past.length > 0 ? past[past.length - 1]!.iso : null;
}

export interface ExpiryFact {
  attribute: string;
  value: string;
  date: string;
}

/**
 * Code-side expiry extraction: "my passport expires in 7 weeks" must become a
 * dated fact even when the prose model omits it. The value stays verbatim from
 * the note (grounding); the date comes from the parser.
 */
export function expiryFactFromText(
  text: string,
  now = new Date(),
): ExpiryFact | null {
  const match = text.match(
    /\b([A-Za-z][A-Za-z ]{1,24}?)\s+(?:expires?|expiry|renewal|valid until|valid through)\b/i,
  );
  if (!match) return null;
  const mentions = findDateMentions(text, now);
  const mention = mentions.find(
    (m) => !m.weak && m.index >= (match.index ?? 0),
  );
  if (!mention) return null;

  const subject = match[1]!
    .trim()
    .replace(/^(my|the|our|his|her|their|its)\s+/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const attribute = subject ? `${subject}_expiry` : "expiry";
  const date = dateForFact(text, attribute, now) ?? mention.iso;
  return { attribute, value: mention.text, date };
}

/** Convert a YYYY-MM-DD date to a stable noon-UTC timestamp. */
export function dateAtNoon(isoDate: string): string {
  return `${isoDate}T12:00:00.000Z`;
}

/** Parse an ISO date or datetime from a model; null when unusable. */
export function parseModelDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = value.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (!m) return null;
  const date = makeDate(Number(m[1]), Number(m[2]), Number(m[3]));
  return date ? iso(date) : null;
}

/** Human display for a date-only value ("March 2027" when day is 1). */
export function formatDate(isoDate: string | null): string | null {
  if (!isoDate) return null;
  const date = new Date(`${isoDate}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
