/**
 * Checks what deciding a leave request changes: `node leave-test.js`.
 *
 * Pure: it plans decisions on plain objects, so it needs no server and no database.
 */

const assert = require('assert');
const { planDecision, leaveYearOf, workingDates } = require('./leave-decision');

let passed = 0;
function test(name, run) {
  try {
    run();
    passed += 1;
  } catch (error) {
    console.error(`FAIL ${name}\n  ${error.message}`);
    process.exitCode = 1;
  }
}

const settings = { work: { workingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] }, leave: { leaveYearStart: '01-01' } };
const NOW = '2026-11-17T09:00:00.000Z';

// Wed 25 Nov to Fri 27 Nov 2026, with Thu 26 a holiday: two working days.
const request = (over = {}) => ({
  id: 'lvr_1',
  employeeId: 'e1',
  leaveTypeId: 't1',
  startDate: '2026-11-25',
  endDate: '2026-11-27',
  days: 2,
  halfDay: false,
  status: 'pending',
  hrRemarks: '',
  ...over,
});
const balance = (over = {}) => ({
  id: 'b1',
  employeeId: 'e1',
  leaveTypeId: 't1',
  year: 2026,
  entitled: 20,
  carriedForward: 0,
  adjustment: 0,
  used: 4,
  pending: 2,
  remaining: 14,
  ...over,
});
const holidays = [{ date: '2026-11-26', locationIds: [] }];
const day = (date, over = {}) => ({
  id: `att_${date}`,
  employeeId: 'e1',
  date,
  status: 'present',
  checkIn: '09:00',
  checkOut: '18:00',
  workedMinutes: 480,
  lateMinutes: 0,
  earlyLeaveMinutes: 0,
  overtimeMinutes: 0,
  leaveRequestId: null,
  leaveTypeId: null,
  note: null,
  ...over,
});

const plan = (over = {}) =>
  planDecision({
    request: request(),
    balance: balance(),
    employee: { id: 'e1', locationId: 'loc_1' },
    attendance: [],
    holidays,
    settings,
    decision: 'approve',
    remarks: '',
    userId: 'u_1',
    now: NOW,
    ...over,
  });

const refused = (run, status, pattern) => {
  try {
    run();
  } catch (error) {
    assert.strictEqual(error.status, status, error.message);
    if (pattern) assert.match(error.message, pattern);
    return;
  }
  assert.fail('expected the decision to be refused');
};

test('leave year follows the start of the leave year', () => {
  assert.strictEqual(leaveYearOf('2026-02-10', '04-01'), 2025);
  assert.strictEqual(leaveYearOf('2026-02-10', '01-01'), 2026);
  assert.strictEqual(leaveYearOf('2026-04-01', '04-01'), 2026);
});

test('working dates leave out weekends and holidays, by location', () => {
  const asked = request({ startDate: '2026-11-23', endDate: '2026-11-30' });
  assert.deepStrictEqual(workingDates(asked, settings, holidays, 'loc_1'), [
    '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-27', '2026-11-30',
  ]);
  const local = [{ date: '2026-11-26', locationIds: ['loc_2'] }];
  assert.strictEqual(workingDates(asked, settings, local, 'loc_1').length, 6);
  assert.strictEqual(workingDates(asked, settings, local, 'loc_2').length, 5);
});

test('approving moves the days from pending to used and records who and when', () => {
  const result = plan();
  assert.strictEqual(result.requestPatch.status, 'approved');
  assert.strictEqual(result.requestPatch.decidedBy, 'u_1');
  assert.strictEqual(result.requestPatch.decidedAt, NOW);
  assert.deepStrictEqual(
    { used: result.balancePatch.used, pending: result.balancePatch.pending, remaining: result.balancePatch.remaining },
    { used: 6, pending: 0, remaining: 14 },
  );
});

test('approving turns each working day into a leave day, and skips the holiday', () => {
  const result = plan();
  assert.deepStrictEqual(result.sync.create.map((record) => record.date), ['2026-11-25', '2026-11-27']);
  assert.ok(result.sync.create.every((record) => record.status === 'leave' && record.leaveRequestId === 'lvr_1' && record.leaveTypeId === 't1'));
  assert.deepStrictEqual(result.summary.attendance, { created: 2, updated: 0, removed: 0, replaced: [] });
});

test('approving over a day already recorded replaces it, keeps what it was, and says so', () => {
  const result = plan({ attendance: [day('2026-11-25'), day('2026-11-27', { status: 'absent', checkIn: null, checkOut: null, workedMinutes: 0 })] });
  assert.strictEqual(result.sync.create.length, 0);
  assert.strictEqual(result.sync.update.length, 2);
  const [first] = result.sync.update;
  assert.strictEqual(first.patch.status, 'leave');
  assert.strictEqual(first.patch.checkIn, null);
  assert.strictEqual(first.patch.workedMinutes, 0);
  assert.strictEqual(first.previous.status, 'present');
  assert.strictEqual(first.previous.checkIn, '09:00');
  // Only the day someone actually worked counts as replaced work.
  assert.deepStrictEqual(result.summary.attendance.replaced, [{ date: '2026-11-25', status: 'present' }]);
});

test('a half day sits beside the rest of the day instead of replacing it', () => {
  const asked = request({ startDate: '2026-11-25', endDate: '2026-11-25', days: 0.5, halfDay: true });
  const onFile = plan({ request: asked, attendance: [day('2026-11-25')] });
  assert.strictEqual(onFile.sync.update[0].patch.status, undefined);
  assert.strictEqual(onFile.sync.update[0].patch.checkIn, undefined);
  assert.strictEqual(onFile.sync.update[0].patch.leaveRequestId, 'lvr_1');
  assert.deepStrictEqual(onFile.summary.attendance.replaced, []);

  const none = plan({ request: asked });
  assert.strictEqual(none.sync.create[0].status, 'half-day');
  assert.strictEqual(none.balancePatch.used, 4.5);
});

test('approving can overdraw a balance, as approving over the limit is HR\'s call', () => {
  const result = plan({ balance: balance({ entitled: 5, used: 4, pending: 2, remaining: -1 }) });
  assert.strictEqual(result.balancePatch.remaining, -1);
});

test('approving needs a balance to charge', () => {
  refused(() => plan({ balance: null }), 409, /no leave balance/i);
});

test('rejecting releases the pending days and leaves attendance alone', () => {
  const result = plan({ decision: 'reject', remarks: 'Team is short that week' });
  assert.strictEqual(result.requestPatch.status, 'rejected');
  assert.strictEqual(result.requestPatch.hrRemarks, 'Team is short that week');
  assert.deepStrictEqual(
    { used: result.balancePatch.used, pending: result.balancePatch.pending, remaining: result.balancePatch.remaining },
    { used: 4, pending: 0, remaining: 16 },
  );
  assert.deepStrictEqual(result.summary.attendance, { created: 0, updated: 0, removed: 0, replaced: [] });
});

test('rejecting and cancelling need a reason', () => {
  refused(() => plan({ decision: 'reject', remarks: '' }), 400, /needs a reason/);
  refused(() => plan({ decision: 'reject', remarks: ' x ' }), 400);
  refused(() => plan({ decision: 'cancel', remarks: '' }), 400, /cancellation/);
  refused(() => plan({ remarks: 'x'.repeat(501) }), 400, /500 characters/);
});

test('a decision that is not approve, reject or cancel is refused', () => {
  refused(() => plan({ decision: 'maybe' }), 400);
  refused(() => plan({ request: null }), 404);
});

test('only a pending request can be approved or rejected', () => {
  for (const status of ['approved', 'rejected', 'cancelled']) {
    refused(() => plan({ request: request({ status }) }), 409, new RegExp(`${status}`));
    refused(() => plan({ request: request({ status }), decision: 'reject', remarks: 'Not possible' }), 409);
  }
});

test('cancelling a pending request releases its days', () => {
  const result = plan({ decision: 'cancel', remarks: 'Withdrawn by the employee' });
  assert.strictEqual(result.requestPatch.status, 'cancelled');
  assert.deepStrictEqual({ used: result.balancePatch.used, pending: result.balancePatch.pending }, { used: 4, pending: 0 });
  assert.strictEqual(result.summary.attendance.removed, 0);
});

test('cancelling an approved request gives the days back and undoes the attendance exactly', () => {
  const approved = request({
    status: 'approved',
    attendanceSync: [
      { id: 'att_new', created: true },
      { id: 'att_old', previous: { status: 'present', checkIn: '09:00', checkOut: '18:00', workedMinutes: 480, leaveRequestId: null } },
    ],
  });
  const result = plan({
    request: approved,
    balance: balance({ used: 6, pending: 0, remaining: 14 }),
    attendance: [day('2026-11-25', { id: 'att_new', status: 'leave' }), day('2026-11-27', { id: 'att_old', status: 'leave' })],
    decision: 'cancel',
    remarks: 'Plans changed',
  });
  assert.deepStrictEqual({ used: result.balancePatch.used, remaining: result.balancePatch.remaining }, { used: 4, remaining: 16 });
  assert.deepStrictEqual(result.sync.remove, ['att_new']);
  assert.strictEqual(result.sync.update.length, 1);
  assert.strictEqual(result.sync.update[0].patch.status, 'present');
  assert.strictEqual(result.sync.update[0].patch.checkIn, '09:00');
});

test('cancelling approved demo data that never tracked its days removes its leave days', () => {
  const approved = request({ status: 'approved' });
  const result = plan({
    request: approved,
    balance: balance({ used: 6, pending: 0, remaining: 14 }),
    attendance: [
      day('2026-11-25', { id: 'a1', status: 'leave', leaveTypeId: 't1' }),
      day('2026-11-27', { id: 'a2', status: 'leave', leaveTypeId: 't9' }),
      day('2026-11-26', { id: 'a3', status: 'present' }),
    ],
    decision: 'cancel',
    remarks: 'Plans changed',
  });
  assert.deepStrictEqual(result.sync.remove, ['a1']);
});

test('the balance never goes below zero used or pending', () => {
  const result = plan({ balance: balance({ pending: 0 }) });
  assert.strictEqual(result.balancePatch.pending, 0);
  const back = plan({ request: request({ status: 'approved' }), balance: balance({ used: 1 }), decision: 'cancel', remarks: 'Plans changed' });
  assert.strictEqual(back.balancePatch.used, 0);
});

console.log(`leave decisions: ${passed} checks passed`);
