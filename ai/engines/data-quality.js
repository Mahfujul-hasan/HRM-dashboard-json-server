/**
 * Data-quality checker (requirements §5.3, §5.16).
 *
 * Scans employee records for missing fields, duplicates, impossible dates and broken links to
 * other collections. Every issue names the record and the field so HR can jump straight to it.
 */

const { bullets, compose, confidenceFrom, daysBetween, percent, source, table, tally } = require('../helpers');

/** Fields an active employee record is expected to have. */
const REQUIRED_FIELDS = [
  'fullName', 'employeeId', 'officialEmail', 'phone', 'dateOfBirth', 'gender',
  'departmentId', 'designationId', 'joiningDate', 'locationId', 'employmentType',
];

const EMAIL_PATTERN = /^[\w.+-]+@[\w-]+\.[\w.-]{2,}$/;

/** A real calendar date written as YYYY-MM-DD ("2026-02-31" has the shape and is not one). */
function isRealDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  if (!match) return false;
  const [, year, month, day] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Normalised phone, so formatting differences do not hide a duplicate. */
function normalisePhone(value) {
  return String(value || '').replace(/\D/g, '').slice(-10);
}

module.exports = [
  {
    id: 'data-quality-checker',
    module: 'data-quality',
    label: 'Data-Quality Checker',
    purpose: 'Detects duplicate, missing, invalid or inconsistent HR data',
    input: {
      employeeId: 'string — check a single record (optional)',
      scope: 'string — employees | all, default employees',
    },
    prompt: (input) =>
      input.employeeId ? `Check the record of employee ${input.employeeId}` : 'Check employee data quality',

    run({ input, db, now }) {
      const all = db.get('employees');
      const employees = input.employeeId ? all.filter((employee) => employee.id === input.employeeId) : all;
      if (!employees.length) throw Object.assign(new Error('No employee records match'), { status: 404 });

      const departments = new Set(db.get('departments').map((department) => department.id));
      const designations = db.get('designations');
      const designationIds = new Set(designations.map((designation) => designation.id));
      const locations = new Set(db.get('locations').map((location) => location.id));
      const structures = new Set(db.get('salaryStructures').filter((item) => item.isCurrent).map((item) => item.employeeId));

      const issues = [];
      // `relatedIds` names the other records an issue is about, so a duplicate can be opened
      // side by side with the record it duplicates.
      const add = (employee, code, severity, field, message, relatedIds) =>
        issues.push({
          code,
          severity,
          field,
          employeeId: employee.id,
          employeeName: employee.fullName,
          message,
          ...(relatedIds && relatedIds.length ? { relatedIds } : {}),
        });
      const teams = new Map(db.get('departments').map((department) => [department.id, department]));

      // Duplicate detection runs across the whole collection, not just the filtered set.
      const emailCounts = new Map();
      const phoneCounts = new Map();
      const nameDobCounts = new Map();

      for (const employee of all) {
        const email = String(employee.officialEmail || '').toLowerCase();
        const personal = String(employee.personalEmail || '').toLowerCase();
        for (const value of new Set([email, personal].filter(Boolean))) {
          emailCounts.set(value, [...(emailCounts.get(value) || []), employee]);
        }
        const phone = normalisePhone(employee.phone);
        if (phone.length === 10) phoneCounts.set(phone, [...(phoneCounts.get(phone) || []), employee]);
        const key = `${String(employee.fullName).toLowerCase()}|${employee.dateOfBirth}`;
        nameDobCounts.set(key, [...(nameDobCounts.get(key) || []), employee]);
      }

      for (const employee of employees) {
        // 1. Missing required fields.
        for (const field of REQUIRED_FIELDS) {
          if (employee[field] === null || employee[field] === undefined || employee[field] === '') {
            add(employee, 'missing-field', 'high', field, `${employee.fullName}: ${field} is empty`);
          }
        }

        // 1b. Fields every record should have but that do not stop it working.
        for (const field of ['personalEmail', 'presentAddress', 'permanentAddress']) {
          if (!employee[field]) add(employee, 'incomplete-record', 'low', field, `${employee.fullName}: ${field} is empty`);
        }
        const emergency = employee.emergencyContact || {};
        if (!emergency.name || !emergency.phone) {
          add(employee, 'incomplete-record', 'low', 'emergencyContact', `${employee.fullName}: emergency contact is incomplete`);
        }

        // 2. Format checks.
        for (const [field, label] of [['officialEmail', 'official'], ['personalEmail', 'personal']]) {
          if (employee[field] && !EMAIL_PATTERN.test(employee[field])) {
            add(employee, 'invalid-email', 'medium', field, `${employee.fullName}: ${label} email "${employee[field]}" is not a valid address`);
          }
        }
        if (employee.phone && normalisePhone(employee.phone).length < 10) {
          add(employee, 'invalid-phone', 'low', 'phone', `${employee.fullName}: phone number looks incomplete`);
        }

        // 3. Date sanity.
        for (const field of ['dateOfBirth', 'joiningDate', 'probationEndDate', 'confirmationDate']) {
          if (employee[field] && !isRealDate(employee[field])) {
            add(employee, 'invalid-date', 'high', field, `${employee.fullName}: ${field} "${employee[field]}" is not a real date`);
          }
        }
        const birth = employee.dateOfBirth ? new Date(`${employee.dateOfBirth}T00:00:00Z`) : null;
        const joined = employee.joiningDate ? new Date(`${employee.joiningDate}T00:00:00Z`) : null;

        if (birth) {
          const age = Math.floor(daysBetween(birth, now) / 365.25);
          if (age < 16 || age > 80) {
            add(employee, 'implausible-dob', 'medium', 'dateOfBirth', `${employee.fullName}: date of birth gives an age of ${age}`);
          }
          if (joined && birth >= joined) {
            add(employee, 'dob-after-joining', 'high', 'dateOfBirth', `${employee.fullName}: date of birth is on or after the joining date`);
          }
        }
        if (joined && joined > now) {
          add(employee, 'future-joining', 'low', 'joiningDate', `${employee.fullName}: joining date ${employee.joiningDate} is in the future`);
        }
        if (employee.probationEndDate && employee.joiningDate && employee.probationEndDate < employee.joiningDate) {
          add(employee, 'probation-before-joining', 'high', 'probationEndDate', `${employee.fullName}: probation ends before the joining date`);
        }
        if (employee.exit) {
          if (employee.exit.lastWorkingDate < employee.joiningDate) {
            add(employee, 'exit-before-joining', 'high', 'exit.lastWorkingDate', `${employee.fullName}: last working date is before the joining date`);
          }
          if (employee.exit.resignationDate && employee.exit.resignationDate > employee.exit.lastWorkingDate) {
            add(employee, 'resignation-after-exit', 'low', 'exit.resignationDate', `${employee.fullName}: resignation date is after the last working date`);
          }
        }

        // 4. Status consistency.
        if (['resigned', 'terminated', 'retired'].includes(employee.status) && !employee.exit) {
          add(employee, 'missing-exit-record', 'high', 'exit', `${employee.fullName} is marked ${employee.status} but has no exit information`);
        }
        if (employee.status === 'active' && employee.exit) {
          add(employee, 'active-with-exit', 'high', 'status', `${employee.fullName} is active but carries exit information`);
        }
        if (employee.status === 'probation' && employee.probationEndDate && employee.probationEndDate < new Date(now).toISOString().slice(0, 10)) {
          add(employee, 'probation-overdue', 'medium', 'probationEndDate', `${employee.fullName} is still on probation, which ended on ${employee.probationEndDate}`);
        }

        // 5. Broken links to other collections.
        if (employee.departmentId && !departments.has(employee.departmentId)) {
          add(employee, 'broken-department', 'high', 'departmentId', `${employee.fullName}: department ${employee.departmentId} does not exist`);
        }
        if (employee.designationId && !designationIds.has(employee.designationId)) {
          add(employee, 'broken-designation', 'high', 'designationId', `${employee.fullName}: designation ${employee.designationId} does not exist`);
        }
        if (employee.locationId && !locations.has(employee.locationId)) {
          add(employee, 'broken-location', 'medium', 'locationId', `${employee.fullName}: location ${employee.locationId} does not exist`);
        }
        if (employee.reportingManagerId === employee.id) {
          add(employee, 'self-manager', 'high', 'reportingManagerId', `${employee.fullName} is set as their own reporting manager`);
        }

        // 6. Designation that belongs to another department.
        const designation = designations.find((item) => item.id === employee.designationId);
        if (designation && designation.departmentId !== employee.departmentId) {
          add(employee, 'designation-department-mismatch', 'medium', 'designationId', `${employee.fullName}: ${designation.title} belongs to a different department than the one on the record`);
        }

        // 6b. A team that is not part of the department on the record.
        const team = employee.teamId ? teams.get(employee.teamId) : null;
        if (employee.teamId && (!team || team.parentId !== employee.departmentId)) {
          add(employee, 'team-department-mismatch', 'medium', 'teamId', `${employee.fullName}: team ${team ? team.name : employee.teamId} is not part of the department on the record`);
        }

        // 7. Missing salary structure for someone being paid.
        if (['active', 'probation'].includes(employee.status) && !structures.has(employee.id)) {
          add(employee, 'no-salary-structure', 'high', 'salary', `${employee.fullName} has no current salary structure`);
        }

        // 8. Duplicates.
        for (const value of new Set([employee.officialEmail, employee.personalEmail].filter(Boolean))) {
          const matches = emailCounts.get(String(value).toLowerCase()) || [];
          if (matches.length > 1) {
            const others = matches.filter((item) => item.id !== employee.id);
            add(employee, 'duplicate-email', 'high', 'email', `${employee.fullName}: email ${value} is also on ${others.map((item) => item.employeeId).join(', ')}`, others.map((item) => item.id));
          }
        }
        const phone = normalisePhone(employee.phone);
        const phoneMatches = phoneCounts.get(phone) || [];
        if (phone && phoneMatches.length > 1) {
          const others = phoneMatches.filter((item) => item.id !== employee.id);
          add(employee, 'duplicate-phone', 'medium', 'phone', `${employee.fullName}: phone number is shared with ${others.map((item) => item.employeeId).join(', ')}`, others.map((item) => item.id));
        }
        const nameMatches = nameDobCounts.get(`${String(employee.fullName).toLowerCase()}|${employee.dateOfBirth}`) || [];
        if (nameMatches.length > 1) {
          const others = nameMatches.filter((item) => item.id !== employee.id);
          add(employee, 'possible-duplicate-record', 'high', 'fullName', `${employee.fullName}: same name and date of birth as ${others.map((item) => item.employeeId).join(', ')} — possible duplicate record`, others.map((item) => item.id));
        }
      }

      const bySeverity = {
        high: issues.filter((issue) => issue.severity === 'high').length,
        medium: issues.filter((issue) => issue.severity === 'medium').length,
        low: issues.filter((issue) => issue.severity === 'low').length,
      };
      const byCode = tally(issues.map((issue) => issue.code));
      const affected = new Set(issues.map((issue) => issue.employeeId)).size;

      return {
        output: compose([
          `${issues.length} data issue(s) across ${affected} of ${employees.length} record(s) — ${bySeverity.high} high, ${bySeverity.medium} medium, ${bySeverity.low} low.`,
          byCode.length ? `By type\n${table(byCode.map((item) => ({ label: item.key, value: item.count })))}` : null,
          issues.length
            ? `Issues\n${bullets(issues.slice(0, 40).map((issue) => `[${issue.severity}] ${issue.message}`))}`
            : 'No issues found in the checks that ran.',
          issues.length > 40 ? `… and ${issues.length - 40} more.` : null,
          `Record completeness: ${percent(employees.length - affected, employees.length)}% of records are clean.`,
          'Each issue points at a field on a record — open it and fix the source. Nothing is corrected automatically.',
        ]),
        sources: [source('dataset', 'employees', `${employees.length} employee records`)],
        confidence: confidenceFrom({ evidence: employees.length, max: 0.92, base: 0.75 }),
        limitation:
          'Rule checks on structure and format only. It cannot tell whether a correctly formatted value is the right value.',
        data: { issues, bySeverity, byCode, checkedCount: employees.length, affectedCount: affected },
      };
    },
  },
];
