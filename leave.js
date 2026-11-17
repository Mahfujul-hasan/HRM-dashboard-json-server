/**
 * Leave decisions for the mock API.
 *
 *   POST /leave/requests/:id/decision   { decision: approve | reject | cancel, remarks? }
 *
 * A decision changes three things together — the request, the person's balance and the
 * attendance days — and a real backend would do that in one transaction. Here it is one
 * synchronous step on the in-memory database: everything is checked by `planDecision` first, and
 * nothing is written unless the whole decision is allowed. The dashboard calls this instead of
 * patching three collections one by one, where a failure half way would leave a request approved
 * with the days still pending.
 *
 * The request, the balance and the attendance days are each written to the audit log with their
 * old and new values, under the acting user.
 */

const crypto = require('crypto');
const { labelOf } = require('./audit');
const { planDecision, leaveYearOf } = require('./leave-decision');

const newId = (prefix) => `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;

const copy = (value) => JSON.parse(JSON.stringify(value));

/** The fields of a record that changed, as old and new values. */
function changed(before, patch) {
  const oldValue = {};
  const newValue = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'updatedAt' || JSON.stringify(before[key]) === JSON.stringify(value)) continue;
    oldValue[key] = before[key] === undefined ? null : before[key];
    newValue[key] = value;
  }
  return { oldValue, newValue };
}

function createLeaveRoutes(router) {
  const db = router.db;

  return (req, res, next) => {
    const match = /^\/leave\/requests\/([^/]+)\/decision\/?$/.exec(req.path);
    if (!match || req.method !== 'POST') return next();

    const id = decodeURIComponent(match[1]);
    const { decision, remarks } = req.body || {};
    const now = new Date().toISOString();

    try {
      const request = db.get('leaveRequests').find({ id }).value();
      const settings = db.get('settings').value() || {};
      const employee = request ? db.get('employees').find({ id: request.employeeId }).value() : null;

      const year = request ? leaveYearOf(request.startDate, settings.leave && settings.leave.leaveYearStart) : null;
      const balance = request
        ? db
            .get('leaveBalances')
            .find({ employeeId: request.employeeId, leaveTypeId: request.leaveTypeId, year })
            .value()
        : null;

      const attendance = request
        ? db
            .get('attendance')
            .filter(
              (record) =>
                record.employeeId === request.employeeId &&
                record.date >= request.startDate &&
                record.date <= request.endDate,
            )
            .value()
        : [];

      const plan = planDecision({
        request: request && copy(request),
        balance: balance && copy(balance),
        employee,
        attendance: copy(attendance),
        holidays: db.get('holidays').value() || [],
        settings,
        decision,
        remarks,
        userId: req.auditUser ? req.auditUser.id : null,
        now,
      });

      /* Everything is allowed: from here on, write. */
      const audit = (entry) =>
        db
          .get('auditLogs')
          .push({
            id: newId('aud'),
            userId: req.auditUser ? req.auditUser.id : null,
            userEmail: req.auditUser ? req.auditUser.email : null,
            aiRunId: null,
            ip: req.ip,
            userAgent: req.get('user-agent') || null,
            createdAt: now,
            ...entry,
          })
          .value();

      const created = plan.sync.create.map((record) => ({ ...record, id: newId('att') }));
      if (created.length) db.get('attendance').push(...created).value();
      for (const entry of plan.sync.update) db.get('attendance').find({ id: entry.id }).assign(entry.patch).value();
      if (plan.sync.remove.length) {
        const gone = new Set(plan.sync.remove);
        db.get('attendance').remove((record) => gone.has(record.id)).value();
      }

      // What cancelling needs to undo this approval exactly.
      const attendanceSync =
        decision === 'approve'
          ? [
              ...created.map((record) => ({ id: record.id, created: true })),
              ...plan.sync.update.map((entry) => ({ id: entry.id, previous: entry.previous })),
            ]
          : null;
      const requestPatch = { ...plan.requestPatch, attendanceSync };

      const requestBefore = copy(request);
      db.get('leaveRequests').find({ id }).assign(requestPatch).value();
      const updatedRequest = db.get('leaveRequests').find({ id }).value();

      let updatedBalance = null;
      if (plan.balancePatch) {
        const balanceBefore = copy(balance);
        db.get('leaveBalances').find({ id: balance.id }).assign(plan.balancePatch).value();
        updatedBalance = db.get('leaveBalances').find({ id: balance.id }).value();
        const { oldValue, newValue } = changed(balanceBefore, plan.balancePatch);
        if (Object.keys(newValue).length) {
          audit({
            action: 'leaveBalance.update',
            entity: 'leaveBalance',
            entityId: balance.id,
            entityLabel: labelOf(balanceBefore),
            oldValue,
            newValue,
            details: { reason: `Leave request ${id} ${plan.summary.to}` },
          });
        }
      }

      const { oldValue, newValue } = changed(requestBefore, plan.requestPatch);
      audit({
        action: `leave.${decision}`,
        entity: 'leaveRequest',
        entityId: id,
        entityLabel: labelOf(requestBefore),
        oldValue,
        newValue,
        details: {
          days: plan.summary.days,
          attendance: {
            created: plan.summary.attendance.created,
            updated: plan.summary.attendance.updated,
            removed: plan.summary.attendance.removed,
            replacedWork: plan.summary.attendance.replaced.length,
          },
        },
      });

      const touched = plan.summary.attendance;
      if (touched.created || touched.updated || touched.removed) {
        audit({
          action: 'attendance.leave-sync',
          entity: 'attendance',
          entityId: request.employeeId,
          entityLabel: labelOf(requestBefore),
          oldValue: touched.replaced.length ? { replaced: touched.replaced } : null,
          newValue: { leaveRequestId: id, created: touched.created, updated: touched.updated, removed: touched.removed },
          details: { decision },
        });
      }

      if (typeof req.scheduleDbWrite === 'function') req.scheduleDbWrite();
      else db.write();

      return res.json({
        request: updatedRequest,
        balance: updatedBalance,
        attendance: plan.summary.attendance,
        balanceYear: plan.balanceYear,
      });
    } catch (error) {
      const status = error.status || 500;
      return res.status(status).json({ message: error.message, status });
    }
  };
}

module.exports = { createLeaveRoutes };
