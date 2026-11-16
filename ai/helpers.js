/**
 * Shared helpers for the mock AI engines.
 *
 * These engines are deterministic rule-based stand-ins for a real model: keyword matching,
 * counting, thresholds and templates over the data already in db.json. The point is that the
 * dashboard can build and test the full review flow — sources, confidence, edit, approve,
 * reject, audit — long before a model is wired in. Swapping in a real model later changes
 * only what `run()` returns, not the contract around it.
 */

const DAY_MS = 86400000;

function ymd(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function addDays(date, days) {
  return new Date(new Date(date).getTime() + days * DAY_MS);
}

function daysBetween(from, to) {
  return Math.round((new Date(to) - new Date(from)) / DAY_MS);
}

function monthKey(date) {
  return new Date(date).toISOString().slice(0, 7);
}

function percent(part, total) {
  if (!total) return 0;
  return Math.round((part / total) * 100);
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value, places = 1) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function money(value) {
  return `$${Math.round(value).toLocaleString('en-US')}`;
}

/** Bullet list for the text output. */
function bullets(lines) {
  return lines.filter(Boolean).map((line) => `- ${line}`).join('\n');
}

function section(title, body) {
  if (!body) return '';
  return `${title}\n${body}`;
}

/** Joins sections, dropping the empty ones. */
function compose(parts) {
  return parts.filter(Boolean).join('\n\n');
}

function source(kind, id, label) {
  return { kind, id, label };
}

/**
 * Confidence rises with the amount of evidence and falls with ambiguity.
 * Deliberately never 1: these are mock results and the panel must always show a caveat.
 */
function confidenceFrom({ evidence = 0, max = 0.9, base = 0.45 }) {
  const scaled = base + Math.min(0.45, Math.log10(Math.max(1, evidence) + 1) * 0.3);
  return Math.min(max, round(scaled, 2));
}

/** Case-insensitive, punctuation-insensitive word set. */
function words(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** How much of `needles` appears in `haystack`, ignoring case. 0–1. */
function overlap(needles, haystack) {
  if (!needles.length) return 0;
  const pool = new Set(words(haystack.join(' ')));
  const hits = needles.filter((needle) =>
    words(needle).every((part) => pool.has(part)),
  );
  return hits.length / needles.length;
}

/** Which of `needles` are present / missing in `haystack`. */
function matchSkills(required, owned) {
  const pool = new Set((owned || []).map((skill) => String(skill).toLowerCase()));
  const matched = (required || []).filter((skill) => pool.has(String(skill).toLowerCase()));
  const missing = (required || []).filter((skill) => !pool.has(String(skill).toLowerCase()));
  return { matched, missing };
}

const POSITIVE_WORDS = [
  'good', 'great', 'excellent', 'helpful', 'supportive', 'clear', 'fair', 'improved', 'improving',
  'useful', 'smooth', 'consistent', 'happy', 'enjoy', 'recommend', 'benefit', 'strong', 'well',
  'appreciate', 'balanced', 'realistic', 'organised', 'organized', 'practical',
];

const NEGATIVE_WORDS = [
  'poor', 'bad', 'slow', 'unclear', 'unfair', 'hard', 'heavy', 'stress', 'stressful', 'noisy',
  'problem', 'issue', 'lack', 'lacking', 'limited', 'blocked', 'leaving', 'frustrating', 'rare',
  'difficult', 'late', 'missing', 'not', 'no', 'never', 'too', 'struggle', 'unsustainable',
  'confusing', 'delayed',
];

/** Lexicon sentiment: positive / negative / neutral plus the raw score. */
function sentimentOf(text) {
  const tokens = words(text);
  if (!tokens.length) return { label: 'neutral', score: 0 };

  let score = 0;
  for (const token of tokens) {
    if (POSITIVE_WORDS.includes(token)) score += 1;
    if (NEGATIVE_WORDS.includes(token)) score -= 1;
  }

  const label = score > 0 ? 'positive' : score < 0 ? 'negative' : 'neutral';
  return { label, score };
}

/** Theme keywords, from the areas the requirements call out (§5.14). */
const THEMES = {
  Workload: ['workload', 'overload', 'deadline', 'deadlines', 'busy', 'capacity', 'projects', 'hours', 'overtime', 'sustainable', 'unsustainable'],
  Salary: ['salary', 'compensation', 'pay', 'bonus', 'increment', 'raise', 'market'],
  Management: ['manager', 'management', 'leadership', 'direction', 'supervisor', 'lead'],
  'Career growth': ['career', 'growth', 'promotion', 'progression', 'path', 'opportunities', 'role'],
  Facilities: ['office', 'desk', 'parking', 'commute', 'noisy', 'room', 'rooms', 'equipment', 'facility'],
  'Work environment': ['culture', 'team', 'colleagues', 'environment', 'respect', 'support'],
  Communication: ['communication', 'communicate', 'informed', 'transparent', 'transparency', 'updates'],
  Recognition: ['recognition', 'recognised', 'recognized', 'appreciated', 'credit', 'reward'],
  Onboarding: ['onboarding', 'joined', 'joining', 'induction', 'access', 'tools', 'setup'],
  'Work-life balance': ['balance', 'family', 'flexible', 'remote', 'wellbeing', 'burnout'],
  Training: ['training', 'learning', 'course', 'certification', 'mentoring', 'budget'],
};

/** Themes mentioned in one piece of text. */
function themesOf(text) {
  const tokens = new Set(words(text));
  return Object.entries(THEMES)
    .filter(([, keywords]) => keywords.some((keyword) => tokens.has(keyword)))
    .map(([theme]) => theme);
}

/** Counts by key, highest first. */
function tally(items) {
  const counts = new Map();
  for (const item of items) counts.set(item, (counts.get(item) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, count }));
}

/** Mean and standard deviation, for outlier checks. */
function stats(values) {
  const mean = average(values);
  const variance = average(values.map((value) => (value - mean) ** 2));
  return { mean, stdDev: Math.sqrt(variance) };
}

/** Least-squares slope and the next `periods` projected values. */
function forecast(series, periods = 3) {
  const n = series.length;
  if (n < 2) return { slope: 0, projection: new Array(periods).fill(series[0] || 0) };

  const meanX = (n - 1) / 2;
  const meanY = average(series);
  let numerator = 0;
  let denominator = 0;

  for (let index = 0; index < n; index += 1) {
    numerator += (index - meanX) * (series[index] - meanY);
    denominator += (index - meanX) ** 2;
  }

  const slope = denominator ? numerator / denominator : 0;
  const intercept = meanY - slope * meanX;
  const projection = Array.from({ length: periods }, (unused, step) =>
    Math.max(0, round(intercept + slope * (n + step), 1)),
  );

  return { slope: round(slope, 2), projection };
}

/** `[{ label, value }]` rendered as an aligned text table. */
function table(rows) {
  if (!rows.length) return '';
  const width = Math.max(...rows.map((row) => String(row.label).length));
  return rows.map((row) => `  ${String(row.label).padEnd(width)}  ${row.value}`).join('\n');
}

module.exports = {
  DAY_MS,
  addDays,
  average,
  bullets,
  compose,
  confidenceFrom,
  daysBetween,
  forecast,
  matchSkills,
  money,
  monthKey,
  overlap,
  percent,
  round,
  section,
  sentimentOf,
  source,
  stats,
  table,
  tally,
  themesOf,
  words,
  ymd,
  THEMES,
};
