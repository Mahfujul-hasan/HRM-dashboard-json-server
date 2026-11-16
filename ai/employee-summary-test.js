/**
 * Checks for the employee-profile summary. Run: `node ai/employee-summary-test.js`.
 *
 * The summary goes in front of whoever reads the profile and may be pasted elsewhere, so the
 * checks that matter most are about what must NOT be in it: pay, date of birth, address, phone.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const registry = require('./registry');
const helpers = require('./helpers');

const engine = registry.get('summarize-employee-profile');
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

function run(db, input, settings = { ai: { allowConfidentialDocuments: true } }) {
  const view = {
    get: (name) => db[name] || [],
    byId: (name, id) => (db[name] || []).find((row) => row.id === id) || null,
  };
  return engine.run({ input, db: view, settings, now: NOW, helpers, tools: [] });
}

const employee = {
  id: 'emp_011',
  employeeId: 'EMP-0011',
  fullName: 'Will Rutherford',
  firstName: 'Will',
  lastName: 'Rutherford',
  dateOfBirth: '1990-08-10',
  phone: '(963) 622-9131',
  personalEmail: 'will.private@example.com',
  officialEmail: 'will@acme.test',
  presentAddress: '9312 Jayme Crescent',
  permanentAddress: '8885 Natalia Summit',
  emergencyContact: { name: 'Vern Hills', relation: 'Parent', phone: '(208) 897-4563' },
  departmentId: 'dep_02',
  teamId: 'dep_06',
  designationId: 'des_007',
  reportingManagerId: 'emp_002',
  locationId: 'loc_02',
  employmentType: 'full-time',
  workMode: 'hybrid',
  joiningDate: '2026-05-01',
  probationEndDate: '2026-11-30',
  status: 'probation',
  experienceYears: 4,
  skills: ['Testing', 'SQL'],
  education: [{ degree: 'BSc', institution: 'Oxford University', year: 2012 }],
  history: [
    { type: 'joined', date: '2026-05-01', from: null, to: 'QA Engineer', note: 'Joined the company' },
    { type: 'promotion', date: '2026-09-01', from: 'QA Engineer', to: 'Senior QA', note: 'Strong start' },
  ],
  exit: null,
};

const world = (overrides = {}) => ({
  employees: [
    employee,
    { id: 'emp_002', employeeId: 'EMP-0002', fullName: 'Grace Hopper', status: 'active', history: [] },
    { id: 'emp_020', employeeId: 'EMP-0020', fullName: 'Linus', status: 'active', reportingManagerId: 'emp_011', history: [] },
  ],
  departments: [
    { id: 'dep_02', name: 'Engineering' },
    { id: 'dep_06', name: 'QA' },
  ],
  designations: [{ id: 'des_007', title: 'QA Engineer', requiredSkills: ['Testing', 'Playwright'] }],
  locations: [{ id: 'loc_02', name: 'New York Office' }],
  salaryStructures: [{ employeeId: 'emp_011', basic: 98765, monthlyGross: 123456, isCurrent: true }],
  documents: [
    { id: 'doc_1', employeeId: 'emp_011', title: 'Offer Letter — Will', category: 'offer-letter', expiryDate: null, archived: false },
    { id: 'doc_2', employeeId: 'emp_011', title: 'Work Permit — Will', category: 'work-authorization', expiryDate: '2026-11-30', archived: false },
    { id: 'doc_3', employeeId: 'emp_011', title: 'Old Visa — Will', category: 'work-authorization', expiryDate: '2026-01-01', archived: false },
    { id: 'doc_4', employeeId: 'emp_011', title: 'Old Letter — Will', category: 'offer-letter', expiryDate: null, archived: true },
    { id: 'doc_5', employeeId: 'emp_999', title: 'Someone else', category: 'resume', expiryDate: null, archived: false },
  ],
  ...overrides,
});

check('describes the role, place, manager and time here', () => {
  const { output } = run(world(), { employeeId: 'emp_011' });
  assert.match(output, /Will Rutherford \(EMP-0011\) is a QA Engineer in Engineering, QA team/);
  assert.match(output, /based at New York Office, working hybrid, reporting to Grace Hopper, and managing 1 person/);
  assert.match(output, /Joined on 2026-05-01 \(6 months ago\)/);
});

check('summarises skills against the role, history, and documents', () => {
  const { output } = run(world(), { employeeId: 'emp_011' });
  assert.match(output, /Matches 1 of the 2 skills listed for the QA Engineer role/);
  assert.match(output, /Education: BSc, Oxford University \(2012\)/);
  assert.match(output, /2 entries — 1 promotion, 0 transfers/);
  assert.match(output, /2026-09-01 — Promotion: QA Engineer → Senior QA \(Strong start\)/);
  assert.match(output, /3 documents: offer letter, work authorization ×2/);
});

check('leaves out pay, date of birth, address, phone, personal email and emergency contact', () => {
  const result = run(world(), { employeeId: 'emp_011' });
  const everything = `${result.output}\n${JSON.stringify(result.data)}\n${JSON.stringify(result.sources)}`;
  for (const secret of [
    '123456', '98765', '1990-08-10', 'Jayme Crescent', 'Natalia Summit', '622-9131', '897-4563',
    'will.private@example.com', 'Vern Hills',
  ]) {
    assert.ok(!everything.includes(secret), `the summary contains "${secret}"`);
  }
});

check('does not read the salary collection at all', () => {
  const touched = [];
  const view = {
    get: (name) => {
      touched.push(name);
      return world()[name] || [];
    },
    byId: (name, id) => (world()[name] || []).find((row) => row.id === id) || null,
  };
  engine.run({ input: { employeeId: 'emp_011' }, db: view, settings: { ai: {} }, now: NOW, helpers, tools: [] });
  assert.ok(!touched.includes('salaryStructures'), `read ${touched.join(', ')}`);
});

check('counts only this person\'s documents that are still current', () => {
  const { data } = run(world(), { employeeId: 'emp_011' });
  assert.equal(data.documentCount, 3);
});

check('points at expired and soon-to-expire documents, and an ending probation', () => {
  const { data, output } = run(world(), { employeeId: 'emp_011' });
  assert.equal(data.expiredDocuments, 1);
  assert.equal(data.expiringDocuments, 1);
  assert.match(output, /Probation ends in 14 days \(2026-11-30\)/);
  assert.match(output, /1 document has expired: Old Visa/);
  assert.match(output, /1 document expires within 30 days: Work Permit/);
});

check('says plainly when confidential documents were left out', () => {
  const { output } = run(world(), { employeeId: 'emp_011' }, { ai: { allowConfidentialDocuments: false } });
  assert.match(output, /Confidential documents are left out by the AI settings/);
});

check('ends a person who has left at their last working day, not today', () => {
  const left = {
    ...employee,
    status: 'resigned',
    exit: { resignationDate: '2026-08-01', lastWorkingDate: '2026-09-01', reason: 'x', interviewNotes: '', clearanceStatus: 'pending', rehireEligible: true },
  };
  const { output } = run(world({ employees: [left] }), { employeeId: 'emp_011' });
  assert.match(output, /left on 2026-09-01 after 4 months; status is resigned/);
});

check('flags a record marked as left with no exit details', () => {
  const broken = { ...employee, status: 'terminated', exit: null };
  const { output } = run(world({ employees: [broken] }), { employeeId: 'emp_011' });
  assert.match(output, /Marked terminated but no exit details are recorded/);
});

check('says what is missing rather than inventing it', () => {
  const bare = { ...employee, skills: [], education: [], history: [], reportingManagerId: null, experienceYears: 0 };
  const { output } = run(world({ employees: [bare], documents: [] }), { employeeId: 'emp_011' });
  assert.match(output, /No skills are recorded/);
  assert.match(output, /Nothing is recorded beyond joining/);
  assert.match(output, /No documents are on file/);
  assert.match(output, /no reporting manager recorded/);
});

check('does not assess performance or recommend anything', () => {
  const { output, limitation } = run(world(), { employeeId: 'emp_011' });
  assert.ok(!/\b(excellent|poor|should be|recommend|underperform|rating)\b/i.test(output), output);
  assert.match(limitation, /nothing here assesses performance/);
});

check('names its sources: the record and the documents it used', () => {
  const { sources } = run(world(), { employeeId: 'emp_011' });
  assert.equal(sources[0].kind, 'employee');
  assert.ok(sources.some((item) => item.kind === 'document'));
});

check('refuses a missing or unknown employee', () => {
  assert.throws(() => run(world(), {}), /Say which employee/);
  assert.throws(() => run(world(), { employeeId: 'emp_404' }), /not found/);
});

const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'db.json');
if (fs.existsSync(DB_FILE)) {
  const seed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  check('summarises every employee in the seed without error, and without their pay', () => {
    for (const person of seed.employees) {
      const result = run(seed, { employeeId: person.id });
      assert.ok(result.output.length > 80, person.employeeId);
      assert.ok(!result.output.includes('undefined') && !result.output.includes('NaN'), person.employeeId);
      assert.ok(!result.output.includes(person.dateOfBirth), `${person.employeeId} date of birth`);
    }
  });
}

console.log(`employee summary: ${passed} checks passed`);
