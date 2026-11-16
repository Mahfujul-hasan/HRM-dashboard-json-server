/**
 * Leave conflict checking (requirements §5.8).
 *
 * Checks balance, notice, holiday overlap and department coverage for a leave request and
 * reports what it found. It never approves or rejects: the decision, and the record of who
 * made it, stay with HR.
 */

const { bullets, compose, confidenceFrom, daysBetween, percent, source, ymd } = require('../helpers');

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Working days between two dates, excluding weekends and public holidays. */
function workingDaysBetween(from, to, workingDays, holidayDates) {
  const days = [];
  for (let cursor = new Date(from); cursor <= to; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const date = ymd(cursor);
    if (!workingDays.includes(DAY_NAMES[cursor.getUTCDay()])) continue;
    if (holidayDates.has(date)) continue;
    days.push(date);
  }
  return days;
}

module.exports = [
  {
    id: 'leave-conflict-check',
    module: 'leave',
    label: 'Leave Conflict Check',
    purpose: 'Checks balance, notice, holiday overlap and team coverage for a leave request',
    input: {
      leaveRequestId: 'string — an existing request (or supply the fields below)',
      employeeId: 'string',
      leaveTypeId: 'string',
      startDate: 'string — YYYY-MM-DD',
      endDate: 'string — YYYY-MM-DD',
    },
    prompt: (input) =>
      input.leaveRequestId
        ? `Check conflicts for leave request ${input.leaveRequestId}`
        : `Check conflicts for ${input.employeeId} from ${input.startDate} to ${input.endDate}`,

    run({ input, db, settings, now }) {
      let request = input.leaveRequestId ? db.byId('leaveRequests', input.leaveRequestId) : null;
      if (input.leaveRequestId && !request) {
        throw Object.assign(new Error(`Leave request ${input.leaveRequestId} was not found`), { status: 404 });
      }

      // Asked about a person rather than a request id: take their pending request, which is
      // what "should I approve X's leave?" almost always means.
      if (!request && input.employeeId && !input.startDate) {
        const pending = db
          .get('leaveRequests')
          .filter((item) => item.employeeId === input.employeeId && item.status === 'pending')
          .sort((a, b) => a.startDate.localeCompare(b.startDate));

        if (!pending.length) {
          throw Object.assign(
            new Error('That employee has no pending leave request — give the dates, or a request id, to check a specific period'),
            { status: 404 },
          );
        }
        request = pending[0];
      }

      const employeeId = (request && request.employeeId) || input.employeeId;
      const leaveTypeId = (request && request.leaveTypeId) || input.leaveTypeId;
      const startDate = new Date(`${(request && request.startDate) || input.startDate}T00:00:00Z`);
      const endDate = new Date(`${(request && request.endDate) || input.endDate}T00:00:00Z`);

      const employee = db.byId('employees', employeeId);
      if (!employee) throw Object.assign(new Error('employeeId is required and must exist'), { status: 400 });
      if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
        throw Object.assign(new Error('startDate and endDate are required'), { status: 400 });
      }
      if (endDate < startDate) throw Object.assign(new Error('endDate is before startDate'), { status: 400 });

      const leaveType = db.byId('leaveTypes', leaveTypeId);
      const holidays = db.get('holidays');
      const holidayDates = new Set(holidays.map((holiday) => holiday.date));
      const workingDays = settings.work.workingDays;

      const days = workingDaysBetween(startDate, endDate, workingDays, holidayDates);
      // Inclusive of both ends: 4 Dec to 5 Dec is 2 calendar days, not 1.
      const calendarDays = daysBetween(startDate, endDate) + 1;
      const overlappingHolidays = holidays.filter(
        (holiday) => holiday.date >= ymd(startDate) && holiday.date <= ymd(endDate),
      );

      const findings = [];

      // 1. Balance.
      const year = startDate.getUTCFullYear();
      const balance = db
        .get('leaveBalances')
        .find((item) => item.employeeId === employee.id && item.leaveTypeId === leaveTypeId && item.year === year);

      if (!balance) {
        findings.push({
          code: 'no-balance-record',
          severity: 'high',
          message: `No ${leaveType ? leaveType.name : 'leave'} balance exists for ${employee.fullName} in ${year}`,
        });
      } else {
        const available = balance.remaining + (request && request.status === 'pending' ? request.days : 0);
        if (days.length > available) {
          findings.push({
            code: 'insufficient-balance',
            severity: 'high',
            message: `Requested ${days.length} day(s) but only ${available} remain (entitled ${balance.entitled}, used ${balance.used}, pending ${balance.pending})`,
          });
        } else {
          findings.push({
            code: 'balance-ok',
            severity: 'info',
            message: `Balance is sufficient: ${days.length} day(s) requested, ${available} available`,
          });
        }
      }

      // 2. Notice period.
      const noticeDays = daysBetween(now, startDate);
      const requiredNotice = leaveType ? leaveType.minNoticeDays : settings.leave.minNoticeDays;
      if (noticeDays < requiredNotice && startDate >= now) {
        findings.push({
          code: 'short-notice',
          severity: 'medium',
          message: `Notice is ${noticeDays} day(s); policy asks for ${requiredNotice}`,
        });
      }

      // 3. Non-working days inside the range.
      if (overlappingHolidays.length) {
        findings.push({
          code: 'holiday-overlap',
          severity: 'low',
          message: `The range includes ${overlappingHolidays.length} public holiday(s): ${overlappingHolidays.map((holiday) => `${holiday.name} (${holiday.date})`).join(', ')} — these are not deducted`,
        });
      }
      if (!days.length) {
        findings.push({
          code: 'no-working-days',
          severity: 'medium',
          message: 'The range contains no working days at all',
        });
      }

      // 4. Documentation.
      if (leaveType && leaveType.requiresDocument && days.length > settings.leave.requireDocumentAfterDays) {
        const attached = request && request.attachmentDocumentId;
        findings.push({
          code: 'document-required',
          severity: attached ? 'info' : 'medium',
          message: attached
            ? 'Supporting document is attached'
            : `${leaveType.name} over ${settings.leave.requireDocumentAfterDays} day(s) needs a supporting document, and none is attached`,
        });
      }

      // 5. Overlap with the employee's own approved leave.
      const ownOverlap = db
        .get('leaveRequests')
        .filter(
          (item) =>
            item.employeeId === employee.id &&
            item.id !== (request && request.id) &&
            ['approved', 'pending'].includes(item.status) &&
            item.startDate <= ymd(endDate) &&
            item.endDate >= ymd(startDate),
        );
      if (ownOverlap.length) {
        findings.push({
          code: 'self-overlap',
          severity: 'high',
          message: `Overlaps ${ownOverlap.length} existing request(s) for the same employee: ${ownOverlap.map((item) => `${item.startDate}–${item.endDate} (${item.status})`).join(', ')}`,
        });
      }

      // 6. Department coverage.
      const colleagues = db
        .get('employees')
        .filter((item) => item.departmentId === employee.departmentId && item.id !== employee.id && ['active', 'probation'].includes(item.status));
      const colleagueIds = new Set(colleagues.map((item) => item.id));
      const overlappingColleagues = db
        .get('leaveRequests')
        .filter(
          (item) =>
            colleagueIds.has(item.employeeId) &&
            item.status === 'approved' &&
            item.startDate <= ymd(endDate) &&
            item.endDate >= ymd(startDate),
        );

      const awayCount = new Set(overlappingColleagues.map((item) => item.employeeId)).size;
      const coverageLoss = percent(awayCount + 1, colleagues.length + 1);
      if (coverageLoss >= 30) {
        findings.push({
          code: 'coverage-gap',
          severity: coverageLoss >= 50 ? 'high' : 'medium',
          message: `${awayCount} of ${colleagues.length} colleagues in the same department are already on approved leave — ${coverageLoss}% of the team would be away`,
        });
      } else if (awayCount) {
        findings.push({
          code: 'coverage-note',
          severity: 'low',
          message: `${awayCount} colleague(s) in the department are on leave during part of this period`,
        });
      }

      const blockers = findings.filter((finding) => finding.severity === 'high');
      const department = db.byId('departments', employee.departmentId);

      return {
        output: compose([
          `Leave check — ${employee.fullName}, ${leaveType ? leaveType.name : 'leave'}, ${ymd(startDate)} to ${ymd(endDate)}`,
          `${days.length} working day(s) over ${calendarDays} calendar day(s)${department ? ` · ${department.name}` : ''}`,
          `Findings\n${bullets(findings.map((finding) => `[${finding.severity}] ${finding.message}`))}`,
          blockers.length
            ? `${blockers.length} finding(s) would normally block approval. Review them before deciding.`
            : 'Nothing blocking was found.',
          'This check does not approve or reject anything — the decision and the record of who made it stay with HR.',
        ]),
        sources: [
          source('employee', employee.id, employee.fullName),
          request ? source('dataset', request.id, `Leave request ${request.id}`) : null,
          balance ? source('dataset', balance.id, `Leave balance ${year}`) : null,
          source('dataset', 'holidays', `Holiday calendar (${holidays.length} dates)`),
        ].filter(Boolean),
        confidence: confidenceFrom({ evidence: findings.length + days.length, max: 0.85, base: 0.6 }),
        limitation:
          'Based on recorded balances, approved leave and the holiday calendar. Leave agreed verbally but not entered is invisible to this check.',
        data: {
          workingDays: days.length,
          calendarDays,
          findings,
          blockerCount: blockers.length,
          coverageLossPercent: coverageLoss,
          decisionAllowed: false,
        },
      };
    },
  },
];
