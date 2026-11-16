/**
 * Routing checks for the assistant.
 *
 *   node ai/router-test.js
 *
 * Each case is a question an HR user would actually type, with the tool it should reach.
 * Routing is the part of the chat most likely to be wrong, so it is tested on its own,
 * without HTTP and without running the engines.
 */

const fs = require('fs');
const path = require('path');
const { route } = require('./router');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'db.json');
const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
const now = new Date();

const view = {
  get: (name) => db[name] || [],
  byId: (name, id) => (db[name] || []).find((row) => row.id === id) || null,
};

const employee = db.employees.find((item) => item.status === 'active');
const candidate = db.candidates.find((item) => item.stage === 'shortlisted') || db.candidates[0];

const CASES = [
  // General data questions → the assistant engine.
  { message: 'how many employees do we have?', expect: 'hr-data-query' },
  { message: 'who is on leave today?', expect: 'hr-data-query' },
  { message: 'who was late yesterday?', expect: 'hr-data-query' },
  { message: 'show me the new joiners', expect: 'hr-data-query' },
  { message: 'what needs my approval?', expect: 'hr-data-query' },
  { message: 'any birthdays this month?', expect: 'hr-data-query' },
  { message: 'what can you do?', expect: 'hr-data-query' },
  { message: 'how many open positions are there?', expect: 'hr-data-query' },
  { message: 'whose probation is ending?', expect: 'hr-data-query' },
  { message: 'what is the payroll total?', expect: 'hr-data-query' },

  // Specialist tools.
  { message: 'what is the policy on carry forward of annual leave?', expect: 'ask-hr-policy' },
  { message: 'how many leave days am i entitled to?', expect: 'ask-hr-policy' },
  { message: `check leave conflicts for ${employee.fullName} from 2026-12-01 to 2026-12-05`, expect: 'leave-conflict-check' },
  { message: 'validate the payroll before i finalise it', expect: 'payroll-validation' },
  { message: 'find attendance anomalies in the last 14 days', expect: 'attendance-insight' },
  { message: `what is the match score for ${candidate.fullName}?`, expect: 'candidate-match-score' },
  { message: `summarise the cv of ${candidate.fullName}`, expect: 'analyze-candidate-cv' },
  { message: 'write a job description for a Software Engineer', expect: 'generate-job-description' },
  { message: 'what interview questions should i ask?', expect: 'generate-interview-questions' },
  { message: `draft a rejection email for ${candidate.fullName}`, expect: 'draft-hr-email' },
  { message: `create an onboarding plan for ${employee.fullName}`, expect: 'generate-onboarding-plan' },
  { message: `draft the performance review for ${employee.fullName}`, expect: 'performance-feedback-summary' },
  { message: `what is the skill gap for ${employee.fullName}?`, expect: 'skill-gap-analyzer' },
  { message: `recommend training for ${employee.fullName}`, expect: 'training-recommendation' },
  { message: 'what are people saying in the engagement survey?', expect: 'analyze-survey-feedback' },
  { message: 'why are people leaving?', expect: 'analyze-exit-interview' },
  { message: 'which documents are expiring this month?', expect: 'document-expiry-assistant' },
  { message: 'are there duplicate employee records?', expect: 'data-quality-checker' },
  { message: 'how many people will we need to hire next quarter?', expect: 'workforce-forecasting' },
  { message: 'why did attrition go up this quarter?', expect: 'report-explainer' },
  { message: 'explain the attendance report', expect: 'report-explainer' },

  // An intent whose entity is missing must step aside rather than fail.
  { message: 'what is the skill gap?', expect: 'hr-data-query', note: 'no employee named' },
  { message: 'give me a match score', expect: 'hr-data-query', note: 'no candidate named' },
];

const failures = [];

for (const testCase of CASES) {
  const result = route({ message: testCase.message, db: view, now, context: {}, extra: {} });
  const ok = result.toolId === testCase.expect;
  if (!ok) {
    failures.push(`"${testCase.message}" → ${result.toolId} (expected ${testCase.expect})`);
  }
  console.log(
    `  ${ok ? 'ok ' : 'FAIL'} ${testCase.message.slice(0, 58).padEnd(60)} → ${result.toolId}${testCase.note ? `  [${testCase.note}]` : ''}`,
  );
}

// Entity extraction and follow-up context.
const named = route({ message: `tell me about ${employee.fullName}`, db: view, now, context: {}, extra: {} });
if (named.entities.employeeId !== employee.id) {
  failures.push(`Name "${employee.fullName}" did not resolve to ${employee.id}`);
}

const followUp = route({
  message: 'what is the skill gap?',
  db: view,
  now,
  context: { employeeId: employee.id },
  extra: {},
});
if (followUp.toolId !== 'skill-gap-analyzer') {
  failures.push(`Follow-up with carried context went to ${followUp.toolId}, expected skill-gap-analyzer`);
}

// A name in the current message must replace whoever the thread was about.
const other = db.employees.find((item) => item.id !== employee.id && item.status === 'active' && item.lastName.length > 3);
const switched = route({
  message: `recommend training for ${other.fullName}`,
  db: view,
  now,
  context: { employeeId: employee.id },
  extra: {},
});
if (switched.entities.employeeId !== other.id) {
  failures.push(`Naming ${other.fullName} did not override the carried subject`);
}

// Carried context must not leak into a tool that was not asked about a person.
const wholeOrg = route({
  message: 'are there any duplicate records?',
  db: view,
  now,
  context: { employeeId: employee.id },
  extra: {},
});
if (wholeOrg.input.employeeId) {
  failures.push('Carried employee leaked into the organisation-wide data-quality check');
}

// A forward window must be read as a window, not ignored.
const forward = route({ message: 'which documents expire in the next 60 days?', db: view, now, context: {}, extra: {} });
if (forward.input.withinDays !== 60) {
  failures.push(`"next 60 days" produced withinDays ${forward.input.withinDays}, expected 60`);
}

// "Approve X's leave" runs the conflict check; approving itself stays with HR.
const approval = route({ message: `approve the leave for ${other.fullName}`, db: view, now, context: {}, extra: {} });
if (approval.toolId !== 'leave-conflict-check') {
  failures.push(`Leave approval question went to ${approval.toolId}, expected leave-conflict-check`);
}

console.log('');
if (failures.length) {
  console.error(`${failures.length} routing failure(s):\n`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  console.error('');
  process.exit(1);
}
console.log(`All ${CASES.length} routing case(s) passed, plus entity resolution and follow-up context.\n`);
