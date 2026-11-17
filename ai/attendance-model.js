/**
 * What the attendance engines look at, worked out once.
 *
 * The three attendance tools — anomaly check, trend explainer, pre-report data check — are
 * different questions about the same thing: every person's records over a period, set against
 * the days they were expected at work. This builds that, and the flags that can be raised from
 * it, so the tools disagree about nothing.
 *
 * Expected days follow the working week and holidays in settings and the person's employment
 * dates, the same rule the dashboard applies. A flag is a threshold crossed, never a
 * conclusion: it names the person, the number and the days, so HR can confirm or dismiss it.
 */

const { addDays, ymd } = require('./helpers');
const { deriveMinutes, hasPunches } = require('../seed/attendance-rules');
const { toMinutes } = require('../seed/utils');

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MAX_DAYS = 366;

/** The numbers that turn a count into a flag. Shown with every result. */
const THRESHOLDS = {
  lateRatePercent: 30,
  lateDaysMinimum: 3,
  lateIncreaseFactor: 2,
  absenceCount: 3,
  absencePatternShare: 0.6,
  overtimeHours: 25,
  missingRatePercent: 15,
};

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

function weekdayOf(date) {
  return WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
}

/**
 * The period a tool was asked about: `from`/`to`, or the last `days` days. Never past today —
 * a day that has not happened has no attendance, and counting it would make everyone look absent.
 */
function resolvePeriod(input, now) {
  const today = ymd(now);
  let to = input.to || today;
  let from = input.from;

  if (!from) {
    const days = Math.max(1, Math.min(MAX_DAYS, Number(input.days || 30)));
    from = ymd(addDays(to > today ? today : to, -(days - 1)));
  }
  if (to > today) to = today;

  const valid = /^\d{4}-\d{2}-\d{2}$/;
  if (!valid.test(from) || !valid.test(to)) {
    throw Object.assign(new Error('from and to must be YYYY-MM-DD dates'), { status: 400 });
  }
  if (from > to) throw Object.assign(new Error('The period starts after it ends'), { status: 400 });

  const length = Math.round((new Date(to) - new Date(from)) / 86400000) + 1;
  if (length > MAX_DAYS) {
    throw Object.assign(new Error(`Choose a period of ${MAX_DAYS} days or fewer`), { status: 400 });
  }
  return { from, to, length };
}

/** The same length of time immediately before a period, for comparison. */
function previousPeriod({ from, length }) {
  const to = ymd(addDays(from, -1));
  return { from: ymd(addDays(to, -(length - 1))), to, length };
}

function datesBetween(from, to) {
  const dates = [];
  for (let date = from; date <= to; date = ymd(addDays(date, 1))) dates.push(date);
  return dates;
}

/** Statuses of people who have left; the dashboard applies the same rule. */
const LEFT_STATUSES = new Set(['resigned', 'terminated', 'retired']);

/**
 * The last day someone worked, once they have actually left. An exit record can outlive the
 * exit — a withdrawn resignation leaves one behind — so the status decides, not the record.
 */
function lastWorkingDateOf(employee) {
  return LEFT_STATUSES.has(employee.status) && employee.exit ? employee.exit.lastWorkingDate || null : null;
}

function employedOn(employee, date) {
  if (employee.joiningDate > date) return false;
  const last = lastWorkingDateOf(employee);
  return !last || last >= date;
}

/** Builds the per-person picture of a period. */
function buildModel({ db, settings, period, now, departmentId, employeeId }) {
  const work = settings.work || { workingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] };
  const today = ymd(now);
  const { from, to } = period;
  const days = datesBetween(from, to);

  const holidays = db.get('holidays').filter((holiday) => holiday.type !== 'optional');
  const holidayDates = new Map();
  for (const holiday of holidays) {
    const list = holidayDates.get(holiday.date) || [];
    list.push(holiday);
    holidayDates.set(holiday.date, list);
  }

  /** A working day for a person: in the working week, and not a holiday at their location. */
  const isWorkingDay = (date, employee) => {
    if (!work.workingDays.includes(weekdayOf(date))) return false;
    const onDay = holidayDates.get(date) || [];
    return !onDay.some(
      (holiday) =>
        !holiday.locationIds || holiday.locationIds.length === 0 || holiday.locationIds.includes(employee.locationId),
    );
  };

  const allEmployees = db.get('employees');
  let employees = allEmployees.filter((employee) => employee.joiningDate <= to && (!lastWorkingDateOf(employee) || lastWorkingDateOf(employee) >= from));
  if (departmentId) employees = employees.filter((employee) => employee.departmentId === departmentId);
  if (employeeId) employees = employees.filter((employee) => employee.id === employeeId);
  if (!employees.length) throw Object.assign(new Error('No employees match the filter'), { status: 404 });

  const inWindow = db.get('attendance').filter((record) => record.date >= from && record.date <= to);
  const byEmployee = new Map();
  for (const record of inWindow) {
    const list = byEmployee.get(record.employeeId) || [];
    list.push(record);
    byEmployee.set(record.employeeId, list);
  }

  const known = new Set(allEmployees.map((employee) => employee.id));
  const unknownRecords = departmentId || employeeId ? [] : inWindow.filter((record) => !known.has(record.employeeId));

  const people = employees.map((employee) => {
    const records = (byEmployee.get(employee.id) || []).sort((a, b) => a.date.localeCompare(b.date));
    const recorded = new Set(records.map((record) => record.date));
    // Completed days only: today's attendance is still being entered, and is not yet "missing".
    const expected = days.filter((date) => date < today && employedOn(employee, date) && isWorkingDay(date, employee));
    const missing = expected.filter((date) => !recorded.has(date));

    const count = (status) => records.filter((record) => record.status === status).length;
    const absentDates = records.filter((record) => record.status === 'absent').map((record) => record.date);
    const counted = records.filter((record) => record.status !== 'leave' && record.status !== 'holiday');
    const attended = counted.filter((record) => record.status !== 'absent').length;
    const lateRecords = records.filter((record) => (record.lateMinutes || 0) > 0);

    return {
      employee,
      records,
      expected,
      missing,
      counted: counted.length,
      attended,
      leave: count('leave'),
      halfDays: count('half-day'),
      absentDates,
      absent: absentDates.length,
      lateDays: lateRecords.length,
      lateDates: lateRecords.map((record) => record.date),
      lateMinutes: lateRecords.reduce((sum, record) => sum + record.lateMinutes, 0),
      overtimeMinutes: records.reduce((sum, record) => sum + (record.overtimeMinutes || 0), 0),
      workedMinutes: records.reduce((sum, record) => sum + (record.workedMinutes || 0), 0),
      // Absences on the day before or after a day off: the Monday/Friday pattern.
      nextToDayOff: absentDates.filter(
        (date) => !isWorkingDay(ymd(addDays(date, -1)), employee) || !isWorkingDay(ymd(addDays(date, 1)), employee),
      ),
    };
  });

  return { period, from, to, days, today, work, settings, people, unknownRecords, isWorkingDay, recordCount: inWindow.length };
}

/** Share of days at work among the days someone was expected, 0–1, or null with nothing to go on. */
function rateOf(part, whole) {
  return whole > 0 ? part / whole : null;
}

function totalsOf(people) {
  const sum = (key) => people.reduce((total, person) => total + person[key], 0);
  return {
    people: people.length,
    records: sum('counted') + sum('leave'),
    counted: sum('counted'),
    attended: sum('attended'),
    late: sum('lateDays'),
    lateMinutes: sum('lateMinutes'),
    absent: sum('absent'),
    halfDays: sum('halfDays'),
    leave: sum('leave'),
    overtimeMinutes: sum('overtimeMinutes'),
    expected: people.reduce((total, person) => total + person.expected.length, 0),
    missing: people.reduce((total, person) => total + person.missing.length, 0),
  };
}

/* --------------------------------- the flags ----------------------------- */

function flag(model, person, code, kind, severity, message, dates) {
  const id = person ? person.employee.id : 'records';
  return {
    key: `${code}|${id}|${model.from}|${model.to}`,
    code,
    kind,
    severity,
    message,
    employeeId: person ? person.employee.id : null,
    employeeName: person ? person.employee.fullName : null,
    departmentId: person ? person.employee.departmentId : null,
    dates: dates || [],
    count: (dates || []).length,
  };
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Unusual behaviour: lateness, absence, overtime — set against the thresholds, and the last period. */
function behaviourFlags(model, previous) {
  const flags = [];
  const before = previous ? new Map(previous.people.map((person) => [person.employee.id, person])) : new Map();

  for (const person of model.people) {
    const name = person.employee.fullName;
    const lateRate = rateOf(person.lateDays, person.attended || person.counted);
    const lateShare = lateRate === null ? 0 : Math.round(lateRate * 100);

    if (lateShare >= THRESHOLDS.lateRatePercent && person.lateDays >= THRESHOLDS.lateDaysMinimum) {
      const average = Math.round(person.lateMinutes / person.lateDays);
      flags.push(
        flag(model, person, 'frequent-late', 'behaviour', lateShare >= 50 ? 'high' : 'medium',
          `${name} was late on ${person.lateDays} of ${person.attended || person.counted} days at work (${lateShare}%, threshold ${THRESHOLDS.lateRatePercent}%), by ${average} minutes on average`,
          person.lateDates),
      );
    } else if (previous && person.lateDays >= THRESHOLDS.lateDaysMinimum) {
      const was = before.get(person.employee.id);
      const wasRate = was ? rateOf(was.lateDays, was.attended || was.counted) : null;
      if (wasRate !== null && lateRate >= 0.2 && lateRate >= wasRate * THRESHOLDS.lateIncreaseFactor && lateRate - wasRate >= 0.1) {
        flags.push(
          flag(model, person, 'late-increase', 'behaviour', 'medium',
            `${name} was late on ${lateShare}% of days at work, up from ${Math.round(wasRate * 100)}% in the previous ${plural(previous.period.length, 'day')}`,
            person.lateDates),
        );
      }
    }

    if (person.absent >= THRESHOLDS.absenceCount) {
      flags.push(
        flag(model, person, 'frequent-absence', 'behaviour', person.absent >= 6 ? 'high' : 'medium',
          `${name} was absent on ${person.absent} days (threshold ${THRESHOLDS.absenceCount})`,
          person.absentDates),
      );
      if (person.nextToDayOff.length / person.absent >= THRESHOLDS.absencePatternShare) {
        flags.push(
          flag(model, person, 'absence-pattern', 'behaviour', 'medium',
            `${person.nextToDayOff.length} of ${name}'s ${person.absent} absences fall right before or after a day off`,
            person.nextToDayOff),
        );
      }
    }

    const overtimeHours = Math.round((person.overtimeMinutes / 60) * 10) / 10;
    if (overtimeHours >= THRESHOLDS.overtimeHours) {
      flags.push(
        flag(model, person, 'excessive-overtime', 'behaviour', overtimeHours >= 45 ? 'high' : 'medium',
          `${name} logged ${overtimeHours} overtime hours (threshold ${THRESHOLDS.overtimeHours})`,
          person.records.filter((record) => (record.overtimeMinutes || 0) > 0).map((record) => record.date)),
      );
    }
  }
  return flags;
}

/** What is wrong with the records themselves, per person: errors rather than behaviour. */
function dataIssues(model) {
  const issues = [];
  const settings = model.settings;

  for (const person of model.people) {
    const name = person.employee.fullName;
    const employee = person.employee;
    const last = lastWorkingDateOf(employee);

    const seen = new Map();
    for (const record of person.records) seen.set(record.date, (seen.get(record.date) || 0) + 1);
    const duplicated = [...seen].filter(([, times]) => times > 1).map(([date]) => date);

    const invalid = person.records.filter(
      (record) => hasPunches(record) && toMinutes(record.checkOut) <= toMinutes(record.checkIn),
    );
    const noPunches = person.records.filter(
      (record) => ['present', 'late', 'half-day'].includes(record.status) && !hasPunches(record),
    );
    const absentWithPunches = person.records.filter((record) => record.status === 'absent' && hasPunches(record));
    const mismatch = person.records.filter((record) => {
      if (!hasPunches(record) || ['leave', 'holiday', 'absent'].includes(record.status)) return false;
      if (toMinutes(record.checkOut) <= toMinutes(record.checkIn)) return false;
      const derived = deriveMinutes(record, settings);
      return (
        Math.abs((record.workedMinutes || 0) - derived.workedMinutes) > 1 ||
        Math.abs((record.lateMinutes || 0) - derived.lateMinutes) > 1 ||
        Math.abs((record.overtimeMinutes || 0) - derived.overtimeMinutes) > 1
      );
    });
    const onDayOff = person.records.filter(
      (record) => !['holiday', 'leave'].includes(record.status) && !model.isWorkingDay(record.date, employee),
    );
    const outside = person.records.filter((record) => record.date < employee.joiningDate || (last && record.date > last));

    const dates = (list) => [...new Set(list.map((record) => record.date))];

    if (duplicated.length) {
      issues.push(flag(model, person, 'duplicate-record', 'data', 'high',
        `${name} has more than one record on ${plural(duplicated.length, 'day')}`, duplicated));
    }
    if (invalid.length) {
      issues.push(flag(model, person, 'invalid-punches', 'data', 'high',
        `${name} has ${plural(invalid.length, 'record')} that check out at or before check-in`, dates(invalid)));
    }
    if (noPunches.length || absentWithPunches.length) {
      const both = [...noPunches, ...absentWithPunches];
      issues.push(flag(model, person, 'status-mismatch', 'data', 'medium',
        `${name} has ${plural(both.length, 'record')} whose status does not fit the punches (present with no punches, or absent with punches)`, dates(both)));
    }
    if (mismatch.length) {
      issues.push(flag(model, person, 'minutes-mismatch', 'data', 'medium',
        `${name} has ${plural(mismatch.length, 'record')} whose worked, late or overtime minutes do not follow from the punches under the current rules`, dates(mismatch)));
    }
    if (outside.length) {
      issues.push(flag(model, person, 'outside-employment', 'data', 'medium',
        `${name} has ${plural(outside.length, 'record')} dated outside their employment`, dates(outside)));
    }
    if (onDayOff.length) {
      issues.push(flag(model, person, 'day-off-record', 'data', 'low',
        `${name} has ${plural(onDayOff.length, 'record')} on a weekend or holiday`, dates(onDayOff)));
    }

    if (person.missing.length) {
      const rate = person.missing.length / Math.max(1, person.expected.length);
      // A share alone is misleading for someone who joined last week: one day missing of one is 100%.
      const count = person.missing.length;
      const severity =
        rate >= 0.3 && count >= 3 ? 'high' : rate >= THRESHOLDS.missingRatePercent / 100 && count >= 2 ? 'medium' : 'low';
      const message =
        person.records.length === 0
          ? `${name} has no attendance record at all in this period (${plural(person.expected.length, 'day')} expected)`
          : `${name} is missing ${plural(person.missing.length, 'expected day')} of attendance (${Math.round(rate * 100)}% of the period)`;
      issues.push(flag(model, person, 'missing-records', 'data', severity, message, person.missing));
    }
  }

  if (model.unknownRecords.length) {
    const ids = [...new Set(model.unknownRecords.map((record) => record.employeeId))];
    issues.push({
      key: `unknown-employee|records|${model.from}|${model.to}`,
      code: 'unknown-employee',
      kind: 'data',
      severity: 'high',
      message: `${plural(model.unknownRecords.length, 'record')} belong to ${plural(ids.length, 'employee')} who do not exist (${ids.slice(0, 3).join(', ')}${ids.length > 3 ? '…' : ''})`,
      employeeId: null,
      employeeName: null,
      departmentId: null,
      dates: [...new Set(model.unknownRecords.map((record) => record.date))],
      count: model.unknownRecords.length,
    });
  }

  return issues;
}

function sortFlags(flags) {
  return [...flags].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      (a.employeeName || '').localeCompare(b.employeeName || '') ||
      a.code.localeCompare(b.code),
  );
}

const countBy = (items, pick) =>
  items.reduce((counts, item) => {
    const key = pick(item);
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});

module.exports = {
  THRESHOLDS,
  WEEKDAYS,
  resolvePeriod,
  previousPeriod,
  buildModel,
  behaviourFlags,
  dataIssues,
  sortFlags,
  totalsOf,
  rateOf,
  weekdayOf,
  countBy,
  plural,
};
