/**
 * Checks for the document engines. Run: `node ai/document-ai-test.js`.
 *
 * What matters most here is what the engines must NOT do: apply a suggestion, answer from outside
 * the text, or reach a confidential document the AI settings keep away from it.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const registry = require('./registry');
const helpers = require('./helpers');
const { classifyText, findDates, suggestDates } = require('./document-signals');

const NOW = new Date('2026-11-16T00:00:00Z');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    console.error(`FAIL  ${name}\n      ${error.message}`);
    process.exitCode = 1;
  }
}

/** Runs an engine over `db`, with the same confidential filter the gateway applies. */
function run(toolId, db, input, allowConfidential = true) {
  const settings = { ai: { allowConfidentialDocuments: allowConfidential }, notifications: { documentExpiryDays: 30 } };
  const rows = (name) => {
    const all = db[name] || [];
    return name === 'documents' && !allowConfidential ? all.filter((item) => !item.confidential) : all;
  };
  const view = { get: rows, byId: (name, id) => rows(name).find((row) => row.id === id) || null };
  return registry.get(toolId).run({ input, db: view, settings, now: NOW, helpers, tools: [] });
}

const OFFER = `Northwind Labs
Offer of Employment

Dear Will, we are pleased to offer you the position of QA Engineer.
Your compensation package is $98,000 per year.
Issued: 2026-04-15
Please accept this offer by signing below.`;

const VISA = `Employment Authorization Document
Work permit for Will Rutherford
Date of issue: January 10, 2026
Valid until March 31, 2027`;

const doc = (over) => ({
  id: 'doc_1', ownerType: 'employee', employeeId: 'emp_011', title: 'Work Permit — Will', category: 'work-authorization',
  fileName: 'file.pdf', issueDate: '2026-01-10', expiryDate: '2027-03-30', confidential: false, tags: [],
  remarks: '', version: 1, archived: false, updatedAt: '2026-10-01T00:00:00Z', ...over,
});

const world = (documents = []) => ({
  employees: [
    { id: 'emp_011', employeeId: 'EMP-0011', fullName: 'Will Rutherford', firstName: 'Will', lastName: 'Rutherford', status: 'active' },
    { id: 'emp_002', employeeId: 'EMP-0002', fullName: 'Grace Hopper', firstName: 'Grace', lastName: 'Hopper', status: 'active' },
  ],
  documents,
});

/* ------------------------------ signals ----------------------------------- */

check('recognises an offer letter, a visa and a contract from their words', () => {
  assert.equal(classifyText({ text: OFFER, title: '' }).category, 'offer-letter');
  assert.equal(classifyText({ text: VISA, title: '' }).category, 'work-authorization');
  assert.equal(classifyText({ text: 'This Agreement sets the term of this agreement. Termination requires notice.', title: '' }).category, 'contract');
});

check('lets the title outweigh a passing mention in the text', () => {
  const verdict = classifyText({ title: 'Non-Disclosure Agreement', text: 'The employee will also receive an offer of training.' });
  assert.equal(verdict.category, 'nda');
});

check('says other, and says so with low confidence, when nothing matches', () => {
  const verdict = classifyText({ text: 'lorem ipsum dolor sit amet', title: 'scan0042' });
  assert.equal(verdict.category, 'other');
  assert.ok(verdict.confidence <= 0.25);
});

check('reads each date by the words before it', () => {
  const dates = suggestDates(VISA);
  assert.equal(dates.issueDate, '2026-01-10');
  assert.equal(dates.expiryDate, '2027-03-31');
});

check('leaves a date with no telling words undecided rather than guessing', () => {
  const found = findDates('Meeting on 2026-05-05 about the file');
  assert.equal(found[0].role, 'unknown');
  assert.equal(suggestDates('Meeting on 2026-05-05').expiryDate, null);
});

check('ignores a date that is not on the calendar', () => {
  assert.deepEqual(findDates('Valid until 2026-02-31'), []);
  assert.deepEqual(findDates('Valid until 13/45/2026'), []);
});

check('reads slash dates as month/day and says when they could be read the other way', () => {
  const [item] = findDates('Issued 03/04/2026');
  assert.equal(item.iso, '2026-03-04');
  assert.equal(item.ambiguous, true);
  assert.equal(findDates('Issued 03/03/2026')[0].ambiguous, false);
});

check('does not suggest an expiry that falls before the issue date', () => {
  const found = suggestDates('Issued 2026-06-01\nExpires 2026-01-01');
  assert.equal(found.consistent, false);
  const { data } = run('classify-document', world([]), { text: 'Visa. Issued 2026-06-01\nExpires 2026-01-01' });
  assert.equal(data.suggestion.expiryDate, null);
});

/* ------------------------------ classify ---------------------------------- */

check('classifies, and lists only what would change on the record', () => {
  const record = doc({ category: 'contract', confidential: false, issueDate: '2026-01-10', expiryDate: '2027-03-30' });
  const result = run('classify-document', world([record]), { documentId: 'doc_1', text: VISA });

  assert.equal(result.data.suggestion.category, 'work-authorization');
  assert.deepEqual(result.data.changes.map((item) => item.field).sort(), ['category', 'confidential', 'expiryDate']);
  assert.match(result.output, /Suggested type: Work authorization/);
  assert.match(result.output, /Nothing has been changed/);
});

check('says the record already matches when it does', () => {
  const record = doc({ category: 'work-authorization', confidential: true, issueDate: '2026-01-10', expiryDate: '2027-03-31' });
  const result = run('classify-document', world([record]), { documentId: 'doc_1', text: VISA });
  assert.deepEqual(result.data.changes, []);
  assert.match(result.output, /matches what the record already says/);
});

check('never suggests clearing a date the text did not state', () => {
  const record = doc({ category: 'offer-letter', issueDate: '2026-04-15', expiryDate: '2027-01-01' });
  const result = run('classify-document', world([record]), { documentId: 'doc_1', text: 'Offer letter. We are pleased to offer you a role.' });
  assert.ok(!result.data.changes.some((item) => item.field === 'expiryDate' && item.to === null));
});

check('reads only the title when there is no text, and is less sure about it', () => {
  const result = run('classify-document', world([]), { title: 'Offer Letter — Grace' });
  assert.equal(result.data.basis, 'title');
  assert.ok(result.confidence <= 0.5);
  assert.match(result.limitation, /Only the title was read/);
});

check('is a draft: it carries no decision and writes nothing', () => {
  const records = [doc({})];
  const before = JSON.stringify(records);
  const result = run('classify-document', world(records), { documentId: 'doc_1', text: VISA });
  assert.equal(result.data.decisionAllowed, false);
  assert.equal(JSON.stringify(records), before);
});

check('needs something to classify', () => {
  assert.throws(() => run('classify-document', world([]), {}), /classify/);
});

check('refuses a confidential document the AI settings keep away from it, whatever text is sent', () => {
  const secret = doc({ id: 'doc_9', confidential: true });
  assert.throws(() => run('classify-document', world([secret]), { documentId: 'doc_9', text: VISA }, false), /not available to the AI/);
  assert.throws(() => run('ask-document', world([secret]), { documentId: 'doc_9', text: VISA, question: 'when does it expire?' }, false), /not available to the AI/);
  assert.ok(run('classify-document', world([secret]), { documentId: 'doc_9', text: VISA }, true));
});

/* ------------------------------ ask a document ------------------------------ */

const CONTRACT = `Employment Agreement
The employee will receive a base salary of $98,000 per year.
Either party may end this agreement with 30 days written notice.
The employee is entitled to 20 days of paid annual leave.
Valid until 2027-06-30`;

check('quotes the passage that answers, with its line', () => {
  const result = run('ask-document', world([]), { text: CONTRACT, question: 'How much notice is required to end the agreement?' });
  assert.equal(result.data.found, true);
  assert.match(result.output, /> Either party may end this agreement with 30 days written notice\.\s+\(line 3\)/);
});

check('does not answer from outside the text', () => {
  const result = run('ask-document', world([]), { text: CONTRACT, question: 'What is the dress code policy?' });
  assert.equal(result.data.found, false);
  assert.match(result.output, /does not seem to answer/);
  assert.ok(result.confidence <= 0.3);
});

check('does not treat one shared word as an answer', () => {
  const result = run('ask-document', world([]), { text: CONTRACT, question: 'What is the maternity leave arrangement for contractors in Germany?' });
  assert.equal(result.data.found, false);
});

check('answers a date question from the dates the text states, and flags a record that disagrees', () => {
  const record = doc({ expiryDate: '2027-01-01' });
  const result = run('ask-document', world([record]), { documentId: 'doc_1', text: CONTRACT, question: 'When does this expire?' });
  assert.match(result.output, /Expiry date stated in the text: 2027-06-30/);
  assert.match(result.output, /record lists the expiry as 2027-01-01, which differs/);
});

check('needs a question and the text', () => {
  assert.throws(() => run('ask-document', world([]), { text: CONTRACT }), /question is required/);
  assert.throws(() => run('ask-document', world([]), { question: 'anything?' }), /text is required/);
});

/* ------------------------------ search ------------------------------------ */

const REGISTER = [
  doc({ id: 'doc_1', title: 'Work Permit — Will', tags: ['permit'], category: 'work-authorization', employeeId: 'emp_011', expiryDate: '2026-11-30', issueDate: '2025-11-30' }),
  doc({ id: 'doc_2', title: 'Employment Contract — Will', category: 'contract', employeeId: 'emp_011', expiryDate: '2026-12-20', issueDate: '2024-03-01', confidential: true }),
  doc({ id: 'doc_3', title: 'Employment Contract — Grace', category: 'contract', employeeId: 'emp_002', expiryDate: '2026-12-05', issueDate: '2025-02-01' }),
  doc({ id: 'doc_4', title: 'Old Passport — Grace', category: 'id-proof', employeeId: 'emp_002', expiryDate: '2026-06-01', issueDate: '2016-06-01' }),
  doc({ id: 'doc_5', title: 'Employee Handbook', category: 'policy', ownerType: 'company', employeeId: null, expiryDate: null, issueDate: '2024-11-12', tags: ['handbook', 'policy'] }),
  doc({ id: 'doc_6', title: 'Old Contract — Grace', category: 'contract', employeeId: 'emp_002', archived: true, expiryDate: '2026-12-01' }),
];
const ids = (result) => result.data.documentIds;
const find = (question, allow = true) => run('search-documents', world(REGISTER), { question }, allow);

check('finds a type for a person', () => {
  assert.deepEqual(ids(find("Will Rutherford's contract")), ['doc_2']);
  assert.deepEqual(ids(find('contracts for Grace Hopper')), ['doc_3']);
});

check('reads "next month" as next calendar month, and "this month" as the rest of this one', () => {
  assert.deepEqual(ids(find('what expires next month?')), ['doc_3', 'doc_2']);
  assert.deepEqual(ids(find('documents expiring this month')), ['doc_1']);
});

check('finds what has already expired, and what never expires', () => {
  assert.deepEqual(ids(find('which documents have expired?')), ['doc_4']);
  assert.deepEqual(ids(find('documents with no expiry')), ['doc_5']);
});

check('reads "next N days" as a window from today', () => {
  assert.deepEqual(ids(find('contracts expiring in the next 30 days')), ['doc_3']);
  assert.deepEqual(ids(find('contracts expiring in the next 45 days')), ['doc_3', 'doc_2']);
});

check('keeps archived documents out unless asked for', () => {
  assert.ok(!ids(find('contracts for Grace')).includes('doc_6'));
  assert.deepEqual(ids(find('archived contracts')), ['doc_6']);
});

check('filters on confidential, and on the year it was issued', () => {
  assert.deepEqual(ids(find('confidential contracts')), ['doc_2']);
  assert.deepEqual(ids(find('contracts issued in 2025')), ['doc_3']);
  assert.deepEqual(ids(find('documents issued before 2020')), ['doc_4']);
});

check('matches leftover words against titles and tags, and says it did', () => {
  const result = find('permit');
  assert.deepEqual(ids(result), ['doc_1']);
  assert.ok(result.data.interpreted.some((item) => item.label === 'Mentions' && item.value === 'permit'));
});

check('shows how it understood the question, so a misreading can be seen', () => {
  const { output, data } = find('contracts expiring next month');
  assert.match(output, /Understood as/);
  assert.ok(data.interpreted.some((item) => item.label === 'Type'));
  assert.ok(data.interpreted.some((item) => item.label === 'Expiry'));
});

check('says it could not tell, rather than listing everything', () => {
  const result = find('show me');
  assert.equal(result.data.answered, false);
  assert.deepEqual(ids(result), []);
});

check('cannot find a confidential document when the AI settings keep them away', () => {
  assert.deepEqual(ids(find('contracts for Will', false)), []);
  assert.match(find('contracts', false).output, /Confidential documents are not searched/);
});

check('caps what it returns, and still reports the true total', () => {
  const many = Array.from({ length: 40 }, (_, i) => doc({ id: `doc_m${i}`, title: `Contract ${i}`, category: 'contract', expiryDate: null }));
  const result = run('search-documents', world(many), { question: 'contracts' });
  assert.equal(result.data.documentIds.length, 25);
  assert.equal(result.data.total, 40);
});

check('needs a question', () => {
  assert.throws(() => find(''), /Say what to look for/);
});

/* ------------------------------ against the seed ------------------------------ */

const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'db.json');
if (fs.existsSync(DB_FILE)) {
  const seed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  const person = seed.employees.find((item) => item.status === 'active');
  const questions = [
    'contracts expiring next month',
    'which documents have expired?',
    `${person.fullName} documents`,
    'confidential policies',
    'work permits expiring in the next 90 days',
    'tax forms issued in 2026',
  ];

  check('answers every sample question against the seed without errors', () => {
    for (const question of questions) {
      const result = run('search-documents', seed, { question }, true);
      assert.ok(result.output.length > 20, question);
      assert.ok(!result.output.includes('undefined') && !result.output.includes('NaN'), question);
      assert.ok(result.data.documentIds.every((id) => seed.documents.some((item) => item.id === id)), question);
    }
  });

  check('finds Will-style documents for a real employee, and only that person’s', () => {
    const result = run('search-documents', seed, { question: `${person.fullName} documents` }, true);
    const owners = new Set(result.data.documentIds.map((id) => seed.documents.find((item) => item.id === id).employeeId));
    assert.ok(owners.size <= 1 && (owners.size === 0 || owners.has(person.id)));
  });
}

console.log(`document ai: ${passed} checks passed`);
