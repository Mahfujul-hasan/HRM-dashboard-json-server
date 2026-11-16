/**
 * Attendance anomaly detection and trend explanation (requirements §5.7).
 *
 * Flags are thresholds over recorded attendance, not judgements: each one names the employee,
 * the number and the threshold it crossed, so HR can confirm or dismiss it. A flag is never a
 * disciplinary conclusion — the data itself may be wrong, which is why missing records are
 * reported alongside the behavioural flags.
 */

const { addDays, bullets, compose, confidenceFrom, percent, round, source, table, ymd } = require('../helpers');

/** Thresholds that turn a count into a flag. */
const THRESHOLDS = {
  lateRatePercent: 30,
  absenceCount: 3,
  overtimeHours: 25,
  missingRatePercent: 15,
  longDayMinutes: 660,
};

module.exports = [
  {
    id: 'attendance-insight',
    module: 'attendance',
    label: 'Attendance Insight',
    purpose: 'Detects late arrivals, absences, overtime and anomalies',
    input: {
      days: 'number — window size, default 30',
      departmentId: 'string — limit to one department (optional)',
      employeeId: 'string — limit to one employee (optional)',
    },
    prompt: (input) =>
      `Find attendance anomalies over the last ${input.days || 30} days${input.departmentId ? ` for department ${input.departmentId}` : ''}`,

    run({ input, db, now }) {
      const days = Number(input.days || 30);
      const from = ymd(addDays(now, -days));
      const to = ymd(now);

      let employees = db.get('employees').filter((employee) => ['active', 'probation'].includes(employee.status));
      if (input.departmentId) employees = employees.filter((employee) => employee.departmentId === input.departmentId);
      if (input.employeeId) employees = employees.filter((employee) => employee.id === input.employeeId);
      if (!employees.length) throw Object.assign(new Error('No employees match the filter'), { status: 404 });

      const employeeIds = new Set(employees.map((employee) => employee.id));
      const records = db
        .get('attendance')
        .filter((record) => record.date >= from && record.date <= to && employeeIds.has(record.employeeId));

      if (!records.length) {
        return {
          output: `No attendance records between ${from} and ${to} for the selected employees. Import or enter attendance before running this check.`,
          sources: [source('dataset', 'attendance', `Attendance ${from} to ${to}`)],
          confidence: 0.3,
          limitation: 'No data in the window — absence of records is not absence of attendance.',
          data: { from, to, flags: [] },
        };
      }

      // Working days in the window, taken from the densest employee's record count.
      const perEmployee = new Map();
      for (const record of records) {
        const bucket = perEmployee.get(record.employeeId) || {
          present: 0, late: 0, absent: 0, leave: 0, halfDay: 0, wfh: 0,
          lateMinutes: 0, overtimeMinutes: 0, longDays: 0, total: 0,
        };
        bucket.total += 1;
        bucket.lateMinutes += record.lateMinutes || 0;
        bucket.overtimeMinutes += record.overtimeMinutes || 0;
        if ((record.workedMinutes || 0) >= THRESHOLDS.longDayMinutes) bucket.longDays += 1;
        if (record.status === 'late') bucket.late += 1;
        else if (record.status === 'absent') bucket.absent += 1;
        else if (record.status === 'leave') bucket.leave += 1;
        else if (record.status === 'half-day') bucket.halfDay += 1;
        else if (record.status === 'work-from-home') bucket.wfh += 1;
        else bucket.present += 1;
        perEmployee.set(record.employeeId, bucket);
      }

      const expectedDays = Math.max(...[...perEmployee.values()].map((bucket) => bucket.total));
      const flags = [];

      for (const employee of employees) {
        const bucket = perEmployee.get(employee.id);
        if (!bucket) {
          flags.push({
            type: 'missing-records',
            severity: 'high',
            employeeId: employee.id,
            message: `${employee.fullName} has no attendance record at all in this window`,
          });
          continue;
        }

        const workedDays = bucket.total - bucket.leave;
        const lateRate = percent(bucket.late, workedDays || 1);
        const overtimeHours = round(bucket.overtimeMinutes / 60, 1);
        const missingRate = percent(expectedDays - bucket.total, expectedDays || 1);

        if (lateRate >= THRESHOLDS.lateRatePercent) {
          flags.push({
            type: 'frequent-late',
            severity: lateRate >= 50 ? 'high' : 'medium',
            employeeId: employee.id,
            message: `${employee.fullName} was late on ${bucket.late} of ${workedDays} working days (${lateRate}%, threshold ${THRESHOLDS.lateRatePercent}%), averaging ${round(bucket.lateMinutes / Math.max(1, bucket.late), 0)} minutes`,
          });
        }
        if (bucket.absent >= THRESHOLDS.absenceCount) {
          flags.push({
            type: 'frequent-absence',
            severity: bucket.absent >= 6 ? 'high' : 'medium',
            employeeId: employee.id,
            message: `${employee.fullName} has ${bucket.absent} unexplained absences (threshold ${THRESHOLDS.absenceCount})`,
          });
        }
        if (overtimeHours >= THRESHOLDS.overtimeHours) {
          flags.push({
            type: 'excessive-overtime',
            severity: overtimeHours >= 45 ? 'high' : 'medium',
            employeeId: employee.id,
            message: `${employee.fullName} logged ${overtimeHours} overtime hours (threshold ${THRESHOLDS.overtimeHours}) across ${bucket.longDays} long days`,
          });
        }
        if (missingRate >= THRESHOLDS.missingRatePercent) {
          flags.push({
            type: 'missing-records',
            severity: 'medium',
            employeeId: employee.id,
            message: `${employee.fullName} is missing ${expectedDays - bucket.total} day(s) of attendance data (${missingRate}% of the window)`,
          });
        }
      }

      const totals = [...perEmployee.values()].reduce(
        (sum, bucket) => ({
          present: sum.present + bucket.present,
          late: sum.late + bucket.late,
          absent: sum.absent + bucket.absent,
          leave: sum.leave + bucket.leave,
          overtimeMinutes: sum.overtimeMinutes + bucket.overtimeMinutes,
        }),
        { present: 0, late: 0, absent: 0, leave: 0, overtimeMinutes: 0 },
      );

      const bySeverity = { high: flags.filter((flag) => flag.severity === 'high').length, medium: flags.filter((flag) => flag.severity === 'medium').length };
      const correctionCount = records.filter((record) => record.corrected).length;

      const trend = compose([
        `Across ${employees.length} employee(s) and ${records.length} records, ${percent(totals.late, records.length)}% of days were late arrivals, ${percent(totals.absent, records.length)}% absences and ${percent(totals.leave, records.length)}% approved leave.`,
        `Overtime totalled ${round(totals.overtimeMinutes / 60, 1)} hours${correctionCount ? `, and ${correctionCount} record(s) were manually corrected` : ''}.`,
      ]);

      return {
        output: compose([
          `Attendance review ${from} to ${to} — ${flags.length} flag(s): ${bySeverity.high} high, ${bySeverity.medium} medium.`,
          trend,
          flags.length ? `Flags\n${bullets(flags.map((flag) => `[${flag.severity}] ${flag.message}`))}` : 'No thresholds were crossed in this window.',
          `Totals\n${table([
            { label: 'Records', value: records.length },
            { label: 'Late days', value: totals.late },
            { label: 'Absences', value: totals.absent },
            { label: 'Leave days', value: totals.leave },
            { label: 'Overtime hours', value: round(totals.overtimeMinutes / 60, 1) },
            { label: 'Corrected records', value: correctionCount },
          ])}`,
          'Confirm or dismiss each flag before it reaches a report. A flag may reflect a data problem rather than behaviour.',
        ]),
        sources: [
          source('dataset', 'attendance', `Attendance records ${from} to ${to} (${records.length})`),
          ...flags.slice(0, 5).map((flag) => source('employee', flag.employeeId, flag.message.split(' ')[0])),
        ],
        confidence: confidenceFrom({ evidence: records.length, max: 0.8, base: 0.55 }),
        limitation:
          'Fixed thresholds over recorded data. Approved leave, business travel and missing imports can all look like a pattern here.',
        data: { from, to, thresholds: THRESHOLDS, flags, totals, employeeCount: employees.length },
      };
    },
  },
];
