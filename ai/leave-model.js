/**
 * How leave adds up, for the leave AI tools.
 *
 * The dashboard works out what a request costs, how much of a balance can be taken and when a
 * leave year starts in one place (`src/features/leave/utils` and `settings/utils/leave-policy`).
 * The AI tools have to give the same answers — a check that says four days where the request
 * screen says five is worse than no check — so the same rules are written here, over plain
 * database rows. Dates are `YYYY-MM-DD` strings throughout.
 *
 * Nothing here writes; the tools that use it never change a request, a balance or attendance.
 */

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const CURRENT_STATUSES = new Set(['active', 'probation']);

const floorHalf = (days) => Math.floor(days * 2 + 1e-9) / 2;

const parse = (date) => new Date(`${date}T00:00:00Z`);
const ymd = (date) => date.toISOString().slice(0, 10);
const addDays = (date, days) => ymd(new Date(parse(date).getTime() + days * 86400000));
const gap = (from, to) => Math.round((parse(to) - parse(from)) / 86400000);

function eachDay(from, to) {
  const days = [];
  for (let date = from; date <= to; date = addDays(date, 1)) days.push(date);
  return days;
}

const weekdayOf = (date) => DAY_NAMES[parse(date).getUTCDay()];

/** The calendar year a leave year starts in: with a 04-01 start, 10 Feb 2026 is in 2025. */
function leaveYearOf(date, leaveYearStart = '01-01') {
  const year = Number(date.slice(0, 4));
  const start = date.slice(5) >= leaveYearStart ? year : year - 1;
  return { year: start, from: `${start}-${leaveYearStart}`, to: addDays(`${start + 1}-${leaveYearStart}`, -1) };
}

/** Holidays that are days off for this person: optional ones are only for those who take them. */
function daysOffFor(holidays, locationId) {
  return new Set(
    holidays
      .filter((holiday) => holiday.type !== 'optional')
      .filter((holiday) => !holiday.locationIds || !holiday.locationIds.length || holiday.locationIds.includes(locationId))
      .map((holiday) => holiday.date),
  );
}

function isWorkingDay(date, workingDays, off) {
  return workingDays.includes(weekdayOf(date)) && !off.has(date);
}

/**
 * What a request costs. Only working days count; with the sandwich rule a weekend or holiday
 * between two days of leave is charged as well, but one at either end never is.
 */
function costOf({ startDate, endDate, halfDay }, employee, settings, holidays) {
  const workingDays = (settings.work && settings.work.workingDays) || ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  const off = daysOffFor(holidays, employee && employee.locationId);
  const dates = endDate < startDate ? [] : eachDay(startDate, endDate);
  const working = dates.map((date) => isWorkingDay(date, workingDays, off));
  const worked = dates.filter((_, index) => working[index]);

  const first = working.indexOf(true);
  const last = working.lastIndexOf(true);
  let days = 0;
  if (first !== -1) {
    if (halfDay && startDate === endDate) days = 0.5;
    else days = settings.leave && settings.leave.sandwichLeaveEnabled ? last - first + 1 : worked.length;
  }

  return {
    days,
    calendarDays: dates.length,
    workingDates: worked,
    holidaysInside: dates.filter((date) => off.has(date)),
  };
}

/** Whole months from one date to another: 1 Jan to 1 Feb is one, 15 Jan to 14 Feb is none. */
function completedMonths(from, to) {
  const a = parse(from);
  const b = parse(to);
  let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if (b.getUTCDate() < a.getUTCDate()) months -= 1;
  return Math.max(0, months);
}

/** How much of a year's entitlement can be taken by a date: all of it up front, or month by month. */
function accruedEntitlement({ entitled, accrual, year, date, joiningDate }) {
  if (accrual !== 'monthly') return entitled;
  if (date >= year.to) return entitled;

  const startsOn = joiningDate && joiningDate > year.from ? joiningDate : year.from;
  if (date < startsOn) return 0;

  const period = completedMonths(startsOn, addDays(year.to, 1));
  if (period === 0) return entitled;
  const elapsed = Math.min(period, completedMonths(startsOn, addDays(date, 1)));
  return floorHalf((entitled * elapsed) / period);
}

/**
 * The person's balance for the type, in the leave year the request starts in, and how much of
 * it can be taken by the first day. A request already on file has its own days held on the
 * balance — pending, or used once approved — so they are not counted against it a second time.
 */
function balanceFor({ db, settings, employee, leaveTypeId, startDate, ownPendingDays = 0, ownUsedDays = 0 }) {
  const policy = settings.leave || {};
  const year = leaveYearOf(startDate, policy.leaveYearStart);
  const balance =
    db
      .get('leaveBalances')
      .find((item) => item.employeeId === employee.id && item.leaveTypeId === leaveTypeId && item.year === year.year) ||
    null;
  if (!balance) return { balance: null, year, available: null };

  const earned = accruedEntitlement({
    entitled: balance.entitled,
    accrual: policy.accrual,
    year,
    date: startDate,
    joiningDate: employee.joiningDate,
  });
  const available =
    earned +
    balance.carriedForward +
    (balance.adjustment || 0) -
    Math.max(0, balance.used - ownUsedDays) -
    Math.max(0, balance.pending - ownPendingDays);
  return { balance, year, available };
}

const lastWorkingDateOf = (employee) =>
  ['resigned', 'terminated', 'retired'].includes(employee.status) && employee.exit ? employee.exit.lastWorkingDate || null : null;

/** Whether someone is on the payroll on a date: joined, and has not left. */
function employedOn(employee, date) {
  if (employee.joiningDate > date) return false;
  const last = lastWorkingDateOf(employee);
  return !last || last >= date;
}

/**
 * How many of a person's colleagues are away on each day of a span, and the day it is worst.
 * `team` is the people in the department who are working; `requests` is everyone's leave.
 */
function coverageFor({ employee, startDate, endDate, requests, employees, settings, holidays, ignoreRequestId }) {
  const team = employees.filter(
    (item) => item.departmentId === employee.departmentId && item.id !== employee.id && CURRENT_STATUSES.has(item.status),
  );
  const teamIds = new Map(team.map((item) => [item.id, item]));
  const workingDays = (settings.work && settings.work.workingDays) || ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

  const away = new Map();
  for (const request of requests) {
    const colleague = teamIds.get(request.employeeId);
    if (!colleague || request.id === ignoreRequestId) continue;
    if (!['approved', 'pending'].includes(request.status)) continue;
    if (request.startDate > endDate || request.endDate < startDate) continue;

    const off = daysOffFor(holidays, colleague.locationId);
    const from = request.startDate < startDate ? startDate : request.startDate;
    const to = request.endDate > endDate ? endDate : request.endDate;
    for (const date of eachDay(from, to)) {
      if (!isWorkingDay(date, workingDays, off)) continue;
      const entry = away.get(date) || { approved: new Set(), pending: new Set() };
      entry[request.status].add(colleague.id);
      away.set(date, entry);
    }
  }

  let peak = null;
  for (const [date, entry] of away) {
    const count = new Set([...entry.approved, ...entry.pending]).size;
    if (!peak || count > peak.count || (count === peak.count && date < peak.date)) {
      peak = { date, count, approved: entry.approved.size, pending: entry.pending.size };
    }
  }
  const awayPeople = new Set();
  for (const entry of away.values()) for (const id of [...entry.approved, ...entry.pending]) awayPeople.add(id);

  return { teamSize: team.length, peak, awayPeople: awayPeople.size };
}

module.exports = {
  CURRENT_STATUSES,
  addDays,
  balanceFor,
  costOf,
  coverageFor,
  daysOffFor,
  eachDay,
  employedOn,
  gap,
  isWorkingDay,
  leaveYearOf,
  weekdayOf,
  ymd,
};
