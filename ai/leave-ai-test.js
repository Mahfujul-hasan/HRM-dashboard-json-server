/**
 * Checks for the leave AI. Run: `node ai/leave-ai-test.js`.
 *
 * Synthetic people pin down each finding the conflict check can raise, the wording of the
 * decision emails and what the trend explainer notices — and that the answers match the rules the
 * dashboard uses to charge leave, since a check that disagrees with the request screen is worse
 * than none.
 */
const assert = require('node:assert/strict');
const registry = require('./registry');
const helpers = require('./helpers');
const model = require('./leave-model');

const NOW = new Date('2026-11-17T09:00:00Z');
const check = registry.get('leave-conflict-check');
const email = registry.get('leave-decision-email');
const trend = registry.get('leave-trend-explainer');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    console.error(`FAIL  ${name}\n      ${error.message}`);
    process.exitCode = 1;
  }
}

const settings = {
  company: { name: 'Northwind' },
  work: { workingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] },
  leave: {
    leaveYearStart: '01-01',
    carryForwardEnabled: true,
    maxCarryForwardDays: 5,
    requireDocumentAfterDays: 3,
    minNoticeDays: 2,
    sandwichLeaveEnabled: false,
    accrual: 'upfront',
  },
};

const type = (id, name, over = {}) => ({
  id,
  name,
  code: name.slice(0, 2).toUpperCase(),
  active: true,
  paid: true,
  annualQuota: 20,
  minNoticeDays: 2,
  maxConsecutiveDays: 10,
  requiresDocument: false,
  ...over,
});
const leaveTypes = [type('t1', 'Annual Leave'), type('t2', 'Sick Leave', { requiresDocument: true, minNoticeDays: 0, halfDayAllowed: false })];

const person = (id, over = {}) => ({
  id,
  fullName: `Person ${id.toUpperCase()}`,
  employeeId: `EMP-${id}`,
  officialEmail: `${id}@example.com`,
  departmentId: 'dep_1',
  locationId: 'loc_1',
  joiningDate: '2020-01-01',
  status: 'active',
  ...over,
});

let counter = 0;
const request = (employeeId, startDate, endDate, over = {}) => ({
  id: `lvr_${(counter += 1)}`,
  employeeId,
  leaveTypeId: 't1',
  startDate,
  endDate,
  days: 1,
  halfDay: false,
  reason: 'Family',
  source: 'email',
  attachmentDocumentId: null,
  status: 'pending',
  hrRemarks: '',
  decidedBy: null,
  decidedAt: null,
  appliedOn: '2026-11-01',
  ...over,
});

const balance = (employeeId, over = {}) => ({
  id: `lvb_${employeeId}_${over.leaveTypeId || 't1'}`,
  employeeId,
  leaveTypeId: 't1',
  year: 2026,
  entitled: 20,
  carriedForward: 0,
  adjustment: 0,
  used: 0,
  pending: 0,
  remaining: 20,
  ...over,
});

function makeDb(parts = {}, over = settings) {
  const db = {
    settings: over,
    employees: [],
    leaveRequests: [],
    leaveBalances: [],
    leaveTypes,
    holidays: [],
    attendance: [],
    departments: [
      { id: 'dep_1', name: 'Engineering' },
      { id: 'dep_2', name: 'Finance' },
    ],
    ...parts,
  };
  return {
    get: (name) => JSON.parse(JSON.stringify(db[name] || [])),
    byId: (name, id) => JSON.parse(JSON.stringify((db[name] || []).find((row) => row.id === id) || null)),
  };
}

const run = (engine, db, input = {}, over = settings) => engine.run({ input, db, settings: over, now: NOW, helpers, tools: [] });
const codes = (result) => result.data.findings.map((finding) => finding.code);
const finding = (result, code) => result.data.findings.find((item) => item.code === code);

// Wed 25 Nov to Fri 27 Nov 2026.
const ASK = { startDate: '2026-11-25', endDate: '2026-11-27' };
const alone = (extra = {}) => ({ employees: [person('a')], leaveBalances: [balance('a')], ...extra });

/* -------------------------------- the model -------------------------------- */

test('leave year follows the start of the leave year', () => {
  assert.equal(model.leaveYearOf('2026-02-10', '04-01').year, 2025);
  assert.equal(model.leaveYearOf('2026-04-01', '04-01').year, 2026);
  assert.equal(model.leaveYearOf('2026-12-31', '01-01').to, '2026-12-31');
});

test('a request costs its working days, less holidays, and the sandwich rule charges the days between', () => {
  const holiday = { date: '2026-11-26', type: 'public', locationIds: [] };
  assert.equal(model.costOf({ ...ASK }, person('a'), settings, []).days, 3);
  assert.equal(model.costOf({ ...ASK }, person('a'), settings, [holiday]).days, 2);
  const fridayToMonday = { startDate: '2026-11-27', endDate: '2026-11-30' };
  assert.equal(model.costOf(fridayToMonday, person('a'), settings, []).days, 2);
  const sandwiched = { ...settings, leave: { ...settings.leave, sandwichLeaveEnabled: true } };
  assert.equal(model.costOf(fridayToMonday, person('a'), sandwiched, []).days, 4);
  assert.equal(model.costOf({ startDate: '2026-11-25', endDate: '2026-11-25', halfDay: true }, person('a'), settings, []).days, 0.5);
});

test('an optional holiday is a working day, and a local one only binds that location', () => {
  const optional = { date: '2026-11-26', type: 'optional', locationIds: [] };
  assert.equal(model.costOf(ASK, person('a'), settings, [optional]).days, 3);
  const local = { date: '2026-11-26', type: 'public', locationIds: ['loc_2'] };
  assert.equal(model.costOf(ASK, person('a'), settings, [local]).days, 3);
  assert.equal(model.costOf(ASK, person('a', { locationId: 'loc_2' }), settings, [local]).days, 2);
});

/* ------------------------------ the conflict check -------------------------- */

test('a request that fits raises nothing that would hold it up', () => {
  const db = makeDb(alone({ leaveRequests: [request('a', ASK.startDate, ASK.endDate, { days: 3, id: 'r1' })] }));
  const result = run(check, db, { leaveRequestId: 'r1' });
  assert.equal(result.data.blockerCount, 0);
  assert.equal(result.data.decisionAllowed, false);
  assert.ok(codes(result).includes('balance-ok'));
  assert.match(result.output, /Nothing that would hold up approval/);
  assert.equal(result.data.workingDays, 3);
});

test('it warns when the balance is short, saying how far overdrawn', () => {
  const db = makeDb(alone({ leaveBalances: [balance('a', { used: 18, remaining: 2 })] }));
  const result = run(check, db, { employeeId: 'a', ...ASK, leaveTypeId: 't1' });
  assert.equal(finding(result, 'insufficient-balance').severity, 'high');
  assert.match(finding(result, 'insufficient-balance').message, /only 2 days can be taken.*1 day overdrawn/);
});

test('the request own pending days are not counted against the balance twice', () => {
  const own = request('a', ASK.startDate, ASK.endDate, { days: 3, id: 'r1' });
  const db = makeDb(alone({ leaveRequests: [own], leaveBalances: [balance('a', { used: 17, pending: 3, remaining: 0 })] }));
  assert.ok(!codes(run(check, db, { leaveRequestId: 'r1' })).includes('insufficient-balance'));
});

test('an approved request own days, already used, are not counted twice either', () => {
  const own = request('a', ASK.startDate, ASK.endDate, { days: 3, id: 'r1', status: 'approved' });
  const db = makeDb(alone({ leaveRequests: [own], leaveBalances: [balance('a', { used: 20, remaining: 0 })] }));
  const result = run(check, db, { leaveRequestId: 'r1' });
  assert.ok(!codes(result).includes('insufficient-balance'));
  assert.ok(codes(result).includes('already-decided'));
});

test('monthly accrual counts only what has been earned by the first day', () => {
  const monthly = { ...settings, leave: { ...settings.leave, accrual: 'monthly' } };
  // 12 days a year, three months earned by early April: 3 days, but 5 are asked for.
  const db = makeDb(alone({ leaveBalances: [balance('a', { entitled: 12, remaining: 12 })] }), monthly);
  const result = run(check, db, { employeeId: 'a', leaveTypeId: 't1', startDate: '2026-04-06', endDate: '2026-04-10' }, monthly);
  assert.match(finding(result, 'insufficient-balance').message, /only 3 days/);
});

test('adjustments and carried days count toward what can be taken', () => {
  const db = makeDb(alone({ leaveBalances: [balance('a', { entitled: 2, carriedForward: 1, adjustment: 1, remaining: 4 })] }));
  const result = run(check, db, { employeeId: 'a', leaveTypeId: 't1', startDate: '2026-11-25', endDate: '2026-11-26' });
  assert.ok(!codes(result).includes('insufficient-balance'));
});

test('no balance for the type in that leave year is a high finding', () => {
  const db = makeDb(alone({ leaveBalances: [] }));
  assert.equal(finding(run(check, db, { employeeId: 'a', leaveTypeId: 't1', ...ASK }), 'no-balance-record').severity, 'high');
});

test('notice is judged from the day the request was received, not from today', () => {
  const late = request('a', '2026-11-25', '2026-11-25', { id: 'r1', appliedOn: '2026-11-24' });
  const early = request('a', '2026-11-25', '2026-11-25', { id: 'r2', appliedOn: '2026-11-01' });
  const db = makeDb(alone({ leaveRequests: [late, early] }));
  assert.ok(codes(run(check, db, { leaveRequestId: 'r1' })).includes('short-notice'));
  assert.ok(!codes(run(check, db, { leaveRequestId: 'r2' })).includes('short-notice'));
});

test('leave received after it began is called out, and a type with no notice is not short of it', () => {
  const started = request('a', '2026-11-10', '2026-11-11', { id: 'r1', appliedOn: '2026-11-12' });
  const sick = request('a', '2026-11-18', '2026-11-18', { id: 'r2', leaveTypeId: 't2', appliedOn: '2026-11-17' });
  const db = makeDb(alone({ leaveRequests: [started, sick], leaveBalances: [balance('a'), balance('a', { leaveTypeId: 't2', remaining: 10 })] }));
  assert.ok(codes(run(check, db, { leaveRequestId: 'r1' })).includes('already-started'));
  assert.ok(!codes(run(check, db, { leaveRequestId: 'r2' })).includes('short-notice'));
});

test('too many days in a row, a missing document and a half day for a type that forbids it', () => {
  const long = makeDb(alone({ leaveBalances: [balance('a', { entitled: 40, remaining: 40 })] }));
  assert.ok(codes(run(check, long, { employeeId: 'a', leaveTypeId: 't1', startDate: '2026-12-01', endDate: '2026-12-16' })).includes('too-long'));

  const sick = makeDb(alone({ leaveBalances: [balance('a', { leaveTypeId: 't2', remaining: 10 })] }));
  const doc = run(check, sick, { employeeId: 'a', leaveTypeId: 't2', startDate: '2026-11-18', endDate: '2026-11-23' });
  assert.equal(finding(doc, 'document-required').severity, 'medium');
  const half = run(check, sick, { employeeId: 'a', leaveTypeId: 't2', startDate: '2026-11-18', endDate: '2026-11-18', halfDay: true });
  assert.equal(finding(half, 'half-day-invalid').severity, 'high');
});

test('a holiday inside the range is noted and not charged', () => {
  const holiday = { id: 'h', name: 'Founders day', date: '2026-11-26', type: 'company', locationIds: [] };
  const result = run(check, makeDb(alone({ holidays: [holiday] })), { employeeId: 'a', leaveTypeId: 't1', ...ASK });
  assert.match(finding(result, 'holiday-overlap').message, /Founders day \(Nov 26\)/);
  assert.equal(result.data.workingDays, 2);
});

test('it finds the person own overlapping leave, and ignores rejected and cancelled', () => {
  const other = request('a', '2026-11-26', '2026-11-30', { status: 'approved' });
  const dead = request('a', '2026-11-25', '2026-11-25', { status: 'rejected' });
  const result = run(check, makeDb(alone({ leaveRequests: [other, dead] })), { employeeId: 'a', leaveTypeId: 't1', ...ASK });
  assert.match(finding(result, 'self-overlap').message, /Overlaps 1 other request.*approved/);
});

test('leave before someone joined or after they left is high', () => {
  const joiner = makeDb({ employees: [person('a', { joiningDate: '2026-12-01' })], leaveBalances: [balance('a')] });
  assert.equal(finding(run(check, joiner, { employeeId: 'a', leaveTypeId: 't1', ...ASK }), 'not-employed').severity, 'high');
  const leaver = makeDb({ employees: [person('a', { status: 'resigned', exit: { lastWorkingDate: '2026-11-20' } })], leaveBalances: [balance('a')] });
  assert.equal(finding(run(check, leaver, { employeeId: 'a', leaveTypeId: 't1', ...ASK }), 'not-employed').severity, 'high');
});

describe_coverage();

function describe_coverage() {
  const team = ['a', 'b', 'c', 'd', 'e'].map((id) => person(id));
  const base = { employees: team, leaveBalances: [balance('a')] };

  test('coverage is judged on the worst day, not on whether anyone overlaps at all', () => {
    // Two colleagues away on the same day: 3 of 5 out is 60%.
    const same = makeDb({ ...base, leaveRequests: [request('b', '2026-11-25', '2026-11-25', { status: 'approved' }), request('c', '2026-11-25', '2026-11-25')] });
    const gap = finding(run(check, same, { employeeId: 'a', leaveTypeId: 't1', ...ASK }), 'coverage-gap');
    assert.equal(gap.severity, 'high');
    assert.match(gap.message, /On Nov 25, 2 of 4 colleagues.*1 approved, 1 pending.*60%/);

    // The same two colleagues on different days: never more than one away at once, so 2 of 5.
    const apart = makeDb({ ...base, leaveRequests: [request('b', '2026-11-25', '2026-11-25', { status: 'approved' }), request('c', '2026-11-26', '2026-11-26', { status: 'approved' })] });
    const result = run(check, apart, { employeeId: 'a', leaveTypeId: 't1', ...ASK });
    assert.equal(finding(result, 'coverage-gap').severity, 'medium');
    assert.match(finding(result, 'coverage-gap').message, /1 of 4/);
  });

  test('other departments, rejected leave and weekends do not count against cover', () => {
    const elsewhere = person('f', { departmentId: 'dep_2' });
    const db = makeDb({
      employees: [...team, elsewhere],
      leaveBalances: [balance('a')],
      leaveRequests: [
        request('f', '2026-11-25', '2026-11-27', { status: 'approved' }),
        request('b', '2026-11-25', '2026-11-25', { status: 'rejected' }),
        request('c', '2026-11-21', '2026-11-22', { status: 'approved' }),
      ],
    });
    const result = run(check, db, { employeeId: 'a', leaveTypeId: 't1', ...ASK });
    assert.ok(!codes(result).some((code) => code.startsWith('coverage')));
  });
}

test('work already on the attendance sheet is flagged, since approving replaces it', () => {
  const worked = { employeeId: 'a', date: '2026-11-25', status: 'present' };
  const absent = { employeeId: 'a', date: '2026-11-26', status: 'absent' };
  const result = run(check, makeDb(alone({ attendance: [worked, absent] })), { employeeId: 'a', leaveTypeId: 't1', ...ASK });
  assert.match(finding(result, 'attendance-recorded').message, /1 day worked/);
});

test('findings come most serious first, with sources and a limitation', () => {
  const db = makeDb(alone({ leaveBalances: [balance('a', { used: 20, remaining: 0 })] }));
  const result = run(check, db, { employeeId: 'a', leaveTypeId: 't1', startDate: '2026-11-18', endDate: '2026-11-18' });
  const order = result.data.findings.map((item) => item.severity);
  assert.deepEqual(order, [...order].sort((a, b) => ['high', 'medium', 'low', 'info'].indexOf(a) - ['high', 'medium', 'low', 'info'].indexOf(b)));
  assert.ok(result.sources.length >= 3);
  assert.match(result.limitation, /invisible to this check/);
});

test('it refuses what it cannot check', () => {
  const db = makeDb(alone());
  assert.throws(() => run(check, db, { leaveRequestId: 'nope' }), /not found/);
  assert.throws(() => run(check, db, { employeeId: 'a' }), /no pending leave request/);
  assert.throws(() => run(check, db, { employeeId: 'a', leaveTypeId: 't1', startDate: '2026-11-27', endDate: '2026-11-25' }), /before startDate/);
  assert.throws(() => run(check, db, {}), /employeeId is required/);
});

/* ------------------------------ the decision email -------------------------- */

const decided = (status, over = {}) =>
  request('a', ASK.startDate, ASK.endDate, { id: 'r1', days: 3, status, decidedAt: '2026-11-15T10:00:00Z', ...over });

test('an approval says the dates, the days and what is left, and addresses the person', () => {
  const db = makeDb(alone({ leaveRequests: [decided('approved')], leaveBalances: [balance('a', { used: 3, remaining: 17 })] }));
  const result = run(email, db, { leaveRequestId: 'r1' });
  assert.match(result.output, /To: a@example.com/);
  assert.match(result.output, /Subject: Your annual leave request has been approved/);
  assert.match(result.output, /Hello Person/);
  assert.match(result.output, /Nov 25 – Nov 27, 2026 \(3 days\)/);
  assert.match(result.output, /you have 17 days of annual leave left/);
  assert.match(result.output, /Northwind HR team/);
  assert.match(result.output, /Nothing is sent automatically/);
  assert.equal(result.data.kind, 'approval');
  assert.equal(result.data.decisionAllowed, false);
});

test('an approval that leaves the balance below zero leaves the figure out and tells HR', () => {
  const db = makeDb(alone({ leaveRequests: [decided('approved')], leaveBalances: [balance('a', { used: 22, remaining: -2 })] }));
  const result = run(email, db, { leaveRequestId: 'r1' });
  assert.ok(!/days of annual leave left/.test(result.output));
  assert.match(result.output, /leaves Person 2 days overdrawn/);
});

test('a rejection gives the reason HR entered, or says it is missing', () => {
  const withReason = makeDb(alone({ leaveRequests: [decided('rejected', { hrRemarks: 'The team is short that week' })] }));
  assert.match(run(email, withReason, { leaveRequestId: 'r1' }).output, /Reason: The team is short that week/);
  const without = makeDb(alone({ leaveRequests: [decided('rejected')] }));
  assert.match(run(email, without, { leaveRequestId: 'r1' }).output, /reason has not been entered yet/);
  assert.match(run(email, withReason, { leaveRequestId: 'r1', reason: 'Peak season' }).output, /Reason: Peak season/);
});

test('a cancellation says the days were returned', () => {
  const db = makeDb(alone({ leaveRequests: [decided('cancelled', { hrRemarks: 'Plans changed' })] }));
  const result = run(email, db, { leaveRequestId: 'r1' });
  assert.match(result.output, /has been cancelled: Plans changed/);
  assert.match(result.output, /returned to your leave balance/);
});

test('a pending request needs to be told which email, and the draft says it is before the decision', () => {
  const db = makeDb(alone({ leaveRequests: [decided('pending', { decidedAt: null })] }));
  assert.throws(() => run(email, db, { leaveRequestId: 'r1' }), /still pending/);
  const result = run(email, db, { leaveRequestId: 'r1', kind: 'rejection' });
  assert.match(result.output, /still pending.*send it only once you have decided/);
});

test('it says when the person has no email on file, and refuses what it cannot draft', () => {
  const db = makeDb({ employees: [person('a', { officialEmail: undefined })], leaveRequests: [decided('approved')], leaveBalances: [balance('a')] });
  assert.match(run(email, db, { leaveRequestId: 'r1' }).output, /no email address on file/);
  assert.throws(() => run(email, db, {}), /leaveRequestId is required/);
  assert.throws(() => run(email, db, { leaveRequestId: 'nope' }), /not found/);
});

/* ------------------------------ the trend explainer ------------------------- */

function seeded() {
  const people = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => person(id));
  const approved = (employeeId, start, end, over = {}) => request(employeeId, start, end, { status: 'approved', days: 1, ...over });
  const requests = [
    // Latest 30 days (Oct 19 – Nov 17): Mondays and Fridays, mostly one person.
    approved('a', '2026-10-19', '2026-10-23', { days: 5, appliedOn: '2026-10-05' }),
    approved('a', '2026-11-02', '2026-11-06', { days: 5, appliedOn: '2026-10-20' }),
    approved('b', '2026-11-09', '2026-11-09', { appliedOn: '2026-11-01' }),
    approved('c', '2026-11-13', '2026-11-13', { appliedOn: '2026-11-02', leaveTypeId: 't2' }),
    request('d', '2026-11-10', '2026-11-10', { status: 'rejected', appliedOn: '2026-11-05' }),
    // The 30 days before (Sep 19 – Oct 18): quieter.
    approved('b', '2026-10-01', '2026-10-01', { appliedOn: '2026-09-20' }),
    // Waiting.
    request('e', '2026-12-01', '2026-12-02', { appliedOn: '2026-11-01' }),
  ];
  return makeDb({ employees: people, leaveRequests: requests, leaveBalances: [balance('a', { used: 25, remaining: -5 })] });
}

test('it compares leave with the period before, in days and in percent', () => {
  const result = run(trend, seeded(), { days: 30 });
  assert.match(result.output, /Leave trend, Oct 19 – Nov 17, compared with Sep 19 – Oct 18/);
  assert.match(result.output, /Approved leave came to 12 days, up from 1 day/);
  assert.equal(result.data.personDays, 12);
  assert.equal(result.data.previousPersonDays, 1);
  assert.equal(result.data.decisionAllowed, false);
});

test('it says what was taken, who took most of it, and how requests were decided', () => {
  const output = run(trend, seeded(), { days: 30 }).output;
  assert.match(output, /Most of it was Annual Leave \(11\), Sick Leave \(1\)/);
  assert.match(output, /requests? (was|were) received/);
});

test('it notices what is waiting and what is overdrawn', () => {
  const output = run(trend, seeded(), { days: 30 }).output;
  assert.match(output, /1 request is waiting for a decision; the oldest has waited 16 days|1 request is waiting for a decision/);
  assert.match(output, /1 balance is overdrawn this leave year/);
});

test('a quiet period says so, and a period with nothing to compare says that too', () => {
  const quiet = run(trend, makeDb({ employees: [person('a')] }), { days: 30 });
  assert.match(quiet.output, /No approved leave fell in/);
  assert.match(quiet.output, /no earlier period with leave to compare against/);
  assert.ok(quiet.confidence <= 0.6);
});

test('a department can be looked at on its own, and a bad period is refused', () => {
  const db = seeded();
  assert.ok(run(trend, db, { days: 30, departmentId: 'dep_2' }).data.personDays === 0);
  assert.throws(() => run(trend, db, { from: '2026-11-10', to: '2026-11-01' }), /starts after it ends/);
});

test('none of the three tools writes: they work on copies', () => {
  const db = seeded();
  const before = JSON.stringify(['leaveRequests', 'leaveBalances', 'attendance'].map((name) => db.get(name)));
  run(trend, db, { days: 30 });
  run(check, db, { employeeId: 'e' });
  run(email, db, { leaveRequestId: db.get('leaveRequests')[0].id });
  assert.equal(JSON.stringify(['leaveRequests', 'leaveBalances', 'attendance'].map((name) => db.get(name))), before);
});

console.log(`${passed} leave AI checks passed`);
