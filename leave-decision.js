/**
 * What deciding a leave request changes (requirements §5.8, workflow §6.2 steps 7-9).
 *
 * Approving, rejecting or cancelling a request is one decision with three consequences that must
 * not come apart: the request's status, the person's leave balance, and the attendance days the
 * leave covers. This module works out all three from plain objects and writes nothing, so the
 * route can check everything before it changes anything and the rules can be tested without a
 * server.
 *
 *   approve  pending  -> approved   days move from `pending` to `used`; each working day in the
 *                                    request becomes a leave day in attendance
 *   reject   pending  -> rejected   days are released from `pending`; attendance is untouched
 *   cancel   pending  -> cancelled  days are released from `pending`
 *            approved -> cancelled  days are given back from `used`; the attendance days the
 *                                    approval wrote are put back as they were
 *
 * Only HR decides. Nothing in the AI layer calls this.
 */

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const DECISIONS = {
  approve: { from: ['pending'], to: 'approved' },
  reject: { from: ['pending'], to: 'rejected' },
  cancel: { from: ['pending', 'approved'], to: 'cancelled' },
};

/** A reason is required for the decisions that say no, so the record explains itself. */
const NEEDS_REMARKS = new Set(['reject', 'cancel']);
const MIN_REMARKS = 3;
const MAX_REMARKS = 500;

/** The attendance fields an approval overwrites, and so the fields kept to put back. */
const SYNCED_FIELDS = [
  'status',
  'checkIn',
  'checkOut',
  'workedMinutes',
  'lateMinutes',
  'earlyLeaveMinutes',
  'overtimeMinutes',
  'leaveRequestId',
  'leaveTypeId',
  'note',
];

/** Statuses that mean the person did turn up, so approving leave over them replaces real work. */
const WORKED = new Set(['present', 'late', 'half-day', 'work-from-home', 'on-duty']);

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

function eachDay(from, to) {
  const days = [];
  for (
    let cursor = new Date(`${from}T00:00:00Z`);
    ymd(cursor) <= to;
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  ) {
    days.push(ymd(cursor));
  }
  return days;
}

/** The calendar year a leave year starts in: with a 04-01 start, 10 Feb 2026 is in 2025. */
function leaveYearOf(date, leaveYearStart = '01-01') {
  const year = Number(date.slice(0, 4));
  return date.slice(5) >= leaveYearStart ? year : year - 1;
}

/** The days in a request that are working days for the person: no weekends, no holidays. */
function workingDates(request, settings, holidays, locationId) {
  const workingDays = (settings.work && settings.work.workingDays) || ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  const off = new Set(
    holidays
      .filter((holiday) => !holiday.locationIds || !holiday.locationIds.length || holiday.locationIds.includes(locationId))
      .map((holiday) => holiday.date),
  );
  return eachDay(request.startDate, request.endDate).filter((date) => {
    const weekday = DAY_NAMES[new Date(`${date}T00:00:00Z`).getUTCDay()];
    return workingDays.includes(weekday) && !off.has(date);
  });
}

const remainingOf = (balance) =>
  balance.entitled + balance.carriedForward + (balance.adjustment || 0) - balance.used - balance.pending;

const pick = (record) => Object.fromEntries(SYNCED_FIELDS.map((field) => [field, record[field] === undefined ? null : record[field]]));

/**
 * Plans a decision. Throws an error carrying an HTTP `status` when it cannot be made; otherwise
 * returns the patches to write and a summary, and has changed nothing.
 *
 * `attendance` is the person's records inside the request's dates; `holidays` all holidays.
 */
function planDecision({ request, balance, employee, attendance, holidays, settings, decision, remarks, userId, now }) {
  const rule = DECISIONS[decision];
  if (!rule) throw fail(400, `decision must be one of: ${Object.keys(DECISIONS).join(', ')}`);
  if (!request) throw fail(404, 'Leave request not found');
  if (!rule.from.includes(request.status)) {
    throw fail(409, `This request is already ${request.status}, so it cannot be ${rule.to}`);
  }

  const note = typeof remarks === 'string' ? remarks.trim() : '';
  if (NEEDS_REMARKS.has(decision) && note.length < MIN_REMARKS) {
    throw fail(400, `Say why: ${decision === 'reject' ? 'a rejection' : 'a cancellation'} needs a reason`);
  }
  if (note.length > MAX_REMARKS) throw fail(400, `Remarks can be up to ${MAX_REMARKS} characters`);

  const was = request.status;
  const requestPatch = {
    status: rule.to,
    hrRemarks: note,
    decidedBy: userId || null,
    decidedAt: now,
    updatedAt: now,
  };

  /* ------------------------------ the balance ----------------------------- */
  let balancePatch = null;
  if (decision === 'approve' && !balance) {
    throw fail(409, 'There is no leave balance to charge. Assign one in Leave balances first.');
  }
  if (balance) {
    const next = { ...balance };
    if (decision === 'approve') {
      next.pending = Math.max(0, balance.pending - request.days);
      next.used = balance.used + request.days;
    } else if (was === 'pending') {
      next.pending = Math.max(0, balance.pending - request.days);
    } else {
      next.used = Math.max(0, balance.used - request.days);
    }
    next.remaining = remainingOf(next);
    balancePatch = { pending: next.pending, used: next.used, remaining: next.remaining, updatedAt: now };
  }

  /* ----------------------------- attendance sync -------------------------- */
  const sync = { create: [], update: [], remove: [], replaced: [] };

  if (decision === 'approve') {
    const byDate = new Map(attendance.map((record) => [record.date, record]));

    for (const date of workingDates(request, settings, holidays, employee && employee.locationId)) {
      const existing = byDate.get(date);
      const base = {
        leaveRequestId: request.id,
        leaveTypeId: request.leaveTypeId,
        note: request.halfDay ? 'Half-day leave' : 'Approved leave',
      };

      if (!existing) {
        sync.create.push({
          employeeId: request.employeeId,
          date,
          status: request.halfDay ? 'half-day' : 'leave',
          checkIn: null,
          checkOut: null,
          workedMinutes: 0,
          lateMinutes: 0,
          earlyLeaveMinutes: 0,
          overtimeMinutes: 0,
          ...base,
          source: 'manual',
          corrected: false,
          correctionReason: null,
          updatedAt: now,
        });
        continue;
      }

      // Half a day of leave sits beside the other half's attendance rather than replacing it.
      const patch = request.halfDay
        ? { ...base }
        : {
            ...base,
            status: 'leave',
            checkIn: null,
            checkOut: null,
            workedMinutes: 0,
            lateMinutes: 0,
            earlyLeaveMinutes: 0,
            overtimeMinutes: 0,
          };
      if (!request.halfDay && WORKED.has(existing.status)) {
        sync.replaced.push({ date, status: existing.status });
      }
      sync.update.push({ id: existing.id, previous: pick(existing), patch: { ...patch, updatedAt: now } });
    }
  }

  if (decision === 'cancel' && was === 'approved') {
    if (Array.isArray(request.attendanceSync)) {
      // Put each day back as the approval found it.
      const byId = new Map(attendance.map((record) => [record.id, record]));
      for (const entry of request.attendanceSync) {
        if (!byId.has(entry.id)) continue;
        if (entry.created) sync.remove.push(entry.id);
        else sync.update.push({ id: entry.id, previous: null, patch: { ...entry.previous, updatedAt: now } });
      }
    } else {
      // Approved before days were tracked (demo data): the leave days it covered are removed, as
      // the original record of those days is not known.
      for (const record of attendance) {
        if (
          record.status === 'leave' &&
          record.leaveTypeId === request.leaveTypeId &&
          (!record.leaveRequestId || record.leaveRequestId === request.id)
        ) {
          sync.remove.push(record.id);
        }
      }
    }
  }

  return {
    requestPatch,
    balancePatch,
    balanceYear: leaveYearOf(request.startDate, settings.leave && settings.leave.leaveYearStart),
    sync,
    summary: {
      decision,
      from: was,
      to: rule.to,
      days: request.days,
      attendance: {
        created: sync.create.length,
        updated: sync.update.length,
        removed: sync.remove.length,
        replaced: sync.replaced,
      },
    },
  };
}

module.exports = { planDecision, leaveYearOf, workingDates, remainingOf, DECISIONS, MIN_REMARKS, MAX_REMARKS };
