/**
 * Payroll validation (requirements §5.9).
 *
 * Finds the data problems that make a payroll run wrong — missing attendance, outliers,
 * duplicates, negative net pay — before HR finalises it. It never computes or approves the
 * final salary; the payroll calculation itself stays in the payroll service.
 */

const { bullets, compose, confidenceFrom, money, monthKey, percent, round, source, stats, table } = require('../helpers');

module.exports = [
  {
    id: 'payroll-validation',
    module: 'payroll',
    label: 'Payroll Validation',
    purpose: 'Flags missing attendance, odd deductions and salary outliers',
    input: {
      payrollRunId: 'string — the run to validate (or give a month)',
      month: 'string — YYYY-MM',
    },
    prompt: (input) => `Validate payroll for ${input.payrollRunId || input.month}`,

    run({ input, db, now }) {
      const runs = db.get('payrollRuns');
      const run = input.payrollRunId
        ? runs.find((item) => item.id === input.payrollRunId)
        : runs.find((item) => item.month === (input.month || monthKey(now)));

      if (!run) {
        throw Object.assign(new Error('No payroll run found for the given id or month'), { status: 404 });
      }

      const employees = db.get('employees');
      const structures = db.get('salaryStructures').filter((structure) => structure.isCurrent);
      const payslips = db.get('payslips').filter((payslip) => payslip.payrollRunId === run.id);
      const attendance = db.get('attendance').filter((record) => record.date.startsWith(run.month));
      const designations = db.get('designations');

      const eligible = employees.filter((employee) => {
        const joined = employee.joiningDate;
        const left = employee.exit ? employee.exit.lastWorkingDate : null;
        return joined <= run.periodEnd && (!left || left >= run.periodStart);
      });

      const issues = [];

      // 1. Attendance coverage, per employee in the run.
      const attendanceByEmployee = new Map();
      for (const record of attendance) {
        attendanceByEmployee.set(record.employeeId, (attendanceByEmployee.get(record.employeeId) || 0) + 1);
      }
      const expectedDays = Math.max(0, ...attendanceByEmployee.values());

      for (const employee of eligible) {
        const count = attendanceByEmployee.get(employee.id) || 0;
        if (count === 0) {
          issues.push({
            code: 'missing-attendance',
            severity: 'high',
            employeeId: employee.id,
            message: `${employee.fullName} (${employee.employeeId}) has no attendance records for ${run.month}`,
          });
        } else if (expectedDays && percent(expectedDays - count, expectedDays) >= 20) {
          issues.push({
            code: 'partial-attendance',
            severity: 'medium',
            employeeId: employee.id,
            message: `${employee.fullName} has ${count} of about ${expectedDays} expected attendance days`,
          });
        }
      }

      // 2. Employees in the run with no current salary structure.
      const structureByEmployee = new Map(structures.map((structure) => [structure.employeeId, structure]));
      for (const employee of eligible) {
        if (!structureByEmployee.has(employee.id)) {
          issues.push({
            code: 'no-salary-structure',
            severity: 'high',
            employeeId: employee.id,
            message: `${employee.fullName} has no current salary structure`,
          });
        }
      }

      // 3. Duplicate payslips for the same employee in one run.
      const seen = new Map();
      for (const payslip of payslips) {
        const previous = seen.get(payslip.employeeId);
        if (previous) {
          issues.push({
            code: 'duplicate-payslip',
            severity: 'high',
            employeeId: payslip.employeeId,
            message: `Two payslips exist for the same employee in ${run.month} (${previous.id} and ${payslip.id})`,
          });
        }
        seen.set(payslip.employeeId, payslip);
      }

      // 4. Amount checks on the payslips.
      for (const payslip of payslips) {
        const employee = employees.find((item) => item.id === payslip.employeeId);
        const name = employee ? employee.fullName : payslip.employeeId;

        if (payslip.net <= 0) {
          issues.push({ code: 'non-positive-net', severity: 'high', employeeId: payslip.employeeId, message: `${name} has a net pay of ${money(payslip.net)}` });
        }
        if (payslip.deductionsTotal > payslip.gross * 0.5) {
          issues.push({
            code: 'high-deductions',
            severity: 'medium',
            employeeId: payslip.employeeId,
            message: `${name}: deductions are ${percent(payslip.deductionsTotal, payslip.gross)}% of gross`,
          });
        }
        if (payslip.overtimeAmount > payslip.basic * 0.4) {
          issues.push({
            code: 'high-overtime',
            severity: 'medium',
            employeeId: payslip.employeeId,
            message: `${name}: overtime of ${money(payslip.overtimeAmount)} is over 40% of basic pay`,
          });
        }
        if (payslip.absentDays >= 5) {
          issues.push({
            code: 'high-absence-deduction',
            severity: 'low',
            employeeId: payslip.employeeId,
            message: `${name}: ${payslip.absentDays} absent day(s) deducted (${money(payslip.absenceDeduction)})`,
          });
        }
      }

      // 5. Salary outliers against the designation band and against peers in the same role.
      const byDesignation = new Map();
      for (const structure of structures) {
        const employee = employees.find((item) => item.id === structure.employeeId);
        if (!employee) continue;
        const list = byDesignation.get(employee.designationId) || [];
        list.push({ employee, structure });
        byDesignation.set(employee.designationId, list);
      }

      for (const [designationId, list] of byDesignation) {
        const designation = designations.find((item) => item.id === designationId);
        if (!designation) continue;

        for (const { employee, structure } of list) {
          const annual = structure.monthlyGross * 12;
          if (annual < designation.salaryBand.min * 0.85 || annual > designation.salaryBand.max * 1.15) {
            issues.push({
              code: 'outside-band',
              severity: 'medium',
              employeeId: employee.id,
              message: `${employee.fullName}: annual ${money(annual)} sits outside the ${designation.title} band (${money(designation.salaryBand.min)}–${money(designation.salaryBand.max)})`,
            });
          }
        }

        if (list.length >= 4) {
          const values = list.map((item) => item.structure.monthlyGross);
          const { mean, stdDev } = stats(values);
          for (const { employee, structure } of list) {
            if (stdDev > 0 && Math.abs(structure.monthlyGross - mean) > stdDev * 2.5) {
              issues.push({
                code: 'peer-outlier',
                severity: 'low',
                employeeId: employee.id,
                message: `${employee.fullName}: monthly gross ${money(structure.monthlyGross)} is far from the ${designation.title} average of ${money(mean)}`,
              });
            }
          }
        }
      }

      const bySeverity = {
        high: issues.filter((issue) => issue.severity === 'high').length,
        medium: issues.filter((issue) => issue.severity === 'medium').length,
        low: issues.filter((issue) => issue.severity === 'low').length,
      };

      const blocking = bySeverity.high;

      return {
        output: compose([
          `Payroll validation — ${run.month} (${run.status}): ${issues.length} issue(s), ${bySeverity.high} high, ${bySeverity.medium} medium, ${bySeverity.low} low.`,
          `Run totals\n${table([
            { label: 'Employees', value: run.employeeCount },
            { label: 'Payslips', value: payslips.length },
            { label: 'Gross', value: money(run.totalGross) },
            { label: 'Deductions', value: money(run.totalDeductions) },
            { label: 'Net', value: money(run.totalNet) },
            { label: 'Attendance records', value: attendance.length },
          ])}`,
          issues.length
            ? `Issues\n${bullets(issues.slice(0, 40).map((issue) => `[${issue.severity}] ${issue.message}`))}`
            : 'No issues found in the checks that ran.',
          issues.length > 40 ? `… and ${issues.length - 40} more.` : null,
          blocking
            ? `${blocking} high-severity issue(s) should be resolved or explicitly acknowledged before the run is finalised.`
            : 'No high-severity issues are blocking finalisation.',
          'This validates data only. It does not calculate or approve any salary — payroll figures come from the payroll service and are finalised by HR.',
        ]),
        sources: [
          source('report', run.id, `Payroll run ${run.month}`),
          source('dataset', 'attendance', `Attendance for ${run.month} (${attendance.length} records)`),
          source('dataset', 'salaryStructures', `Current salary structures (${structures.length})`),
        ],
        confidence: confidenceFrom({ evidence: payslips.length + attendance.length / 10, max: 0.88, base: 0.6 }),
        limitation:
          'Threshold and completeness checks only. It cannot tell a correct unusual payment from a mistake, and it does not recompute the payroll.',
        data: {
          payrollRunId: run.id,
          month: run.month,
          issues,
          bySeverity,
          blockingCount: blocking,
          finalizeAllowed: false,
          attendanceCoverage: percent(attendanceByEmployee.size, eligible.length || 1),
          averageNet: payslips.length ? round(payslips.reduce((sum, item) => sum + item.net, 0) / payslips.length, 0) : 0,
        },
      };
    },
  },
];
