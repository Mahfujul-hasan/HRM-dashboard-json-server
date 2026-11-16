/**
 * Report explanation and workforce forecasting (requirements §5.15).
 *
 * Both engines compute from the live collections and always state the filters and the data
 * window they used, because an explanation without its source is not reviewable.
 */

const { addDays, average, bullets, compose, confidenceFrom, forecast, money, monthKey, percent, round, source, table, tally, ymd } = require('../helpers');

/** Month keys from oldest to newest, `count` of them, ending with the current month. */
function recentMonths(now, count) {
  const months = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = new Date(now);
    date.setUTCMonth(date.getUTCMonth() - offset);
    months.push(monthKey(date));
  }
  return months;
}

/** Headcount at the end of each month. */
function headcountSeries(employees, months) {
  return months.map((month) => {
    const end = `${month}-31`;
    return employees.filter((employee) => {
      const joined = employee.joiningDate <= end;
      const left = employee.exit && employee.exit.lastWorkingDate <= end;
      return joined && !left;
    }).length;
  });
}

const REPORTS = {
  headcount: 'Employee headcount',
  attrition: 'Attrition and resignation',
  attendance: 'Attendance',
  leave: 'Leave balance and usage',
  recruitment: 'Recruitment funnel',
  payroll: 'Payroll summary',
  performance: 'Performance rating',
  training: 'Training completion',
};

module.exports = [
  {
    id: 'report-explainer',
    module: 'reports',
    label: 'Report Explainer',
    purpose: 'Explains HR reports, charts and trends in plain language',
    input: {
      reportType: `string — one of ${Object.keys(REPORTS).join(', ')}`,
      months: 'number — window, default 6',
      departmentId: 'string — limit to one department (optional)',
      question: 'string — a specific question about the report (optional)',
    },
    prompt: (input) =>
      input.question
        ? `${input.question} (${input.reportType || 'headcount'} report)`
        : `Explain the ${input.reportType || 'headcount'} report`,

    run({ input, db, now }) {
      const reportType = input.reportType || 'headcount';
      if (!REPORTS[reportType]) {
        throw Object.assign(new Error(`Unknown reportType. Use one of: ${Object.keys(REPORTS).join(', ')}`), { status: 400 });
      }

      const months = Number(input.months || 6);
      const monthKeys = recentMonths(now, months);
      const filters = { reportType, months, departmentId: input.departmentId || null };

      let employees = db.get('employees');
      if (input.departmentId) employees = employees.filter((employee) => employee.departmentId === input.departmentId);

      const findings = [];
      const risks = [];
      let headline = '';
      let series = [];

      if (reportType === 'headcount') {
        series = headcountSeries(employees, monthKeys);
        const change = series[series.length - 1] - series[0];
        headline = `Headcount moved from ${series[0]} to ${series[series.length - 1]} over ${months} months (${change >= 0 ? '+' : ''}${change}).`;
        const joiners = employees.filter((employee) => employee.joiningDate >= `${monthKeys[0]}-01`).length;
        const leavers = employees.filter((employee) => employee.exit && employee.exit.lastWorkingDate >= `${monthKeys[0]}-01`).length;
        findings.push(`${joiners} people joined and ${leavers} left in the window.`);
        findings.push(
          `Largest departments: ${tally(employees.filter((employee) => employee.status === 'active').map((employee) => {
            const department = db.byId('departments', employee.departmentId);
            return department ? department.name : employee.departmentId;
          }))
            .slice(0, 3)
            .map((item) => `${item.key} (${item.count})`)
            .join(', ')}.`,
        );
        if (leavers > joiners) risks.push('More people left than joined in this window — net shrinkage.');
      }

      if (reportType === 'attrition') {
        const leavers = employees.filter((employee) => employee.exit && employee.exit.lastWorkingDate >= `${monthKeys[0]}-01`);
        series = monthKeys.map((month) => leavers.filter((employee) => employee.exit.lastWorkingDate.startsWith(month)).length);
        const active = employees.filter((employee) => employee.status === 'active').length;
        const rate = percent(leavers.length, active + leavers.length);
        headline = `${leavers.length} exit(s) over ${months} months, an attrition rate of ${rate}%.`;
        const reasons = tally(leavers.map((employee) => employee.exit.reason));
        if (reasons.length) findings.push(`Top reason: ${reasons[0].key} (${reasons[0].count} of ${leavers.length}).`);
        const probationExits = leavers.filter((employee) => employee.status === 'terminated').length;
        if (probationExits) findings.push(`${probationExits} were terminations rather than resignations.`);
        if (rate > 15) risks.push(`Attrition of ${rate}% is above a typical healthy range — worth a root-cause review.`);
      }

      if (reportType === 'attendance') {
        const from = `${monthKeys[0]}-01`;
        const ids = new Set(employees.map((employee) => employee.id));
        const records = db.get('attendance').filter((record) => record.date >= from && ids.has(record.employeeId));
        series = monthKeys.map((month) => records.filter((record) => record.date.startsWith(month) && record.status === 'late').length);
        const late = records.filter((record) => record.status === 'late').length;
        const absent = records.filter((record) => record.status === 'absent').length;
        const overtimeHours = round(records.reduce((sum, record) => sum + (record.overtimeMinutes || 0), 0) / 60, 0);
        headline = `${records.length} attendance records: ${percent(late, records.length)}% late, ${percent(absent, records.length)}% absent, ${overtimeHours} overtime hours.`;
        findings.push(`${records.filter((record) => record.corrected).length} record(s) were manually corrected.`);
        if (percent(late, records.length) > 12) risks.push('Late arrivals are above one in eight working days.');
      }

      if (reportType === 'leave') {
        const ids = new Set(employees.map((employee) => employee.id));
        const requests = db.get('leaveRequests').filter((request) => ids.has(request.employeeId) && request.startDate >= `${monthKeys[0]}-01`);
        series = monthKeys.map((month) => requests.filter((request) => request.startDate.startsWith(month)).length);
        const approved = requests.filter((request) => request.status === 'approved');
        const pending = requests.filter((request) => request.status === 'pending');
        headline = `${requests.length} leave request(s): ${approved.length} approved, ${pending.length} still pending, ${requests.filter((request) => request.status === 'rejected').length} rejected.`;
        const byType = tally(approved.map((request) => {
          const type = db.byId('leaveTypes', request.leaveTypeId);
          return type ? type.name : request.leaveTypeId;
        }));
        if (byType.length) findings.push(`Most used: ${byType.slice(0, 3).map((item) => `${item.key} (${item.count})`).join(', ')}.`);
        if (pending.length > 5) risks.push(`${pending.length} requests are waiting for a decision.`);
      }

      if (reportType === 'recruitment') {
        const jobs = db.get('jobs').filter((job) => (input.departmentId ? job.departmentId === input.departmentId : true));
        const jobIds = new Set(jobs.map((job) => job.id));
        const candidates = db.get('candidates').filter((candidate) => jobIds.has(candidate.jobId));
        const stages = tally(candidates.map((candidate) => candidate.stage));
        series = monthKeys.map((month) => candidates.filter((candidate) => String(candidate.appliedAt).startsWith(month)).length);
        headline = `${jobs.filter((job) => job.status === 'open').length} open job(s) and ${candidates.length} candidate(s) in the pipeline.`;
        findings.push(`Stage spread: ${stages.slice(0, 5).map((item) => `${item.key} ${item.count}`).join(', ')}.`);
        const joined = candidates.filter((candidate) => candidate.stage === 'joined').length;
        findings.push(`${joined} candidate(s) reached joined — a ${percent(joined, candidates.length)}% conversion from application.`);
        const stale = jobs.filter((job) => job.status === 'open' && job.closingDate < ymd(now));
        if (stale.length) risks.push(`${stale.length} open job(s) are past their closing date.`);
      }

      if (reportType === 'payroll') {
        const runs = db.get('payrollRuns').filter((run) => monthKeys.includes(run.month));
        series = runs.map((run) => run.totalNet);
        headline = `${runs.length} payroll run(s) in the window, latest net total ${money(series[series.length - 1] || 0)}.`;
        const warnings = runs.reduce((sum, run) => sum + run.validationWarnings.length, 0);
        findings.push(`${warnings} validation warning(s) recorded across these runs.`);
        const draft = runs.filter((run) => run.status === 'draft');
        if (draft.length) risks.push(`${draft.length} run(s) are still in draft.`);
      }

      if (reportType === 'performance') {
        const ids = new Set(employees.map((employee) => employee.id));
        const reviews = db.get('performanceReviews').filter((review) => ids.has(review.employeeId));
        const rated = reviews.filter((review) => review.rating !== null);
        const distribution = tally(rated.map((review) => `${review.rating}/5`));
        series = [1, 2, 3, 4, 5].map((rating) => rated.filter((review) => review.rating === rating).length);
        headline = `${rated.length} rated review(s), average ${round(average(rated.map((review) => review.rating)), 2)}/5.`;
        findings.push(`Distribution: ${distribution.map((item) => `${item.key} → ${item.count}`).join(', ')}.`);
        const pending = reviews.filter((review) => review.status === 'pending').length;
        if (pending) risks.push(`${pending} review(s) are still pending.`);
      }

      if (reportType === 'training') {
        const ids = new Set(employees.map((employee) => employee.id));
        const enrollments = db.get('trainingEnrollments').filter((item) => ids.has(item.employeeId));
        const completed = enrollments.filter((item) => item.status === 'completed');
        series = monthKeys.map((month) => completed.filter((item) => String(item.completedAt).startsWith(month)).length);
        headline = `${enrollments.length} enrolment(s) with a ${percent(completed.length, enrollments.length || 1)}% completion rate.`;
        findings.push(`${enrollments.filter((item) => item.status === 'dropped').length} enrolment(s) were dropped.`);
        const spend = db.get('trainings').reduce((sum, training) => sum + training.cost, 0);
        findings.push(`Programme cost on the books: ${money(spend)}.`);
        if (percent(completed.length, enrollments.length || 1) < 70) risks.push('Completion is below 70%.');
      }

      const { slope, projection } = forecast(series.filter((value) => typeof value === 'number'), 3);
      const direction = slope > 0.5 ? 'rising' : slope < -0.5 ? 'falling' : 'broadly flat';

      const department = input.departmentId ? db.byId('departments', input.departmentId) : null;

      return {
        output: compose([
          `${REPORTS[reportType]} report — ${headline}`,
          input.question ? `Question asked: "${input.question}"` : null,
          `The series over ${monthKeys.length} period(s) is ${direction} (slope ${slope} per period): ${series.join(' → ')}.`,
          findings.length ? `Key findings\n${bullets(findings)}` : null,
          risks.length ? `Risks\n${bullets(risks)}` : 'No risk thresholds were crossed.',
          `Next three periods, if the trend holds: ${projection.join(', ')}.`,
          `Data used\n${table([
            { label: 'Report', value: REPORTS[reportType] },
            { label: 'Window', value: `${monthKeys[0]} to ${monthKeys[monthKeys.length - 1]}` },
            { label: 'Department filter', value: department ? department.name : 'all departments' },
            { label: 'Employees in scope', value: employees.length },
          ])}`,
          'A straight-line projection, not a forecast model. It assumes nothing changes, which is rarely true in hiring or attrition.',
        ]),
        sources: [
          source('report', reportType, `${REPORTS[reportType]} report`),
          source('dataset', 'employees', `${employees.length} employees in scope`),
          department ? source('dataset', department.id, `Department: ${department.name}`) : null,
        ].filter(Boolean),
        confidence: confidenceFrom({ evidence: series.length * 3 + employees.length / 10, max: 0.75 }),
        limitation: 'Descriptive statistics with a straight-line trend. It explains what the numbers do, not why.',
        data: { filters, series, months: monthKeys, slope, projection, findings, risks },
      };
    },
  },

  {
    id: 'workforce-forecasting',
    module: 'reports',
    label: 'Workforce Forecasting',
    purpose: 'Predicts hiring needs, attrition risk and staffing gaps',
    input: { months: 'number — history to learn from, default 12', horizon: 'number — periods ahead, default 3' },
    prompt: (input) => `Forecast workforce needs for the next ${input.horizon || 3} months`,

    run({ input, db, now }) {
      const months = Number(input.months || 12);
      const horizon = Number(input.horizon || 3);
      const monthKeys = recentMonths(now, months);

      const employees = db.get('employees');
      const active = employees.filter((employee) => employee.status === 'active' || employee.status === 'probation');

      const headcount = headcountSeries(employees, monthKeys);
      const exits = monthKeys.map((month) =>
        employees.filter((employee) => employee.exit && employee.exit.lastWorkingDate.startsWith(month)).length,
      );
      const hires = monthKeys.map((month) => employees.filter((employee) => employee.joiningDate.startsWith(month)).length);

      const headcountForecast = forecast(headcount, horizon);
      const exitForecast = forecast(exits, horizon);
      const monthlyAttrition = round(average(exits), 1);
      const annualisedAttrition = percent(Math.round(monthlyAttrition * 12), active.length || 1);

      // Open demand already in the system.
      const openJobs = db.get('jobs').filter((job) => job.status === 'open');
      const openings = openJobs.reduce((sum, job) => sum + job.openings, 0);
      const pipeline = db.get('candidates').filter((candidate) => !['rejected', 'joined'].includes(candidate.stage));
      const offersOut = pipeline.filter((candidate) => ['offer-sent', 'offer-accepted'].includes(candidate.stage)).length;

      // Departments carrying risk: high recent exits or probation-heavy.
      const departmentRisk = db
        .get('departments')
        .filter((department) => department.parentId === null)
        .map((department) => {
          const staff = active.filter((employee) => employee.departmentId === department.id);
          const recentExits = employees.filter(
            (employee) =>
              employee.departmentId === department.id &&
              employee.exit &&
              employee.exit.lastWorkingDate >= `${monthKeys[Math.max(0, monthKeys.length - 6)]}-01`,
          ).length;
          const onProbation = staff.filter((employee) => employee.status === 'probation').length;
          return {
            department: department.name,
            staff: staff.length,
            recentExits,
            onProbation,
            riskScore: percent(recentExits, staff.length + recentExits || 1),
          };
        })
        .filter((item) => item.staff > 0)
        .sort((a, b) => b.riskScore - a.riskScore);

      const atRisk = departmentRisk.filter((item) => item.riskScore >= 15);

      const expectedExits = Math.round(exitForecast.projection.reduce((sum, value) => sum + value, 0));
      const hiringNeed = Math.max(0, expectedExits + openings - offersOut);

      // Overtime pressure as a proxy for understaffing.
      const recent = db.get('attendance').filter((record) => record.date >= ymd(addDays(now, -60)));
      const overtimeHours = round(recent.reduce((sum, record) => sum + (record.overtimeMinutes || 0), 0) / 60, 0);
      const overtimePerHead = round(overtimeHours / (active.length || 1), 1);

      return {
        output: compose([
          `Workforce forecast — ${active.length} active employees, ${horizon} month horizon.`,
          `Headcount\n${bullets([
            `Last ${months} months: ${headcount.join(' → ')}`,
            `Trend ${headcountForecast.slope >= 0 ? '+' : ''}${headcountForecast.slope} per month`,
            `Projection: ${headcountForecast.projection.join(', ')}`,
          ])}`,
          `Attrition\n${bullets([
            `${exits.reduce((sum, value) => sum + value, 0)} exit(s) in the window, ${monthlyAttrition} per month on average`,
            `Annualised attrition rate around ${annualisedAttrition}%`,
            `Expected exits over the next ${horizon} month(s): about ${expectedExits}`,
          ])}`,
          `Hiring demand\n${bullets([
            `${openJobs.length} open job(s) covering ${openings} opening(s)`,
            `${pipeline.length} candidate(s) in the pipeline, ${offersOut} at offer stage`,
            `Estimated hires needed to stand still: ${hiringNeed}`,
          ])}`,
          atRisk.length
            ? `Departments to watch\n${table(atRisk.map((item) => ({ label: item.department, value: `${item.recentExits} recent exit(s) of ${item.staff + item.recentExits} (${item.riskScore}%), ${item.onProbation} on probation` })))}`
            : 'No department crossed the attrition risk threshold.',
          `Overtime over the last 60 days: ${overtimeHours} hours, ${overtimePerHead} per active employee${overtimePerHead > 8 ? ' — sustained overtime often signals understaffing' : ''}.`,
          'Straight-line projection from recorded history. It cannot know about budget, planned projects, seasonality or anything decided but not yet in the system.',
        ]),
        sources: [
          source('dataset', 'employees', `${employees.length} employee records`),
          source('dataset', 'jobs', `${openJobs.length} open jobs`),
          source('dataset', 'attendance', 'Attendance, last 60 days'),
        ],
        confidence: confidenceFrom({ evidence: months * 2, max: 0.62 }),
        limitation:
          'A trend line over a short history. Treat the numbers as a prompt for a staffing conversation, not a plan.',
        data: {
          horizon,
          headcount,
          headcountProjection: headcountForecast.projection,
          exits,
          expectedExits,
          annualisedAttrition,
          openings,
          pipelineCount: pipeline.length,
          hiringNeed,
          departmentRisk,
          overtimePerHead,
        },
      };
    },
  },
];
