/**
 * Leave balances and leave requests (requirements §5.8).
 *
 * Runs before attendance: every approved leave day is handed to the attendance generator so a
 * day marked as leave here is never also marked present there.
 */

const { faker } = require('@faker-js/faker');
const config = require('./config');
const { addDays, chance, id, intBetween, iso, isWorkingDay, pick, weighted, ymd } = require('./utils');

const SOURCES = ['email', 'phone', 'paper-form', 'in-person', 'whatsapp'];
const REASONS = {
  AL: ['Family vacation', 'Planned trip', 'Personal time off', 'Wedding in the family'],
  SL: ['Fever and cold', 'Medical appointment', 'Recovering from surgery', 'Food poisoning'],
  CL: ['Personal errand', 'House shifting', 'Family commitment'],
  ML: ['Maternity leave'],
  PL: ['Paternity leave'],
  UL: ['Extended personal leave', 'Unpaid sabbatical'],
  EL: ['Family emergency', 'Urgent personal matter', 'Bereavement'],
};

const TYPE_WEIGHTS = { AL: 10, SL: 8, CL: 6, EL: 2, UL: 1, ML: 1, PL: 1 };

function buildLeave({ employees, leaveTypes, holidays, hrUser }) {
  const now = config.TODAY;
  const historyStart = addDays(now, -Math.round(config.HISTORY_MONTHS * 30.4));
  const holidayDates = new Set(holidays.map((holiday) => holiday.date));
  const years = [...new Set([historyStart.getUTCFullYear(), now.getUTCFullYear()])];

  const leaveBalances = [];
  const leaveRequests = [];
  /** Key `employeeId|YYYY-MM-DD` to leave type id; consumed by the attendance generator. */
  const leaveDayMap = new Map();

  let balanceIndex = 1;
  let requestIndex = 1;

  for (const employee of employees) {
    const joined = new Date(`${employee.joiningDate}T00:00:00Z`);
    const leftOn = employee.exit ? new Date(`${employee.exit.lastWorkingDate}T00:00:00Z`) : null;

    for (const year of years) {
      const yearStart = new Date(Date.UTC(year, 0, 1));
      const yearEnd = new Date(Date.UTC(year, 11, 31));
      const activeFrom = joined > yearStart ? joined : yearStart;
      const cappedEnd = yearEnd > now ? now : yearEnd;
      const activeTo = leftOn && leftOn < cappedEnd ? leftOn : cappedEnd;
      if (activeTo < activeFrom) continue;

      // Roughly the number of months on the payroll that year; quota is pro-rated by it.
      const activeMonths = Math.max(1, Math.round((activeTo - activeFrom) / 2628000000));

      for (const leaveType of leaveTypes) {
        // Parental leave is only allocated to the few employees who actually take it.
        const parental = ['ML', 'PL'].includes(leaveType.code);
        if (parental && !chance(0.06)) continue;

        const entitled = parental
          ? leaveType.annualQuota
          : Math.round((leaveType.annualQuota * Math.min(12, activeMonths)) / 12);
        const carriedForward =
          leaveType.carryForward && year === now.getUTCFullYear() && joined < yearStart
            ? intBetween(0, leaveType.maxCarryForward)
            : 0;

        leaveBalances.push({
          id: id('lvb', balanceIndex++, 4),
          employeeId: employee.id,
          leaveTypeId: leaveType.id,
          leaveTypeCode: leaveType.code,
          year,
          entitled,
          carriedForward,
          used: 0,
          pending: 0,
          remaining: entitled + carriedForward,
          updatedAt: iso(now),
        });
      }
    }

    const windowStart = joined > historyStart ? joined : historyStart;
    const windowEnd = leftOn && leftOn < now ? leftOn : now;
    if (windowEnd <= windowStart) continue;

    const windowMonths = Math.max(1, Math.round((windowEnd - windowStart) / 2628000000));
    const requestCount = Math.max(0, Math.round((windowMonths / 12) * intBetween(3, 11)));

    for (let n = 0; n < requestCount; n += 1) {
      const startDate = faker.date.between({ from: windowStart, to: windowEnd });
      startDate.setUTCHours(0, 0, 0, 0);

      const yearBalances = leaveBalances.filter(
        (balance) => balance.employeeId === employee.id && balance.year === startDate.getUTCFullYear(),
      );
      if (!yearBalances.length) continue;

      const balance = weighted(
        yearBalances.map((item) => ({ weight: TYPE_WEIGHTS[item.leaveTypeCode] || 1, value: item })),
      );
      const leaveType = leaveTypes.find((item) => item.id === balance.leaveTypeId);

      const requestedDays = ['ML', 'PL'].includes(leaveType.code)
        ? leaveType.annualQuota
        : weighted([
            { weight: 50, value: 1 },
            { weight: 25, value: 2 },
            { weight: 15, value: 3 },
            { weight: 7, value: 5 },
            { weight: 3, value: intBetween(6, 10) },
          ]);

      // Walk forward until the requested number of working days is covered.
      const days = [];
      let cursor = new Date(startDate);
      let guard = 0;
      while (days.length < requestedDays && guard < 120) {
        if (isWorkingDay(cursor, config.WORKING_DAYS) && !holidayDates.has(ymd(cursor))) days.push(new Date(cursor));
        cursor = addDays(cursor, 1);
        guard += 1;
      }
      if (!days.length) continue;

      const endDate = days[days.length - 1];
      const status =
        startDate > now
          ? weighted([
              { weight: 6, value: 'pending' },
              { weight: 4, value: 'approved' },
            ])
          : weighted([
              { weight: 72, value: 'approved' },
              { weight: 10, value: 'rejected' },
              { weight: 10, value: 'pending' },
              { weight: 8, value: 'cancelled' },
            ]);

      const createdAt = addDays(startDate, -intBetween(1, 10));
      const decidedAt = status === 'pending' ? null : addDays(createdAt, intBetween(0, 2));

      leaveRequests.push({
        id: id('lvr', requestIndex++, 4),
        employeeId: employee.id,
        leaveTypeId: leaveType.id,
        startDate: ymd(startDate),
        endDate: ymd(endDate),
        days: days.length,
        halfDay: false,
        reason: pick(REASONS[leaveType.code] || ['Personal reasons']),
        source: pick(SOURCES),
        attachmentDocumentId: null,
        status,
        hrRemarks:
          status === 'rejected'
            ? pick([
                'Insufficient balance for the requested period',
                'Team coverage gap in this week',
                'Overlaps with a planned release',
              ])
            : status === 'approved'
              ? pick(['Approved.', 'Approved — coverage arranged.', ''])
              : '',
        decidedBy: decidedAt ? hrUser.id : null,
        decidedAt: decidedAt ? iso(decidedAt) : null,
        appliedOn: ymd(createdAt),
        createdAt: iso(createdAt),
        updatedAt: iso(decidedAt || createdAt),
      });

      if (status === 'approved') {
        balance.used += days.length;
        for (const day of days) leaveDayMap.set(`${employee.id}|${ymd(day)}`, leaveType.id);
      } else if (status === 'pending') {
        balance.pending += days.length;
      }
    }
  }

  for (const balance of leaveBalances) {
    balance.remaining = Math.max(0, balance.entitled + balance.carriedForward - balance.used - balance.pending);
  }

  return { leaveBalances, leaveRequests, leaveDayMap };
}

module.exports = { buildLeave };
