/**
 * Integrity check for a generated database.
 *
 *   node seed/validate.js                  checks db.json
 *   DB_FILE=./db.seedtest.json node seed/validate.js
 *
 * Verifies that every foreign key points at a record that exists, that attendance and leave
 * agree with each other, and that leave balances add up. Exits non-zero on the first failure
 * so it can be dropped into CI later.
 */

const fs = require('fs');
const path = require('path');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'db.json');

const failures = [];

function check(label, condition, detail) {
  if (!condition) failures.push(detail ? `${label} — ${detail}` : label);
}

/**
 * Employees damaged on purpose by `seed/flaws.js`, so the data-quality engine has something
 * to find. Checks that these records are expected to fail skip them.
 */
let flawed = new Set();

/** Every `field` on `rows` must appear in `target`, unless the value is null. */
function checkRefs(rows, field, target, label) {
  const valid = new Set(target.map((row) => row.id));
  const broken = rows.filter((row) => row[field] != null && !valid.has(row[field]));
  check(label, broken.length === 0, broken.length ? `${broken.length} broken, first: ${broken[0].id} → ${broken[0][field]}` : '');
}

function main() {
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  const {
    employees, departments, designations, locations, attendance, leaveTypes, leaveRequests,
    leaveBalances, salaryStructures, payrollRuns, payslips, jobs, candidates, interviews,
    onboarding, onboardingTasks, performanceCycles, performanceReviews, goals, trainings,
    trainingEnrollments, documents, surveys, surveyResponses, aiRuns, users, settings,
  } = db;

  // --- foreign keys -------------------------------------------------------
  checkRefs(employees, 'departmentId', departments, 'employee.departmentId');
  checkRefs(employees, 'designationId', designations, 'employee.designationId');
  checkRefs(employees, 'locationId', locations, 'employee.locationId');
  checkRefs(employees, 'reportingManagerId', employees, 'employee.reportingManagerId');
  checkRefs(employees, 'teamId', departments, 'employee.teamId');
  checkRefs(departments, 'parentId', departments, 'department.parentId');
  checkRefs(departments, 'headEmployeeId', employees, 'department.headEmployeeId');
  checkRefs(designations, 'departmentId', departments, 'designation.departmentId');
  checkRefs(attendance, 'employeeId', employees, 'attendance.employeeId');
  checkRefs(attendance, 'leaveTypeId', leaveTypes, 'attendance.leaveTypeId');
  checkRefs(leaveRequests, 'employeeId', employees, 'leaveRequest.employeeId');
  checkRefs(leaveRequests, 'leaveTypeId', leaveTypes, 'leaveRequest.leaveTypeId');
  checkRefs(leaveBalances, 'employeeId', employees, 'leaveBalance.employeeId');
  checkRefs(leaveBalances, 'leaveTypeId', leaveTypes, 'leaveBalance.leaveTypeId');
  checkRefs(salaryStructures, 'employeeId', employees, 'salaryStructure.employeeId');
  checkRefs(salaryStructures, 'previousStructureId', salaryStructures, 'salaryStructure.previousStructureId');
  checkRefs(payslips, 'employeeId', employees, 'payslip.employeeId');
  checkRefs(payslips, 'payrollRunId', payrollRuns, 'payslip.payrollRunId');
  checkRefs(jobs, 'departmentId', departments, 'job.departmentId');
  checkRefs(jobs, 'designationId', designations, 'job.designationId');
  checkRefs(jobs, 'hiringManagerId', employees, 'job.hiringManagerId');
  checkRefs(candidates, 'jobId', jobs, 'candidate.jobId');
  checkRefs(candidates, 'referredByEmployeeId', employees, 'candidate.referredByEmployeeId');
  checkRefs(candidates, 'convertedEmployeeId', employees, 'candidate.convertedEmployeeId');
  checkRefs(interviews, 'candidateId', candidates, 'interview.candidateId');
  checkRefs(interviews, 'jobId', jobs, 'interview.jobId');
  checkRefs(onboarding, 'employeeId', employees, 'onboarding.employeeId');
  checkRefs(onboarding, 'candidateId', candidates, 'onboarding.candidateId');
  checkRefs(onboarding, 'buddyEmployeeId', employees, 'onboarding.buddyEmployeeId');
  checkRefs(onboardingTasks, 'onboardingId', onboarding, 'onboardingTask.onboardingId');
  checkRefs(onboardingTasks, 'employeeId', employees, 'onboardingTask.employeeId');
  checkRefs(performanceReviews, 'cycleId', performanceCycles, 'performanceReview.cycleId');
  checkRefs(performanceReviews, 'employeeId', employees, 'performanceReview.employeeId');
  checkRefs(performanceReviews, 'reviewerEmployeeId', employees, 'performanceReview.reviewerEmployeeId');
  checkRefs(goals, 'employeeId', employees, 'goal.employeeId');
  checkRefs(goals, 'cycleId', performanceCycles, 'goal.cycleId');
  checkRefs(trainingEnrollments, 'trainingId', trainings, 'trainingEnrollment.trainingId');
  checkRefs(trainingEnrollments, 'employeeId', employees, 'trainingEnrollment.employeeId');
  checkRefs(documents, 'employeeId', employees, 'document.employeeId');
  checkRefs(surveyResponses, 'surveyId', surveys, 'surveyResponse.surveyId');
  checkRefs(surveyResponses, 'employeeId', employees, 'surveyResponse.employeeId');

  // --- unique ids and keys ------------------------------------------------
  for (const [name, rows] of Object.entries(db)) {
    if (!Array.isArray(rows)) continue;
    const ids = new Set(rows.map((row) => row.id));
    check(`${name}: unique ids`, ids.size === rows.length, `${rows.length - ids.size} duplicates`);
  }

  flawed = new Set((settings.seed && settings.seed.flawedEmployeeIds) || []);
  const clean = employees.filter((employee) => !flawed.has(employee.id));

  const emails = clean.map((employee) => employee.officialEmail);
  check('employee.officialEmail unique', new Set(emails).size === emails.length);

  const attendanceKeys = attendance.map((record) => `${record.employeeId}|${record.date}`);
  check('one attendance record per employee per day', new Set(attendanceKeys).size === attendanceKeys.length);

  // --- business rules -----------------------------------------------------
  const leaveDays = new Set();
  for (const request of leaveRequests.filter((item) => item.status === 'approved')) {
    for (
      let cursor = new Date(`${request.startDate}T00:00:00Z`);
      cursor <= new Date(`${request.endDate}T00:00:00Z`);
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    ) {
      leaveDays.add(`${request.employeeId}|${cursor.toISOString().slice(0, 10)}`);
    }
  }
  const clash = attendance.filter(
    (record) => record.status !== 'leave' && leaveDays.has(`${record.employeeId}|${record.date}`),
  );
  check('no present day inside approved leave', clash.length === 0, `${clash.length} clashes`);

  const badBalance = leaveBalances.filter(
    (balance) => balance.remaining !== Math.max(0, balance.entitled + balance.carriedForward - balance.used - balance.pending),
  );
  check('leave balance arithmetic', badBalance.length === 0, `${badBalance.length} wrong`);

  const negativePay = payslips.filter((payslip) => payslip.net <= 0 || payslip.gross <= 0);
  check('payslip amounts positive', negativePay.length === 0, `${negativePay.length} non-positive`);

  const currentStructures = salaryStructures.filter((structure) => structure.isCurrent);
  check(
    'one current salary structure per employee',
    new Set(currentStructures.map((structure) => structure.employeeId)).size === currentStructures.length,
  );
  const withStructure = new Set(currentStructures.map((structure) => structure.employeeId));
  const missingStructure = clean.filter((employee) => !withStructure.has(employee.id));
  check('every employee has a salary structure', missingStructure.length === 0,
    `${missingStructure.length} without one`);

  const selfManaged = employees.filter((employee) => employee.reportingManagerId === employee.id);
  check('nobody reports to themselves', selfManaged.length === 0);

  const ceo = employees.filter((employee) => employee.reportingManagerId === null);
  check('exactly one employee without a manager', ceo.length === 1, `${ceo.length} found`);

  const badDates = clean.filter((employee) => employee.exit && employee.exit.lastWorkingDate < employee.joiningDate);
  check('exit date is after joining date', badDates.length === 0, `${badDates.length} wrong`);

  // The intentional flaws must actually be present, or the data-quality engine has nothing to find.
  if (settings.seed && settings.seed.flaws && settings.seed.flaws.length) {
    const flawedExist = settings.seed.flaws.every((flaw) => employees.some((employee) => employee.id === flaw.employeeId));
    check('seeded flaws point at real records', flawedExist, `${settings.seed.flaws.length} declared`);
  }

  const draftRuns = payrollRuns.filter((run) => run.status === 'draft');
  check('exactly one draft payroll run', draftRuns.length === 1, `${draftRuns.length} found`);

  const ratedByAi = performanceReviews.filter((review) => review.rating !== null && review.ratedBy === null);
  check('every rating has a human rater', ratedByAi.length === 0, `${ratedByAi.length} unattributed`);

  check('ai runs carry a source', aiRuns.every((run) => Array.isArray(run.sources) && run.sources.length > 0));
  check('ai runs carry a limitation note', aiRuns.every((run) => Boolean(run.limitation)));
  check('reviewed ai runs name a reviewer', aiRuns.filter((run) => run.status !== 'draft').every((run) => Boolean(run.reviewedBy)));

  check('hr login user exists', users.length >= 1 && Boolean(users[0].email));
  check('settings has an ai section', Boolean(settings && settings.ai));

  // --- report -------------------------------------------------------------
  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed:\n`);
    for (const failure of failures) console.error(`  ✗ ${failure}`);
    console.error('');
    process.exit(1);
  }

  console.log(`\nAll integrity checks passed for ${path.basename(DB_FILE)}.\n`);
}

main();
