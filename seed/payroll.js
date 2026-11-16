/**
 * Salary structures, monthly payroll runs and payslips (requirements §5.9).
 *
 * Amounts are whole US dollars. Tax uses simplified progressive brackets on the annualised
 * gross — enough for realistic numbers, not a real tax engine.
 */

const { faker } = require('@faker-js/faker');
const config = require('./config');
const { addDays, addMonths, chance, endOfMonth, id, intBetween, iso, money, monthKey, pick, startOfMonth, ymd } = require('./utils');

/** Simplified annual brackets: [upper bound, rate]. */
const TAX_BRACKETS = [
  [11600, 0.1],
  [47150, 0.12],
  [100525, 0.22],
  [191950, 0.24],
  [243725, 0.32],
  [Infinity, 0.35],
];

const COMPONENT_SPLIT = { basic: 0.55, housing: 0.2, transport: 0.08, medical: 0.07, other: 0.1 };

function annualTax(annualGross) {
  let remaining = annualGross;
  let previousCap = 0;
  let tax = 0;

  for (const [cap, rate] of TAX_BRACKETS) {
    if (remaining <= 0) break;
    const taxable = Math.min(remaining, cap - previousCap);
    tax += taxable * rate;
    remaining -= taxable;
    previousCap = cap;
  }

  return tax;
}

/** Splits a monthly gross into the components every payslip and salary structure uses. */
function splitComponents(monthlyGross) {
  const basic = money(monthlyGross * COMPONENT_SPLIT.basic);
  const allowances = {
    housing: money(monthlyGross * COMPONENT_SPLIT.housing),
    transport: money(monthlyGross * COMPONENT_SPLIT.transport),
    medical: money(monthlyGross * COMPONENT_SPLIT.medical),
    other: money(monthlyGross * COMPONENT_SPLIT.other),
  };
  const allowancesTotal = Object.values(allowances).reduce((sum, value) => sum + value, 0);

  const tax = money(annualTax(monthlyGross * 12) / 12);
  const retirement = money(basic * 0.05);
  const insurance = 120;
  const deductions = { tax, retirement, insurance, other: 0 };
  const deductionsTotal = Object.values(deductions).reduce((sum, value) => sum + value, 0);

  return {
    basic,
    allowances,
    allowancesTotal,
    deductions,
    deductionsTotal,
    gross: basic + allowancesTotal,
    net: basic + allowancesTotal - deductionsTotal,
  };
}

function buildPayroll({ employees, designations, attendance, hrUser }) {
  const now = config.TODAY;
  const months = Math.min(config.HISTORY_MONTHS, 12);

  const salaryStructures = [];
  const payrollRuns = [];
  const payslips = [];

  let structureIndex = 1;
  let runIndex = 1;
  let payslipIndex = 1;

  /** Current monthly gross per employee, used when building payslips. */
  const currentGross = new Map();

  for (const employee of employees) {
    const designation = designations.find((item) => item.id === employee.designationId);
    const { min, max } = designation.salaryBand;
    const spread = max - min;
    const seniorityFactor = Math.min(1, employee.experienceYears / (designation.minExperienceYears + 8));
    const annual = money(min + spread * (0.25 + seniorityFactor * 0.65));

    const joined = new Date(`${employee.joiningDate}T00:00:00Z`);
    // One structure at joining, plus a revision for roughly every two years of tenure.
    const tenureYears = (now - joined) / 31557600000;
    const revisionCount = Math.min(3, Math.floor(tenureYears / 2) + (chance(0.3) ? 1 : 0));

    let previousId = null;
    let monthlyGross = money((annual / 12) / Math.pow(1.07, revisionCount));

    for (let revision = 0; revision <= revisionCount; revision += 1) {
      const effectiveFrom = revision === 0 ? joined : addMonths(joined, Math.round((tenureYears * 12 * revision) / (revisionCount + 1)));
      if (revision > 0) monthlyGross = money(monthlyGross * (1.05 + faker.number.float({ min: 0, max: 0.06 })));

      const components = splitComponents(monthlyGross);
      const structure = {
        id: id('sal', structureIndex++, 4),
        employeeId: employee.id,
        effectiveFrom: ymd(effectiveFrom),
        currency: config.CURRENCY,
        payFrequency: 'monthly',
        basic: components.basic,
        allowances: components.allowances,
        deductions: components.deductions,
        monthlyGross: components.gross,
        monthlyNet: components.net,
        annualGross: components.gross * 12,
        bankName: pick(['Chase', 'Bank of America', 'Wells Fargo', 'Citibank', 'US Bank']),
        bankAccountNumber: `****${intBetween(1000, 9999)}`,
        taxId: `***-**-${intBetween(1000, 9999)}`,
        revisionReason:
          revision === 0
            ? 'Initial salary on joining'
            : pick(['Annual increment', 'Promotion', 'Market adjustment', 'Performance increase']),
        previousStructureId: previousId,
        isCurrent: revision === revisionCount,
        approvedBy: hrUser.id,
        createdAt: iso(effectiveFrom),
      };

      salaryStructures.push(structure);
      previousId = structure.id;
      if (structure.isCurrent) currentGross.set(employee.id, structure);
    }
  }

  // Index attendance by employee and month so payslips can use real absence and overtime.
  const attendanceByKey = new Map();
  for (const record of attendance) {
    const key = `${record.employeeId}|${record.date.slice(0, 7)}`;
    const bucket = attendanceByKey.get(key) || { absent: 0, overtimeMinutes: 0, days: 0, leave: 0 };
    bucket.days += 1;
    if (record.status === 'absent') bucket.absent += 1;
    if (record.status === 'leave') bucket.leave += 1;
    bucket.overtimeMinutes += record.overtimeMinutes || 0;
    attendanceByKey.set(key, bucket);
  }

  for (let offset = months - 1; offset >= 0; offset -= 1) {
    const monthDate = addMonths(now, -offset);
    const month = monthKey(monthDate);
    const periodStart = startOfMonth(monthDate);
    const periodEnd = endOfMonth(monthDate);
    const isCurrentMonth = offset === 0;

    const eligible = employees.filter((employee) => {
      const joined = new Date(`${employee.joiningDate}T00:00:00Z`);
      const leftOn = employee.exit ? new Date(`${employee.exit.lastWorkingDate}T00:00:00Z`) : null;
      return joined <= periodEnd && (!leftOn || leftOn >= periodStart);
    });

    const runId = id('pr', runIndex++, 3);
    const warnings = [];
    let totalGross = 0;
    let totalDeductions = 0;
    let totalNet = 0;

    for (const employee of eligible) {
      const structure = currentGross.get(employee.id);
      if (!structure) continue;

      const bucket = attendanceByKey.get(`${employee.id}|${month}`) || { absent: 0, overtimeMinutes: 0, days: 0 };
      const workingDays = Math.max(1, bucket.days || 21);
      const dailyRate = structure.monthlyGross / workingDays;
      const hourlyRate = dailyRate / 8;

      const absenceDeduction = money(bucket.absent * dailyRate);
      const overtimeAmount = money((bucket.overtimeMinutes / 60) * hourlyRate * 1.5);
      const deductionsTotal = Object.values(structure.deductions).reduce((sum, value) => sum + value, 0) + absenceDeduction;
      const gross = structure.monthlyGross + overtimeAmount;
      const net = gross - deductionsTotal;

      if (!bucket.days) {
        warnings.push({
          code: 'missing-attendance',
          employeeId: employee.id,
          message: `No attendance records for ${employee.fullName} in ${month}`,
          severity: 'high',
        });
      }
      if (overtimeAmount > structure.monthlyGross * 0.25) {
        warnings.push({
          code: 'high-overtime',
          employeeId: employee.id,
          message: `Overtime is over 25% of gross for ${employee.fullName}`,
          severity: 'medium',
        });
      }

      totalGross += gross;
      totalDeductions += deductionsTotal;
      totalNet += net;

      if (!isCurrentMonth) {
        payslips.push({
          id: id('ps', payslipIndex++, 5),
          payrollRunId: runId,
          employeeId: employee.id,
          employeeCode: employee.employeeId,
          month,
          currency: config.CURRENCY,
          basic: structure.basic,
          allowances: structure.allowances,
          allowancesTotal: structure.monthlyGross - structure.basic,
          overtimeMinutes: bucket.overtimeMinutes,
          overtimeAmount,
          absentDays: bucket.absent,
          absenceDeduction,
          deductions: structure.deductions,
          deductionsTotal,
          gross,
          net,
          paymentStatus: 'paid',
          paidOn: ymd(addDays(periodEnd, 2)),
          generatedAt: iso(addDays(periodEnd, 1)),
        });
      }
    }

    payrollRuns.push({
      id: runId,
      month,
      periodStart: ymd(periodStart),
      periodEnd: ymd(periodEnd),
      status: isCurrentMonth ? 'draft' : 'finalized',
      currency: config.CURRENCY,
      employeeCount: eligible.length,
      totalGross: money(totalGross),
      totalDeductions: money(totalDeductions),
      totalNet: money(totalNet),
      validationWarnings: warnings,
      warningsResolved: !isCurrentMonth,
      preparedBy: hrUser.id,
      finalizedBy: isCurrentMonth ? null : hrUser.id,
      finalizedAt: isCurrentMonth ? null : iso(addDays(periodEnd, 1)),
      createdAt: iso(periodStart),
      updatedAt: iso(isCurrentMonth ? now : addDays(periodEnd, 1)),
    });
  }

  return { salaryStructures, payrollRuns, payslips };
}

module.exports = { buildPayroll, splitComponents, annualTax };
