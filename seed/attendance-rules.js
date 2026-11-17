/**
 * How attendance minutes follow from the punches and the rules in settings.
 *
 * The dashboard applies the same rules in `features/attendance/utils/calculations.ts`; this is
 * the mock server's copy, used to check the seeded data and to bring an older database in line.
 *
 *  - Minutes worked: check-in to check-out, break taken out.
 *  - Late minutes: counted from the end of the grace period, not from the start of the day.
 *  - Overtime: time worked beyond a full day plus the overtime buffer, and only that.
 *  - Half day: worked no more than the half-day limit.
 */

const { toMinutes } = require('./utils');

function deriveMinutes(record, settings) {
  const rules = settings.attendance;
  const work = settings.work;
  const checkIn = toMinutes(record.checkIn);
  const checkOut = toMinutes(record.checkOut);
  const start = toMinutes(work.workingHours.start);
  const end = toMinutes(work.workingHours.end);

  const worked = Math.max(0, checkOut - checkIn - work.breakMinutes);
  return {
    workedMinutes: worked,
    lateMinutes: Math.max(0, checkIn - start - rules.graceMinutes),
    earlyLeaveMinutes: Math.max(0, end - checkOut),
    overtimeMinutes: rules.overtimeEnabled ? Math.max(0, worked - rules.fullDayMinutes - rules.overtimeAfterMinutes) : 0,
  };
}

/** The status the clock implies; work-from-home and on-duty are stated by HR, not derived. */
function deriveStatus(derived, settings) {
  if (derived.workedMinutes <= 0) return 'absent';
  if (derived.workedMinutes <= settings.attendance.halfDayAfterMinutes) return 'half-day';
  return derived.lateMinutes > 0 ? 'late' : 'present';
}

const hasPunches = (record) => Boolean(record.checkIn && record.checkOut);

module.exports = { deriveMinutes, deriveStatus, hasPunches };
