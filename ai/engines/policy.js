/**
 * Ask HR Policy.
 *
 * Answers only from documents flagged `policySource` in the document register, and cites the
 * one it used. When no approved document covers the question it says so instead of guessing —
 * the behaviour a real retrieval-backed answer must also have.
 */

const { bullets, compose, confidenceFrom, source, words } = require('../helpers');

/**
 * Canned answers keyed by topic. Each names the policy document it belongs to, so the answer
 * can be cited. A real model would retrieve the passage instead; the shape of the result,
 * and the rule that an uncited answer is not returned, stay the same.
 */
const KNOWLEDGE = [
  {
    topic: 'annual leave carry forward',
    document: 'Leave Policy',
    keywords: ['carry', 'forward', 'carryforward', 'annual', 'unused', 'lapse', 'expire'],
    answer: (settings) =>
      `Up to ${settings.leave.maxCarryForwardDays} unused annual leave days carry forward into the next leave year. Anything above that lapses at the end of the leave year (${settings.leave.leaveYearStart.replace('-', '/')}).`,
  },
  {
    topic: 'annual leave entitlement',
    document: 'Leave Policy',
    keywords: ['how', 'many', 'annual', 'leave', 'days', 'entitlement', 'quota', 'allowance'],
    answer: (settings, context) => {
      const annual = context.leaveTypes.find((type) => type.code === 'AL');
      const sick = context.leaveTypes.find((type) => type.code === 'SL');
      return `Full-time employees are entitled to ${annual ? annual.annualQuota : 20} annual leave days and ${sick ? sick.annualQuota : 10} sick leave days per year, pro-rated for anyone who joins part-way through the year.`;
    },
  },
  {
    topic: 'leave notice period',
    document: 'Leave Policy',
    keywords: ['notice', 'advance', 'apply', 'before', 'short'],
    answer: (settings) =>
      `Leave should be requested at least ${settings.leave.minNoticeDays} working days in advance. Emergency leave is exempt from the notice requirement but must be recorded by HR on the first day of absence.`,
  },
  {
    topic: 'sick leave documentation',
    document: 'Leave Policy',
    keywords: ['sick', 'medical', 'certificate', 'doctor', 'document', 'proof'],
    answer: (settings) =>
      `A medical certificate is required for sick leave longer than ${settings.leave.requireDocumentAfterDays} consecutive days. HR attaches it to the leave record.`,
  },
  {
    topic: 'leave year and accrual',
    document: 'Leave Policy',
    keywords: ['year', 'accrue', 'accrual', 'accrued', 'granted', 'earned', 'monthly', 'upfront', 'start'],
    answer: (settings) => {
      const start = settings.leave.leaveYearStart;
      const when = start === '01-01' ? 'follows the calendar year' : `starts on ${start.replace('-', '/')}`;
      return `The leave year ${when}. ${
        settings.leave.accrual === 'monthly'
          ? 'Days are earned month by month — a twelfth at the end of each completed month — and can be taken once earned.'
          : "A year's days are granted in full at the start of the leave year."
      } Someone who joins part-way through gets a pro-rated share, to the nearest half day.`;
    },
  },
  {
    topic: 'sandwich leave',
    document: 'Leave Policy',
    keywords: ['sandwich', 'weekend', 'between', 'holiday', 'counted', 'charged', 'friday', 'monday'],
    answer: (settings) =>
      settings.leave.sandwichLeaveEnabled
        ? 'Days off between two days of leave count as leave: a request from Friday to Monday costs four days, not two. A weekend or holiday at either end of the request is never charged.'
        : 'Only working days count as leave: a request from Friday to Monday costs two days, and weekends and public holidays inside it are not charged.',
  },
  {
    topic: 'half-day leave',
    document: 'Leave Policy',
    keywords: ['half', 'halfday', 'part', 'morning', 'afternoon'],
    answer: (settings, context) => {
      const allowed = context.leaveTypes.filter((type) => type.active && type.halfDayAllowed !== false).map((type) => type.name);
      return `A single day can be taken as half a day (0.5 days) for ${allowed.length ? allowed.join(', ') : 'no type of leave'}. A half day cannot be used on a request that spans several days.`;
    },
  },
  {
    topic: 'types of leave',
    document: 'Leave Policy',
    keywords: ['types', 'kinds', 'which', 'paid', 'unpaid', 'categories', 'available'],
    answer: (settings, context) =>
      `Types of leave in use: ${context.leaveTypes
        .filter((type) => type.active)
        .map((type) => `${type.name} (${type.annualQuota} days a year, ${type.paid ? 'paid' : 'unpaid'})`)
        .join('; ')}.`,
  },
  {
    topic: 'longest leave at a time',
    document: 'Leave Policy',
    keywords: ['consecutive', 'maximum', 'longest', 'long', 'most', 'limit', 'row'],
    answer: (settings, context) =>
      `The most days in a row each type allows: ${context.leaveTypes
        .filter((type) => type.active && type.maxConsecutiveDays > 0)
        .map((type) => `${type.name} ${type.maxConsecutiveDays}`)
        .join(', ')}. A longer request can still be recorded; HR decides whether to approve it.`,
  },
  {
    topic: 'how leave is requested',
    document: 'Leave Policy',
    keywords: ['apply', 'request', 'requested', 'submit', 'approves', 'approve', 'approved', 'who'],
    answer: () =>
      'Employees do not use the HR system. They send a request by email, phone or a paper form, and HR records it, checks it against the balance and the team calendar, and approves or rejects it. An approved request takes its days from the balance and marks them as leave in attendance.',
  },
  {
    topic: 'probation',
    document: 'Employee Handbook',
    keywords: ['probation', 'confirmation', 'confirmed', 'trial'],
    answer: (settings) =>
      `New employees serve a ${settings.work.probationMonths}-month probation period. HR schedules a probation review before the end date, and confirmation is recorded on the employee record.`,
  },
  {
    topic: 'working hours',
    document: 'Attendance and Working Hours Policy',
    keywords: ['working', 'hours', 'shift', 'start', 'end', 'time', 'week'],
    answer: (settings) =>
      `Standard hours are ${settings.work.workingHours.start} to ${settings.work.workingHours.end}, ${settings.work.workingDays.join(', ')}, with a ${settings.work.breakMinutes}-minute break — ${settings.work.weeklyHours} hours a week.`,
  },
  {
    topic: 'late arrival',
    document: 'Attendance and Working Hours Policy',
    keywords: ['late', 'grace', 'arrival', 'tardy'],
    answer: (settings) =>
      `A grace period of ${settings.attendance.graceMinutes} minutes applies to the start of the shift. Arrivals after that are recorded as late, and repeated lateness is raised with the employee's manager.`,
  },
  {
    topic: 'overtime',
    document: 'Attendance and Working Hours Policy',
    keywords: ['overtime', 'extra', 'ot', 'additional'],
    answer: (settings) =>
      settings.attendance.overtimeEnabled
        ? `Work beyond ${settings.attendance.overtimeAfterMinutes} minutes past the standard day counts as overtime and is paid at ${settings.attendance.overtimeMultiplier}×. It must be recorded in the attendance sheet to reach payroll.`
        : 'Overtime is currently disabled in the system settings.',
  },
  {
    topic: 'remote work',
    document: 'Remote Work Policy',
    keywords: ['remote', 'home', 'wfh', 'hybrid', 'office', 'days'],
    answer: () =>
      'Hybrid employees are expected on site two days a week, agreed within the team. Fully remote employees record their location on the employee record and follow the same working hours.',
  },
  {
    topic: 'payroll date',
    document: 'Employee Handbook',
    keywords: ['salary', 'paid', 'payday', 'payroll', 'payslip', 'when'],
    answer: (settings) =>
      `Salaries are paid ${settings.payroll.payFrequency} on day ${settings.payroll.payDayOfMonth} of the following month. Payslips are available in the employee's document record once the payroll run is finalised.`,
  },
  {
    topic: 'expenses',
    document: 'Travel and Expense Policy',
    keywords: ['expense', 'travel', 'reimburse', 'claim', 'receipt'],
    answer: () =>
      'Travel and expense claims need an itemised receipt and manager approval, and should be submitted within 30 days of the expense.',
  },
  {
    topic: 'performance review',
    document: 'Performance Review Guidelines',
    keywords: ['review', 'appraisal', 'rating', 'performance', 'cycle', 'goals'],
    answer: () =>
      'Reviews run on an annual cycle with a mid-year check-in. Self-review and manager feedback are collected first, HR calibrates, and the final rating is set by HR — never automatically.',
  },
  {
    topic: 'data protection',
    document: 'Data Protection and Privacy Policy',
    keywords: ['data', 'privacy', 'confidential', 'gdpr', 'personal', 'protection'],
    answer: () =>
      'Employee records are confidential and accessible only to HR. Document downloads and record changes are written to the audit log, and confidential documents are excluded from AI processing unless HR enables it in settings.',
  },
];

module.exports = [
  {
    id: 'ask-hr-policy',
    module: 'policy',
    label: 'Ask HR Policy',
    purpose: 'Answers HR policy questions from approved documents',
    input: { question: 'string — the HR policy question' },
    prompt: (input) => String(input.question || '').trim(),

    run({ input, db, settings }) {
      const question = String(input.question || '').trim();
      if (!question) throw Object.assign(new Error('A question is required'), { status: 400 });

      const policyDocs = db.get('documents').filter((document) => document.policySource && !document.archived);
      const asked = new Set(words(question));

      const scored = KNOWLEDGE.map((entry) => ({
        entry,
        score: entry.keywords.filter((keyword) => asked.has(keyword)).length / entry.keywords.length,
      }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score);

      const best = scored[0];

      // Nothing in the approved set covers this: say so rather than inventing an answer.
      if (!best || best.score < 0.15) {
        return {
          output: compose([
            'No approved policy document covers this question.',
            policyDocs.length
              ? `Approved sources searched:\n${bullets(policyDocs.slice(0, 8).map((document) => document.title))}`
              : 'No documents are currently marked as approved policy sources.',
            'Add or mark the relevant policy document as an approved source, then ask again.',
          ]),
          sources: policyDocs.slice(0, 3).map((document) => source('policy', document.id, document.title)),
          confidence: 0.25,
          limitation: 'No matching approved policy document — this is a "not found" answer, not a policy statement.',
          data: { answered: false, topic: null },
        };
      }

      const document = policyDocs.find((item) => item.title === best.entry.document);
      const context = { leaveTypes: db.get('leaveTypes') };
      const answer = best.entry.answer(settings, context);

      const alternatives = scored.slice(1, 3).map((item) => item.entry.topic);

      return {
        output: compose([
          answer,
          document ? `Source: ${document.title}${document.issueDate ? ` (issued ${document.issueDate})` : ''}` : null,
          alternatives.length ? `Related topics: ${alternatives.join(', ')}` : null,
        ]),
        sources: document
          ? [source('policy', document.id, document.title)]
          : [source('policy', 'missing', `${best.entry.document} (not in the document register)`)],
        confidence: confidenceFrom({ evidence: Math.round(best.score * 10), max: 0.85, base: 0.5 }),
        limitation: document
          ? undefined
          : `The answer comes from the ${best.entry.document}, which is not uploaded to the document register — upload it so the answer can be verified.`,
        data: { answered: true, topic: best.entry.topic, matchScore: best.score },
      };
    },
  },
];
