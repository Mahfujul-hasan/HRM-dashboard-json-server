/**
 * Seed generator for the HR dashboard mock API.
 *
 *   npm run seed                      100 employees, 12 months of history
 *   EMPLOYEES=25 MONTHS=3 npm run seed
 *   SEED_TODAY=2026-11-16 npm run seed   pins "today" for a byte-identical run
 *
 * The existing db.json is copied to db.backup.json before it is replaced.
 */

const fs = require('fs');
const path = require('path');
const { faker } = require('@faker-js/faker');

const config = require('./config');
const { buildOrg } = require('./org');
const { buildEmployees } = require('./employees');
const { buildLeave } = require('./leave');
const { buildAttendance } = require('./attendance');
const { buildPayroll } = require('./payroll');
const { buildRecruitment } = require('./recruitment');
const { buildOnboarding } = require('./onboarding');
const { buildPerformance } = require('./performance');
const { buildTraining } = require('./training');
const { buildDocuments } = require('./documents');
const { applyFlaws } = require('./flaws');
const { buildEngagement } = require('./engagement');
const { HR_USER, buildSettings, buildAiRuns, buildAuditLogs, buildNotifications } = require('./system');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'db.json');

function generate() {
  faker.seed(config.SEED);

  const hrUser = { ...HR_USER };
  const { locations, departments, designations, leaveTypes, holidays } = buildOrg();
  const employees = buildEmployees({ departments, designations, locations });

  // An HR employee record stands behind the login, so audit entries point at a real person.
  const hrEmployee = employees.find((employee) => {
    const designation = designations.find((item) => item.id === employee.designationId);
    return designation && designation.title === 'HR Director';
  });
  if (hrEmployee) {
    hrUser.employeeId = hrEmployee.id;
    hrUser.name = hrEmployee.fullName;
  }

  const { leaveBalances, leaveRequests, leaveDayMap } = buildLeave({ employees, leaveTypes, holidays, hrUser });
  const { attendance } = buildAttendance({ employees, holidays, leaveDayMap });
  const { salaryStructures, payrollRuns, payslips } = buildPayroll({ employees, designations, attendance, hrUser });
  const { jobs, candidates, interviews } = buildRecruitment({ departments, designations, locations, employees, hrUser });
  const { onboarding, onboardingTasks } = buildOnboarding({ employees, candidates, hrUser });
  const { performanceCycles, goals, performanceReviews } = buildPerformance({ employees, hrUser });
  const { trainings, trainingEnrollments } = buildTraining({ employees, departments, hrUser });
  const { documents } = buildDocuments({ employees, hrUser });
  const { announcements, surveys, surveyResponses } = buildEngagement({ employees, departments, locations, hrUser });

  const aiRuns = buildAiRuns({ employees, documents, candidates, leaveRequests, payrollRuns, hrUser });
  const auditLogs = buildAuditLogs({ employees, leaveRequests, payrollRuns, documents, aiRuns, hrUser });
  const notifications = buildNotifications({ documents, onboardingTasks, leaveRequests, employees });

  hrUser.lastLoginAt = auditLogs.find((entry) => entry.action === 'auth.login')?.createdAt || null;

  // Applied last, so nothing downstream is generated from a damaged record.
  const { flawedEmployeeIds, flaws } = applyFlaws({ employees, salaryStructures, designations });
  const settings = buildSettings();
  settings.seed = {
    generatedAt: new Date().toISOString(),
    employeeCount: employees.length,
    historyMonths: config.HISTORY_MONTHS,
    fakerSeed: config.SEED,
    /** Records damaged on purpose, so validate.js can tell them from real breakage. */
    flawedEmployeeIds,
    flaws,
  };

  return {
    users: [hrUser],
    employees,
    departments,
    designations,
    locations,
    attendance,
    leaveTypes,
    leaveRequests,
    leaveBalances,
    holidays,
    salaryStructures,
    payrollRuns,
    payslips,
    jobs,
    candidates,
    interviews,
    onboarding,
    onboardingTasks,
    performanceCycles,
    performanceReviews,
    goals,
    trainings,
    trainingEnrollments,
    documents,
    announcements,
    surveys,
    surveyResponses,
    notifications,
    auditLogs,
    aiRuns,
    /** Chat threads with the assistant; filled at runtime, not seeded. */
    aiConversations: [],
    settings,
  };
}

function main() {
  const started = Date.now();

  if (fs.existsSync(DB_FILE)) {
    const backup = DB_FILE.replace(/\.json$/, '.backup.json');
    fs.copyFileSync(DB_FILE, backup);
    console.log(`Backed up existing database to ${path.basename(backup)}`);
  }

  const db = generate();
  fs.writeFileSync(DB_FILE, `${JSON.stringify(db, null, 2)}\n`);

  const sizeMb = (fs.statSync(DB_FILE).size / 1048576).toFixed(1);
  const rows = Object.entries(db)
    .map(([name, value]) => `  ${name.padEnd(22)} ${Array.isArray(value) ? value.length : 1}`)
    .join('\n');

  console.log(
    [
      '',
      `Seeded ${path.basename(DB_FILE)} (${sizeMb} MB) in ${Date.now() - started}ms`,
      `Employees: ${config.EMPLOYEE_COUNT} · history: ${config.HISTORY_MONTHS} months · faker seed: ${config.SEED}`,
      '',
      rows,
      '',
      `Login: ${HR_USER.email} / ${HR_USER.password}`,
      '',
    ].join('\n'),
  );
}

if (require.main === module) main();

module.exports = { generate };
