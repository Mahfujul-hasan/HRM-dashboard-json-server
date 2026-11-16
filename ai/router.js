/**
 * Intent router for the assistant chat.
 *
 * The HR user types one question into one box. This turns that sentence into a tool call:
 * it scores the message against each intent, pulls out the entities it needs (an employee, a
 * candidate, a month, a department, a record id), and falls back to the general HR data engine
 * when the question is just a question about the data.
 *
 * Matching is keyword and pattern based, which is good enough to route and is honest about it:
 * the chosen tool, the score and the runner-up are returned so the UI can show what it did and
 * let HR pick a different tool.
 */

const { findEmployees } = require('./engines/assistant');

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** Pulls the ids, names, dates and numbers an engine might need out of the message. */
function extractEntities(message, db, now, carried = {}) {
  const text = String(message);
  const lower = text.toLowerCase();
  const entities = { ...carried };

  // Explicit record ids win over anything inferred.
  const idPatterns = {
    employeeId: /\bemp_\d+\b/i,
    candidateId: /\bcan_\d+\b/i,
    jobId: /\bjob_\d+\b/i,
    leaveRequestId: /\blvr_\d+\b/i,
    documentId: /\bdoc_\d+\b/i,
    payrollRunId: /\bpr_\d+\b/i,
    surveyId: /\bsrv_\d+\b/i,
    trainingId: /\btrn_\d+\b/i,
  };
  for (const [key, pattern] of Object.entries(idPatterns)) {
    const match = text.match(pattern);
    if (match) entities[key] = match[0].toLowerCase();
  }

  // Employee code, e.g. EMP-0042.
  const code = text.match(/\bEMP-\d{3,}\b/i);
  if (code) {
    const employee = db.get('employees').find((item) => item.employeeId.toLowerCase() === code[0].toLowerCase());
    if (employee) entities.employeeId = employee.id;
  }

  // Names, matched against the real employee and candidate lists.
  if (!entities.employeeId) {
    const matches = findEmployees(db, ` ${text} `);
    if (matches.length) {
      entities.employeeId = matches[0].id;
      entities.employeeName = matches[0].fullName;
      if (matches.length > 1) entities.ambiguousEmployees = matches.map((item) => item.fullName);
    }
  }
  if (!entities.candidateId) {
    const candidate = db
      .get('candidates')
      .find((item) => lower.includes(item.fullName.toLowerCase()));
    if (candidate) {
      entities.candidateId = candidate.id;
      entities.candidateName = candidate.fullName;
      if (!entities.jobId) entities.jobId = candidate.jobId;
    }
  }

  // Department by name.
  const department = db
    .get('departments')
    .find((item) => item.parentId === null && lower.includes(item.name.toLowerCase()));
  if (department) entities.departmentId = department.id;

  // Job by title, when no candidate already fixed one.
  if (!entities.jobId) {
    const job = db.get('jobs').find((item) => lower.includes(item.title.toLowerCase()));
    if (job) entities.jobId = job.id;
  }

  // Survey by title or type.
  if (!entities.surveyId) {
    const survey = db
      .get('surveys')
      .find((item) => lower.includes(item.title.toLowerCase()) || (lower.includes('exit') && item.type === 'exit'));
    if (survey) entities.surveyId = survey.id;
  }

  // Month: "2026-10", "October", "last month", "this month".
  const isoMonth = text.match(/\b(20\d{2})-(0[1-9]|1[0-2])\b/);
  if (isoMonth) entities.month = isoMonth[0];
  else {
    const named = MONTH_NAMES.findIndex((name) => lower.includes(name));
    if (named >= 0) {
      const year = now.getUTCFullYear() - (named > now.getUTCMonth() ? 1 : 0);
      entities.month = `${year}-${String(named + 1).padStart(2, '0')}`;
    } else if (/last month/.test(lower)) {
      const date = new Date(now);
      date.setUTCMonth(date.getUTCMonth() - 1);
      entities.month = date.toISOString().slice(0, 7);
    } else if (/this month|current month/.test(lower)) {
      entities.month = now.toISOString().slice(0, 7);
    }
  }

  // A window in either direction: "last 14 days", "past 3 months", "next 60 days", "within a week".
  const window = lower.match(/(?:last|past|next|coming|within|in)\s+(?:the\s+)?(\d{1,3})\s*(day|week|month)/);
  if (window) {
    const amount = Number(window[1]);
    entities.days = window[2] === 'day' ? amount : window[2] === 'week' ? amount * 7 : amount * 30;
    if (window[2] === 'month') entities.months = amount;
  }

  // Date range for a leave question: "from 2026-12-01 to 2026-12-05".
  const dates = text.match(/\b20\d{2}-\d{2}-\d{2}\b/g);
  if (dates && dates.length >= 2) {
    entities.startDate = dates[0];
    entities.endDate = dates[1];
  } else if (dates && dates.length === 1) {
    entities.startDate = dates[0];
  }

  return entities;
}

/**
 * Intents, in priority order. `score` counts how many patterns hit, and `requires` lets an
 * intent step aside when the entity it needs is missing.
 */
const INTENTS = [
  {
    toolId: 'candidate-match-score',
    patterns: [/match score/i, /how good a (fit|match)/i, /\bscore\b.*candidate/i, /candidate.*\bscore\b/i, /suitab(le|ility)/i, /\bfit\b.*role/i],
    requires: ['candidateId'],
    build: (entities) => ({ candidateId: entities.candidateId, jobId: entities.jobId }),
  },
  {
    toolId: 'analyze-candidate-cv',
    patterns: [/\bcv\b/i, /\bresume\b/i, /summar(y|ise|ize).*candidate/i, /candidate.*summar/i],
    requires: ['candidateId'],
    build: (entities, message, extra) => ({ candidateId: entities.candidateId, cvText: extra.text || '' }),
  },
  {
    toolId: 'generate-job-description',
    patterns: [/job description/i, /\bjd\b/i, /write.*(job post|vacancy)/i, /draft.*job/i],
    build: (entities) => ({ jobId: entities.jobId, departmentId: entities.departmentId }),
  },
  {
    toolId: 'generate-interview-questions',
    patterns: [/interview questions?/i, /questions? (to|for) ask/i, /what should i ask/i],
    build: (entities) => ({ jobId: entities.jobId }),
  },
  {
    toolId: 'draft-hr-email',
    patterns: [/draft.*(email|mail|letter|invitation|reply)/i, /write.*(email|mail)/i, /send.*(invitation|rejection|offer)/i, /\boffer letter\b/i],
    build: (entities, message) => {
      const lower = message.toLowerCase();
      const kind = /reject/.test(lower)
        ? 'rejection'
        : /offer/.test(lower)
          ? 'offer'
          : /invit|schedule|interview/.test(lower)
            ? 'interview-invitation'
            : /approv/.test(lower) && /leave/.test(lower)
              ? 'leave-approval'
              : /leave/.test(lower)
                ? 'leave-rejection'
                : 'follow-up';
      return { kind, candidateId: entities.candidateId, employeeId: entities.employeeId };
    },
  },
  {
    toolId: 'leave-conflict-check',
    patterns: [
      /leave.*(conflict|clash|coverage|check)/i,
      /check.*leave/i,
      /can .* take leave/i,
      // "approve the leave for X" is still routed here: the check runs, the decision stays with HR.
      /(approve|reject|decline).*leave/i,
      /leave request (for|from)/i,
      /enough (leave )?balance/i,
    ],
    build: (entities) => ({
      leaveRequestId: entities.leaveRequestId,
      employeeId: entities.employeeId,
      startDate: entities.startDate,
      endDate: entities.endDate,
    }),
    requiresAny: ['leaveRequestId', 'employeeId'],
  },
  {
    toolId: 'payroll-validation',
    patterns: [/validate.*payroll/i, /payroll.*(check|validation|issues?|problems?|warnings?)/i, /before (i )?finali[sz]e/i, /payroll ready/i],
    build: (entities) => ({ payrollRunId: entities.payrollRunId, month: entities.month }),
  },
  {
    toolId: 'attendance-insight',
    patterns: [/attendance (anomal|pattern|insight|issue|problem)/i, /who (is|has been) (coming )?late/i, /absenteeism/i, /overtime (pattern|trend|too much)/i, /unusual.*attendance/i],
    build: (entities) => ({ days: entities.days || 30, departmentId: entities.departmentId, employeeId: entities.employeeId }),
  },
  {
    toolId: 'generate-onboarding-plan',
    patterns: [/onboarding plan/i, /30.?60.?90/i, /checklist for .*(new|joiner|hire)/i, /plan.*onboard/i],
    requires: ['employeeId'],
    build: (entities) => ({ employeeId: entities.employeeId }),
  },
  {
    toolId: 'performance-feedback-summary',
    patterns: [/(performance|appraisal) (summary|draft|review) (for|of)/i, /draft.*(review|appraisal)/i, /summar(y|ise|ize).*(feedback|performance)/i],
    requires: ['employeeId'],
    build: (entities) => ({ employeeId: entities.employeeId }),
  },
  {
    toolId: 'skill-gap-analyzer',
    patterns: [/skill gap/i, /what skills? .* (missing|need)/i, /ready for promotion/i, /compare.*skills/i],
    requires: ['employeeId'],
    build: (entities) => ({ employeeId: entities.employeeId }),
  },
  {
    toolId: 'training-recommendation',
    patterns: [/recommend.*training/i, /which (training|course)/i, /training for/i, /learning path/i],
    requires: ['employeeId'],
    build: (entities) => ({ employeeId: entities.employeeId }),
  },
  {
    toolId: 'analyze-exit-interview',
    patterns: [/exit interview/i, /why are people leaving/i, /exit (reason|analysis|pattern)/i],
    build: (entities) => ({ surveyId: entities.surveyId, months: entities.months || 12 }),
  },
  {
    toolId: 'analyze-survey-feedback',
    patterns: [/survey/i, /employee feedback/i, /sentiment/i, /engagement (result|score|analysis)/i, /what are people saying/i],
    build: (entities, message, extra, db) => ({
      surveyId: entities.surveyId || (db.get('surveys').find((item) => item.type === 'engagement') || {}).id,
      departmentId: entities.departmentId,
    }),
  },
  {
    toolId: 'document-expiry-assistant',
    patterns: [/expir(e|ing|y)/i, /renewal/i, /documents? .*(due|expire)/i, /visa|certificate.*expire/i],
    build: (entities) => ({ withinDays: entities.days || 30, employeeId: entities.employeeId }),
  },
  {
    toolId: 'extract-document-data',
    patterns: [/extract.*(data|fields?|information)/i, /read this document/i, /fill (in )?the form/i],
    build: (entities, message, extra) => ({ text: extra.text || '', target: /candidate/i.test(message) ? 'candidate' : 'employee' }),
    requiresText: true,
  },
  {
    toolId: 'summarize-document',
    patterns: [/summar(y|ise|ize).*(document|contract|policy|letter|file)/i, /what does this document say/i, /tl;?dr/i],
    build: (entities, message, extra) => ({ documentId: entities.documentId, text: extra.text || '' }),
  },
  {
    toolId: 'data-quality-checker',
    patterns: [/data (quality|issues?|problems?|errors?)/i, /duplicate/i, /missing (fields?|data|information)/i, /incomplete records?/i, /clean.*data/i],
    build: (entities) => ({ employeeId: entities.employeeId }),
  },
  {
    toolId: 'workforce-forecasting',
    patterns: [/forecast/i, /predict/i, /how many .*(will|need to) hire/i, /staffing (gap|need|plan)/i, /next quarter/i],
    build: (entities) => ({ months: entities.months || 12, horizon: 3 }),
  },
  {
    toolId: 'report-explainer',
    patterns: [/explain/i, /\bwhy (did|has|is|are)\b/i, /\btrend\b/i, /what does .*(report|chart|number) mean/i, /interpret/i],
    build: (entities, message) => {
      const lower = message.toLowerCase();
      const reportType = /attrition|turnover|leaving|resign/.test(lower)
        ? 'attrition'
        : /attendance|late|absent/.test(lower)
          ? 'attendance'
          : /leave/.test(lower)
            ? 'leave'
            : /recruit|hiring|candidate|pipeline/.test(lower)
              ? 'recruitment'
              : /payroll|salary|cost/.test(lower)
                ? 'payroll'
                : /performance|rating|appraisal/.test(lower)
                  ? 'performance'
                  : /training|course|learning/.test(lower)
                    ? 'training'
                    : 'headcount';
      return { reportType, months: entities.months || 6, departmentId: entities.departmentId, question: message };
    },
  },
  {
    toolId: 'ask-hr-policy',
    patterns: [/policy/i, /\bam i allowed\b/i, /what(?:'s| is) the rule/i, /how many .*(entitled|allowed)/i, /carry forward/i, /notice period/i, /probation period/i, /working hours/i, /\bovertime rule/i],
    build: (entities, message) => ({ question: message }),
  },
];

/**
 * Picks a tool for the message.
 * Returns the chosen tool, the input to run it with, the runner-up, and the entities found.
 */
/** A message that refers back to someone without naming them. */
const REFERS_BACK = /\b(his|her|their|them|this (employee|person|candidate)|that (employee|person|candidate)|the same)\b/i;

function route({ message, db, now, context = {}, extra = {} }) {
  // Entities named in this message, and the fuller set including what the conversation carries.
  // Fresh always wins: naming someone new must replace whoever the thread was about.
  const fresh = extractEntities(message, db, now, {});
  const carried = { ...context, ...fresh };

  const scored = INTENTS.map((intent) => {
    const hits = intent.patterns.filter((pattern) => pattern.test(message)).length;
    if (!hits) return null;

    /**
     * Carried entities are only used where they are meant to be: by a tool that needs a
     * subject, or when the sentence points back at one ("what is *her* skill gap?").
     * Otherwise "are there duplicate records?" would silently inherit the employee from the
     * previous question and check one record instead of all of them.
     */
    const needsSubject = Boolean(intent.requires || intent.requiresAny);
    const entities = needsSubject || REFERS_BACK.test(message) ? carried : fresh;

    // An intent that needs an entity it cannot find steps aside.
    if (intent.requires && intent.requires.some((key) => !entities[key])) {
      return { intent, score: 0, blockedBy: intent.requires.filter((key) => !entities[key]) };
    }
    if (intent.requiresAny && !intent.requiresAny.some((key) => entities[key])) {
      return { intent, score: 0, blockedBy: intent.requiresAny };
    }
    if (intent.requiresText && !extra.text) {
      return { intent, score: 0, blockedBy: ['document text'] };
    }

    return { intent, score: hits, entities };
  }).filter(Boolean);

  const runnable = scored.filter((item) => item.score > 0).sort((a, b) => b.score - a.score);
  const blocked = scored.filter((item) => item.score === 0);

  if (!runnable.length) {
    return {
      toolId: 'hr-data-query',
      input: { question: message },
      entities: fresh,
      score: 0,
      blocked: blocked.map((item) => ({ toolId: item.intent.toolId, missing: item.blockedBy })),
      alternatives: [],
      reason: blocked.length
        ? `Routed to the general data engine — ${blocked[0].intent.toolId} would fit but needs ${blocked[0].blockedBy.join(', ')}.`
        : 'Routed to the general data engine.',
    };
  }

  const best = runnable[0];
  const input = best.intent.build(best.entities, message, extra, db) || {};

  return {
    toolId: best.intent.toolId,
    input,
    entities: best.entities,
    score: best.score,
    blocked: blocked.map((item) => ({ toolId: item.intent.toolId, missing: item.blockedBy })),
    alternatives: runnable.slice(1, 4).map((item) => item.intent.toolId),
    reason: `Matched ${best.score} pattern(s) for ${best.intent.toolId}.`,
  };
}

module.exports = { route, extractEntities, INTENTS };
