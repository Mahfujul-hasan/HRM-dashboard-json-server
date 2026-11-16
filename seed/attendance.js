/**
 * Daily attendance (requirements §5.7).
 *
 * One record per employee per working day, skipping weekends and public holidays (the
 * `holidays` collection already covers those). Approved leave days come from the leave
 * generator, so a leave day is never also a present day.
 *
 * A few employees get a deliberate behaviour profile — chronic lateness, frequent absence,
 * heavy overtime — and a small number of records are left missing or malformed on purpose, so
 * the anomaly-detection and data-quality engines have something real to find.
 */

const config = require('./config');
const { addDays, chance, eachDate, id, intBetween, iso, isWorkingDay, toMinutes, toTime, weighted, ymd } = require('./utils');

const { graceMinutes, halfDayAfterMinutes, overtimeAfterMinutes, fullDayMinutes } = config.ATTENDANCE;

/** Behaviour profiles, assigned once per employee, that bias every day they are generated. */
const PROFILES = [
  { key: 'standard', weight: 68, lateBias: 0, absenceBias: 0, overtimeBias: 0 },
  { key: 'punctual', weight: 12, lateBias: -0.05, absenceBias: -0.015, overtimeBias: 0 },
  { key: 'chronic-late', weight: 8, lateBias: 0.3, absenceBias: 0.01, overtimeBias: 0 },
  { key: 'frequent-absent', weight: 5, lateBias: 0.05, absenceBias: 0.09, overtimeBias: 0 },
  { key: 'overworker', weight: 7, lateBias: -0.02, absenceBias: -0.01, overtimeBias: 0.45 },
];

function assignProfile() {
  return weighted(PROFILES.map((profile) => ({ weight: profile.weight, value: profile })));
}

function buildAttendance({ employees, holidays, leaveDayMap }) {
  const now = config.TODAY;
  const historyStart = addDays(now, -Math.round(config.HISTORY_MONTHS * 30.4));
  const holidayDates = new Set(holidays.map((holiday) => holiday.date));
  const shiftStart = toMinutes(config.WORKING_HOURS.start);
  const shiftEnd = toMinutes(config.WORKING_HOURS.end);

  const attendance = [];
  const profiles = new Map();
  let index = 1;

  for (const employee of employees) {
    const profile = assignProfile();
    profiles.set(employee.id, profile.key);

    const joined = new Date(`${employee.joiningDate}T00:00:00Z`);
    const leftOn = employee.exit ? new Date(`${employee.exit.lastWorkingDate}T00:00:00Z`) : null;
    const from = joined > historyStart ? joined : historyStart;
    const to = leftOn && leftOn < now ? leftOn : now;
    if (to < from) continue;

    const remote = employee.workMode === 'remote';
    const hybrid = employee.workMode === 'hybrid';

    for (const date of eachDate(from, to)) {
      const day = ymd(date);
      if (!isWorkingDay(date, config.WORKING_DAYS)) continue;
      if (holidayDates.has(day)) continue;

      const leaveTypeId = leaveDayMap.get(`${employee.id}|${day}`);
      // Deliberately lean: this is by far the largest collection, and json-server rewrites the
      // whole file on every write. Shift times come from settings and the department from the
      // employee record, so neither is repeated on each row.
      const base = {
        id: id('att', index++, 6),
        employeeId: employee.id,
        date: day,
        checkIn: null,
        checkOut: null,
        workedMinutes: 0,
        lateMinutes: 0,
        earlyLeaveMinutes: 0,
        overtimeMinutes: 0,
        leaveRequestId: null,
        leaveTypeId: leaveTypeId || null,
        source: chance(0.6) ? 'import' : 'manual',
        corrected: false,
        correctionReason: null,
        note: null,
        updatedAt: iso(addDays(date, 1)),
      };

      if (leaveTypeId) {
        attendance.push({ ...base, status: 'leave' });
        continue;
      }

      // ~0.4% of days are simply never recorded — the gap payroll validation must catch.
      if (chance(0.004)) continue;

      const status = weighted([
        { weight: Math.max(1, 820 + profile.lateBias * -100), value: 'present' },
        { weight: Math.max(1, 70 + profile.lateBias * 1000), value: 'late' },
        { weight: Math.max(1, 25 + profile.absenceBias * 1000), value: 'absent' },
        { weight: remote ? 200 : hybrid ? 90 : 25, value: 'work-from-home' },
        { weight: 14, value: 'half-day' },
        { weight: 10, value: 'on-duty' },
      ]);

      if (status === 'absent') {
        attendance.push({
          ...base,
          status,
          note: chance(0.3) ? 'No information received' : null,
        });
        continue;
      }

      let checkInMinutes;
      if (status === 'late') {
        checkInMinutes = shiftStart + intBetween(graceMinutes + 1, 150);
      } else if (status === 'half-day') {
        checkInMinutes = shiftStart + intBetween(-10, 20);
      } else {
        checkInMinutes = shiftStart + intBetween(-25, graceMinutes);
      }

      const plannedMinutes =
        status === 'half-day' ? intBetween(180, halfDayAfterMinutes) : fullDayMinutes + intBetween(-20, 35);
      const overtimeMinutes =
        status === 'half-day'
          ? 0
          : chance(0.12 + profile.overtimeBias)
            ? intBetween(overtimeAfterMinutes + 5, 210)
            : 0;

      const workedMinutes = plannedMinutes + overtimeMinutes;
      const checkOutMinutes = checkInMinutes + workedMinutes + config.WORKING_HOURS.breakMinutes;
      const lateMinutes = Math.max(0, checkInMinutes - shiftStart - graceMinutes);
      const earlyLeaveMinutes =
        status === 'half-day' ? Math.max(0, shiftEnd - checkOutMinutes) : Math.max(0, shiftEnd - checkOutMinutes);

      const corrected = chance(0.015);

      attendance.push({
        ...base,
        status,
        checkIn: toTime(checkInMinutes),
        checkOut: toTime(checkOutMinutes),
        workedMinutes,
        lateMinutes,
        earlyLeaveMinutes,
        overtimeMinutes,
        corrected,
        correctionReason: corrected
          ? weighted([
              { weight: 4, value: 'Biometric device missed the punch' },
              { weight: 3, value: 'Employee was on client site' },
              { weight: 2, value: 'Wrong shift applied during import' },
            ])
          : null,
      });
    }
  }

  return { attendance, profiles };
}

module.exports = { buildAttendance, PROFILES };
