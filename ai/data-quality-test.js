/**
 * Checks for the data-quality engine. Run: `node ai/data-quality-test.js`.
 *
 * Two kinds: every flaw the seed planted on purpose must be found (the seed lists them in
 * `settings.seed.flaws`, so a checker that stops finding one fails here), and a few synthetic
 * records pin down individual rules, including that clean data is left alone.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const registry = require('./registry');
const helpers = require('./helpers');

const engine = registry.get('data-quality-checker');
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

function run(db, input = {}) {
  const view = {
    get: (name) => db[name] || [],
    byId: (name, id) => (db[name] || []).find((row) => row.id === id) || null,
  };
  return engine.run({ input, db: view, settings: db.settings || {}, now: NOW, helpers, tools: [] });
}

/* ------------------------------ the real seed ------------------------------ */

const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'db.json');
if (fs.existsSync(DB_FILE)) {
  const seed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  const result = run(seed);
  const flaws = (seed.settings.seed && seed.settings.seed.flaws) || [];

  check('the seed plants flaws to find', () => assert.ok(flaws.length > 0));

  for (const flaw of flaws) {
    check(`finds ${flaw.type} on ${flaw.employeeCode}`, () => {
      const hit = result.data.issues.find(
        (issue) => issue.employeeId === flaw.employeeId && issue.code === flaw.type,
      );
      assert.ok(hit, `${flaw.type} on ${flaw.employeeCode} (${flaw.detail}) was not reported`);
    });
  }

  check('reports nothing on a record the seed left clean', () => {
    const flawed = new Set(flaws.map((flaw) => flaw.employeeId));
    // A duplicate flags both records, so the other side of a planted pair is allowed too.
    const related = new Set(
      result.data.issues.filter((issue) => flawed.has(issue.employeeId)).flatMap((issue) => issue.relatedIds || []),
    );
    const stray = result.data.issues.filter(
      (issue) => !flawed.has(issue.employeeId) && !related.has(issue.employeeId),
    );
    assert.deepEqual(stray.map((issue) => `${issue.employeeId} ${issue.code}`), []);
  });
}

/* ------------------------------ synthetic rules ---------------------------- */

const base = {
  id: 'emp_001',
  employeeId: 'EMP-0001',
  fullName: 'Ada Lovelace',
  officialEmail: 'ada@acme.test',
  personalEmail: 'ada@home.test',
  phone: '(415) 555-0100',
  dateOfBirth: '1990-12-10',
  gender: 'female',
  departmentId: 'dep_02',
  teamId: null,
  designationId: 'des_1',
  joiningDate: '2024-01-01',
  probationEndDate: null,
  locationId: 'loc_1',
  employmentType: 'full-time',
  status: 'active',
  exit: null,
  presentAddress: '1 Way',
  permanentAddress: '1 Way',
  emergencyContact: { name: 'Vern', relation: 'Parent', phone: '(208) 897-4563' },
};

const world = (employees) => ({
  employees,
  departments: [
    { id: 'dep_02', name: 'Engineering', parentId: null },
    { id: 'dep_06', name: 'QA', parentId: 'dep_02' },
    { id: 'dep_03', name: 'Finance', parentId: null },
  ],
  designations: [{ id: 'des_1', title: 'Engineer', departmentId: 'dep_02' }],
  locations: [{ id: 'loc_1', name: 'HQ' }],
  salaryStructures: employees.map((employee) => ({ employeeId: employee.id, isCurrent: true })),
});

const codes = (db, input) => run(db, input).data.issues.map((issue) => issue.code);

check('finds nothing wrong with a clean record', () => {
  assert.deepEqual(codes(world([base])), []);
});

check('flags a malformed personal email as well as an official one', () => {
  const issue = run(world([{ ...base, personalEmail: 'ada at home.test' }])).data.issues[0];
  assert.equal(issue.code, 'invalid-email');
  assert.equal(issue.field, 'personalEmail');
});

check('flags a date that has the shape of one and is not one', () => {
  const issue = run(world([{ ...base, dateOfBirth: '1990-02-31' }])).data.issues.find(
    (item) => item.code === 'invalid-date',
  );
  assert.equal(issue.field, 'dateOfBirth');
});

check('names the other record on each side of a duplicate email', () => {
  const second = { ...base, id: 'emp_002', employeeId: 'EMP-0002', fullName: 'Grace Hopper', officialEmail: 'grace@acme.test', phone: '(415) 555-0199', personalEmail: 'ada@acme.test' };
  const { issues } = run(world([base, second])).data;
  const dupes = issues.filter((issue) => issue.code === 'duplicate-email');
  assert.deepEqual(dupes.map((issue) => [issue.employeeId, issue.relatedIds]).sort(), [
    ['emp_001', ['emp_002']],
    ['emp_002', ['emp_001']],
  ]);
});

check('flags the same person entered twice, whatever the contact details', () => {
  const twin = { ...base, id: 'emp_002', employeeId: 'EMP-0002', officialEmail: 'ada2@acme.test', personalEmail: 'ada2@home.test', phone: '(415) 555-0177' };
  const issue = run(world([base, twin])).data.issues.find((item) => item.code === 'possible-duplicate-record');
  assert.deepEqual(issue.relatedIds, ['emp_002']);
});

check('flags a team that is not part of the record\'s department', () => {
  const issue = run(world([{ ...base, teamId: 'dep_06', departmentId: 'dep_03', designationId: 'des_1' }])).data.issues.find(
    (item) => item.code === 'team-department-mismatch',
  );
  assert.equal(issue.field, 'teamId');
});

check('notes what is missing from a record that still works, as low severity', () => {
  const { issues } = run(world([{ ...base, presentAddress: '', emergencyContact: { name: '', phone: '' } }])).data;
  assert.deepEqual(
    issues.map((issue) => [issue.code, issue.severity, issue.field]),
    [
      ['incomplete-record', 'low', 'presentAddress'],
      ['incomplete-record', 'low', 'emergencyContact'],
    ],
  );
});

check('checks one record when asked, but still finds its duplicates among all', () => {
  const second = { ...base, id: 'emp_002', employeeId: 'EMP-0002', fullName: 'Grace Hopper', officialEmail: 'grace@acme.test', phone: '(415) 555-0199', personalEmail: 'ada@acme.test' };
  const { issues } = run(world([base, second]), { employeeId: 'emp_002' }).data;
  assert.ok(issues.every((issue) => issue.employeeId === 'emp_002'));
  assert.ok(issues.some((issue) => issue.code === 'duplicate-email'));
});

console.log(`data-quality: ${passed} checks passed`);
