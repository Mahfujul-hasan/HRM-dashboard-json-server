/**
 * Seed configuration.
 *
 * Every value can be overridden from the environment so a smaller or larger data set can be
 * generated without editing code:
 *
 *   EMPLOYEES=25 MONTHS=3 npm run seed
 *
 * SEED_TODAY pins "today" (ISO date) so a run is byte-for-byte reproducible; without it the
 * data is generated relative to the real current date, which keeps the dashboard looking live.
 */

const SEED_TODAY = process.env.SEED_TODAY ? new Date(`${process.env.SEED_TODAY}T00:00:00Z`) : new Date();

module.exports = {
  /** faker seed — same number in, same data out. */
  SEED: Number(process.env.SEED || 20261116),
  EMPLOYEE_COUNT: Number(process.env.EMPLOYEES || 100),
  /** Months of attendance, leave, payroll and audit history to generate. */
  HISTORY_MONTHS: Number(process.env.MONTHS || 12),
  TODAY: SEED_TODAY,
  CURRENCY: 'USD',
  COMPANY: {
    name: process.env.COMPANY_NAME || 'Northwind Labs',
    domain: 'northwindlabs.com',
    legalName: 'Northwind Labs, Inc.',
    phone: '+1 (415) 555-0142',
    taxId: 'EIN 84-1920447',
  },
  /** Working week. Mon–Fri, matching the USD / English locale. */
  WORKING_DAYS: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
  WORKING_HOURS: { start: '09:00', end: '18:00', breakMinutes: 60 },
  /** Attendance rules the generator and the dashboard both follow. */
  ATTENDANCE: {
    graceMinutes: 10,
    halfDayAfterMinutes: 240,
    overtimeAfterMinutes: 30,
    fullDayMinutes: 480,
  },
};
