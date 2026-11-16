/**
 * General HR data questions — the engine behind most chatbot answers.
 *
 * The 20 specialist engines each do one job well. This one answers the everyday questions that
 * do not belong to any of them: how many people are active, who is on leave today, which
 * contracts expire this month, what a given employee's record says. Each handler computes from
 * the collections and returns the rows it used, so the answer can be traced.
 */

const { addDays, average, bullets, compose, confidenceFrom, percent, round, money, source, table, tally, ymd } = require('../helpers');

/** Fields that only appear when the question explicitly asks for them. */
const SENSITIVE = ['salary', 'pay', 'compensation', 'bank', 'ctc'];

function activeEmployees(db) {
  return db.get('employees').filter((employee) => ['active', 'probation'].includes(employee.status));
}

function departmentName(db, id) {
  const department = db.byId('departments', id);
  return department ? department.name : id;
}

function designationTitle(db, id) {
  const designation = db.byId('designations', id);
  return designation ? designation.title : id;
}

/** Employees whose name appears in the question. */
function findEmployees(db, text) {
  const haystack = String(text).toLowerCase();
  return db
    .get('employees')
    .filter((employee) => {
      const full = employee.fullName.toLowerCase();
      if (haystack.includes(full)) return true;
      if (employee.employeeId && haystack.includes(employee.employeeId.toLowerCase())) return true;
      // A distinctive single name is enough, as long as it is not a very short token.
      return employee.lastName.length > 3 && haystack.includes(` ${employee.lastName.toLowerCase()}`);
    })
    .slice(0, 5);
}

/**
 * Handlers run in order and the first match answers, so the specific ones come first.
 * "How many people are on leave today?" is a leave question, not a headcount question, which
 * is why the headcount patterns refuse the qualifiers that belong to another handler.
 */
const HANDLERS = [
  {
    key: 'headcount',
    patterns: [
      /how many (employees|people|staff)\b(?!.*\b(on leave|absent|late|present|joined|left|resigned|probation|birthday)\b)/i,
      /\b(total|current) (headcount|employees|staff)\b/i,
      /^headcount\b/i,
    ],
    run({ db }) {
      const employees = db.get('employees');
      const active = activeEmployees(db);
      const byStatus = tally(employees.map((employee) => employee.status));
      const byDepartment = tally(active.map((employee) => departmentName(db, employee.departmentId)));
      const byType = tally(active.map((employee) => employee.employmentType));

      return {
        text: compose([
          `${active.length} employees are currently on the books (${byStatus.find((item) => item.key === 'probation')?.count || 0} of them on probation), out of ${employees.length} records in total.`,
          `By department\n${table(byDepartment.map((item) => ({ label: item.key, value: item.count })))}`,
          `By status\n${table(byStatus.map((item) => ({ label: item.key, value: item.count })))}`,
          `By employment type\n${table(byType.map((item) => ({ label: item.key, value: item.count })))}`,
        ]),
        sources: [source('dataset', 'employees', `${employees.length} employee records`)],
        data: { active: active.length, total: employees.length, byDepartment, byStatus },
        evidence: employees.length,
      };
    },
  },

  {
    key: 'on-leave',
    patterns: [
      /who(?:'s| is| are)? .*(on leave|off today|away)/i,
      /\bon leave\b/i,
      /\bleave today\b/i,
      /how many .*(on leave|off)\b/i,
    ],
    run({ db, now }) {
      const today = ymd(now);
      const requests = db
        .get('leaveRequests')
        .filter((request) => request.status === 'approved' && request.startDate <= today && request.endDate >= today);

      const rows = requests.map((request) => {
        const employee = db.byId('employees', request.employeeId);
        const type = db.byId('leaveTypes', request.leaveTypeId);
        return `${employee ? employee.fullName : request.employeeId} — ${type ? type.name : 'leave'}, until ${request.endDate} (${departmentName(db, employee ? employee.departmentId : '')})`;
      });

      return {
        text: compose([
          `${requests.length} employee(s) are on approved leave today (${today}).`,
          rows.length ? bullets(rows) : null,
          requests.length
            ? `By department: ${tally(requests.map((request) => {
                const employee = db.byId('employees', request.employeeId);
                return departmentName(db, employee ? employee.departmentId : 'unknown');
              }))
                .map((item) => `${item.key} ${item.count}`)
                .join(', ')}.`
            : null,
        ]),
        sources: [source('dataset', 'leaveRequests', `Approved leave covering ${today}`)],
        data: { date: today, count: requests.length, requestIds: requests.map((request) => request.id) },
        evidence: requests.length + 5,
      };
    },
  },

  {
    key: 'attendance-today',
    patterns: [/\b(present|absent|late) (today|yesterday)\b/i, /who was late/i, /attendance today/i],
    run({ db, now, message }) {
      const wantsYesterday = /yesterday/i.test(message);
      const date = ymd(wantsYesterday ? addDays(now, -1) : now);
      let records = db.get('attendance').filter((record) => record.date === date);

      // Fall back to the most recent day with data, so the answer is never just "nothing".
      let note = null;
      if (!records.length) {
        const latest = db.get('attendance').map((record) => record.date).sort().pop();
        if (latest) {
          records = db.get('attendance').filter((record) => record.date === latest);
          note = `No records for ${date}, so this shows the most recent day with data (${latest}).`;
        }
      }

      const byStatus = tally(records.map((record) => record.status));
      const late = records.filter((record) => record.status === 'late');
      const absent = records.filter((record) => record.status === 'absent');
      const name = (id) => {
        const employee = db.byId('employees', id);
        return employee ? employee.fullName : id;
      };

      return {
        text: compose([
          note,
          `${records.length} attendance record(s) for that day.`,
          byStatus.length ? table(byStatus.map((item) => ({ label: item.key, value: item.count }))) : null,
          late.length ? `Late\n${bullets(late.slice(0, 15).map((record) => `${name(record.employeeId)} — in at ${record.checkIn} (${record.lateMinutes} min late)`))}` : null,
          absent.length ? `Absent\n${bullets(absent.slice(0, 15).map((record) => name(record.employeeId)))}` : null,
        ]),
        sources: [source('dataset', 'attendance', `Attendance for ${date}`)],
        data: { date, byStatus, lateCount: late.length, absentCount: absent.length },
        evidence: records.length,
      };
    },
  },

  {
    key: 'new-hires',
    patterns: [/new (hires|joiners|employees)/i, /who joined/i, /joined (this|last) month/i, /recent joiners/i],
    run({ db, now }) {
      const from = ymd(addDays(now, -45));
      const joiners = db
        .get('employees')
        .filter((employee) => employee.joiningDate >= from)
        .sort((a, b) => b.joiningDate.localeCompare(a.joiningDate));

      return {
        text: compose([
          `${joiners.length} employee(s) joined in the last 45 days.`,
          joiners.length
            ? bullets(
                joiners.map(
                  (employee) =>
                    `${employee.joiningDate} — ${employee.fullName}, ${designationTitle(db, employee.designationId)} (${departmentName(db, employee.departmentId)}), status ${employee.status}`,
                ),
              )
            : null,
          joiners.length ? 'Check their onboarding progress on the onboarding board.' : null,
        ]),
        sources: [source('dataset', 'employees', `Employees joining since ${from}`)],
        data: { from, count: joiners.length, employeeIds: joiners.map((employee) => employee.id) },
        evidence: joiners.length + 3,
      };
    },
  },

  {
    key: 'exits',
    patterns: [/who (left|resigned|quit)/i, /\b(exits|resignations|attrition|turnover)\b/i, /leaving/i],
    run({ db, now }) {
      const from = ymd(addDays(now, -180));
      const leavers = db
        .get('employees')
        .filter((employee) => employee.exit && employee.exit.lastWorkingDate >= from)
        .sort((a, b) => b.exit.lastWorkingDate.localeCompare(a.exit.lastWorkingDate));
      const active = activeEmployees(db).length;

      return {
        text: compose([
          `${leavers.length} employee(s) left in the last 6 months — an attrition rate of about ${percent(leavers.length, active + leavers.length)}%.`,
          leavers.length
            ? bullets(
                leavers
                  .slice(0, 15)
                  .map((employee) => `${employee.exit.lastWorkingDate} — ${employee.fullName} (${departmentName(db, employee.departmentId)}), ${employee.status}: ${employee.exit.reason}`),
              )
            : null,
          leavers.length ? `Most common reason: ${tally(leavers.map((employee) => employee.exit.reason))[0].key}.` : null,
        ]),
        sources: [source('dataset', 'employees', `Exits since ${from}`)],
        data: { from, count: leavers.length },
        evidence: leavers.length + 4,
      };
    },
  },

  {
    key: 'pending-leave',
    patterns: [/pending leave/i, /leave (requests?|applications?) (waiting|pending)/i, /awaiting (approval|decision)/i, /what needs (my )?approval/i],
    run({ db }) {
      const pending = db.get('leaveRequests').filter((request) => request.status === 'pending');

      return {
        text: compose([
          `${pending.length} leave request(s) are waiting for a decision.`,
          pending.length
            ? bullets(
                pending.slice(0, 20).map((request) => {
                  const employee = db.byId('employees', request.employeeId);
                  const type = db.byId('leaveTypes', request.leaveTypeId);
                  return `${employee ? employee.fullName : request.employeeId} — ${type ? type.name : ''}, ${request.startDate} to ${request.endDate} (${request.days} day(s)), applied ${request.appliedOn}`;
                }),
              )
            : null,
          pending.length ? 'Ask me to check conflicts on any of these before you decide.' : null,
        ]),
        sources: [source('dataset', 'leaveRequests', `${pending.length} pending requests`)],
        data: { count: pending.length, requestIds: pending.map((request) => request.id) },
        evidence: pending.length + 4,
      };
    },
  },

  {
    key: 'open-jobs',
    patterns: [/open (jobs|positions|roles|vacancies)/i, /\bhiring\b/i, /recruitment (status|pipeline)/i, /how many candidates/i],
    run({ db }) {
      const jobs = db.get('jobs').filter((job) => job.status === 'open');
      const candidates = db.get('candidates');
      const byStage = tally(candidates.filter((candidate) => !['rejected', 'joined'].includes(candidate.stage)).map((candidate) => candidate.stage));

      return {
        text: compose([
          `${jobs.length} open job(s) covering ${jobs.reduce((sum, job) => sum + job.openings, 0)} opening(s), with ${candidates.length} candidate(s) on record.`,
          jobs.length
            ? bullets(
                jobs.map((job) => {
                  const applicants = candidates.filter((candidate) => candidate.jobId === job.id).length;
                  return `${job.title} (${departmentName(db, job.departmentId)}) — ${job.openings} opening(s), ${applicants} candidate(s), closes ${job.closingDate}`;
                }),
              )
            : null,
          byStage.length ? `Active pipeline\n${table(byStage.map((item) => ({ label: item.key, value: item.count })))}` : null,
        ]),
        sources: [source('dataset', 'jobs', `${jobs.length} open jobs`), source('dataset', 'candidates', `${candidates.length} candidates`)],
        data: { openJobs: jobs.length, byStage },
        evidence: jobs.length + candidates.length / 5,
      };
    },
  },

  {
    key: 'probation',
    patterns: [/probation/i, /confirmation due/i],
    run({ db, now }) {
      const horizon = ymd(addDays(now, 30));
      const today = ymd(now);
      const onProbation = db.get('employees').filter((employee) => employee.status === 'probation');
      const dueSoon = onProbation.filter((employee) => employee.probationEndDate <= horizon);
      const overdue = onProbation.filter((employee) => employee.probationEndDate < today);

      return {
        text: compose([
          `${onProbation.length} employee(s) are on probation; ${dueSoon.length} reach their end date within 30 days and ${overdue.length} are already past it.`,
          dueSoon.length
            ? bullets(
                dueSoon
                  .sort((a, b) => a.probationEndDate.localeCompare(b.probationEndDate))
                  .map((employee) => `${employee.probationEndDate} — ${employee.fullName} (${departmentName(db, employee.departmentId)})${employee.probationEndDate < today ? ' — overdue' : ''}`),
              )
            : null,
          overdue.length ? 'Overdue confirmations should be closed out — the employee is still shown as probationary.' : null,
        ]),
        sources: [source('dataset', 'employees', `${onProbation.length} employees on probation`)],
        data: { onProbation: onProbation.length, dueSoon: dueSoon.length, overdue: overdue.length },
        evidence: onProbation.length + 4,
      };
    },
  },

  {
    key: 'onboarding',
    patterns: [/onboarding (status|progress|tasks)/i, /overdue (tasks|onboarding)/i, /who is onboarding/i],
    run({ db }) {
      const records = db.get('onboarding');
      const open = records.filter((record) => record.status !== 'completed');
      const overdueTasks = db.get('onboardingTasks').filter((task) => task.overdue);

      return {
        text: compose([
          `${open.length} onboarding record(s) are still open, with ${overdueTasks.length} overdue task(s) across all of them.`,
          open.length
            ? bullets(
                open.map((record) => {
                  const employee = db.byId('employees', record.employeeId);
                  return `${employee ? employee.fullName : record.employeeId} — ${record.completionPercent}% complete, ${record.overdueTaskCount} overdue, started ${record.startDate}`;
                }),
              )
            : null,
          overdueTasks.length
            ? `Most common overdue task: ${tally(overdueTasks.map((task) => task.title))[0].key}.`
            : null,
        ]),
        sources: [source('dataset', 'onboarding', `${records.length} onboarding records`)],
        data: { open: open.length, overdueTasks: overdueTasks.length },
        evidence: records.length + overdueTasks.length,
      };
    },
  },

  {
    key: 'birthdays',
    patterns: [/birthday/i, /work anniversar/i],
    run({ db, now, message }) {
      const wantsAnniversary = /anniversar/i.test(message);
      const month = String(now.getUTCMonth() + 1).padStart(2, '0');
      const employees = activeEmployees(db);

      const matches = employees
        .filter((employee) => {
          const date = wantsAnniversary ? employee.joiningDate : employee.dateOfBirth;
          return date && date.slice(5, 7) === month;
        })
        .sort((a, b) => {
          const left = wantsAnniversary ? a.joiningDate : a.dateOfBirth;
          const right = wantsAnniversary ? b.joiningDate : b.dateOfBirth;
          return left.slice(8).localeCompare(right.slice(8));
        });

      return {
        text: compose([
          `${matches.length} ${wantsAnniversary ? 'work anniversary' : 'birthday'}(s) this month.`,
          matches.length
            ? bullets(
                matches.map((employee) => {
                  const date = wantsAnniversary ? employee.joiningDate : employee.dateOfBirth;
                  const years = now.getUTCFullYear() - Number(date.slice(0, 4));
                  return `${date.slice(5)} — ${employee.fullName}${wantsAnniversary ? ` (${years} year${years === 1 ? '' : 's'})` : ''}`;
                }),
              )
            : null,
        ]),
        sources: [source('dataset', 'employees', `${employees.length} active employees`)],
        data: { month, count: matches.length, kind: wantsAnniversary ? 'anniversary' : 'birthday' },
        evidence: matches.length + 5,
      };
    },
  },

  {
    key: 'payroll-summary',
    patterns: [/payroll (summary|total|cost)/i, /salary (cost|bill|total)/i, /how much .*(payroll|salaries)/i],
    run({ db }) {
      const runs = db.get('payrollRuns').sort((a, b) => a.month.localeCompare(b.month));
      const latest = runs.filter((run) => run.status === 'finalized').slice(-1)[0];
      const draft = runs.find((run) => run.status === 'draft');
      const recent = runs.slice(-6);

      return {
        text: compose([
          latest
            ? `The most recent finalised run is ${latest.month}: ${money(latest.totalGross)} gross, ${money(latest.totalDeductions)} deductions, ${money(latest.totalNet)} net across ${latest.employeeCount} employees.`
            : 'No finalised payroll run yet.',
          draft ? `${draft.month} is still in draft with ${draft.validationWarnings.length} validation warning(s).` : null,
          recent.length
            ? `Recent runs\n${table(recent.map((run) => ({ label: `${run.month} (${run.status})`, value: money(run.totalNet) })))}`
            : null,
          'Ask me to validate the draft run before you finalise it.',
        ]),
        sources: [source('report', latest ? latest.id : 'payrollRuns', 'Payroll runs')],
        data: { latestMonth: latest ? latest.month : null, draftMonth: draft ? draft.month : null },
        evidence: runs.length * 3,
      };
    },
  },

  {
    key: 'training-status',
    patterns: [/training (status|completion|programs|programmes)/i, /who completed training/i],
    run({ db }) {
      const enrollments = db.get('trainingEnrollments');
      const completed = enrollments.filter((item) => item.status === 'completed');
      const trainings = db.get('trainings');
      const upcoming = trainings.filter((training) => training.status === 'scheduled');

      return {
        text: compose([
          `${trainings.length} training programme(s) on record, ${enrollments.length} enrolment(s), completion rate ${percent(completed.length, enrollments.length || 1)}%.`,
          upcoming.length
            ? `Upcoming\n${bullets(upcoming.map((training) => `${training.startDate} — ${training.title} (${training.mode}, ${training.durationHours}h)`))}`
            : 'No scheduled programmes ahead.',
          completed.length ? `Average feedback rating: ${round(average(completed.filter((item) => item.rating).map((item) => item.rating)), 1)}/5.` : null,
        ]),
        sources: [source('dataset', 'trainings', `${trainings.length} programmes`)],
        data: { completionRate: percent(completed.length, enrollments.length || 1), upcoming: upcoming.length },
        evidence: enrollments.length / 2,
      };
    },
  },

  {
    key: 'performance-status',
    patterns: [/pending (reviews|appraisals)/i, /performance (status|reviews?)\b/i, /top performers?/i],
    run({ db, message }) {
      const reviews = db.get('performanceReviews');
      const pending = reviews.filter((review) => review.status !== 'completed');
      const rated = reviews.filter((review) => review.rating !== null);

      const wantsTop = /top performer/i.test(message);
      const top = [...rated]
        .sort((a, b) => b.rating - a.rating || String(b.ratedAt).localeCompare(String(a.ratedAt)))
        .slice(0, 10);

      return {
        text: compose([
          `${reviews.length} review record(s): ${pending.length} still open, ${rated.length} rated, average ${round(average(rated.map((review) => review.rating)), 2)}/5.`,
          wantsTop && top.length
            ? `Highest rated\n${bullets(
                top.map((review) => {
                  const employee = db.byId('employees', review.employeeId);
                  return `${employee ? employee.fullName : review.employeeId} — ${review.rating}/5 (${review.ratingLabel})`;
                }),
              )}`
            : null,
          pending.length ? `${pending.length} review(s) still need to be completed.` : null,
          'Ratings are entered by HR. I can draft a review summary, but I cannot set a rating.',
        ]),
        sources: [source('dataset', 'performanceReviews', `${reviews.length} reviews`)],
        data: { pending: pending.length, rated: rated.length },
        evidence: reviews.length / 2,
      };
    },
  },

  {
    key: 'employee-lookup',
    patterns: [/tell me about/i, /who is\b/i, /details? (of|for)\b/i, /profile of/i, /\brecord of\b/i, /leave balance/i, /salary of/i],
    run({ db, message, now }) {
      const matches = findEmployees(db, message);
      if (!matches.length) return null;

      const employee = matches[0];
      const wantsSensitive = SENSITIVE.some((word) => message.toLowerCase().includes(word));
      const manager = employee.reportingManagerId ? db.byId('employees', employee.reportingManagerId) : null;
      const location = db.byId('locations', employee.locationId);

      const year = now.getUTCFullYear();
      const balances = db
        .get('leaveBalances')
        .filter((balance) => balance.employeeId === employee.id && balance.year === year);
      const structure = db.get('salaryStructures').find((item) => item.employeeId === employee.id && item.isCurrent);
      const month = ymd(now).slice(0, 7);
      const attendance = db.get('attendance').filter((record) => record.employeeId === employee.id && record.date.startsWith(month));

      return {
        text: compose([
          `${employee.fullName} (${employee.employeeId}) — ${designationTitle(db, employee.designationId)}, ${departmentName(db, employee.departmentId)}`,
          bullets([
            `Status ${employee.status}, ${employee.employmentType}, ${employee.workMode}`,
            `Joined ${employee.joiningDate}${employee.status === 'probation' ? `, probation ends ${employee.probationEndDate}` : ''}`,
            manager ? `Reports to ${manager.fullName}` : 'No reporting manager recorded',
            location ? `Based at ${location.name}` : null,
            `Contact: ${employee.officialEmail}${employee.phone ? `, ${employee.phone}` : ' (no phone recorded)'}`,
            `Skills: ${employee.skills.join(', ') || 'none recorded'}`,
            employee.exit ? `Exit recorded: last working day ${employee.exit.lastWorkingDate}, reason ${employee.exit.reason}` : null,
          ]),
          balances.length
            ? `Leave balance ${year}\n${table(balances.filter((balance) => balance.entitled > 0).map((balance) => ({ label: balance.leaveTypeCode, value: `${balance.remaining} left of ${balance.entitled + balance.carriedForward} (used ${balance.used}, pending ${balance.pending})` })))}`
            : null,
          attendance.length
            ? `This month: ${attendance.filter((record) => record.status === 'late').length} late, ${attendance.filter((record) => record.status === 'absent').length} absent, ${attendance.filter((record) => record.status === 'leave').length} on leave, over ${attendance.length} recorded day(s).`
            : null,
          wantsSensitive && structure
            ? `Salary (confidential): ${money(structure.monthlyGross)} gross per month, ${money(structure.monthlyNet)} net, effective ${structure.effectiveFrom}. This view is audit-logged.`
            : structure
              ? 'Salary details are available but not shown — ask explicitly if you need them.'
              : 'No current salary structure on record.',
          matches.length > 1 ? `Other people matched this name: ${matches.slice(1).map((item) => item.fullName).join(', ')}.` : null,
        ]),
        sources: [
          source('employee', employee.id, employee.fullName),
          ...balances.slice(0, 2).map((balance) => source('dataset', balance.id, `Leave balance ${balance.leaveTypeCode}`)),
        ],
        data: { employeeId: employee.id, sensitiveShown: Boolean(wantsSensitive && structure) },
        evidence: 10 + balances.length,
        context: { employeeId: employee.id },
      };
    },
  },

  {
    key: 'department-breakdown',
    patterns: [/department(s)? (list|breakdown|size)/i, /how many (departments|teams)/i, /org (structure|chart)/i],
    run({ db }) {
      const parents = db.get('departments').filter((department) => department.parentId === null);
      const active = activeEmployees(db);

      return {
        text: compose([
          `${parents.length} departments and ${db.get('departments').length - parents.length} teams, ${active.length} active employees.`,
          table(
            parents.map((department) => {
              const staff = active.filter((employee) => employee.departmentId === department.id).length;
              const head = department.headEmployeeId ? db.byId('employees', department.headEmployeeId) : null;
              return { label: department.name, value: `${staff} people${head ? `, led by ${head.fullName}` : ''}` };
            }),
          ),
        ]),
        sources: [source('dataset', 'departments', `${db.get('departments').length} departments and teams`)],
        data: { departmentCount: parents.length },
        evidence: parents.length * 3,
      };
    },
  },

  {
    key: 'capabilities',
    patterns: [/what can you (do|help)/i, /^help\b/i, /how (do|does) (you|this) work/i, /who are you/i],
    run({ db, tools }) {
      const grouped = {};
      for (const tool of tools) {
        grouped[tool.module] = grouped[tool.module] || [];
        grouped[tool.module].push(tool.label);
      }

      return {
        text: compose([
          'Ask me anything about the HR data in this system — in plain language. A few examples:',
          bullets([
            '"How many people are on leave today?"',
            '"Tell me about Priya Raman" or "what is her leave balance?"',
            '"Check conflicts for the pending leave request from last week"',
            '"Score the shortlisted candidates for the Sales Manager role"',
            '"Validate the draft payroll run"',
            '"Which documents expire this month?"',
            '"Why did attrition go up?" or "explain the attendance report"',
            '"Draft an interview invitation for Jordan"',
          ]),
          `Behind the scenes I use ${tools.length} tools: ${Object.entries(grouped).map(([module, labels]) => `${module} (${labels.length})`).join(', ')}.`,
          'I can read, summarise, draft and flag. I cannot approve leave, select or reject a candidate, finalise payroll or set a performance rating — those stay with you, and every answer I give is logged with its sources.',
        ]),
        sources: [source('dataset', 'ai-tools', `${tools.length} available tools`)],
        data: { toolCount: tools.length },
        evidence: 20,
      };
    },
  },
];

module.exports = [
  {
    id: 'hr-data-query',
    module: 'assistant',
    label: 'HR Data Question',
    purpose: 'Answers everyday questions about employees, leave, attendance, hiring and payroll',
    input: { question: 'string — a plain-language question about the HR data' },
    prompt: (input) => String(input.question || '').trim(),

    run({ input, db, now, tools }) {
      const message = String(input.question || '').trim();
      if (!message) throw Object.assign(new Error('A question is required'), { status: 400 });

      const available = tools || [];

      for (const handler of HANDLERS) {
        if (!handler.patterns.some((pattern) => pattern.test(message))) continue;
        const result = handler.run({ db, now, message, tools: available });
        if (!result) continue;

        return {
          output: result.text,
          sources: result.sources,
          confidence: confidenceFrom({ evidence: result.evidence || 5, max: 0.85, base: 0.55 }),
          limitation: 'Counted from the records as they stand — anything not entered in the system is not included.',
          data: { handler: handler.key, ...result.data },
          context: result.context || null,
        };
      }

      // Nothing matched: say what is available rather than guessing.
      const capability = HANDLERS.find((handler) => handler.key === 'capabilities');
      const fallback = capability.run({ db, now, message, tools: available });

      return {
        output: compose([
          `I could not work out which data would answer "${message}".`,
          fallback.text,
        ]),
        sources: fallback.sources,
        confidence: 0.2,
        limitation: 'The question did not match anything I know how to compute, so this is a list of what I can do rather than an answer.',
        data: { handler: 'unmatched' },
      };
    },
  },
];

module.exports.HANDLERS = HANDLERS;
module.exports.findEmployees = findEmployees;
