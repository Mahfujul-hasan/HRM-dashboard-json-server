/**
 * What can be told about a document from its words: what kind it is, whether it is the sort
 * HR keeps confidential, and the dates it states about itself.
 *
 * Rule based, like every mock engine: phrases are counted, not understood. The functions return
 * the evidence along with the answer (which phrases matched, which line a date was on) so the
 * UI can show HR why a suggestion was made instead of only what it is.
 */

/** Phrases that point at a kind of document. A longer, more specific phrase counts double. */
const CATEGORY_RULES = [
  { category: 'offer-letter', confidential: true, phrases: ['offer letter', 'offer of employment', 'pleased to offer', 'accept this offer', 'compensation package', 'offer'] },
  { category: 'appointment-letter', confidential: true, phrases: ['appointment letter', 'is appointed', 'appointed as', 'your appointment', 'terms of employment'] },
  { category: 'contract', confidential: true, phrases: ['employment agreement', 'employment contract', 'term of this agreement', 'this agreement', 'termination', 'contract'] },
  { category: 'nda', confidential: true, phrases: ['non-disclosure', 'nondisclosure', 'confidential information', 'proprietary information', 'nda'] },
  { category: 'resume', confidential: false, phrases: ['curriculum vitae', 'resume', 'professional summary', 'work experience', 'skills'] },
  { category: 'certification', confidential: false, phrases: ['certificate of completion', 'is hereby certified', 'successfully completed', 'certification', 'certified', 'awarded'] },
  { category: 'education-certificate', confidential: false, phrases: ['bachelor of', 'master of', 'degree', 'diploma', 'university', 'graduated'] },
  { category: 'experience-letter', confidential: false, phrases: ['to whom it may concern', 'experience letter', 'was employed', 'worked with us', 'relieved from'] },
  { category: 'id-proof', confidential: true, phrases: ['passport', 'driver license', "driver's license", 'identity card', 'national id', 'date of birth', 'id number'] },
  { category: 'work-authorization', confidential: true, phrases: ['work authorization', 'employment authorization', 'work permit', 'h-1b', 'i-797', 'visa'] },
  { category: 'tax-form', confidential: true, phrases: ['form w-4', 'w-4', 'w-9', 'withholding', 'tax identification', 'irs'] },
  { category: 'performance-record', confidential: true, phrases: ['performance review', 'appraisal', 'goals achieved', 'rating'] },
  { category: 'policy', confidential: false, phrases: ['this policy applies', 'employees must', 'guidelines', 'policy'] },
  { category: 'template', confidential: false, phrases: ['template', '[name]', '{{'] },
  { category: 'compliance', confidential: false, phrases: ['safety certificate', 'insurance certificate', 'compliance', 'audit'] },
];

const CONFIDENTIAL_BY_CATEGORY = Object.fromEntries(CATEGORY_RULES.map((rule) => [rule.category, rule.confidential]));

/**
 * Ranks the kinds a document could be. The title counts double: "Offer Letter — Will" says more
 * than any one sentence inside it.
 */
function classifyText({ text = '', title = '' }) {
  const body = String(text).toLowerCase();
  const heading = String(title).toLowerCase();

  const ranked = CATEGORY_RULES.map((rule) => {
    const signals = [];
    let score = 0;
    for (const phrase of rule.phrases) {
      // A bare "offer" inside "offer letter" is the same evidence, not two pieces of it.
      if (signals.some((seen) => seen.includes(phrase))) continue;
      const weight = phrase.includes(' ') || phrase.length > 8 ? 2 : 1;
      const inBody = body.includes(phrase);
      const inTitle = heading.includes(phrase);
      if (inBody) score += weight;
      if (inTitle) score += weight * 2;
      if (inBody || inTitle) signals.push(phrase);
    }
    return { category: rule.category, score, signals };
  })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best) return { category: 'other', confidence: 0.2, signals: [], alternatives: [] };

  const second = ranked[1] ? ranked[1].score : 0;
  const margin = best.score / (best.score + second);
  const strength = Math.min(1, best.score / 6);
  return {
    category: best.category,
    confidence: Math.round((0.35 + 0.5 * margin * strength + 0.05 * strength) * 100) / 100,
    signals: best.signals,
    alternatives: ranked.slice(1, 3).map((item) => ({ category: item.category, score: item.score })),
  };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const pad = (value) => String(value).padStart(2, '0');

/** A real calendar date as YYYY-MM-DD, or null: "2026-02-31" must not become March. */
function isoOf(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * Dates written in the usual ways. "03/04/2026" is read as month/day, the way the rest of this
 * product reads it, and flagged ambiguous when day and month could swap.
 */
const DATE_FORMS = [
  {
    pattern: /\b(\d{4})-(\d{2})-(\d{2})\b/g,
    read: (m) => ({ iso: isoOf(+m[1], +m[2], +m[3]) }),
  },
  {
    pattern: /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g,
    read: (m) => ({ iso: isoOf(+m[3], +m[1], +m[2]), ambiguous: +m[1] <= 12 && +m[2] <= 12 && +m[1] !== +m[2] }),
  },
  {
    pattern: /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/gi,
    read: (m) => ({ iso: isoOf(+m[3], MONTHS.indexOf(m[1].toLowerCase()) + 1, +m[2]) }),
  },
  {
    pattern: /\b(\d{1,2})(?:st|nd|rd|th)?\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?,?\s+(\d{4})\b/gi,
    read: (m) => ({ iso: isoOf(+m[3], MONTHS.indexOf(m[2].toLowerCase()) + 1, +m[1]) }),
  },
];

const EXPIRY_WORDS = /(expir|valid (until|through|thru|to)|renew(al)? (by|on|date)|good until|end date|ends on|not valid after)/i;
const ISSUE_WORDS = /(issued|issue date|date of issue|dated|effective|signed|granted|awarded)/i;

/**
 * Every date in the text, with the role its surroundings suggest.
 *
 * The words just before a date decide its role ("valid until 2027-01-31" is an expiry). A date
 * with no such words is returned as `unknown` rather than guessed at: HR chooses.
 */
function findDates(text) {
  const found = [];
  const lines = String(text).split(/\r?\n/);

  lines.forEach((line, index) => {
    for (const form of DATE_FORMS) {
      form.pattern.lastIndex = 0;
      for (const match of line.matchAll(form.pattern)) {
        const read = form.read(match);
        if (!read.iso) continue;
        const before = line.slice(Math.max(0, match.index - 45), match.index);
        const role = EXPIRY_WORDS.test(before) ? 'expiry' : ISSUE_WORDS.test(before) ? 'issue' : 'unknown';
        found.push({ iso: read.iso, role, ambiguous: Boolean(read.ambiguous), line: line.trim().slice(0, 140), lineNumber: index + 1 });
      }
    }
  });

  // The same date matched by two forms (an ISO date also fits nothing else, but be safe).
  const seen = new Set();
  return found.filter((item) => {
    const key = `${item.iso}:${item.lineNumber}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The dates the record could take from the text: one issue date and one expiry date at most. */
function suggestDates(text) {
  const dates = findDates(text);
  const issue = dates.find((item) => item.role === 'issue');
  const expiry = dates.find((item) => item.role === 'expiry');
  return {
    dates,
    issueDate: issue ? issue.iso : null,
    expiryDate: expiry ? expiry.iso : null,
    // An expiry before the issue date is the document contradicting itself; do not suggest it.
    consistent: !(issue && expiry && expiry.iso < issue.iso),
  };
}

module.exports = { CATEGORY_RULES, CONFIDENTIAL_BY_CATEGORY, classifyText, findDates, suggestDates };
