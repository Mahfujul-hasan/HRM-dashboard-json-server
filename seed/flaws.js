/**
 * Deliberate data flaws.
 *
 * The rest of the seed is consistent, which leaves the data-quality checker with nothing to
 * report and no way to demonstrate the review flow. This module damages a handful of records
 * on purpose — the kinds of mistakes a real HRMS collects: a missing field, a duplicate email,
 * a shared phone number, an impossible date, a status that contradicts the record.
 *
 * Every damaged record id is written to `settings.seed.flawedEmployeeIds` so `validate.js`
 * knows which failures are intentional. Run with `FLAWS=off` for a spotless database.
 */

const { intBetween } = require('./utils');

function applyFlaws({ employees, salaryStructures, designations }) {
  if (process.env.FLAWS === 'off') return { flawedEmployeeIds: [], flaws: [] };

  const flaws = [];
  const used = new Set();

  /** Picks an employee not already damaged, skipping department heads and the CEO. */
  const takeVictim = (predicate = () => true) => {
    const candidate = employees.find(
      (employee) =>
        !used.has(employee.id) &&
        employee.reportingManagerId !== null &&
        predicate(employee),
    );
    if (candidate) used.add(candidate.id);
    return candidate;
  };

  const record = (employee, type, detail) => {
    if (employee) flaws.push({ employeeId: employee.id, employeeCode: employee.employeeId, type, detail });
  };

  // 1. Missing contact field.
  const noPhone = takeVictim();
  if (noPhone) {
    noPhone.phone = '';
    record(noPhone, 'missing-field', 'phone cleared');
  }

  // 2. Duplicate official email — two records claiming the same mailbox.
  const emailSource = takeVictim();
  const emailCopy = takeVictim();
  if (emailSource && emailCopy) {
    emailCopy.officialEmail = emailSource.officialEmail;
    record(emailCopy, 'duplicate-email', `shares ${emailSource.officialEmail} with ${emailSource.employeeId}`);
  }

  // 3. Shared phone number, typed from the same form twice.
  const phoneSource = takeVictim();
  const phoneCopy = takeVictim();
  if (phoneSource && phoneCopy) {
    phoneCopy.phone = phoneSource.phone;
    record(phoneCopy, 'duplicate-phone', `shares a phone number with ${phoneSource.employeeId}`);
  }

  // 4. Impossible date of birth, from a mistyped year.
  const badDob = takeVictim();
  if (badDob) {
    badDob.dateOfBirth = `19${intBetween(10, 29)}-0${intBetween(1, 9)}-1${intBetween(0, 9)}`;
    record(badDob, 'implausible-dob', badDob.dateOfBirth);
  }

  // 5. Probation ending before the joining date.
  const badProbation = takeVictim();
  if (badProbation) {
    const joined = new Date(`${badProbation.joiningDate}T00:00:00Z`);
    joined.setUTCMonth(joined.getUTCMonth() - 2);
    badProbation.probationEndDate = joined.toISOString().slice(0, 10);
    record(badProbation, 'probation-before-joining', badProbation.probationEndDate);
  }

  // 6. Active employee still carrying exit information — an exit that was reversed.
  const reversedExit = takeVictim((employee) => employee.status === 'active');
  if (reversedExit) {
    const lastWorkingDate = reversedExit.joiningDate;
    reversedExit.exit = {
      resignationDate: lastWorkingDate,
      lastWorkingDate,
      reason: 'Resignation withdrawn',
      interviewNotes: '',
      clearanceStatus: 'pending',
      rehireEligible: true,
    };
    record(reversedExit, 'active-with-exit', 'status active but exit information present');
  }

  // 7. Designation belonging to another department.
  const mismatched = takeVictim();
  if (mismatched) {
    const foreign = designations.find((designation) => designation.departmentId !== mismatched.departmentId);
    if (foreign) {
      mismatched.designationId = foreign.id;
      record(mismatched, 'designation-department-mismatch', `${foreign.title} is not in this department`);
    }
  }

  // 8. Paid employee with no current salary structure — the row was deleted, not replaced.
  const noSalary = takeVictim((employee) => ['active', 'probation'].includes(employee.status));
  if (noSalary) {
    for (let index = salaryStructures.length - 1; index >= 0; index -= 1) {
      if (salaryStructures[index].employeeId === noSalary.id) salaryStructures.splice(index, 1);
    }
    record(noSalary, 'no-salary-structure', 'salary structures removed');
  }

  // 9. Invalid email format, from a typo.
  const badEmail = takeVictim();
  if (badEmail) {
    badEmail.personalEmail = badEmail.personalEmail.replace('@', ' at ');
    record(badEmail, 'invalid-email', badEmail.personalEmail);
  }

  return { flawedEmployeeIds: [...used], flaws };
}

module.exports = { applyFlaws };
