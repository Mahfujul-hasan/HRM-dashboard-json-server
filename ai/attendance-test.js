/**
 * Checks for the attendance AI. Run: `node ai/attendance-test.js`.
 *
 * Synthetic people pin down each rule — every flag, the working calendar, the comparison with
 * the previous period, the data check's verdict — and the real seed is run through all three
 * tools to prove they hold together on data nobody arranged for them.
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const registry = require('./registry');
const helpers = require('./helpers');
const model = require('./attendance-model');
const { route } = require('./router');
const { deriveMinutes, deriveStatus } = require('../seed/attendance-rules');

const NOW = new Date('2026-11-30T09:00:00Z');
const insight = registry.get('attendance-insight');
const trend = registry.get('attendance-trend-explainer');
const dataCheck = registry.get('attendance-data-check');

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

const settings = {
  work: { workingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], workingHours: { start: '09:00', end: '18:00' }, breakMinutes: 60 },
  attendance: {
    graceMinutes: 10,
    halfDayAfterMinutes: 240,
    fullDayMinutes: 480,
    overtimeEnabled: true,
    overtimeAfterMinutes: 30,
  },
};

const weekday = (date) => ![0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());
const days = (from, to) => {
  const out = [];
  for (let date = from; date <= to; date = helpers.ymd(helpers.addDays(date, 1))) out.push(date);
  return out;
};

let counter = 0;
/** A record whose minutes and status follow from its punches, as the dashboard would store it. */
function record(employeeId, date, checkIn = '09:00', checkOut = '18:00', over = {}) {
  const base = { id: `att_${(counter += 1)}`, employeeId, date, checkIn, checkOut, corrected: false };
  const derived = deriveMinutes(base, settings);
  return { ...base, ...derived, leaveRequestId: null, status: deriveStatus(derived, settings), ...over };
}

/** A normal day on every working day of a span, with overrides by date. */
function fill(employeeId, from, to, special = {}) {
  return days(from, to)
    .filter(weekday)
    .filter((date) => !(date in special) || special[date] !== null)
    .map((date) => (special[date] ? special[date](date) : record(employeeId, date)));
}

const person = (id, over = {}) => ({
  id,
  fullName: `Person ${id.toUpperCase()}`,
  lastName: id.toUpperCase(),
  employeeId: `EMP-${id}`,
  departmentId: 'dep_1',
  locationId: 'loc_1',
  joiningDate: '2020-01-01',
  status: 'active',
  ...over,
});

function makeDb(parts) {
  const db = {
    settings,
    employees: [],
    attendance: [],
    holidays: [],
    departments: [
      { id: 'dep_1', name: 'Engineering', parentId: null },
      { id: 'dep_2', name: 'Finance', parentId: null },
    ],
    ...parts,
  };
  return {
    get: (name) => JSON.parse(JSON.stringify(db[name] || [])),
    byId: (name, id) => (db[name] || []).find((row) => row.id === id) || null,
  };
}

const run = (engine, db, input = {}) =>
  engine.run({ input, db, settings, now: NOW, helpers, tools: [] });

const CURRENT = { from: '2026-11-02', to: '2026-11-20' };
const BEFORE = ['2026-10-14', '2026-11-01'];

/* ------------------------------- the people ------------------------------- */

const late = (id, dates) => Object.fromEntries(dates.map((d) => [d, (date) => record(id, date, '09:40', '18:40')]));

const people = [
  person('a'), // late on 6 of 15 days
  person('b'), // late on 2 of 15: under every threshold
  person('c'), // absent on Mon 2, Mon 9, Tue 17: two next to a weekend
  person('d'), // a lot of overtime
  person('e'), // never late before, late three days in the last week
  person('f'), // a mess of record errors
  person('g', { joiningDate: '2026-11-10' }), // joined mid-period
  person('h'), // clean, and a holiday falls in the period
  person('j', { departmentId: 'dep_2' }), // finance: fine before, absent a lot now
];

const holiday = { id: 'hol_1', name: 'Founders Day', date: '2026-11-11', type: 'public', locationIds: [] };

const attendance = [
  ...fill('a', BEFORE[0], CURRENT.to, late('a', ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-09'])),
  ...fill('b', BEFORE[0], CURRENT.to, late('b', ['2026-11-02', '2026-11-03'])),
  ...fill('c', BEFORE[0], CURRENT.to, {
    '2026-11-02': (d) => record('c', d, null, null, { status: 'absent', workedMinutes: 0, lateMinutes: 0, overtimeMinutes: 0 }),
    '2026-11-09': (d) => record('c', d, null, null, { status: 'absent', workedMinutes: 0, lateMinutes: 0, overtimeMinutes: 0 }),
    '2026-11-17': (d) => record('c', d, null, null, { status: 'absent', workedMinutes: 0, lateMinutes: 0, overtimeMinutes: 0 }),
  }),
  ...fill(
    'd',
    BEFORE[0],
    CURRENT.to,
    Object.fromEntries(days(CURRENT.from, CURRENT.to).filter(weekday).map((d) => [d, (date) => record('d', date, '09:00', '22:00')])),
  ),
  ...fill('e', BEFORE[0], CURRENT.to, late('e', ['2026-11-16', '2026-11-17', '2026-11-18'])),
  ...fill('h', BEFORE[0], CURRENT.to, { [holiday.date]: null }),
  ...fill(
    'j',
    BEFORE[0],
    CURRENT.to,
    Object.fromEntries(
      ['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-09'].map((d) => [
        d,
        (date) => record('j', date, null, null, { status: 'absent', workedMinutes: 0, lateMinutes: 0, overtimeMinutes: 0 }),
      ]),
    ),
  ),
  // g: a normal run from the day they joined, and a record from before they joined.
  ...fill('g', '2026-11-10', CURRENT.to),
  record('g', '2026-11-03'),
  // f: records that cannot all be right, and five missing weekdays (the 11th is a holiday).
  ...fill('f', BEFORE[0], CURRENT.to, {
    '2026-11-04': (d) => record('f', d, '18:00', '09:00', { status: 'present', workedMinutes: 0 }), // out before in
    '2026-11-05': (d) => ({ ...record('f', d), status: 'present', checkIn: null, checkOut: null }), // no punches
    '2026-11-06': (d) => ({ ...record('f', d), workedMinutes: 999 }), // minutes that do not follow
    ...Object.fromEntries(['2026-11-09', '2026-11-10', '2026-11-12', '2026-11-13', '2026-11-16'].map((d) => [d, null])),
  }),
  record('f', '2026-11-03'), // a second record for Nov 3
  record('f', '2026-11-07'), // a Saturday
  record('ghost', '2026-11-03'),
];
const dbRows = attendance;

const db = makeDb({ employees: people, attendance: dbRows, holidays: [holiday] });

const flagsOf = (result) => result.data.flags;
const find = (result, code, id) => flagsOf(result).find((item) => item.code === code && item.employeeId === id);

/* ------------------------------ the period ----------------------------- */

check('resolves a period from dates, never past today', () => {
  assert.deepEqual(model.resolvePeriod({ from: '2026-11-02', to: '2026-11-20' }, NOW), { from: '2026-11-02', to: '2026-11-20', length: 19 });
  assert.equal(model.resolvePeriod({ from: '2026-11-02', to: '2027-01-01' }, NOW).to, '2026-11-30');
});

check('resolves the last N days, default 30', () => {
  assert.deepEqual(model.resolvePeriod({}, NOW), { from: '2026-11-01', to: '2026-11-30', length: 30 });
  assert.equal(model.resolvePeriod({ days: 7 }, NOW).from, '2026-11-24');
});

check('refuses a period that cannot be right', () => {
  assert.throws(() => model.resolvePeriod({ from: '2026-11-20', to: '2026-11-02' }, NOW), /starts after/);
  assert.throws(() => model.resolvePeriod({ from: 'last tuesday' }, NOW), /YYYY-MM-DD/);
  assert.throws(() => model.resolvePeriod({ from: '2024-01-01', to: '2026-11-30' }, NOW), /366/);
});

check('the previous period is the same length, just before', () => {
  assert.deepEqual(model.previousPeriod({ from: '2026-11-02', length: 19 }), { from: '2026-10-14', to: '2026-11-01', length: 19 });
});

/* ---------------------------- behaviour flags -------------------------- */

const result = run(insight, db, CURRENT);

check('flags frequent lateness, with the dates and the number', () => {
  const item = find(result, 'frequent-late', 'a');
  assert.ok(item);
  assert.equal(item.severity, 'medium');
  assert.equal(item.dates.length, 6);
  assert.match(item.message, /6 of 15/);
  assert.match(item.message, /40%/);
});

check('leaves alone someone late twice', () => {
  assert.equal(flagsOf(result).filter((item) => item.employeeId === 'b').length, 0);
});

check('flags frequent absence and the pattern around days off', () => {
  assert.ok(find(result, 'frequent-absence', 'c'));
  const pattern = find(result, 'absence-pattern', 'c');
  assert.ok(pattern);
  assert.deepEqual(pattern.dates, ['2026-11-02', '2026-11-09']);
});

check('flags excessive overtime, high past 45 hours', () => {
  const item = find(result, 'excessive-overtime', 'd');
  assert.ok(item);
  assert.equal(item.severity, 'high');
});

check('flags a rise in lateness against the previous period', () => {
  const item = find(result, 'late-increase', 'e');
  assert.ok(item, 'late-increase');
  assert.match(item.message, /up from 0%/);
  // A person already over the threshold is flagged once, as frequently late.
  assert.equal(find(result, 'late-increase', 'a'), undefined);
});

check('every flag has a stable key, a severity and a kind', () => {
  const keys = flagsOf(result).map((item) => item.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const item of flagsOf(result)) {
    assert.match(item.key, new RegExp(`^${item.code}\\|`));
    assert.ok(item.key.endsWith('|2026-11-02|2026-11-20'));
    assert.ok(['high', 'medium', 'low'].includes(item.severity));
    assert.ok(['behaviour', 'data'].includes(item.kind));
  }
  assert.deepEqual(keys, run(insight, db, CURRENT).data.flags.map((item) => item.key));
});

check('lists the worst first', () => {
  const order = { high: 0, medium: 1, low: 2 };
  const severities = flagsOf(result).map((item) => order[item.severity]);
  assert.deepEqual(severities, [...severities].sort((a, b) => a - b));
});

check('never decides: it only flags', () => {
  assert.equal(result.data.decisionAllowed, false);
  assert.match(result.output, /Confirm or dismiss/);
});

/* ------------------------------- data errors ----------------------------- */

check('finds a second record for the same day', () => {
  assert.deepEqual(find(result, 'duplicate-record', 'f').dates, ['2026-11-03']);
});

check('finds punches that go out before they come in', () => {
  assert.deepEqual(find(result, 'invalid-punches', 'f').dates, ['2026-11-04']);
});

check('finds a status that does not fit the punches', () => {
  assert.deepEqual(find(result, 'status-mismatch', 'f').dates, ['2026-11-05']);
});

check('finds minutes that do not follow from the punches', () => {
  assert.deepEqual(find(result, 'minutes-mismatch', 'f').dates, ['2026-11-06']);
});

check('finds a record dated before someone joined', () => {
  assert.deepEqual(find(result, 'outside-employment', 'g').dates, ['2026-11-03']);
});

check('finds days that were expected and are missing, high when it is a third or more', () => {
  const item = find(result, 'missing-records', 'f');
  assert.deepEqual(item.dates, ['2026-11-09', '2026-11-10', '2026-11-12', '2026-11-13', '2026-11-16']);
  assert.equal(item.severity, 'high');
});

check('one missing day is not an emergency, however large a share of a short stay', () => {
  const fresh = makeDb({
    employees: [person('x', { joiningDate: '2026-11-20' })],
    attendance: [],
  });
  const [one] = run(dataCheck, fresh, CURRENT).data.flags;
  assert.equal(one.code, 'missing-records');
  assert.equal(one.severity, 'low');
  assert.equal(run(dataCheck, fresh, CURRENT).data.ready, false);
});

check('a record on a weekend is for the data check, not an alarm', () => {
  assert.equal(find(result, 'day-off-record', 'f'), undefined);
  const checked = run(dataCheck, db, CURRENT);
  assert.deepEqual(find(checked, 'day-off-record', 'f').dates, ['2026-11-07', '2026-11-11']);
  assert.equal(find(checked, 'day-off-record', 'f').severity, 'low');
});

check('records for someone who does not exist are found, but not when looking at one person', () => {
  const checked = run(dataCheck, db, CURRENT);
  const ghost = flagsOf(checked).find((item) => item.code === 'unknown-employee');
  assert.ok(ghost);
  assert.equal(ghost.severity, 'high');
  assert.equal(flagsOf(run(dataCheck, db, { ...CURRENT, employeeId: 'a' })).find((item) => item.code === 'unknown-employee'), undefined);
});

/* --------------------------- the working calendar ------------------------ */

check('a holiday is not an expected day', () => {
  const [h] = model.buildModel({ db, settings, period: model.resolvePeriod(CURRENT, NOW), now: NOW, employeeId: 'h' }).people;
  assert.ok(!h.expected.includes('2026-11-11'));
  assert.equal(h.expected.length, 14);
  assert.equal(h.missing.length, 0);
});

check('nobody is expected before they joined', () => {
  const [g] = model.buildModel({ db, settings, period: model.resolvePeriod(CURRENT, NOW), now: NOW, employeeId: 'g' }).people;
  assert.equal(g.expected[0], '2026-11-10');
  assert.equal(g.missing.length, 0);
});

check('nobody is expected after their last working day', () => {
  const left = makeDb({
    employees: [person('x', { status: 'resigned', exit: { lastWorkingDate: '2026-11-06' } })],
    attendance: fill('x', '2026-11-02', '2026-11-06'),
  });
  const [x] = model.buildModel({ db: left, settings, period: model.resolvePeriod(CURRENT, NOW), now: NOW }).people;
  assert.equal(x.expected.length, 5);
  assert.equal(x.missing.length, 0);
});

check('a withdrawn resignation does not make someone leave', () => {
  const stayed = makeDb({
    employees: [person('x', { status: 'active', exit: { lastWorkingDate: '2026-11-06' } })],
    attendance: [],
  });
  const [x] = model.buildModel({ db: stayed, settings, period: model.resolvePeriod(CURRENT, NOW), now: NOW }).people;
  assert.equal(x.expected.length, 15);
});

check('an optional holiday is still a working day', () => {
  const optional = makeDb({
    employees: [person('x')],
    attendance: [],
    holidays: [{ ...holiday, type: 'optional' }],
  });
  const [x] = model.buildModel({ db: optional, settings, period: model.resolvePeriod({ from: '2026-11-09', to: '2026-11-13' }, NOW), now: NOW }).people;
  assert.ok(x.expected.includes('2026-11-11'));
});

check('a holiday for another location does not apply', () => {
  const elsewhere = makeDb({
    employees: [person('x', { locationId: 'loc_1' })],
    attendance: [],
    holidays: [{ ...holiday, locationIds: ['loc_2'] }],
  });
  const [x] = model.buildModel({ db: elsewhere, settings, period: model.resolvePeriod({ from: '2026-11-09', to: '2026-11-13' }, NOW), now: NOW }).people;
  assert.ok(x.expected.includes('2026-11-11'));
});

/* ----------------------------- the filters ------------------------------ */

check('filters by department', () => {
  const finance = run(insight, db, { ...CURRENT, departmentId: 'dep_2' });
  assert.ok(flagsOf(finance).every((item) => item.departmentId === 'dep_2'));
  assert.ok(find(finance, 'frequent-absence', 'j'));
});

check('filters by employee', () => {
  const one = run(insight, db, { ...CURRENT, employeeId: 'c' });
  assert.ok(flagsOf(one).every((item) => item.employeeId === 'c'));
});

check('refuses a filter that matches nobody', () => {
  assert.throws(() => run(insight, db, { ...CURRENT, employeeId: 'nobody' }), /No employees match/);
});

check('reports an empty period honestly, with a low confidence', () => {
  const empty = run(insight, makeDb({ employees: [person('x')], attendance: [] }), CURRENT);
  assert.equal(empty.data.empty, true);
  assert.ok(empty.confidence <= 0.3);
  assert.match(empty.output, /no attendance records/i);
});

/* ----------------------------- trend explainer -------------------------- */

const explained = run(trend, db, CURRENT);

check('explains the trend in sentences against the previous period', () => {
  assert.match(explained.output, /Attendance was \d+%/);
  assert.match(explained.output, /previous 19 days/);
  assert.deepEqual(explained.data.previous, { from: '2026-10-14', to: '2026-11-01' });
});

check('names the department that slipped', () => {
  assert.match(explained.output, /Finance slipped the most/);
  const finance = explained.data.departments.find((item) => item.name === 'Finance');
  assert.ok(finance.change < 0);
});

check('says there is nothing to compare with when there is not', () => {
  const joined = run(trend, db, { ...CURRENT, employeeId: 'g' });
  assert.match(joined.output, /no earlier period/i);
  assert.equal(joined.data.previous, null);
});

check('does not say why', () => {
  assert.match(explained.output, /does not say why/);
  assert.equal(explained.data.decisionAllowed, false);
});

check('warns when many expected days are unrecorded', () => {
  assert.match(run(trend, db, { ...CURRENT, employeeId: 'f' }).output, /of expected days have a record/);
});

/* ----------------------------- the data check ---------------------------- */

check('says a clean, complete period is ready', () => {
  const clean = run(dataCheck, db, { ...CURRENT, employeeId: 'b' });
  assert.equal(clean.data.ready, true);
  assert.match(clean.output, /looks ready/);
  assert.equal(clean.data.coverage, 1);
});

check('says a period with serious errors is not', () => {
  const messy = run(dataCheck, db, { ...CURRENT, employeeId: 'f' });
  assert.equal(messy.data.ready, false);
  assert.match(messy.output, /Not ready yet/);
  assert.ok(messy.data.counts['duplicate-record'] >= 1);
});

check('says a period with a lot unrecorded is not ready, even without errors', () => {
  const gaps = makeDb({ employees: [person('x')], attendance: fill('x', '2026-11-02', '2026-11-13') });
  const gappy = run(dataCheck, gaps, CURRENT);
  assert.equal(gappy.data.ready, false);
  assert.match(gappy.output, /of expected days are recorded/);
});

check('lists the data problems and not the behaviour', () => {
  const checked = run(dataCheck, db, CURRENT);
  assert.ok(flagsOf(checked).every((item) => item.kind === 'data'));
});

/* ------------------------------- routing -------------------------------- */

const ctx = { db: db, now: NOW };
const routed = (message) => route({ message, db: { get: (n) => db.get(n) }, now: NOW }).toolId;

check('routes the three attendance questions to their tools', () => {
  assert.equal(routed('Explain the attendance trend this month'), 'attendance-trend-explainer');
  assert.equal(routed('Is the attendance data ready for the report?'), 'attendance-data-check');
  assert.equal(routed('Any attendance anomalies in the last 14 days?'), 'attendance-insight');
  void ctx;
});

check('a named month becomes the period', () => {
  const choice = route({ message: 'Attendance anomalies for 2026-10', db: { get: (n) => db.get(n) }, now: NOW });
  assert.equal(choice.input.from, '2026-10-01');
  assert.equal(choice.input.to, '2026-10-31');
});

/* ------------------------------- the real seed -------------------------- */

const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'db.json');
if (fs.existsSync(DB_FILE)) {
  const seed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  const real = {
    get: (name) => JSON.parse(JSON.stringify(seed[name] || [])),
    byId: (name, id) => (seed[name] || []).find((row) => row.id === id) || null,
  };
  const now = new Date('2026-11-17T09:00:00Z');
  const ask = (engine, input) =>
    engine.run({ input, db: real, settings: seed.settings, now, helpers, tools: [] });

  for (const days of [14, 30, 90, 365]) {
    check(`all three tools run over the last ${days} days of the seed`, () => {
      for (const engine of [insight, trend, dataCheck]) {
        const out = ask(engine, { days });
        assert.ok(out.output.length > 0);
        assert.ok(out.sources.length > 0);
        assert.ok(out.confidence > 0 && out.confidence < 1);
        const keys = out.data.flags.map((item) => item.key);
        assert.equal(new Set(keys).size, keys.length, 'flag keys are unique');
        for (const item of out.data.flags) {
          assert.ok(item.code && item.severity && item.message);
          for (const date of item.dates) assert.ok(date >= out.data.from && date <= out.data.to, `${item.key} ${date}`);
        }
      }
    });
  }

  check('the seed has no weekend, holiday or out-of-employment records to find', () => {
    const out = ask(dataCheck, { days: 365 });
    for (const code of ['duplicate-record', 'invalid-punches', 'minutes-mismatch', 'outside-employment', 'unknown-employee']) {
      assert.equal(out.data.counts[code] || 0, 0, code);
    }
  });
}

console.log(`${passed} attendance AI checks passed${process.exitCode ? ' (with failures)' : ''}`);
