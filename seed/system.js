/**
 * System collections: users, settings, notifications, audit log and AI runs.
 *
 * Audit entries are derived from the data that was actually generated (employee creation,
 * leave decisions, payroll finalisation, document access, AI reviews), so the audit viewer
 * always points at records that exist.
 */

const config = require('./config');
const { addDays, chance, id, intBetween, iso, pick, picks, weighted } = require('./utils');

const HR_USER = {
  id: 'u_1',
  name: 'Super Admin',
  email: 'admin@hrm.dev',
  password: 'admin123',
  role: 'hr-admin',
  avatarUrl: null,
  employeeId: null,
  active: true,
  lastLoginAt: null,
  failedLoginCount: 0,
  lockedUntil: null,
  twoFactorEnabled: false,
};

function buildSettings() {
  return {
    company: {
      name: config.COMPANY.name,
      legalName: config.COMPANY.legalName,
      logoUrl: null,
      email: `hr@${config.COMPANY.domain}`,
      phone: config.COMPANY.phone,
      website: `https://${config.COMPANY.domain}`,
      address: '600 Market Street, San Francisco, CA 94105',
      taxId: config.COMPANY.taxId,
      currency: config.CURRENCY,
      dateFormat: 'MMM d, yyyy',
      timezone: 'America/Los_Angeles',
      language: 'en',
      fiscalYearStart: '01-01',
    },
    work: {
      workingDays: config.WORKING_DAYS,
      workingHours: { start: config.WORKING_HOURS.start, end: config.WORKING_HOURS.end },
      breakMinutes: config.WORKING_HOURS.breakMinutes,
      weeklyHours: 40,
      probationMonths: 6,
    },
    attendance: {
      graceMinutes: config.ATTENDANCE.graceMinutes,
      halfDayAfterMinutes: config.ATTENDANCE.halfDayAfterMinutes,
      fullDayMinutes: config.ATTENDANCE.fullDayMinutes,
      overtimeEnabled: true,
      overtimeAfterMinutes: config.ATTENDANCE.overtimeAfterMinutes,
      overtimeMultiplier: 1.5,
      absenceDeductionEnabled: true,
      allowCorrections: true,
      correctionWindowDays: 30,
    },
    leave: {
      leaveYearStart: '01-01',
      carryForwardEnabled: true,
      maxCarryForwardDays: 5,
      requireDocumentAfterDays: 3,
      minNoticeDays: 2,
      sandwichLeaveEnabled: false,
    },
    payroll: {
      payFrequency: 'monthly',
      payDayOfMonth: 1,
      currency: config.CURRENCY,
      components: {
        basicPercent: 55,
        housingPercent: 20,
        transportPercent: 8,
        medicalPercent: 7,
        otherPercent: 10,
      },
      retirementPercentOfBasic: 5,
      insuranceFlatAmount: 120,
      lockAfterFinalize: true,
    },
    notifications: {
      emailEnabled: false,
      documentExpiryDays: 30,
      probationEndDays: 14,
      contractExpiryDays: 30,
      onboardingOverdue: true,
      pendingLeaveReminder: true,
    },
    ai: {
      enabled: true,
      provider: 'mock',
      model: 'rule-based-mock',
      /** Swapped for a real model later; the /ai/run contract does not change. */
      retentionDays: 90,
      requireHumanReview: true,
      allowConfidentialDocuments: false,
      logPrompts: true,
      features: {
        askHrPolicy: true,
        summarizeDocument: true,
        extractDocumentData: true,
        classifyDocument: true,
        askDocument: true,
        searchDocuments: true,
        summarizeEmployeeProfile: true,
        generateJobDescription: true,
        generateInterviewQuestions: true,
        analyzeCandidateCv: true,
        candidateMatchScore: true,
        draftHrEmail: true,
        generateOnboardingPlan: true,
        analyzeSurveyFeedback: true,
        analyzeExitInterview: true,
        attendanceInsight: true,
        payrollValidation: true,
        performanceFeedbackSummary: true,
        skillGapAnalyzer: true,
        trainingRecommendation: true,
        reportExplainer: true,
        workforceForecasting: true,
        documentExpiryAssistant: true,
        dataQualityChecker: true,
      },
    },
    security: {
      sessionTimeoutMinutes: 60,
      maxFailedLogins: 5,
      lockoutMinutes: 15,
      twoFactorRequired: false,
      passwordMinLength: 8,
    },
    audit: { enabled: true, retentionDays: 730, logReads: false, logExports: true },
    backup: { enabled: false, frequency: 'weekly', lastBackupAt: null },
    updatedAt: iso(config.TODAY),
  };
}

/** Sample AI runs, one per tool family, in the shape the dashboard's `AiRun` type expects. */
function buildAiRuns({ employees, documents, candidates, leaveRequests, payrollRuns, hrUser }) {
  const now = config.TODAY;
  const policyDocs = documents.filter((document) => document.policySource);
  const runs = [];
  let index = 1;

  const push = (toolId, prompt, output, sources, options = {}) => {
    const createdAt = addDays(now, -intBetween(0, 45));
    const status = options.status || weighted([
      { weight: 5, value: 'approved' },
      { weight: 3, value: 'draft' },
      { weight: 2, value: 'rejected' },
    ]);
    const reviewed = status !== 'draft';

    runs.push({
      id: id('air', index++, 4),
      toolId,
      module: options.module || null,
      entityType: options.entityType || null,
      entityId: options.entityId || null,
      prompt,
      input: options.input || null,
      output,
      sources,
      confidence: options.confidence ?? Number((0.55 + Math.min(0.4, index / 100)).toFixed(2)),
      limitation: 'Rule-based mock AI — review the source data before acting on this result.',
      status,
      reviewedBy: reviewed ? hrUser.id : undefined,
      reviewedAt: reviewed ? iso(addDays(createdAt, 1)) : undefined,
      lastAction: reviewed ? (status === 'approved' ? 'approve' : 'reject') : 'generate',
      editedOutput: null,
      createdBy: hrUser.id,
      createdAt: iso(createdAt),
    });
  };

  const sampleEmployees = picks(employees.filter((employee) => employee.status === 'active'), 4);
  const policySource = policyDocs.length
    ? { kind: 'policy', id: policyDocs[0].id, label: policyDocs[0].title }
    : { kind: 'policy', id: 'none', label: 'Employee Handbook' };

  push(
    'ask-hr-policy',
    'How many annual leave days carry forward to next year?',
    'Up to 5 unused annual leave days carry forward into the next leave year. Anything above that lapses on 31 December.',
    [policySource],
    { module: 'policy', confidence: 0.82 },
  );

  for (const employee of sampleEmployees.slice(0, 2)) {
    push(
      'data-quality-checker',
      `Check the record of ${employee.fullName} for missing or inconsistent fields`,
      `2 issues found for ${employee.employeeId}: personal email domain matches another record, and the emergency contact phone is missing a country code.`,
      [{ kind: 'employee', id: employee.id, label: employee.fullName }],
      { module: 'data-quality', entityType: 'employee', entityId: employee.id, confidence: 0.74 },
    );
  }

  const candidate = candidates.find((item) => item.stage === 'shortlisted') || candidates[0];
  if (candidate) {
    push(
      'candidate-match-score',
      `Match ${candidate.fullName} against the job requirements`,
      `Match score 76%. Strengths: ${candidate.skills.slice(0, 3).join(', ')}. Gaps: no recorded experience with the two nice-to-have skills. Suggested next action: schedule a screening call. HR makes the final decision.`,
      [{ kind: 'dataset', id: candidate.id, label: `Candidate: ${candidate.fullName}` }],
      { module: 'recruitment', entityType: 'candidate', entityId: candidate.id, confidence: 0.68 },
    );
  }

  const pendingLeave = leaveRequests.find((request) => request.status === 'pending');
  if (pendingLeave) {
    push(
      'leave-conflict-check',
      `Check conflicts for leave request ${pendingLeave.id}`,
      'No holiday overlap. Balance is sufficient. 2 colleagues in the same department are already on approved leave for one of these days, which leaves thin coverage.',
      [{ kind: 'dataset', id: pendingLeave.id, label: `Leave request ${pendingLeave.id}` }],
      { module: 'leave', entityType: 'leaveRequest', entityId: pendingLeave.id, status: 'draft', confidence: 0.71 },
    );
  }

  const draftRun = payrollRuns.find((run) => run.status === 'draft');
  if (draftRun) {
    push(
      'payroll-validation',
      `Validate payroll for ${draftRun.month}`,
      `${draftRun.validationWarnings.length} issues found: missing attendance for some employees and overtime above 25% of gross in a few records. Resolve these before finalising.`,
      [{ kind: 'report', id: draftRun.id, label: `Payroll run ${draftRun.month}` }],
      { module: 'payroll', entityType: 'payrollRun', entityId: draftRun.id, status: 'draft', confidence: 0.8 },
    );
  }

  push(
    'attendance-insight',
    'Find attendance anomalies for the last 30 days',
    'Three employees show late arrivals on more than 40% of working days, and one shows overtime above 30 hours in the month. Confirm or dismiss each case before it reaches a report.',
    [{ kind: 'dataset', id: 'attendance', label: 'Attendance, last 30 days' }],
    { module: 'attendance', confidence: 0.66 },
  );

  push(
    'analyze-survey-feedback',
    'Analyse the latest engagement survey comments',
    'Top themes: workload (28% of comments, mostly negative), career growth (19%, negative), management (17%, mixed), facilities (11%). Urgent: repeated mentions of unsustainable workload in one department.',
    [{ kind: 'dataset', id: 'srv_01', label: 'Quarterly Engagement Survey' }],
    { module: 'surveys', confidence: 0.63 },
  );

  push(
    'document-expiry-assistant',
    'Which documents expire in the next 30 days?',
    'Several work authorizations and professional certifications expire inside 30 days, and a few are already expired. Renewal reminders drafted for HR review.',
    [{ kind: 'document', id: 'documents', label: 'Document register' }],
    { module: 'documents', confidence: 0.88 },
  );

  return runs;
}

function buildAuditLogs({ employees, leaveRequests, payrollRuns, documents, aiRuns, hrUser }) {
  const now = config.TODAY;
  const logs = [];
  let index = 1;

  const ip = () => `203.0.113.${intBetween(2, 250)}`;
  const agent = () =>
    pick([
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/18.2',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/134.0',
    ]);

  const push = (entry) => {
    const createdAt = entry.createdAt || iso(addDays(now, -intBetween(0, config.HISTORY_MONTHS * 30)));
    logs.push({
      id: id('aud', index++, 4),
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId || null,
      entityLabel: entry.entityLabel || null,
      userId: hrUser.id,
      userEmail: hrUser.email,
      oldValue: entry.oldValue ?? null,
      newValue: entry.newValue ?? null,
      aiRunId: entry.aiRunId || null,
      details: entry.details || null,
      ip: ip(),
      userAgent: agent(),
      createdAt,
    });
  };

  // Logins across the history window, including a few failures.
  for (let n = 0; n < 60; n += 1) {
    const failed = chance(0.12);
    push({
      action: failed ? 'auth.login.failed' : 'auth.login',
      entity: 'session',
      entityLabel: hrUser.email,
      details: failed ? { reason: 'Incorrect password' } : null,
    });
  }

  for (const employee of picks(employees, Math.min(employees.length, 30))) {
    push({
      action: 'employee.create',
      entity: 'employee',
      entityId: employee.id,
      entityLabel: employee.fullName,
      newValue: { status: employee.status, departmentId: employee.departmentId },
      createdAt: employee.createdAt,
    });

    if (chance(0.5)) {
      push({
        action: 'employee.update',
        entity: 'employee',
        entityId: employee.id,
        entityLabel: employee.fullName,
        oldValue: { phone: '***-***-0000' },
        newValue: { phone: employee.phone },
      });
    }
  }

  for (const request of picks(
    leaveRequests.filter((item) => item.status !== 'pending'),
    Math.min(leaveRequests.length, 40),
  )) {
    push({
      action: request.status === 'approved' ? 'leave.approve' : 'leave.reject',
      entity: 'leaveRequest',
      entityId: request.id,
      entityLabel: `${request.startDate} to ${request.endDate}`,
      oldValue: { status: 'pending' },
      newValue: { status: request.status },
      createdAt: request.decidedAt || request.createdAt,
    });
  }

  for (const run of payrollRuns.filter((item) => item.status === 'finalized')) {
    push({
      action: 'payroll.finalize',
      entity: 'payrollRun',
      entityId: run.id,
      entityLabel: run.month,
      oldValue: { status: 'validated' },
      newValue: { status: 'finalized', totalNet: run.totalNet },
      createdAt: run.finalizedAt,
    });
  }

  for (const document of picks(documents, 25)) {
    push({
      action: chance(0.5) ? 'document.download' : 'document.upload',
      entity: 'document',
      entityId: document.id,
      entityLabel: document.title,
      details: { confidential: document.confidential },
    });
  }

  for (const run of aiRuns) {
    push({
      action: 'ai.generate',
      entity: 'aiRun',
      entityId: run.id,
      entityLabel: run.toolId,
      aiRunId: run.id,
      details: { toolId: run.toolId, confidence: run.confidence },
      createdAt: run.createdAt,
    });

    if (run.status !== 'draft') {
      push({
        action: run.status === 'approved' ? 'ai.approve' : 'ai.reject',
        entity: 'aiRun',
        entityId: run.id,
        entityLabel: run.toolId,
        aiRunId: run.id,
        oldValue: { status: 'draft' },
        newValue: { status: run.status },
        createdAt: run.reviewedAt,
      });
    }
  }

  for (let n = 0; n < 12; n += 1) {
    push({
      action: 'report.export',
      entity: 'report',
      entityLabel: pick([
        'Employee headcount report',
        'Attendance report',
        'Leave balance report',
        'Payroll summary report',
        'Attrition report',
      ]),
      details: { format: pick(['xlsx', 'csv', 'pdf']) },
    });
  }

  return logs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function buildNotifications({ documents, onboardingTasks, leaveRequests, employees }) {
  const now = config.TODAY;
  const notifications = [];
  let index = 1;

  const soon = documents.filter((document) => {
    if (!document.expiryDate) return false;
    const days = (new Date(`${document.expiryDate}T00:00:00Z`) - now) / 86400000;
    return days >= 0 && days <= 30;
  });

  for (const document of soon.slice(0, 8)) {
    notifications.push({
      id: id('ntf', index++, 3),
      type: 'document-expiry',
      severity: 'warning',
      title: 'Document expiring soon',
      message: `${document.title} expires on ${document.expiryDate}.`,
      entity: 'document',
      entityId: document.id,
      read: chance(0.3),
      createdAt: iso(addDays(now, -intBetween(0, 5))),
    });
  }

  for (const task of onboardingTasks.filter((item) => item.overdue).slice(0, 6)) {
    notifications.push({
      id: id('ntf', index++, 3),
      type: 'onboarding-overdue',
      severity: 'error',
      title: 'Onboarding task overdue',
      message: `${task.title} was due on ${task.dueDate}.`,
      entity: 'onboardingTask',
      entityId: task.id,
      read: false,
      createdAt: iso(addDays(now, -intBetween(0, 7))),
    });
  }

  for (const request of leaveRequests.filter((item) => item.status === 'pending').slice(0, 6)) {
    const employee = employees.find((item) => item.id === request.employeeId);
    notifications.push({
      id: id('ntf', index++, 3),
      type: 'leave-pending',
      severity: 'info',
      title: 'Leave request waiting for a decision',
      message: `${employee ? employee.fullName : request.employeeId} requested leave from ${request.startDate}.`,
      entity: 'leaveRequest',
      entityId: request.id,
      read: false,
      createdAt: request.createdAt,
    });
  }

  return notifications.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

module.exports = { HR_USER, buildSettings, buildAiRuns, buildAuditLogs, buildNotifications };
