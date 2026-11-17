/**
 * Leave AI (requirements §5.8): a check on a leave request, a draft of the decision email, and a
 * plain-language explanation of how leave is moving.
 *
 * None of these decides anything. The check reports what it found; the email is a draft HR
 * edits and sends; the explainer describes what the records show. Approving or rejecting leave
 * is HR's, made in the dashboard, and engines are pure reads — which is what keeps "AI cannot
 * approve leave" true by construction rather than by convention.
 *
 * The rules (what a request costs, what a balance can bear, when a leave year starts) are the
 * dashboard's own, in `../leave-model.js`.
 */

const { bullets, compose, confidenceFrom, percent, round, source } = require('../helpers');
const model = require('../leave-model');
const attendanceModel = require('../attendance-model');

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2, info: 3 };

/** The share of a team away on one day that is worth a warning. */
const COVERAGE_WARN = 30;
const COVERAGE_HIGH = 50;

const dayWord = (count) => (Number(count) === 1 ? 'day' : 'days');
const days = (count) => `${count} ${dayWord(count)}`;
const short = (date) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const span = (from, to) => (from === to ? short(from) : `${short(from)} – ${short(to)}`);

/* ----------------------------- the conflict check ---------------------------- */

function findRequest(input, db) {
  if (input.leaveRequestId) {
    const request = db.byId('leaveRequests', input.leaveRequestId);
    if (!request) {
      throw Object.assign(new Error(`Leave request ${input.leaveRequestId} was not found`), { status: 404 });
    }
    return request;
  }

  // Asked about a person rather than a request id: take their earliest pending request, which is
  // what "should I approve X's leave?" almost always means.
  if (input.employeeId && !input.startDate) {
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
    return pending[0];
  }
  return null;
}

function conflictCheck({ input, db, settings, now }) {
  const request = findRequest(input, db);

  const employeeId = (request && request.employeeId) || input.employeeId;
  const leaveTypeId = (request && request.leaveTypeId) || input.leaveTypeId;
  const startDate = (request && request.startDate) || input.startDate;
  const endDate = (request && request.endDate) || input.endDate || startDate;
  const halfDay = request ? request.halfDay : Boolean(input.halfDay);
  const today = model.ymd(now);
  const received = request ? request.appliedOn : today;

  const employee = db.byId('employees', employeeId);
  if (!employee) throw Object.assign(new Error('employeeId is required and must exist'), { status: 400 });
  const valid = /^\d{4}-\d{2}-\d{2}$/;
  if (!valid.test(startDate || '') || !valid.test(endDate || '')) {
    throw Object.assign(new Error('startDate and endDate are required'), { status: 400 });
  }
  if (endDate < startDate) throw Object.assign(new Error('endDate is before startDate'), { status: 400 });

  const leaveType = db.byId('leaveTypes', leaveTypeId);
  const holidays = db.get('holidays');
  const requests = db.get('leaveRequests');
  const policy = settings.leave || {};
  const cost = model.costOf({ startDate, endDate, halfDay }, employee, settings, holidays);
  const ownPending = request && request.status === 'pending' ? request.days : 0;
  const ownUsed = request && request.status === 'approved' ? request.days : 0;

  const findings = [];
  const add = (code, severity, message) => findings.push({ code, severity, message });

  if (request && request.status !== 'pending') {
    add('already-decided', 'info', `This request is already ${request.status}${request.decidedAt ? ` (${request.decidedAt.slice(0, 10)})` : ''}.`);
  }
  if (leaveType && !leaveType.active) {
    add('type-inactive', 'medium', `${leaveType.name} is no longer in use for new requests.`);
  }

  // Dates against the person: were they employed, and is this a real stretch of leave.
  if (!model.employedOn(employee, startDate) || !model.employedOn(employee, endDate)) {
    add(
      'not-employed',
      'high',
      employee.joiningDate > startDate
        ? `${employee.fullName} joined on ${employee.joiningDate}, after the leave starts.`
        : `${employee.fullName}'s last working day is before the leave ends.`,
    );
  }
  if (cost.days === 0) {
    add('no-working-days', 'medium', 'The dates contain no working days at all, so there is nothing to take.');
  }
  if (halfDay && (startDate !== endDate || (leaveType && leaveType.halfDayAllowed === false))) {
    add(
      'half-day-invalid',
      'high',
      startDate !== endDate
        ? 'A half day is for a single date, but the request spans several.'
        : `${leaveType.name} cannot be taken as a half day.`,
    );
  }

  // 1. Balance.
  const { balance, year, available } = model.balanceFor({ db, settings, employee, leaveTypeId, startDate, ownPendingDays: ownPending, ownUsedDays: ownUsed });
  if (!balance) {
    add('no-balance-record', 'high', `No ${leaveType ? leaveType.name : 'leave'} balance exists for ${employee.fullName} in the leave year starting ${year.from}.`);
  } else if (cost.days > available) {
    const over = round(cost.days - available, 1);
    add(
      'insufficient-balance',
      'high',
      `Takes ${days(cost.days)} but ${available > 0 ? `only ${days(available)} can be taken by then` : 'none can be taken by then'} (granted ${balance.entitled + balance.carriedForward + (balance.adjustment || 0)}, used ${Math.max(0, balance.used - ownUsed)}, pending ${Math.max(0, balance.pending - ownPending)}). They would be ${days(over)} overdrawn.`,
    );
  } else if (cost.days > 0) {
    add('balance-ok', 'info', `Balance is sufficient: ${days(cost.days)} asked for, ${days(available)} available by the first day.`);
  }

  // 2. Notice.
  if (received > startDate) {
    add('already-started', 'low', 'The leave had already begun when the request was received.');
  } else if (leaveType) {
    const required = leaveType.minNoticeDays !== undefined && leaveType.minNoticeDays !== null ? leaveType.minNoticeDays : policy.minNoticeDays || 0;
    const given = model.gap(received, startDate);
    if (given < required) add('short-notice', 'medium', `${leaveType.name} needs ${days(required)} notice. This gave ${given}.`);
  }

  // 3. Length.
  if (leaveType && leaveType.maxConsecutiveDays > 0 && cost.days > leaveType.maxConsecutiveDays) {
    add('too-long', 'medium', `${leaveType.name} allows ${days(leaveType.maxConsecutiveDays)} at a time. This is ${cost.days}.`);
  }

  // 4. Days off inside the range.
  if (cost.holidaysInside.length) {
    const names = holidays.filter((holiday) => cost.holidaysInside.includes(holiday.date)).map((holiday) => `${holiday.name} (${short(holiday.date)})`);
    add('holiday-overlap', 'low', `The range includes ${cost.holidaysInside.length} holiday${cost.holidaysInside.length === 1 ? '' : 's'}: ${names.join(', ')} — not deducted.`);
  }

  // 5. Documentation.
  if (leaveType && leaveType.requiresDocument && cost.days > (policy.requireDocumentAfterDays || 0)) {
    const attached = request && request.attachmentDocumentId;
    add(
      'document-required',
      attached ? 'info' : 'medium',
      attached
        ? 'The supporting document is attached.'
        : `${leaveType.name} over ${days(policy.requireDocumentAfterDays || 0)} needs a supporting document, and none is attached.`,
    );
  }

  // 6. The person's own leave.
  const ownOverlap = requests.filter(
    (item) =>
      item.employeeId === employee.id &&
      item.id !== (request && request.id) &&
      ['approved', 'pending'].includes(item.status) &&
      item.startDate <= endDate &&
      item.endDate >= startDate,
  );
  if (ownOverlap.length) {
    add('self-overlap', 'high', `Overlaps ${ownOverlap.length} other request${ownOverlap.length === 1 ? '' : 's'} for the same person: ${ownOverlap.map((item) => `${span(item.startDate, item.endDate)} (${item.status})`).join(', ')}.`);
  }

  // 7. Team cover, day by day: the worst day is what matters, not whether anyone overlaps at all.
  const coverage = model.coverageFor({
    employee,
    startDate,
    endDate,
    requests,
    employees: db.get('employees'),
    settings,
    holidays,
    ignoreRequestId: request && request.id,
  });
  const lossPercent = percent((coverage.peak ? coverage.peak.count : 0) + 1, coverage.teamSize + 1);
  if (coverage.peak && lossPercent >= COVERAGE_WARN) {
    add(
      'coverage-gap',
      lossPercent >= COVERAGE_HIGH ? 'high' : 'medium',
      `On ${short(coverage.peak.date)}, ${coverage.peak.count} of ${coverage.teamSize} colleagues in the department are already away (${coverage.peak.approved} approved, ${coverage.peak.pending} pending) — ${lossPercent}% of the team would be out.`,
    );
  } else if (coverage.awayPeople) {
    add('coverage-note', 'low', `${coverage.awayPeople} colleague${coverage.awayPeople === 1 ? '' : 's'} in the department ${coverage.awayPeople === 1 ? 'is' : 'are'} away for part of this period; no day is short of cover.`);
  }
  if (coverage.teamSize > 0 && coverage.teamSize < 3 && !coverage.peak) {
    add('small-team', 'low', `The department has only ${coverage.teamSize} other working ${coverage.teamSize === 1 ? 'person' : 'people'}, so any absence is felt.`);
  }

  // 8. Work already on the attendance sheet (leave recorded after the fact).
  const worked = db
    .get('attendance')
    .filter(
      (record) =>
        record.employeeId === employee.id &&
        record.date >= startDate &&
        record.date <= endDate &&
        ['present', 'late', 'half-day', 'work-from-home', 'on-duty'].includes(record.status),
    );
  if (worked.length && !halfDay) {
    add('attendance-recorded', 'low', `Attendance already shows ${worked.length} day${worked.length === 1 ? '' : 's'} worked in this range. Approving replaces ${worked.length === 1 ? 'it' : 'them'} with leave.`);
  }

  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const blockers = findings.filter((finding) => finding.severity === 'high');
  const department = db.byId('departments', employee.departmentId);

  return {
    output: compose([
      `Leave check — ${employee.fullName}, ${leaveType ? leaveType.name : 'leave'}, ${span(startDate, endDate)}, ${startDate.slice(0, 4)}`,
      `${days(cost.days)} of leave over ${days(cost.calendarDays)}${department ? ` · ${department.name}` : ''}`,
      `Findings\n${bullets(findings.map((finding) => `[${finding.severity}] ${finding.message}`))}`,
      blockers.length
        ? `${blockers.length} finding${blockers.length === 1 ? '' : 's'} would normally hold up approval. Review ${blockers.length === 1 ? 'it' : 'them'} before deciding.`
        : 'Nothing that would hold up approval was found.',
      'This check does not approve or reject anything — the decision and the record of who made it stay with HR.',
    ]),
    sources: [
      source('employee', employee.id, employee.fullName),
      request ? source('dataset', request.id, `Leave request ${request.id}`) : null,
      balance ? source('dataset', balance.id, `Leave balance, ${year.from.slice(0, 4)}`) : null,
      source('dataset', 'holidays', `Holiday calendar (${holidays.length} dates)`),
      source('policy', 'leave-policy', 'Leave policy in Settings'),
    ].filter(Boolean),
    confidence: confidenceFrom({ evidence: findings.length + cost.days, max: 0.85, base: 0.6 }),
    limitation:
      'Based on recorded balances, requests, attendance and the holiday calendar. Leave agreed verbally but not entered is invisible to this check, and it knows nothing about workload or who has to cover what.',
    data: {
      leaveRequestId: request ? request.id : null,
      employeeId: employee.id,
      workingDays: cost.days,
      calendarDays: cost.calendarDays,
      findings,
      blockerCount: blockers.length,
      coverageLossPercent: lossPercent,
      available,
      decisionAllowed: false,
    },
  };
}

/* ----------------------------- the decision email ---------------------------- */

const EMAIL_KINDS = ['approval', 'rejection', 'cancellation'];

function kindFor(input, request) {
  if (EMAIL_KINDS.includes(input.kind)) return input.kind;
  if (request.status === 'approved') return 'approval';
  if (request.status === 'rejected') return 'rejection';
  if (request.status === 'cancelled') return 'cancellation';
  return null;
}

function decisionEmail({ input, db, settings }) {
  if (!input.leaveRequestId) throw Object.assign(new Error('leaveRequestId is required'), { status: 400 });
  const request = db.byId('leaveRequests', input.leaveRequestId);
  if (!request) throw Object.assign(new Error(`Leave request ${input.leaveRequestId} was not found`), { status: 404 });

  const kind = kindFor(input, request);
  if (!kind) {
    throw Object.assign(new Error('This request is still pending — say whether to draft an approval or a rejection'), { status: 400 });
  }

  const employee = db.byId('employees', request.employeeId);
  const leaveType = db.byId('leaveTypes', request.leaveTypeId);
  if (!employee) throw Object.assign(new Error('The employee on this request no longer exists'), { status: 404 });

  const dates = `${span(request.startDate, request.endDate)}, ${request.startDate.slice(0, 4)}`;
  const what = `${leaveType ? leaveType.name.toLowerCase() : 'leave'}${request.halfDay ? ' (half day)' : ''}`;
  const reason = String(input.reason || request.hrRemarks || '').trim();
  const first = employee.fullName.split(' ')[0];
  const company = (settings.company && settings.company.name) || 'HR';

  const { balance, available } = model.balanceFor({
    db,
    settings,
    employee,
    leaveTypeId: request.leaveTypeId,
    startDate: request.startDate,
    ownPendingDays: request.status === 'pending' ? request.days : 0,
    ownUsedDays: request.status === 'approved' ? request.days : 0,
  });
  const left = balance ? balance.remaining : null;

  const templates = {
    approval: {
      subject: `Your ${what} request has been approved`,
      body: [
        `Hello ${first},`,
        '',
        `Your request for ${what} from ${dates} (${days(request.days)}) has been approved.`,
        left !== null && left >= 0
          ? `After this, you have ${days(left)} of ${leaveType ? leaveType.name.toLowerCase() : 'this leave'} left this leave year.`
          : null,
        reason && reason !== 'Approved.' ? `Note from HR: ${reason}` : null,
        '',
        'Please hand over any ongoing work to your team before you go.',
      ],
    },
    rejection: {
      subject: `Your ${what} request`,
      body: [
        `Hello ${first},`,
        '',
        `We are not able to approve your request for ${what} from ${dates} (${days(request.days)}).`,
        reason ? `Reason: ${reason}` : 'The reason has not been entered yet — add it before sending.',
        '',
        'Please speak to HR about other dates that could work.',
      ],
    },
    cancellation: {
      subject: `Your ${what} request has been cancelled`,
      body: [
        `Hello ${first},`,
        '',
        `Your request for ${what} from ${dates} (${days(request.days)}) has been cancelled${reason ? `: ${reason}` : '.'}`,
        'Any days held for it have been returned to your leave balance.',
        '',
        'If this is not what you expected, please speak to HR.',
      ],
    },
  };

  const template = templates[kind];
  const to = employee.officialEmail || employee.email || null;

  return {
    output: compose([
      to ? `To: ${to}` : 'To: (no email address on file — add one to the employee record)',
      `Subject: ${template.subject}`,
      [...template.body.filter((line) => line !== null), '', 'Best regards,', `${company} HR team`].join('\n'),
      kind === 'approval' && left !== null && left < 0
        ? `Note for you, not for the email: this leaves ${employee.fullName.split(' ')[0]} ${days(-left)} overdrawn, so the balance line was left out.`
        : null,
      request.status === 'pending'
        ? `This request is still pending. The ${kind} email is a draft prepared before the decision — send it only once you have decided.`
        : 'Nothing is sent automatically — review, edit, then send it yourself.',
    ]),
    sources: [
      source('employee', employee.id, employee.fullName),
      source('dataset', request.id, `Leave request ${request.id}`),
      balance ? source('dataset', balance.id, 'Leave balance') : null,
    ].filter(Boolean),
    confidence: 0.7,
    limitation:
      'A template filled from the request. It does not know the conversation that led to the decision — check the tone and anything HR agreed with the person before sending.',
    data: {
      kind,
      leaveRequestId: request.id,
      employeeId: employee.id,
      to,
      subject: template.subject,
      requestStatus: request.status,
      available,
      decisionAllowed: false,
    },
  };
}

/* ----------------------------- the trend explainer --------------------------- */

const TREND_INPUT = {
  from: 'string — first day, YYYY-MM-DD (optional; use `days` instead)',
  to: 'string — last day, YYYY-MM-DD (default today)',
  days: 'number — last N days when from is not given, default 90',
  departmentId: 'string — limit to one department (optional)',
};

/** Approved leave expanded into the working days it covers, within a span, for a set of people. */
function leaveDaysIn({ requests, employeesById, settings, holidays, from, to }) {
  const workingDays = (settings.work && settings.work.workingDays) || ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  const rows = [];
  for (const request of requests) {
    if (request.status !== 'approved') continue;
    const employee = employeesById.get(request.employeeId);
    if (!employee || request.startDate > to || request.endDate < from) continue;

    const off = model.daysOffFor(holidays, employee.locationId);
    const start = request.startDate < from ? from : request.startDate;
    const end = request.endDate > to ? to : request.endDate;
    for (const date of model.eachDay(start, end)) {
      if (!model.isWorkingDay(date, workingDays, off)) continue;
      rows.push({ date, request, employee, weight: request.halfDay ? 0.5 : 1 });
    }
  }
  return rows;
}

function leaveMetrics({ settings, holidays, requests, employees, period, departmentId }) {
  const people = employees.filter((employee) => (!departmentId || employee.departmentId === departmentId) && model.employedOn(employee, period.to));
  const employeesById = new Map(people.map((employee) => [employee.id, employee]));
  const taken = leaveDaysIn({ requests, employeesById, settings, holidays, from: period.from, to: period.to });

  const personDays = taken.reduce((sum, row) => sum + row.weight, 0);
  const byPerson = new Map();
  const byType = new Map();
  const byWeekday = new Map();
  for (const row of taken) {
    byPerson.set(row.employee.id, (byPerson.get(row.employee.id) || 0) + row.weight);
    byType.set(row.request.leaveTypeId, (byType.get(row.request.leaveTypeId) || 0) + row.weight);
    const weekday = model.weekdayOf(row.date);
    byWeekday.set(weekday, (byWeekday.get(weekday) || 0) + row.weight);
  }

  const received = requests.filter(
    (request) => employeesById.has(request.employeeId) && request.appliedOn >= period.from && request.appliedOn <= period.to,
  );
  const decided = received.filter((request) => ['approved', 'rejected'].includes(request.status));
  const rejected = decided.filter((request) => request.status === 'rejected').length;

  return {
    headcount: people.length,
    personDays,
    people: byPerson.size,
    perHead: people.length ? personDays / people.length : null,
    byPerson,
    byType,
    byWeekday,
    received: received.length,
    decided: decided.length,
    rejected,
    rejectionRate: decided.length >= 5 ? rejected / decided.length : null,
  };
}

function change(label, now, before, length) {
  if (before === null || before === undefined) return `${label} ${days(now)}.`;
  if (before === 0 && now === 0) return `${label} ${days(now)}, as before.`;
  const diff = now - before;
  const pct = before ? Math.round((diff / before) * 100) : null;
  if (pct !== null && Math.abs(pct) < 5) return `${label} ${days(now)}, about the same as the previous ${days(length)} (${days(before)}).`;
  return `${label} ${days(now)}, ${diff > 0 ? 'up' : 'down'} from ${days(before)}${pct !== null ? ` (${diff > 0 ? '+' : ''}${pct}%)` : ''} in the previous ${days(length)}.`;
}

function trendExplainer({ input, db, settings, now }) {
  const period = attendanceModel.resolvePeriod({ days: 90, ...input }, now);
  const before = attendanceModel.previousPeriod(period);

  const holidays = db.get('holidays');
  const requests = db.get('leaveRequests');
  const employees = db.get('employees');
  const context = { settings, holidays, requests, employees, departmentId: input.departmentId };
  const latest = leaveMetrics({ ...context, period });
  const earlier = leaveMetrics({ ...context, period: before });
  const comparable = earlier.headcount > 0 && (earlier.personDays > 0 || earlier.received > 0);

  const typeNames = new Map(db.get('leaveTypes').map((type) => [type.id, type.name]));
  const topTypes = [...latest.byType].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const typeShift = comparable
    ? [...latest.byType]
        .map(([id, value]) => ({ id, value, was: earlier.byType.get(id) || 0 }))
        .filter((item) => item.was >= 3 && item.value >= item.was * 1.4)
        .sort((a, b) => b.value / b.was - a.value / a.was)[0]
    : null;

  // Which weekday carries the leave: Mondays and Fridays make long weekends.
  const weekdayTotal = [...latest.byWeekday.values()].reduce((sum, value) => sum + value, 0);
  const weekdayTop = [...latest.byWeekday].sort((a, b) => b[1] - a[1])[0];
  const weekdayPeak =
    weekdayTotal >= 10 && weekdayTop && weekdayTop[1] / weekdayTotal >= 0.3
      ? { weekday: weekdayTop[0], share: percent(weekdayTop[1], weekdayTotal) }
      : null;

  // Whether a few people account for a large share.
  const topPeople = [...latest.byPerson].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const topShare = topPeople.reduce((sum, item) => sum + item[1], 0);
  const concentrated = latest.personDays >= 15 && topShare / latest.personDays >= 0.35;
  const names = new Map(employees.map((employee) => [employee.id, employee.fullName]));

  // Departments, each against the company as a whole.
  const departmentNames = new Map(db.get('departments').map((department) => [department.id, department.name]));
  const departments = [];
  if (!input.departmentId) {
    for (const id of new Set(employees.map((employee) => employee.departmentId))) {
      const a = leaveMetrics({ ...context, period, departmentId: id });
      const b = leaveMetrics({ ...context, period: before, departmentId: id });
      if (a.headcount < 3) continue;
      departments.push({ id, name: departmentNames.get(id) || 'Unknown department', headcount: a.headcount, perHead: a.perHead, before: b.perHead });
    }
  }
  const busiest = [...departments].sort((a, b) => (b.perHead || 0) - (a.perHead || 0))[0];

  // Right now: what is waiting, and what is coming.
  const today = model.ymd(now);
  const employeeById = new Map(employees.map((employee) => [employee.id, employee]));
  const pending = requests.filter(
    (request) => request.status === 'pending' && (!input.departmentId || (employeeById.get(request.employeeId) || {}).departmentId === input.departmentId),
  );
  const oldest = pending.map((request) => model.gap(request.appliedOn, today)).sort((a, b) => b - a)[0];
  const upcoming = leaveDaysIn({
    requests,
    employeesById: input.departmentId
      ? new Map(employees.filter((employee) => employee.departmentId === input.departmentId).map((employee) => [employee.id, employee]))
      : employeeById,
    settings,
    holidays,
    from: today,
    to: model.addDays(today, 29),
  });
  const upcomingByDay = new Map();
  for (const row of upcoming) upcomingByDay.set(row.date, (upcomingByDay.get(row.date) || 0) + 1);
  const crowded = [...upcomingByDay].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];

  const currentYear = model.leaveYearOf(today, (settings.leave || {}).leaveYearStart).year;
  const overdrawn = db.get('leaveBalances').filter((balance) => balance.year === currentYear && balance.remaining < 0).length;

  const notes = [
    latest.personDays === 0
      ? `No approved leave fell in ${span(period.from, period.to)}.`
      : change('Approved leave came to', round(latest.personDays, 1), comparable ? round(earlier.personDays, 1) : null, period.length),
    latest.perHead !== null && latest.personDays > 0
      ? `That is ${round(latest.perHead, 1)} days per person across ${latest.headcount} people; ${latest.people} of them took some.`
      : null,
    topTypes.length ? `Most of it was ${topTypes.map(([id, value]) => `${typeNames.get(id) || 'other leave'} (${round(value, 1)})`).join(', ')}.` : null,
    typeShift ? `${typeNames.get(typeShift.id) || 'One type of leave'} rose sharply, from ${round(typeShift.was, 1)} to ${round(typeShift.value, 1)} days.` : null,
    latest.received
      ? `${latest.received} request${latest.received === 1 ? ' was' : 's were'} received${comparable && earlier.received ? `, against ${earlier.received} before` : ''}.${latest.rejectionRate !== null ? ` ${Math.round(latest.rejectionRate * 100)}% of those decided were rejected.` : ''}`
      : null,
    busiest && latest.perHead && busiest.perHead >= latest.perHead * 1.4
      ? `${busiest.name} took the most per person, ${round(busiest.perHead, 1)} days against ${round(latest.perHead, 1)} across the company.`
      : null,
    weekdayPeak ? `${weekdayPeak.share}% of leave days fell on a ${weekdayPeak.weekday}, which tends to mean long weekends.` : null,
    concentrated
      ? `Three people (${topPeople.map(([id]) => names.get(id) || id).join(', ')}) account for ${Math.round((topShare / latest.personDays) * 100)}% of the days, so this is closer to a few cases than a company-wide pattern.`
      : null,
    pending.length
      ? `${pending.length} request${pending.length === 1 ? ' is' : 's are'} waiting for a decision${oldest !== undefined && oldest >= 7 ? `; the oldest has waited ${days(oldest)}` : ''}.`
      : null,
    crowded && crowded[1] >= 3 ? `The busiest day in the next 30 days is ${short(crowded[0])}, with ${crowded[1]} people away.` : null,
    overdrawn ? `${overdrawn} balance${overdrawn === 1 ? ' is' : 's are'} overdrawn this leave year.` : null,
    !comparable ? 'There is no earlier period with leave to compare against.' : null,
  ].filter(Boolean);

  return {
    output: compose([
      `Leave trend, ${span(period.from, period.to)}${comparable ? `, compared with ${span(before.from, before.to)}` : ''}`,
      bullets(notes),
      'This describes what the records show. It does not say why — talk to the people and teams involved before drawing conclusions.',
    ]),
    sources: [
      source('dataset', 'leaveRequests', `Leave requests, ${span(period.from, period.to)} (${latest.received} received)`),
      comparable ? source('dataset', 'leaveRequests', `Leave requests, ${span(before.from, before.to)} (${earlier.received} received)`) : null,
      source('dataset', 'holidays', 'Holiday calendar'),
      busiest ? source('department', busiest.id, busiest.name) : null,
    ].filter(Boolean),
    confidence: confidenceFrom({ evidence: latest.personDays + latest.received, max: comparable ? 0.8 : 0.6, base: 0.5 }),
    limitation:
      'Describes differences between two periods of recorded leave. A change may come from holidays, seasons, a few long absences or requests not yet entered, not from anything about the people.',
    data: {
      from: period.from,
      to: period.to,
      previous: comparable ? { from: before.from, to: before.to } : null,
      personDays: latest.personDays,
      previousPersonDays: comparable ? earlier.personDays : null,
      people: latest.people,
      received: latest.received,
      rejectionRate: latest.rejectionRate,
      pending: pending.length,
      departments,
      decisionAllowed: false,
    },
  };
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
      halfDay: 'boolean — a single day taken as half a day (optional)',
    },
    prompt: (input) =>
      input.leaveRequestId
        ? `Check conflicts for leave request ${input.leaveRequestId}`
        : `Check conflicts for ${input.employeeId} from ${input.startDate || 'their pending request'} to ${input.endDate || ''}`.trim(),
    run: conflictCheck,
  },
  {
    id: 'leave-decision-email',
    module: 'leave',
    label: 'Leave Decision Email',
    purpose: 'Drafts the approval, rejection or cancellation email for a leave request, for HR to review and send',
    input: {
      leaveRequestId: 'string — the request the email is about',
      kind: 'string — approval | rejection | cancellation (default: what the request was decided as)',
      reason: 'string — the reason to give, if not the one HR entered with the decision (optional)',
    },
    prompt: (input) => `Draft a leave ${input.kind || 'decision'} email for request ${input.leaveRequestId}`,
    run: decisionEmail,
  },
  {
    id: 'leave-trend-explainer',
    module: 'leave',
    label: 'Leave Trend Explainer',
    purpose: 'Explains how leave changed against the previous period, in plain language',
    input: TREND_INPUT,
    prompt: (input) => {
      const when = input.from ? `from ${input.from} to ${input.to || 'today'}` : `over the last ${input.days || 90} days`;
      return `Explain the leave trend ${when}${input.departmentId ? ` for department ${input.departmentId}` : ''}`;
    },
    run: trendExplainer,
  },
];
