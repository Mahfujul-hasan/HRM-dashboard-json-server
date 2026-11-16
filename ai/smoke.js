/**
 * Runs every AI engine once against the database and reports the result.
 *
 *   node ai/smoke.js                     checks db.json
 *   DB_FILE=./db.seedtest.json node ai/smoke.js
 *   node ai/smoke.js --print ask-hr-policy      also prints that engine's full output
 *
 * No HTTP and no writes: it calls the engines directly, so a failure here is an engine bug,
 * not a routing one. Exits non-zero if any engine throws or returns an unusable result.
 */

const fs = require('fs');
const path = require('path');
const registry = require('./registry');
const helpers = require('./helpers');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'db.json');
const printTool = process.argv.includes('--print') ? process.argv[process.argv.indexOf('--print') + 1] : null;

const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
const settings = db.settings;
const now = new Date();

/** Same read-only view the gateway builds. */
const view = {
  get: (name) => {
    const rows = db[name] || [];
    if (name === 'documents' && !settings.ai.allowConfidentialDocuments) {
      return rows.filter((document) => !document.confidential);
    }
    return rows;
  },
  byId: (name, id) => (id ? (db[name] || []).find((row) => row.id === id) || null : null),
};

const activeEmployee = db.employees.find((employee) => employee.status === 'active');
const recentHire = [...db.employees].sort((a, b) => b.joiningDate.localeCompare(a.joiningDate))[0];
const candidate = db.candidates.find((item) => item.stage === 'shortlisted') || db.candidates[0];
const job = db.jobs.find((item) => item.status === 'open') || db.jobs[0];
const pendingLeave = db.leaveRequests.find((item) => item.status === 'pending');
const draftRun = db.payrollRuns.find((item) => item.status === 'draft');
const engagementSurvey = db.surveys.find((item) => item.type === 'engagement');
const exitSurvey = db.surveys.find((item) => item.type === 'exit');
const expiringDocument = db.documents.find((item) => item.expiryDate);

const SAMPLE_CV = `Jordan Avery
jordan.avery@example.com
(415) 555-0199

Senior Software Engineer at Contoso since March 3, 2021.
Skills: TypeScript, React, Node.js, AWS, Testing.
Education: BSc Computer Science, 2016.
Expected compensation: $145,000.
`;

/** One case per engine. `skip` marks data the current database cannot provide. */
const CASES = [
  { toolId: 'hr-data-query', input: { question: 'how many employees do we have?' } },
  { toolId: 'hr-data-query', input: { question: 'who is on leave today?' }, note: 'leave today' },
  { toolId: 'hr-data-query', input: { question: 'who was late yesterday?' }, note: 'attendance today' },
  { toolId: 'hr-data-query', input: { question: 'show me the new joiners' }, note: 'new hires' },
  { toolId: 'hr-data-query', input: { question: 'what needs my approval?' }, note: 'pending leave' },
  { toolId: 'hr-data-query', input: { question: 'whose probation is ending?' }, note: 'probation' },
  { toolId: 'hr-data-query', input: { question: 'any birthdays this month?' }, note: 'birthdays' },
  { toolId: 'hr-data-query', input: { question: 'what is the payroll total?' }, note: 'payroll' },
  { toolId: 'hr-data-query', input: { question: 'how many open positions?' }, note: 'open jobs' },
  { toolId: 'hr-data-query', input: { question: 'onboarding status' }, note: 'onboarding' },
  { toolId: 'hr-data-query', input: { question: 'department breakdown' }, note: 'departments' },
  { toolId: 'hr-data-query', input: { question: 'training completion' }, note: 'training' },
  { toolId: 'hr-data-query', input: { question: 'who are the top performers?' }, note: 'performance' },
  { toolId: 'hr-data-query', input: { question: 'who left recently?' }, note: 'exits' },
  { toolId: 'hr-data-query', input: { question: 'what can you do?' }, note: 'capabilities' },
  { toolId: 'hr-data-query', input: { question: 'what is the airspeed of a swallow?' }, note: 'unmatched' },
  { toolId: 'ask-hr-policy', input: { question: 'How many annual leave days carry forward?' } },
  { toolId: 'ask-hr-policy', input: { question: 'What is the pet adoption allowance?' }, note: 'unanswerable on purpose' },
  { toolId: 'summarize-document', input: { documentId: expiringDocument && expiringDocument.id, text: SAMPLE_CV } },
  { toolId: 'extract-document-data', input: { text: SAMPLE_CV, target: 'candidate' } },
  { toolId: 'document-expiry-assistant', input: { withinDays: 30 } },
  { toolId: 'generate-job-description', input: { jobId: job && job.id } },
  { toolId: 'generate-interview-questions', input: { jobId: job && job.id, round: 'technical' } },
  { toolId: 'analyze-candidate-cv', input: { candidateId: candidate && candidate.id, cvText: SAMPLE_CV } },
  { toolId: 'candidate-match-score', input: { candidateId: candidate && candidate.id } },
  { toolId: 'draft-hr-email', input: { kind: 'interview-invitation', candidateId: candidate && candidate.id, interviewDate: 'Thursday at 10:00' } },
  { toolId: 'generate-onboarding-plan', input: { employeeId: recentHire && recentHire.id } },
  { toolId: 'attendance-insight', input: { days: 30 } },
  { toolId: 'leave-conflict-check', input: { leaveRequestId: pendingLeave && pendingLeave.id } },
  { toolId: 'payroll-validation', input: { payrollRunId: draftRun && draftRun.id } },
  { toolId: 'performance-feedback-summary', input: { employeeId: activeEmployee && activeEmployee.id } },
  { toolId: 'skill-gap-analyzer', input: { employeeId: activeEmployee && activeEmployee.id } },
  { toolId: 'training-recommendation', input: { employeeId: activeEmployee && activeEmployee.id } },
  { toolId: 'analyze-survey-feedback', input: { surveyId: engagementSurvey && engagementSurvey.id } },
  { toolId: 'analyze-exit-interview', input: { surveyId: exitSurvey && exitSurvey.id, months: 12 } },
  { toolId: 'report-explainer', input: { reportType: 'attrition', months: 6 } },
  { toolId: 'report-explainer', input: { reportType: 'recruitment', months: 6 } },
  { toolId: 'workforce-forecasting', input: { months: 12, horizon: 3 } },
  { toolId: 'data-quality-checker', input: {} },
];

const failures = [];
const covered = new Set();

for (const testCase of CASES) {
  const engine = registry.get(testCase.toolId);
  if (!engine) {
    failures.push(`${testCase.toolId}: no engine registered`);
    continue;
  }
  covered.add(testCase.toolId);

  const label = `${testCase.toolId}${testCase.note ? ` (${testCase.note})` : ''}`;

  try {
    const result = engine.run({ input: testCase.input, db: view, settings, now, helpers, tools: registry.list() });

    if (typeof result.output !== 'string' || result.output.length < 20) {
      failures.push(`${label}: output too short`);
      continue;
    }
    if (!Array.isArray(result.sources) || !result.sources.length) {
      failures.push(`${label}: no sources returned`);
      continue;
    }
    if (typeof result.confidence !== 'number' || result.confidence <= 0 || result.confidence > 1) {
      failures.push(`${label}: confidence ${result.confidence} is out of range`);
      continue;
    }
    if (result.output.includes('undefined') || result.output.includes('NaN')) {
      failures.push(`${label}: output contains undefined or NaN`);
      continue;
    }

    const firstLine = result.output.split('\n')[0].slice(0, 96);
    console.log(
      `  ok  ${label.padEnd(46)} conf ${String(result.confidence).padEnd(5)} src ${String(result.sources.length).padEnd(2)} ${firstLine}`,
    );

    if (printTool && testCase.toolId === printTool) {
      console.log(`\n${'─'.repeat(80)}\n${result.output}\n${'─'.repeat(80)}\n`);
    }
  } catch (error) {
    failures.push(`${label}: threw ${error.message}`);
  }
}

const missing = registry.list().filter((tool) => !covered.has(tool.id));
if (missing.length) failures.push(`No smoke case for: ${missing.map((tool) => tool.id).join(', ')}`);

console.log('');
if (failures.length) {
  console.error(`${failures.length} failure(s):\n`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  console.error('');
  process.exit(1);
}
console.log(`All ${CASES.length} engine case(s) passed across ${registry.size} registered tools.\n`);
