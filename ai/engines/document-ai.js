/**
 * Document intelligence (requirements §5.12): classify a document, answer a question about one,
 * and find documents with a plain-language question.
 *
 * Reading a file is the browser's job: PDF, DOCX and OCR text arrive as `text`. Nothing here
 * writes to a document record — classification comes back as suggestions HR applies, an answer
 * is only quoted from the text it was given, and search only reports which records match and
 * how the question was understood.
 *
 * `documentId`, when given, goes through the gateway's read view, so a confidential document is
 * refused here whenever AI settings keep confidential documents away from the AI — whatever the
 * browser sends in `text`.
 */

const { findEmployees } = require('./assistant');
const { bullets, compose, confidenceFrom, source, tally } = require('../helpers');
const { CONFIDENTIAL_BY_CATEGORY, classifyText, suggestDates } = require('../document-signals');

const DAY = 86_400_000;
const ymd = (date) => new Date(date).toISOString().slice(0, 10);
const addDays = (date, days) => new Date(new Date(date).getTime() + days * DAY);
const label = (category) => {
  const spaced = String(category).replace(/-/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

const unavailable = (id) =>
  Object.assign(
    new Error(
      `Document ${id} is not available to the AI. It may be confidential: AI access to confidential documents is controlled in the AI settings.`,
    ),
    { status: 404 },
  );

/** The document a request is about, or null when none was named. Refuses one the AI may not see. */
function documentFor(input, db) {
  if (!input.documentId) return null;
  const document = db.byId('documents', input.documentId);
  if (!document) throw unavailable(input.documentId);
  return document;
}

/* ------------------------------ classification ---------------------------- */

const classifyDocument = {
  id: 'classify-document',
  module: 'documents',
  label: 'Classify Document',
  purpose: 'Suggests a document type, whether it is confidential, and the issue and expiry dates',
  input: {
    documentId: 'string — a document in the register (optional)',
    text: 'string — extracted text from the browser (optional, but without it only the title is read)',
    title: 'string — a title to classify when there is no record yet (optional)',
  },
  prompt: (input) => `Classify document ${input.documentId || input.title || '(uploaded text)'}`,

  run({ input, db }) {
    const document = documentFor(input, db);
    const text = String(input.text || '').trim();
    const title = String(input.title || (document && document.title) || '');

    if (!text && !title) {
      throw Object.assign(new Error('Give a document, a title or the extracted text to classify'), { status: 400 });
    }

    const verdict = classifyText({ text, title });
    const found = suggestDates(text);
    const confidential = CONFIDENTIAL_BY_CATEGORY[verdict.category] ?? false;

    const suggestion = {
      category: verdict.category,
      confidential,
      issueDate: found.issueDate,
      expiryDate: found.consistent ? found.expiryDate : null,
    };

    /* What would change on the record if HR took every suggestion. */
    const current = document
      ? {
          category: document.category,
          confidential: Boolean(document.confidential),
          issueDate: document.issueDate || null,
          expiryDate: document.expiryDate || null,
        }
      : null;
    const changes = [];
    if (current) {
      for (const field of ['category', 'confidential', 'issueDate', 'expiryDate']) {
        // A date the text did not state is not a suggestion to clear it.
        if ((field === 'issueDate' || field === 'expiryDate') && !suggestion[field]) continue;
        if (suggestion[field] !== current[field]) changes.push({ field, from: current[field], to: suggestion[field] });
      }
    }

    const basis = text ? 'text' : 'title';
    const dateLines = [
      found.issueDate ? `Issue date: ${found.issueDate}` : null,
      found.expiryDate ? `Expiry date: ${found.expiryDate}${found.consistent ? '' : ' (before the issue date — not suggested)'}` : null,
      ...found.dates
        .filter((item) => item.role === 'unknown')
        .slice(0, 3)
        .map((item) => `Undecided date: ${item.iso} — "${item.line}"`),
      found.dates.some((item) => item.ambiguous) ? 'A date was written as day/month/year or month/day/year; it was read as month/day.' : null,
    ];

    const output = compose([
      `Suggested type: ${label(verdict.category)} (confidence ${Math.round(verdict.confidence * 100)}%)`,
      verdict.signals.length
        ? `Based on: ${verdict.signals.map((signal) => `"${signal}"`).join(', ')} in the ${basis === 'text' ? 'text and title' : 'title'}.`
        : 'Nothing in the words points at a particular type.',
      verdict.alternatives.length ? `Could also be: ${verdict.alternatives.map((item) => label(item.category)).join(', ')}.` : null,
      `Confidential: ${confidential ? 'yes' : 'no'} — ${label(verdict.category).toLowerCase()} documents are usually ${confidential ? 'kept confidential' : 'not confidential'}.`,
      dateLines.filter(Boolean).length ? `Dates found\n${bullets(dateLines)}` : text ? 'No issue or expiry date was found in the text.' : null,
      current
        ? changes.length
          ? `Differs from the record\n${bullets(changes.map((item) => `${item.field}: ${item.from ?? 'empty'} → ${item.to}`))}`
          : 'This matches what the record already says.'
        : null,
      'Nothing has been changed. Apply the suggestions you agree with.',
    ]);

    return {
      output,
      sources: [
        ...(document ? [source('document', document.id, document.title)] : []),
        source('document', 'text', text ? 'Text read from the file' : 'Title only'),
      ],
      confidence: text ? verdict.confidence : Math.min(verdict.confidence, 0.5),
      limitation: text
        ? 'Phrase matching, not understanding: a letter that mentions a contract can look like one. Check the type before applying it, and check which date is the issue date and which the expiry.'
        : 'Only the title was read, so this is a weak guess. Read the file to classify from its contents.',
      data: {
        basis,
        suggestion,
        current,
        changes,
        alternatives: verdict.alternatives,
        signals: verdict.signals,
        dates: found.dates,
        decisionAllowed: false,
      },
    };
  },
};

/* ------------------------------ single-document Q&A ------------------------ */

const STOP = new Set(
  'a an the of for in on at to from by with and or is are was were be been do does did what which who whom whose when where how many much any all show me list find give get tell that this those these have has had there their it its my our about under into does can could would should please'.split(
    ' ',
  ),
);

/** "payments" and "payment", "expires" and "expired" should meet. */
function stem(word) {
  let w = word.toLowerCase();
  for (const suffix of ['ing', 'ed', 'es', 's']) {
    if (w.length > suffix.length + 3 && w.endsWith(suffix)) {
      w = w.slice(0, -suffix.length);
      break;
    }
  }
  return w;
}

const terms = (text) =>
  String(text)
    .toLowerCase()
    .replace(/[^a-z0-9$%\s-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word && !STOP.has(word))
    .map(stem);

/** Lines, and sentences inside long lines: the pieces an answer can be quoted from. */
function passagesOf(text) {
  const passages = [];
  String(text)
    .split(/\r?\n/)
    .forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed.length < 8) return;
      const pieces = trimmed.length > 220 ? trimmed.split(/(?<=[.!?])\s+/) : [trimmed];
      for (const piece of pieces) {
        if (piece.trim().length >= 8) passages.push({ text: piece.trim(), line: index + 1 });
      }
    });
  return passages;
}

const askDocument = {
  id: 'ask-document',
  module: 'documents',
  label: 'Ask About a Document',
  purpose: 'Answers a question from the text of one document, quoting where it found the answer',
  input: {
    documentId: 'string — the document in the register (optional)',
    text: 'string — the document text read in the browser',
    question: 'string — what to find out',
  },
  prompt: (input) => String(input.question || '').trim(),

  run({ input, db }) {
    const document = documentFor(input, db);
    const question = String(input.question || '').trim();
    const text = String(input.text || '').trim();

    if (!question) throw Object.assign(new Error('A question is required'), { status: 400 });
    if (!text) {
      throw Object.assign(new Error('The document text is required: the file is read in the browser and sent with the question'), { status: 400 });
    }

    const wanted = [...new Set(terms(question))];
    const asksDate = /\b(when|expir|valid|renew|issued|date|until|deadline)/i.test(question);
    const asksAmount = /\b(how much|salary|pay|amount|cost|fee|price|total|\$)/i.test(question);

    const scored = passagesOf(text)
      .map((passage) => {
        const have = new Set(terms(passage.text));
        const hits = wanted.filter((word) => have.has(word)).length;
        let score = wanted.length ? hits / wanted.length : 0;
        if (hits > 0 && asksDate && /\d{4}|\d{1,2}\/\d{1,2}/.test(passage.text)) score += 0.15;
        if (hits > 0 && asksAmount && /[$]\s?\d|\d[\d,]{2,}/.test(passage.text)) score += 0.15;
        return { ...passage, score: Math.min(1, Math.round(score * 100) / 100) };
      })
      // One matching word out of several is a coincidence, not an answer.
      .filter((passage) => passage.score >= (wanted.length <= 2 ? 1 : 0.34))
      .sort((a, b) => b.score - a.score || a.line - b.line)
      .slice(0, 3);

    const dates = asksDate ? suggestDates(text) : null;
    const dateLines = dates
      ? [
          dates.expiryDate ? `Expiry date stated in the text: ${dates.expiryDate}` : null,
          dates.issueDate ? `Issue date stated in the text: ${dates.issueDate}` : null,
          document && document.expiryDate && dates.expiryDate && document.expiryDate !== dates.expiryDate
            ? `The record lists the expiry as ${document.expiryDate}, which differs.`
            : null,
        ].filter(Boolean)
      : [];

    const answered = scored.length > 0 || dateLines.length > 0;

    if (!answered) {
      return {
        output: compose([
          'This document does not seem to answer that.',
          'Nothing in the text matches the question closely enough to quote. Try other words, or open the file to check.',
        ]),
        sources: [
          ...(document ? [source('document', document.id, document.title)] : []),
          source('document', 'text', 'Text read from the file'),
        ],
        confidence: 0.25,
        limitation:
          'Searches the text for the question\'s words. If the file was scanned, the text may be missing or garbled — "not found" is not proof the document is silent.',
        data: { found: false, passages: [], dates: dates ? dates.dates : [] },
      };
    }

    return {
      output: compose([
        scored.length ? `The document says:\n${scored.map((item) => `> ${item.text}   (line ${item.line})`).join('\n')}` : null,
        dateLines.length ? bullets(dateLines) : null,
        'Quoted from the text as written; nothing was added. Open the file to read it in context.',
      ]),
      sources: [
        ...(document ? [source('document', document.id, document.title)] : []),
        ...scored.map((item) => source('excerpt', `line-${item.line}`, `Line ${item.line}: ${item.text.slice(0, 80)}`)),
      ],
      confidence: confidenceFrom({ evidence: scored.length * 2 + dateLines.length, max: 0.82, base: scored[0] ? 0.4 + scored[0].score * 0.3 : 0.5 }),
      limitation:
        'Finds the passages that share the question\'s words and quotes them. It does not reason about the document, so a clause that answers in different words can be missed.',
      data: { found: true, passages: scored, dates: dates ? dates.dates : [] },
    };
  },
};

/* ------------------------------ natural-language search --------------------- */

/** Words people use for each kind of document. */
const SEARCH_TERMS = [
  ['offer-letter', ['offer letter', 'offer letters', 'offers']],
  ['appointment-letter', ['appointment letter', 'appointment letters', 'appointment']],
  ['contract', ['contract', 'contracts', 'agreement', 'agreements']],
  ['nda', ['nda', 'ndas', 'non-disclosure', 'nondisclosure']],
  ['resume', ['resume', 'resumes', 'cv', 'cvs', 'curriculum vitae']],
  ['certification', ['certification', 'certifications', 'certificate', 'certificates', 'certified']],
  ['education-certificate', ['degree', 'degrees', 'diploma', 'education certificate']],
  ['experience-letter', ['experience letter', 'experience letters']],
  ['id-proof', ['id proof', 'id proofs', 'passport', 'passports', 'identity', 'id card', 'ids']],
  ['work-authorization', ['visa', 'visas', 'work permit', 'work permits', 'work authorization', 'work authorisation']],
  ['tax-form', ['tax form', 'tax forms', 'w-4', 'w4', 'tax']],
  ['performance-record', ['performance record', 'performance records', 'appraisal', 'appraisals']],
  ['policy', ['policy', 'policies', 'handbook', 'handbooks']],
  ['template', ['template', 'templates']],
  ['compliance', ['compliance', 'safety certificate', 'insurance certificate']],
];

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const has = (lower, phrase) => new RegExp(`(^|[^a-z0-9])${escape(phrase)}($|[^a-z0-9])`).test(lower);

/** Words that describe the question rather than the documents sought. */
const FILLER = new Set(
  'expiring expired expire expires expiry lapse lapsed lapses renew renewal renewals due soon upcoming overdue month months week weeks year years day days next this last past within before after since issued dated signed confidential non-confidential archived company companys employee employees staff people file files document documents doc docs no without never not record records uploaded stored on-file'.split(
    ' ',
  ),
);

function lastDayOfMonth(date, offset = 0) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset + 1, 0));
}

/** The expiry window a question asks about, as `{from, to, text}`, or null. */
function expiryWindow(lower, today) {
  const from = ymd(today);
  const next = lower.match(/next\s+(\d+)\s+(day|week|month)s?/);
  if (next) {
    const days = Number(next[1]) * { day: 1, week: 7, month: 30 }[next[2]];
    return { from, to: ymd(addDays(today, days)), text: `next ${next[1]} ${next[2]}${next[1] === '1' ? '' : 's'}` };
  }
  if (/next month/.test(lower)) {
    const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
    return { from: ymd(start), to: ymd(lastDayOfMonth(today, 1)), text: 'next month' };
  }
  if (/this month/.test(lower)) return { from, to: ymd(lastDayOfMonth(today)), text: 'this month' };
  if (/this year/.test(lower)) return { from, to: `${today.getUTCFullYear()}-12-31`, text: 'this year' };
  if (/next year/.test(lower)) {
    const year = today.getUTCFullYear() + 1;
    return { from: `${year}-01-01`, to: `${year}-12-31`, text: 'next year' };
  }
  return { from, to: ymd(addDays(today, 30)), text: 'the next 30 days' };
}

const searchDocuments = {
  id: 'search-documents',
  module: 'documents',
  label: 'Search Documents',
  purpose: 'Finds documents from a plain-language question',
  input: { question: 'string — e.g. "contracts expiring next month", "Will Rutherford\'s visa", "confidential policies"' },
  prompt: (input) => String(input.question || '').trim(),

  run({ input, db, settings, now }) {
    const question = String(input.question || '').trim();
    if (!question) throw Object.assign(new Error('Say what to look for'), { status: 400 });

    const lower = ` ${question.toLowerCase()} `;
    const today = new Date(`${ymd(now)}T00:00:00Z`);
    const interpreted = [];
    const reasons = new Map();
    const consumed = new Set();
    const note = (id, why) => reasons.set(id, [...(reasons.get(id) || []), why]);

    /* Who it belongs to */
    const people = findEmployees(db, ` ${question} `);
    const companyOnly = /\bcompany(-| )?(wide|documents?|files?)?\b/.test(lower) && !people.length;
    if (people.length) interpreted.push({ label: 'Belongs to', value: people.map((p) => p.fullName).join(' or ') });
    if (companyOnly) interpreted.push({ label: 'Belongs to', value: 'The company' });
    for (const person of people) for (const part of person.fullName.toLowerCase().split(/\s+/)) consumed.add(part);

    /* What kind */
    const categories = SEARCH_TERMS.filter(([, words]) => words.some((word) => has(lower, word)));
    for (const [, words] of categories) for (const word of words) for (const part of word.split(/[\s-]+/)) consumed.add(part);
    if (categories.length) interpreted.push({ label: 'Type', value: categories.map(([category]) => label(category)).join(' or ') });

    /* Expiry */
    const mentionsNoExpiry = /(no|without|never)\s+expir/.test(lower);
    const expiredWord = /\b(already expired|expired|lapsed|overdue)\b/.test(lower);
    const expiringWord = !expiredWord && /\b(expir(e|es|ing|y)|renew(al|als)?|due|lapse[sd]?)\b/.test(lower) && !mentionsNoExpiry;
    let expiry = null;
    if (mentionsNoExpiry) {
      expiry = { kind: 'none' };
      interpreted.push({ label: 'Expiry', value: 'No expiry date' });
    } else if (expiredWord) {
      expiry = { kind: 'expired' };
      interpreted.push({ label: 'Expiry', value: 'Already expired' });
    } else if (expiringWord) {
      expiry = { kind: 'window', ...expiryWindow(lower, today) };
      interpreted.push({ label: 'Expiry', value: `Expires in ${expiry.text} (${expiry.from} to ${expiry.to})` });
    }

    /* Confidential, archived, issue year */
    const confidential = /non-?\s?confidential|not confidential/.test(lower) ? false : /\bconfidential\b/.test(lower) ? true : null;
    if (confidential !== null) interpreted.push({ label: 'Access', value: confidential ? 'Confidential' : 'Not confidential' });
    const archived = /\barchived\b/.test(lower);
    if (archived) interpreted.push({ label: 'Status', value: 'Archived' });

    let issued = null;
    const issuedMatch = lower.match(/\b(issued|dated|signed)\s+(in|during|before|after|since)?\s*(\d{4})\b/);
    if (issuedMatch) {
      const year = issuedMatch[3];
      const how = issuedMatch[2] === 'before' ? 'before' : issuedMatch[2] === 'after' || issuedMatch[2] === 'since' ? 'since' : 'in';
      issued = { how, year };
      interpreted.push({ label: 'Issued', value: `${how === 'before' ? 'Before' : how === 'since' ? 'Since' : 'In'} ${year}` });
      consumed.add(year);
    }

    /* Whatever is left over is matched against titles, tags and remarks */
    const keywords = question
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter((word) => word && !STOP.has(word) && !FILLER.has(word) && !consumed.has(word) && !/^\d+$/.test(word) && word.length > 1);
    if (keywords.length) interpreted.push({ label: 'Mentions', value: keywords.join(', ') });

    if (!interpreted.length) {
      return {
        output: compose([
          'Could not tell what to look for.',
          'Try naming a person, a type of document ("contracts", "visas"), or a time ("expiring next month").',
        ]),
        sources: [source('dataset', 'documents', 'Document register')],
        confidence: 0.2,
        limitation: 'Understands people, document types, expiry windows, confidential/archived, an issue year, and words in titles and tags.',
        data: { answered: false, interpreted: [], documentIds: [], matches: [], total: 0 },
      };
    }

    const all = db.get('documents');
    const todayIso = ymd(today);

    const matches = all
      .filter((document) => (archived ? document.archived : !document.archived))
      .filter((document) => {
        if (people.length && !people.some((person) => person.id === document.employeeId)) return false;
        if (companyOnly && document.ownerType !== 'company') return false;
        if (categories.length && !categories.some(([category]) => category === document.category)) return false;
        if (confidential !== null && Boolean(document.confidential) !== confidential) return false;

        if (expiry) {
          if (expiry.kind === 'none') {
            if (document.expiryDate) return false;
          } else {
            if (!document.expiryDate) return false;
            if (expiry.kind === 'expired' && document.expiryDate >= todayIso) return false;
            if (expiry.kind === 'window' && (document.expiryDate < expiry.from || document.expiryDate > expiry.to)) return false;
          }
        }

        if (issued) {
          const year = Number((document.issueDate || '').slice(0, 4));
          if (!year) return false;
          if (issued.how === 'in' && year !== Number(issued.year)) return false;
          if (issued.how === 'before' && year >= Number(issued.year)) return false;
          if (issued.how === 'since' && year < Number(issued.year)) return false;
        }

        if (keywords.length) {
          const haystack = `${document.title} ${(document.tags || []).join(' ')} ${document.remarks || ''} ${document.fileName || ''}`.toLowerCase();
          const missing = keywords.filter((word) => !haystack.includes(stem(word)));
          if (missing.length) return false;
        }
        return true;
      });

    for (const document of matches) {
      if (categories.length) note(document.id, label(document.category));
      if (expiry && document.expiryDate) note(document.id, `expires ${document.expiryDate}`);
      if (people.length) note(document.id, 'belongs to the person named');
      if (keywords.length) note(document.id, `mentions ${keywords.join(', ')}`);
    }

    matches.sort((a, b) => {
      if (expiry && expiry.kind !== 'none') return (a.expiryDate || '').localeCompare(b.expiryDate || '');
      return (b.updatedAt || '').localeCompare(a.updatedAt || '');
    });
    const shown = matches.slice(0, 25);
    const nameOf = (document) => {
      const employee = document.employeeId ? db.byId('employees', document.employeeId) : null;
      return employee ? employee.fullName : document.ownerType === 'company' ? 'Company' : 'Unknown owner';
    };

    const hiddenNote =
      settings.ai && settings.ai.allowConfidentialDocuments === false
        ? 'Confidential documents are not searched, because the AI settings keep them away from the AI. The register may hold more.'
        : null;

    return {
      output: compose([
        matches.length
          ? `${matches.length} document${matches.length === 1 ? '' : 's'} found${matches.length > shown.length ? ` (showing ${shown.length})` : ''}.`
          : 'No documents match.',
        `Understood as\n${bullets(interpreted.map((item) => `${item.label}: ${item.value}`))}`,
        shown.length
          ? bullets(shown.slice(0, 12).map((document) => `${document.title.replace(/ — .*/, '')} — ${nameOf(document)}${document.expiryDate ? ` — expires ${document.expiryDate}` : ''}`))
          : null,
        hiddenNote,
        'Check the "understood as" list: if a word was read the wrong way, ask again with different words.',
      ]),
      sources: [
        source('dataset', 'documents', `Document register (${all.length} documents visible to the AI)`),
        ...shown.slice(0, 5).map((document) => source('document', document.id, document.title)),
      ],
      confidence: confidenceFrom({ evidence: interpreted.length * 2, max: 0.88, base: 0.55 }),
      limitation:
        'Searches the register — titles, types, owners, dates, tags and remarks — not the words inside the files.',
      data: {
        answered: true,
        interpreted,
        documentIds: shown.map((document) => document.id),
        total: matches.length,
        matches: shown.map((document) => ({ id: document.id, title: document.title, why: reasons.get(document.id) || [] })),
        byCategory: tally(matches.map((document) => document.category)),
      },
    };
  },
};

module.exports = [classifyDocument, askDocument, searchDocuments];
