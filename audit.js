/**
 * Audit logging for the mock API (requirements §5.18).
 *
 * Every successful create, update and delete on a tracked collection is written to
 * `/auditLogs` with the old and new values, the acting user, IP and user agent. The dashboard
 * does not have to remember to log CRUD; it only posts entries for things the server cannot
 * infer — report exports, document downloads, AI review decisions — straight to `/auditLogs`.
 *
 * Writes are batched: entries are appended in memory and flushed to disk shortly afterwards,
 * because json-server rewrites the whole database file on every write.
 */

const crypto = require('crypto');

/** Collections whose mutations are audited, and the entity name used in the entry. */
const TRACKED = {
  employees: 'employee',
  departments: 'department',
  designations: 'designation',
  locations: 'location',
  attendance: 'attendance',
  leaveTypes: 'leaveType',
  leaveRequests: 'leaveRequest',
  leaveBalances: 'leaveBalance',
  holidays: 'holiday',
  salaryStructures: 'salaryStructure',
  payrollRuns: 'payrollRun',
  payslips: 'payslip',
  jobs: 'job',
  candidates: 'candidate',
  interviews: 'interview',
  onboarding: 'onboarding',
  onboardingTasks: 'onboardingTask',
  performanceCycles: 'performanceCycle',
  performanceReviews: 'performanceReview',
  goals: 'goal',
  trainings: 'training',
  trainingEnrollments: 'trainingEnrollment',
  documents: 'document',
  announcements: 'announcement',
  surveys: 'survey',
  surveyResponses: 'surveyResponse',
  aiRuns: 'aiRun',
  settings: 'settings',
};

/** Collections that must never trigger an audit entry of their own. */
const IGNORED = new Set(['auditLogs', 'notifications']);

/** Fields that are never copied into an audit entry. */
const REDACTED = new Set(['password', 'resetToken', 'otpCode', 'token']);

const METHOD_ACTION = { POST: 'create', PATCH: 'update', PUT: 'update', DELETE: 'delete' };

/** Status changes that deserve their own action name instead of a plain `update`. */
const STATUS_ACTIONS = {
  leaveRequest: { approved: 'leave.approve', rejected: 'leave.reject', cancelled: 'leave.cancel' },
  payrollRun: { finalized: 'payroll.finalize', validated: 'payroll.validate' },
  candidate: { selected: 'recruitment.select', rejected: 'recruitment.reject', joined: 'recruitment.join' },
  aiRun: { approved: 'ai.approve', rejected: 'ai.reject' },
};

function redact(value) {
  if (!value || typeof value !== 'object') return value;
  const copy = Array.isArray(value) ? [] : {};
  for (const [key, item] of Object.entries(value)) {
    if (REDACTED.has(key)) continue;
    copy[key] = item && typeof item === 'object' ? redact(item) : item;
  }
  return copy;
}

/** Shallow diff: only the fields that actually changed end up in the entry. */
function diff(before, after) {
  if (!before) return { oldValue: null, newValue: redact(after) };
  if (!after) return { oldValue: redact(before), newValue: null };

  const oldValue = {};
  const newValue = {};

  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (REDACTED.has(key) || key === 'updatedAt') continue;
    if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
    oldValue[key] = redact(before[key]);
    newValue[key] = redact(after[key]);
  }

  return Object.keys(newValue).length ? { oldValue, newValue } : null;
}

/** A human-readable label for the affected record. */
function labelOf(record) {
  if (!record) return null;
  return (
    record.fullName ||
    record.title ||
    record.name ||
    record.month ||
    (record.startDate && record.endDate ? `${record.startDate} to ${record.endDate}` : null) ||
    record.toolId ||
    record.id ||
    null
  );
}

/** Reads the unsigned base64 payload that `auth.js` issues as a token. */
function userFromRequest(db, req) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;

  try {
    const payload = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    const users = db.get('users').value() || [];
    const user = users.find((item) => item.id === payload.sub);
    return user ? { id: user.id, email: user.email } : { id: payload.sub, email: payload.email };
  } catch {
    return null;
  }
}

function createAuditMiddleware(router, options = {}) {
  const db = router.db;
  const flushDelayMs = options.flushDelayMs ?? 750;
  let pendingWrite = null;

  /** Batches the on-disk write so a burst of mutations costs one file rewrite. */
  function scheduleDbWrite() {
    if (pendingWrite) return;
    pendingWrite = setTimeout(() => {
      pendingWrite = null;
      db.write();
    }, flushDelayMs);
    if (typeof pendingWrite.unref === 'function') pendingWrite.unref();
  }

  function append(entry) {
    const logs = db.get('auditLogs');
    if (!logs.value()) return;
    logs.push(entry).value();
    scheduleDbWrite();
  }

  return (req, res, next) => {
    req.scheduleDbWrite = scheduleDbWrite;
    req.auditUser = userFromRequest(db, req);

    const action = METHOD_ACTION[req.method];
    if (!action) return next();

    // `/employees/emp_001` → collection `employees`, id `emp_001`.
    const [, collection, recordId] = req.path.split('/');
    if (!collection || IGNORED.has(collection) || !TRACKED[collection]) return next();

    const entity = TRACKED[collection];
    const isSingleton = collection === 'settings';
    const before =
      isSingleton
        ? JSON.parse(JSON.stringify(db.get(collection).value() || {}))
        : recordId
          ? JSON.parse(JSON.stringify(db.get(collection).find({ id: recordId }).value() || null))
          : null;

    res.on('finish', () => {
      if (res.statusCode >= 400) return;

      const after = isSingleton
        ? db.get(collection).value()
        : action === 'delete'
          ? null
          : db
              .get(collection)
              .find({ id: recordId || (res.locals && res.locals.createdId) || undefined })
              .value() || null;

      // For a create, the new record is the most recently added one with no earlier match.
      const created =
        action === 'create' && !after
          ? (db.get(collection).value() || []).slice(-1)[0] || null
          : after;

      const target = action === 'delete' ? before : created;
      const changes =
        action === 'create'
          ? { oldValue: null, newValue: redact(created) }
          : action === 'delete'
            ? { oldValue: redact(before), newValue: null }
            : diff(before, created);
      // An update that changed nothing is not worth an entry.
      if (!changes) return;

      let resolvedAction = `${entity}.${action}`;
      const statusMap = STATUS_ACTIONS[entity];
      if (statusMap && action === 'update' && changes.newValue && statusMap[changes.newValue.status]) {
        resolvedAction = statusMap[changes.newValue.status];
      }

      append({
        id: `aud_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
        action: resolvedAction,
        entity,
        entityId: target ? target.id || recordId || null : recordId || null,
        entityLabel: labelOf(target),
        userId: req.auditUser ? req.auditUser.id : null,
        userEmail: req.auditUser ? req.auditUser.email : null,
        oldValue: changes.oldValue,
        newValue: changes.newValue,
        aiRunId: (req.body && req.body.aiRunId) || null,
        details: null,
        ip: req.ip,
        userAgent: req.get('user-agent') || null,
        createdAt: new Date().toISOString(),
      });
    });

    return next();
  };
}

module.exports = { createAuditMiddleware, TRACKED, diff, labelOf };
