/**
 * Document engines: summarize, extract fields, and expiry monitoring.
 *
 * Extraction works on text the browser produced (PDF text layer, DOCX, or OCR), so no server
 * side parsing is needed. Nothing here writes to an employee record: the extracted fields come
 * back as suggestions that HR confirms field by field.
 */

const { addDays, bullets, compose, confidenceFrom, daysBetween, percent, source, table, tally } = require('../helpers');

/** Skill dictionary used to spot skills in free text. */
const SKILL_WORDS = [
  'JavaScript', 'TypeScript', 'React', 'Node.js', 'Python', 'Java', 'SQL', 'AWS', 'Azure', 'Docker',
  'Kubernetes', 'Terraform', 'GraphQL', 'Figma', 'Salesforce', 'Excel', 'Tableau', 'Power BI',
  'Project Management', 'Agile', 'Scrum', 'Testing', 'Playwright', 'Cypress', 'Negotiation',
  'Recruiting', 'Payroll', 'Accounting', 'Customer Support', 'Communication', 'Leadership',
];

const PATTERNS = {
  email: /[\w.+-]+@[\w-]+\.[\w.-]{2,}/g,
  phone: /(?:\+\d{1,3}[\s-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}/g,
  date: /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4})\b/gi,
  money: /\$\s?\d[\d,]*(?:\.\d{2})?/g,
  idNumber: /\b(?:[A-Z]{2,4}-?\d{4,10}|\d{3}-\d{2}-\d{4})\b/g,
};

/** Keyword rules that classify a document from its text or title. */
const CATEGORY_RULES = [
  { category: 'offer-letter', keywords: ['offer', 'we are pleased to offer', 'compensation package'] },
  { category: 'appointment-letter', keywords: ['appointment', 'appointed', 'terms of employment'] },
  { category: 'contract', keywords: ['agreement', 'contract', 'term of this agreement', 'termination clause'] },
  { category: 'nda', keywords: ['non-disclosure', 'confidentiality', 'proprietary information'] },
  { category: 'resume', keywords: ['curriculum vitae', 'resume', 'work experience', 'education', 'skills'] },
  { category: 'certification', keywords: ['certificate', 'certified', 'has successfully completed'] },
  { category: 'id-proof', keywords: ['passport', 'driver', 'identity', 'date of birth'] },
  { category: 'policy', keywords: ['policy', 'guidelines', 'employees must', 'this document applies'] },
  { category: 'payslip', keywords: ['payslip', 'gross pay', 'net pay', 'deductions'] },
  { category: 'tax-form', keywords: ['w-4', 'tax', 'withholding', 'irs'] },
];

function unique(values) {
  return [...new Set(values)];
}

function classify(text) {
  const haystack = String(text || '').toLowerCase();
  const scored = CATEGORY_RULES.map((rule) => ({
    category: rule.category,
    hits: rule.keywords.filter((keyword) => haystack.includes(keyword)).length,
  }))
    .filter((item) => item.hits > 0)
    .sort((a, b) => b.hits - a.hits);

  return scored[0] || { category: 'other', hits: 0 };
}

module.exports = [
  {
    id: 'summarize-document',
    module: 'documents',
    label: 'Summarize Document',
    purpose: 'Summarizes CVs, contracts, policies, certificates and HR letters',
    input: {
      documentId: 'string — a document in the register (optional if text is given)',
      text: 'string — extracted text from the browser (PDF/DOCX/OCR)',
    },
    prompt: (input) => `Summarize document ${input.documentId || '(uploaded text)'}`,

    run({ input, db }) {
      const document = input.documentId ? db.byId('documents', input.documentId) : null;
      const text = String(input.text || '').trim();

      if (!document && !text) {
        throw Object.assign(new Error('Provide a documentId or the extracted text'), { status: 400 });
      }
      if (input.documentId && !document) {
        throw Object.assign(new Error(`Document ${input.documentId} is not available`), { status: 404 });
      }

      const sentences = text ? text.split(/(?<=[.!?])\s+/).filter((item) => item.trim().length > 25) : [];
      const detected = text ? classify(text) : { category: document.category, hits: 0 };
      const employee = document && document.employeeId ? db.byId('employees', document.employeeId) : null;

      const facts = document
        ? [
            `Category: ${document.category}`,
            employee ? `Belongs to: ${employee.fullName} (${employee.employeeId})` : 'Company document',
            document.issueDate ? `Issued: ${document.issueDate}` : null,
            document.expiryDate ? `Expires: ${document.expiryDate}` : 'No expiry date recorded',
            document.confidential ? 'Marked confidential' : null,
            `Version ${document.version}`,
          ]
        : [`Detected category: ${detected.category}`, `Length: ${text.split(/\s+/).length} words`];

      // Lead sentences stand in for a written summary; a real model would paraphrase.
      const body = sentences.length
        ? sentences.slice(0, 3).map((sentence) => sentence.trim()).join(' ')
        : document
          ? `No text was supplied for ${document.title}, so this summary is built from the document record only. Upload or extract the text for a content summary.`
          : '';

      return {
        output: compose([
          document ? `Summary — ${document.title}` : 'Summary — uploaded document',
          body,
          bullets(facts),
          text ? null : 'Note: no document text was provided, so nothing in the file itself was read.',
        ]),
        sources: document
          ? [source('document', document.id, document.title)]
          : [source('document', 'uploaded', 'Text supplied by the browser')],
        confidence: confidenceFrom({ evidence: sentences.length, max: text ? 0.78 : 0.4 }),
        limitation: text
          ? undefined
          : 'Built from the document record only — the file contents were not read.',
        data: { category: detected.category, sentenceCount: sentences.length },
      };
    },
  },

  {
    id: 'extract-document-data',
    module: 'documents',
    label: 'Extract Document Data',
    purpose: 'Extracts key fields from uploaded documents into HR forms',
    input: {
      text: 'string — extracted text from the browser (PDF/DOCX/OCR)',
      target: 'string — employee | candidate (which form the fields are for)',
    },
    prompt: (input) => `Extract ${input.target || 'employee'} fields from the uploaded document`,

    run({ input }) {
      const text = String(input.text || '').trim();
      if (!text) throw Object.assign(new Error('Document text is required'), { status: 400 });

      const emails = unique(text.match(PATTERNS.email) || []);
      const phones = unique(text.match(PATTERNS.phone) || []);
      const dates = unique(text.match(PATTERNS.date) || []);
      const amounts = unique(text.match(PATTERNS.money) || []);
      const ids = unique(text.match(PATTERNS.idNumber) || []);
      const skills = SKILL_WORDS.filter((skill) => text.toLowerCase().includes(skill.toLowerCase()));

      // The first non-empty line is usually the name on a CV or letter.
      const firstLine = text.split('\n').map((line) => line.trim()).find((line) => line.length > 2 && line.length < 60);
      const looksLikeName = firstLine && /^[A-Z][a-z]+(?:\s+[A-Z][a-z'.-]+){1,3}$/.test(firstLine);

      const fields = [
        { field: 'fullName', value: looksLikeName ? firstLine : null, confidence: looksLikeName ? 0.6 : 0.2 },
        { field: 'email', value: emails[0] || null, confidence: emails.length === 1 ? 0.9 : emails.length ? 0.6 : 0 },
        { field: 'phone', value: phones[0] || null, confidence: phones.length === 1 ? 0.8 : phones.length ? 0.5 : 0 },
        { field: 'dates', value: dates.slice(0, 4), confidence: dates.length ? 0.5 : 0 },
        { field: 'skills', value: skills, confidence: skills.length ? 0.65 : 0 },
        { field: 'amounts', value: amounts.slice(0, 3), confidence: amounts.length ? 0.55 : 0 },
        { field: 'idNumbers', value: ids.slice(0, 2), confidence: ids.length ? 0.45 : 0 },
      ].filter((item) => item.value && (!Array.isArray(item.value) || item.value.length));

      const detected = classify(text);

      return {
        output: compose([
          `Extracted ${fields.length} field group(s) from the document (detected type: ${detected.category}).`,
          table(
            fields.map((item) => ({
              label: item.field,
              value: `${Array.isArray(item.value) ? item.value.join(', ') : item.value}  (${Math.round(item.confidence * 100)}%)`,
            })),
          ),
          'Confirm each field before it is written to the record. Dates are returned as found, not interpreted — check which is the date of birth, issue date or expiry date.',
        ]),
        sources: [source('document', 'uploaded', 'Text supplied by the browser')],
        confidence: confidenceFrom({ evidence: fields.length, max: 0.75 }),
        limitation:
          'Pattern matching, not document understanding: ambiguous dates and names need a human check before saving.',
        data: { detectedCategory: detected.category, fields },
      };
    },
  },

  {
    id: 'document-expiry-assistant',
    module: 'documents',
    label: 'Document Expiry Assistant',
    purpose: 'Detects expiring documents and drafts renewal reminders',
    input: {
      withinDays: 'number — window to look ahead (defaults to the notification setting)',
      employeeId: 'string — limit to one employee (optional)',
    },
    prompt: (input) => `List documents expiring within ${input.withinDays || 30} days`,

    run({ input, db, settings, now }) {
      const withinDays = Number(input.withinDays || settings.notifications.documentExpiryDays || 30);
      const limit = addDays(now, withinDays);

      const documents = db
        .get('documents')
        .filter((document) => document.expiryDate && !document.archived)
        .filter((document) => (input.employeeId ? document.employeeId === input.employeeId : true))
        .map((document) => ({
          document,
          daysLeft: daysBetween(now, new Date(`${document.expiryDate}T00:00:00Z`)),
        }))
        .filter((item) => item.daysLeft <= withinDays)
        .sort((a, b) => a.daysLeft - b.daysLeft);

      const expired = documents.filter((item) => item.daysLeft < 0);
      const expiring = documents.filter((item) => item.daysLeft >= 0);

      const describe = (item) => {
        const employee = item.document.employeeId ? db.byId('employees', item.document.employeeId) : null;
        const who = employee ? `${employee.fullName} (${employee.employeeId})` : 'Company document';
        const when = item.daysLeft < 0 ? `expired ${Math.abs(item.daysLeft)} day(s) ago` : `expires in ${item.daysLeft} day(s)`;
        return `${item.document.title.replace(/ — .*/, '')} — ${who} — ${when} (${item.document.expiryDate})`;
      };

      const byCategory = tally(documents.map((item) => item.document.category));

      const reminder = expiring.length
        ? [
            'Draft reminder:',
            'Subject: Action needed — document renewal',
            '',
            'Hello,',
            '',
            `Our records show ${expiring.length} document(s) expiring within the next ${withinDays} days. Please send the renewed copy to HR before the expiry date so your record stays current.`,
            '',
            'Thank you,',
            'HR',
          ].join('\n')
        : null;

      return {
        output: compose([
          `${documents.length} document(s) need attention: ${expired.length} already expired, ${expiring.length} expiring within ${withinDays} days.`,
          expired.length ? `Already expired\n${bullets(expired.slice(0, 15).map(describe))}` : null,
          expiring.length ? `Expiring soon\n${bullets(expiring.slice(0, 20).map(describe))}` : null,
          byCategory.length
            ? `By category\n${table(byCategory.map((item) => ({ label: item.key, value: item.count })))}`
            : null,
          reminder,
          'HR sends the reminders — nothing here is sent automatically.',
        ]),
        sources: [
          source('dataset', 'documents', `Document register (${db.get('documents').length} documents)`),
          ...documents.slice(0, 5).map((item) => source('document', item.document.id, item.document.title)),
        ],
        confidence: confidenceFrom({ evidence: documents.length, max: 0.95, base: 0.7 }),
        limitation: documents.length
          ? 'Based only on the expiry dates recorded in the register; a document with no expiry date cannot be detected.'
          : 'No expiry dates fell in the window — documents with a missing expiry date are not covered.',
        data: {
          withinDays,
          expiredCount: expired.length,
          expiringCount: expiring.length,
          documentIds: documents.map((item) => item.document.id),
          coverage: percent(db.get('documents').filter((item) => item.expiryDate).length, db.get('documents').length),
        },
      };
    },
  },
];
