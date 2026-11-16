/**
 * Checks the employee search against a small hand-made company, then against the seeded one.
 * Run with `node search-test.js` (part of `npm test`).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildEmployeeSearch, createSearchMiddleware } = require('./search');

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

const state = {
  departments: [
    { id: 'dep_eng', name: 'Engineering' },
    { id: 'team_fe', name: 'Frontend' },
    { id: 'dep_hr', name: 'People' },
  ],
  designations: [
    { id: 'des_se', title: 'Senior Software Engineer' },
    { id: 'des_hr', title: 'HR Partner' },
  ],
  locations: [
    { id: 'loc_sf', name: 'San Francisco HQ', city: 'San Francisco' },
    { id: 'loc_ny', name: 'New York Office', city: 'New York' },
  ],
  employees: [
    {
      id: 'emp_1', employeeId: 'EMP-0001', fullName: 'Ada Lovelace', status: 'active', employmentType: 'full-time',
      workMode: 'remote', gender: 'female', officialEmail: 'ada@acme.test', personalEmail: 'ada@home.test',
      phone: '(208) 897-4563', departmentId: 'dep_eng', teamId: 'team_fe', designationId: 'des_se', locationId: 'loc_sf',
      skills: ['TypeScript', 'React'],
    },
    {
      id: 'emp_2', employeeId: 'EMP-0002', fullName: 'Grace Hopper', status: 'inactive', employmentType: 'contract',
      workMode: 'on-site', gender: 'female', officialEmail: 'grace@acme.test', personalEmail: 'grace@home.test',
      phone: '555.010.2222', departmentId: 'dep_hr', teamId: null, designationId: 'des_hr', locationId: 'loc_ny',
      skills: ['Recruiting'],
    },
    {
      id: 'emp_3', employeeId: 'EMP-0003', fullName: 'Alan Turing', status: 'probation', employmentType: 'full-time',
      workMode: 'hybrid', gender: 'male', officialEmail: 'alan@acme.test', personalEmail: 'alan@home.test',
      phone: '+1 555 010 3333', departmentId: 'dep_eng', teamId: null, designationId: 'des_se', locationId: 'loc_ny',
      skills: ['Cryptography'],
    },
  ],
};

const ids = buildEmployeeSearch(state);

check('finds by name, case-insensitively', () => assert.deepStrictEqual(ids('LOVELACE'), ['emp_1']));
check('finds by employee code', () => assert.deepStrictEqual(ids('emp-0002'), ['emp_2']));
check('finds by email', () => assert.deepStrictEqual(ids('grace@home'), ['emp_2']));
check('finds by department name', () => assert.deepStrictEqual(ids('engineering'), ['emp_1', 'emp_3']));
check('finds by team name', () => assert.deepStrictEqual(ids('frontend'), ['emp_1']));
check('finds by designation title', () => assert.deepStrictEqual(ids('hr partner'), ['emp_2']));
check('finds by location', () => assert.deepStrictEqual(ids('new york'), ['emp_2', 'emp_3']));
check('finds by skill', () => assert.deepStrictEqual(ids('cryptography'), ['emp_3']));

check('finds a phone number whatever format it was typed in', () => {
  assert.deepStrictEqual(ids('897-4563'), ['emp_1']);
  assert.deepStrictEqual(ids('2088974563'), ['emp_1']);
  assert.deepStrictEqual(ids('(555) 010'), ['emp_2', 'emp_3']);
});

check('matches digits across phone punctuation only from three digits up', () => {
  // "(208) 897" holds the digits 088 but not the text "088"; "88" is too short to look through formatting.
  assert.deepStrictEqual(ids('088'), ['emp_1']);
  assert.deepStrictEqual(ids('88'), []);
});

check('requires every word to match somewhere', () => {
  assert.deepStrictEqual(ids('ada engineering'), ['emp_1']);
  assert.deepStrictEqual(ids('ada people'), []);
  assert.deepStrictEqual(ids('senior new york'), ['emp_3']);
});

check('matches status as a whole word, so "active" does not find the inactive', () => {
  assert.deepStrictEqual(ids('active'), ['emp_1']);
  assert.deepStrictEqual(ids('inactive'), ['emp_2']);
  assert.deepStrictEqual(ids('probation'), ['emp_3']);
});

check('matches gender as a whole word, so "male" does not find the female', () => {
  assert.deepStrictEqual(ids('male'), ['emp_3']);
  assert.deepStrictEqual(ids('female'), ['emp_1', 'emp_2']);
});

check('matches employment type and work mode', () => {
  assert.deepStrictEqual(ids('contract'), ['emp_2']);
  assert.deepStrictEqual(ids('hybrid'), ['emp_3']);
});

check('returns null for a blank query, meaning "no search"', () => {
  assert.strictEqual(ids(''), null);
  assert.strictEqual(ids('   '), null);
});

check('copes with a record whose department or designation no longer exists', () => {
  const broken = buildEmployeeSearch({ employees: [{ id: 'emp_x', fullName: 'Orphan', departmentId: 'gone' }] });
  assert.deepStrictEqual(broken('orphan'), ['emp_x']);
  assert.deepStrictEqual(broken('engineering'), []);
});

/* ------------------------------ the middleware ----------------------------- */

function run(req) {
  const middleware = createSearchMiddleware({ db: { getState: () => state } });
  let called = false;
  middleware({ method: 'GET', path: '/employees', query: {}, ...req }, {}, () => {
    called = true;
  });
  assert.ok(called, 'next() must always be called');
  return req.query;
}

check('middleware swaps q for an id filter json-server can OR', () => {
  const query = { q: 'engineering', _page: '1' };
  run({ query });
  assert.strictEqual(query.q, undefined);
  assert.deepStrictEqual(query.id, ['emp_1', 'emp_3']);
  assert.strictEqual(query._page, '1', 'other parameters are left alone');
});

check('middleware filters to nothing, not to everything, when nothing matches', () => {
  const query = { q: 'zzzz' };
  run({ query });
  assert.deepStrictEqual(query.id, ['__no-match__']);
});

check('middleware leaves other collections and methods alone', () => {
  const other = { q: 'engineering' };
  run({ path: '/departments', query: other });
  assert.strictEqual(other.q, 'engineering');

  const post = { q: 'engineering' };
  run({ method: 'POST', query: post });
  assert.strictEqual(post.q, 'engineering');
});

check('middleware leaves a request with no search alone', () => {
  const query = { _page: '1' };
  run({ query });
  assert.deepStrictEqual(query, { _page: '1' });
});

/* ------------------------------ the seeded company ------------------------- */

const DB = path.join(__dirname, 'db.json');
if (fs.existsSync(DB)) {
  const seeded = JSON.parse(fs.readFileSync(DB, 'utf8'));
  const search = buildEmployeeSearch(seeded);

  check('seed: a department name finds exactly that department\'s people', () => {
    const department = seeded.departments.find((d) => !d.parentId && d.name === 'Engineering');
    const expected = seeded.employees.filter((e) => e.departmentId === department.id).map((e) => e.id);
    const found = search('Engineering');
    for (const id of expected) assert.ok(found.includes(id), `${id} is in Engineering but was not found`);
  });

  check('seed: a designation title finds the people who hold it', () => {
    const held = seeded.designations.find((d) => seeded.employees.some((e) => e.designationId === d.id));
    const expected = seeded.employees.filter((e) => e.designationId === held.id).map((e) => e.id);
    const found = search(held.title);
    for (const id of expected) assert.ok(found.includes(id), `${id} holds "${held.title}" but was not found`);
  });

  check('seed: every employee can be found by their own full name', () => {
    for (const employee of seeded.employees) {
      assert.ok(search(employee.fullName).includes(employee.id), `${employee.fullName} not found by name`);
    }
  });

  check('seed: every employee can be found by their own phone, however it is written', () => {
    for (const employee of seeded.employees.filter((e) => digitsOf(e.phone).length >= 7)) {
      assert.ok(search(digitsOf(employee.phone)).includes(employee.id), `${employee.id} not found by phone digits`);
    }
  });
}

function digitsOf(value) {
  return String(value || '').replace(/\D/g, '');
}

if (!process.exitCode) console.log(`All ${passed} search case(s) passed.`);
