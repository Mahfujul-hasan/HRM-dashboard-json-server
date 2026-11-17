/**
 * Attendance AI (requirements §5.7): anomaly detection, a plain-language trend explainer, and a
 * data check to run before a report is generated.
 *
 * All three read the same model of the period (see `attendance-model.js`) and none of them
 * writes anything. A flag is a threshold crossed, with the number and the days that crossed it;
 * confirming or dismissing it is HR's decision, stored by the dashboard against the flag's
 * `key`, so a re-run does not raise a flag HR has already dealt with as if it were new.
 */

const { bullets, compose, confidenceFrom, round, source, table } = require('../helpers');
const model = require('../attendance-model');

const { THRESHOLDS, plural } = model;

/** The input every attendance tool shares. */
const PERIOD_INPUT = {
  from: 'string — first day, YYYY-MM-DD (optional; use `days` instead)',
  to: 'string — last day, YYYY-MM-DD (default today)',
  days: 'number — last N days when from is not given, default 30',
  departmentId: 'string — limit to one department (optional)',
  employeeId: 'string — limit to one employee (optional)',
};

const percentOf = (value) => (value === null || value === undefined ? null : Math.round(value * 100));

function periodLabel({ from, to }) {
  return from === to ? from : `${from} to ${to}`;
}

function describeAsk(input, what) {
  const when = input.from
    ? `from ${input.from} to ${input.to || 'today'}`
    : `over the last ${input.days || 30} days`;
  return `${what} ${when}${input.departmentId ? ` for department ${input.departmentId}` : ''}${input.employeeId ? ` for employee ${input.employeeId}` : ''}`;
}

/** The period, the model of it, and (when asked) the model of the period before it. */
function analyse({ input, db, settings, now, withPrevious = false }) {
  const period = model.resolvePeriod(input, now);
  const options = { db, settings, now, departmentId: input.departmentId, employeeId: input.employeeId };
  const current = model.buildModel({ ...options, period });

  let previous = null;
  if (withPrevious) {
    try {
      previous = model.buildModel({ ...options, period: model.previousPeriod(period) });
    } catch {
      // Nobody was employed then: there is simply nothing to compare with.
      previous = null;
    }
  }
  return { period, current, previous };
}

function metricsOf(people) {
  const totals = model.totalsOf(people);
  return {
    ...totals,
    attendanceRate: model.rateOf(totals.attended, totals.counted),
    lateRate: model.rateOf(totals.late, totals.attended),
    absenceRate: model.rateOf(totals.absent, totals.counted),
    overtimeHours: round(totals.overtimeMinutes / 60, 1),
    coverage: model.rateOf(totals.expected - totals.missing, totals.expected),
  };
}

function employeeSources(flags) {
  const seen = new Set();
  const sources = [];
  for (const item of flags) {
    if (!item.employeeId || seen.has(item.employeeId)) continue;
    seen.add(item.employeeId);
    sources.push(source('employee', item.employeeId, item.employeeName));
    if (sources.length >= 5) break;
  }
  return sources;
}

const emptyResult = (period, kind) => ({
  output: `There are no attendance records between ${period.from} and ${period.to} for the people selected. Enter or import attendance before running this ${kind}.`,
  sources: [source('dataset', 'attendance', `Attendance ${periodLabel(period)}`)],
  confidence: 0.3,
  limitation: 'No data in the period — an absence of records is not an absence of attendance.',
  data: { from: period.from, to: period.to, flags: [], empty: true, decisionAllowed: false },
});

/** One sentence comparing a rate with the same rate in the previous period. */
function compareRate(label, rate, before, days) {
  if (rate === null) return null;
  const text = `${percentOf(rate)}%`;
  if (before === null || before === undefined) return `${label} was ${text}.`;
  const change = percentOf(rate) - percentOf(before);
  if (Math.abs(change) < 1) return `${label} was ${text}, about the same as the ${percentOf(before)}% before.`;
  return `${label} was ${text}, ${change > 0 ? 'up' : 'down'} from ${percentOf(before)}% in the previous ${plural(days, 'day')}.`;
}

module.exports = [
  /* ------------------------------ anomaly check ------------------------------ */
  {
    id: 'attendance-insight',
    module: 'attendance',
    label: 'Attendance Insight',
    purpose: 'Detects late arrivals, absences, overtime and attendance-data errors',
    input: PERIOD_INPUT,
    prompt: (input) => describeAsk(input, 'Find attendance anomalies'),

    run({ input, db, settings, now }) {
      const { period, current, previous } = analyse({ input, db, settings, now, withPrevious: true });
      if (!current.recordCount) return emptyResult(period, 'check');

      // Data errors worth an alarm; a record on a day off or one missing day is not.
      const errors = model.dataIssues(current).filter((item) => item.severity !== 'low');
      const flags = model.sortFlags([...model.behaviourFlags(current, previous), ...errors]);

      const metrics = metricsOf(current.people);
      const bySeverity = model.countBy(flags, (item) => item.severity);
      const corrected = current.people.reduce(
        (sum, person) => sum + person.records.filter((record) => record.corrected).length,
        0,
      );

      const lines = flags.slice(0, 12).map((item) => `[${item.severity}] ${item.message}`);
      const more = flags.length - lines.length;

      return {
        output: compose([
          `Attendance review ${periodLabel(period)} — ${plural(flags.length, 'flag')}: ${bySeverity.high || 0} high, ${bySeverity.medium || 0} medium.`,
          `Across ${plural(current.people.length, 'employee')} and ${plural(current.recordCount, 'record')}, ${percentOf(metrics.attendanceRate) ?? '—'}% of recorded days were at work, ${percentOf(metrics.lateRate) ?? '—'}% of those late. There were ${plural(metrics.absent, 'absence')} and ${metrics.overtimeHours} overtime hours${corrected ? `, and ${plural(corrected, 'record')} ${corrected === 1 ? 'was' : 'were'} corrected by hand` : ''}.`,
          flags.length
            ? `Flags\n${bullets(lines)}${more > 0 ? `\n- and ${more} more` : ''}`
            : 'No thresholds were crossed in this period.',
          `Totals\n${table([
            { label: 'Records', value: current.recordCount },
            { label: 'Expected days not recorded', value: metrics.missing },
            { label: 'Late days', value: metrics.late },
            { label: 'Absences', value: metrics.absent },
            { label: 'Leave days', value: metrics.leave },
            { label: 'Overtime hours', value: metrics.overtimeHours },
          ])}`,
          'Confirm or dismiss each flag before it reaches a report. A flag may point to a data problem rather than behaviour.',
        ]),
        sources: [
          source('dataset', 'attendance', `Attendance records ${periodLabel(period)} (${current.recordCount})`),
          ...employeeSources(flags),
        ],
        confidence: confidenceFrom({
          evidence: current.recordCount,
          max: metrics.coverage !== null && metrics.coverage < 0.9 ? 0.6 : 0.8,
          base: 0.55,
        }),
        limitation:
          'Fixed thresholds over recorded data. Approved leave, travel and records not yet entered can all look like a pattern here.',
        data: {
          from: period.from,
          to: period.to,
          thresholds: THRESHOLDS,
          flags,
          totals: metrics,
          employeeCount: current.people.length,
          decisionAllowed: false,
        },
      };
    },
  },

  /* ------------------------------ trend explainer ---------------------------- */
  {
    id: 'attendance-trend-explainer',
    module: 'attendance',
    label: 'Attendance Trend Explainer',
    purpose: 'Explains how attendance changed against the previous period, in plain language',
    input: PERIOD_INPUT,
    prompt: (input) => describeAsk(input, 'Explain the attendance trend'),

    run({ input, db, settings, now }) {
      const { period, current, previous } = analyse({ input, db, settings, now, withPrevious: true });
      if (!current.recordCount) return emptyResult(period, 'explanation');

      const latest = metricsOf(current.people);
      const earlier = previous ? metricsOf(previous.people) : null;
      const comparable = Boolean(earlier && earlier.counted > 0);
      const was = comparable ? earlier : null;

      // Departments, each against its own previous period.
      const names = new Map(db.get('departments').map((department) => [department.id, department.name]));
      const group = (people) => {
        const map = new Map();
        for (const person of people) {
          const list = map.get(person.employee.departmentId) || [];
          list.push(person);
          map.set(person.employee.departmentId, list);
        }
        return map;
      };
      const nowGroups = group(current.people);
      const wasGroups = comparable ? group(previous.people) : new Map();
      const departments = [...nowGroups].map(([id, people]) => {
        const a = metricsOf(people);
        const b = wasGroups.has(id) ? metricsOf(wasGroups.get(id)) : null;
        const change =
          a.attendanceRate !== null && b && b.attendanceRate !== null
            ? percentOf(a.attendanceRate) - percentOf(b.attendanceRate)
            : null;
        return {
          id,
          name: names.get(id) || 'Unknown department',
          people: people.length,
          attendanceRate: a.attendanceRate,
          previousAttendanceRate: b ? b.attendanceRate : null,
          change,
          lateRate: a.lateRate,
          absenceRate: a.absenceRate,
        };
      });
      const moved = departments.filter((item) => item.change !== null && Math.abs(item.change) >= 2);
      const worst = [...moved].sort((a, b) => a.change - b.change)[0];
      const best = [...moved].sort((a, b) => b.change - a.change)[0];

      // Which weekday carries the late arrivals and the absences.
      const weekdays = model.WEEKDAYS.map((weekday) => ({ weekday, late: 0, absent: 0 }));
      for (const person of current.people) {
        for (const record of person.records) {
          const slot = weekdays[new Date(`${record.date}T00:00:00Z`).getUTCDay()];
          if ((record.lateMinutes || 0) > 0) slot.late += 1;
          if (record.status === 'absent') slot.absent += 1;
        }
      }
      const peak = (key) => {
        const total = weekdays.reduce((sum, item) => sum + item[key], 0);
        const top = [...weekdays].sort((a, b) => b[key] - a[key])[0];
        return total >= 5 && top[key] / total >= 0.3
          ? { weekday: top.weekday, share: Math.round((top[key] / total) * 100) }
          : null;
      };
      const latePeak = peak('late');
      const absentPeak = peak('absent');

      // Whether a few people account for much of the lateness.
      const lateByPerson = current.people.filter((person) => person.lateDays > 0).sort((a, b) => b.lateDays - a.lateDays);
      const top3 = lateByPerson.slice(0, 3).reduce((sum, person) => sum + person.lateDays, 0);
      const concentration =
        latest.late >= 10 && top3 / latest.late >= 0.4
          ? { people: lateByPerson.slice(0, 3).map((person) => person.employee.fullName), share: Math.round((top3 / latest.late) * 100) }
          : null;

      const overtimeLine =
        was && was.overtimeHours > 0 && latest.overtimeHours >= was.overtimeHours * 1.25
          ? `Overtime rose to ${latest.overtimeHours} hours from ${was.overtimeHours}.`
          : was && was.overtimeHours > 0 && latest.overtimeHours <= was.overtimeHours * 0.75
            ? `Overtime fell to ${latest.overtimeHours} hours from ${was.overtimeHours}.`
            : `Overtime came to ${latest.overtimeHours} hours.`;

      const notes = [
        compareRate('Attendance', latest.attendanceRate, was && was.attendanceRate, period.length),
        compareRate('Of the days at work, lateness', latest.lateRate, was && was.lateRate, period.length),
        compareRate('Absence', latest.absenceRate, was && was.absenceRate, period.length),
        overtimeLine,
        worst && worst.change < 0
          ? `${worst.name} slipped the most: attendance down ${Math.abs(worst.change)} points to ${percentOf(worst.attendanceRate)}%.`
          : null,
        best && best.change > 0
          ? `${best.name} improved the most: attendance up ${best.change} points to ${percentOf(best.attendanceRate)}%.`
          : null,
        latePeak ? `${latePeak.share}% of late arrivals fell on a ${latePeak.weekday}.` : null,
        absentPeak ? `${absentPeak.share}% of absences fell on a ${absentPeak.weekday}.` : null,
        concentration
          ? `Three people (${concentration.people.join(', ')}) account for ${concentration.share}% of the late arrivals, so this is closer to a few cases than a company-wide habit.`
          : null,
        !comparable ? 'There is no earlier period with records to compare against.' : null,
        latest.coverage !== null && latest.coverage < 0.9
          ? `Only ${percentOf(latest.coverage)}% of expected days have a record, so these figures may understate lateness and absence.`
          : null,
      ].filter(Boolean);

      return {
        output: compose([
          `Attendance trend ${periodLabel(period)}${comparable ? `, compared with ${periodLabel(previous.period)}` : ''}`,
          bullets(notes),
          'This describes what the records show. It does not say why — talk to the people and teams involved before drawing conclusions.',
        ]),
        sources: [
          source('dataset', 'attendance', `Attendance records ${periodLabel(period)} (${current.recordCount})`),
          ...(comparable
            ? [source('dataset', 'attendance', `Attendance records ${periodLabel(previous.period)} (${previous.recordCount})`)]
            : []),
          ...departments.slice(0, 3).map((item) => source('department', item.id, item.name)),
        ],
        confidence: confidenceFrom({
          evidence: current.recordCount,
          max: !comparable || (latest.coverage !== null && latest.coverage < 0.9) ? 0.6 : 0.8,
          base: 0.5,
        }),
        limitation:
          'Describes differences between two periods of recorded data. A change may come from holidays, leave, seasonality or records not yet entered, not from behaviour.',
        data: {
          from: period.from,
          to: period.to,
          previous: comparable ? { from: previous.from, to: previous.to } : null,
          current: latest,
          before: was,
          departments,
          weekdays,
          concentration,
          flags: [],
          decisionAllowed: false,
        },
      };
    },
  },

  /* ------------------------------ pre-report data check ----------------------- */
  {
    id: 'attendance-data-check',
    module: 'attendance',
    label: 'Attendance Data Check',
    purpose: 'Checks attendance data for errors and gaps before a report is generated',
    input: PERIOD_INPUT,
    prompt: (input) => describeAsk(input, 'Check attendance data quality'),

    run({ input, db, settings, now }) {
      const { period, current } = analyse({ input, db, settings, now });
      const issues = model.sortFlags(model.dataIssues(current));
      const metrics = metricsOf(current.people);

      const bySeverity = model.countBy(issues, (item) => item.severity);
      const byCode = model.countBy(issues, (item) => item.code);
      const coverage = metrics.coverage;
      // Ready when no record has a serious error and almost every expected day is in.
      const ready = !bySeverity.high && (coverage === null || coverage >= 0.95);

      const verdict = ready
        ? `The data looks ready for a report: ${percentOf(coverage) ?? '—'}% of expected days are recorded and no record has a serious error.`
        : `Not ready yet: ${[
            bySeverity.high ? plural(bySeverity.high, 'serious problem') : null,
            coverage !== null && coverage < 0.95 ? `only ${percentOf(coverage)}% of expected days are recorded` : null,
          ]
            .filter(Boolean)
            .join(' and ')}.`;

      const lines = issues.slice(0, 15).map((item) => `[${item.severity}] ${item.message}`);
      const more = issues.length - lines.length;

      return {
        output: compose([
          `Attendance data check ${periodLabel(period)} — ${verdict}`,
          issues.length
            ? `Found\n${bullets(lines)}${more > 0 ? `\n- and ${more} more` : ''}`
            : 'No errors or gaps were found.',
          `Coverage\n${table([
            { label: 'Employees', value: current.people.length },
            { label: 'Expected days', value: metrics.expected },
            { label: 'Days not recorded', value: metrics.missing },
            { label: 'Records checked', value: current.recordCount },
          ])}`,
          'Fix what you can from the daily or monthly view, then run this again. Reports leave unrecorded days out rather than guessing.',
        ]),
        sources: [
          source('dataset', 'attendance', `Attendance records ${periodLabel(period)} (${current.recordCount})`),
          ...employeeSources(issues),
        ],
        confidence: confidenceFrom({ evidence: current.recordCount, max: 0.85, base: 0.6 }),
        limitation:
          'Checks the records against the working calendar, employment dates and the attendance rules in Settings. It cannot know whether a recorded day is true.',
        data: {
          from: period.from,
          to: period.to,
          ready,
          coverage,
          counts: byCode,
          bySeverity,
          totals: metrics,
          flags: issues,
          decisionAllowed: false,
        },
      };
    },
  },
];
