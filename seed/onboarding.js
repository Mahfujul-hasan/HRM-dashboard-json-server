/**
 * Onboarding records and tasks (requirements §5.6).
 *
 * Every employee who joined inside the last six months gets an onboarding record. Older ones
 * are completed; recent ones are part-done, and a few tasks are deliberately overdue so the
 * dashboard alert and the AI follow-up engine have something to report.
 */

const config = require('./config');
const { addDays, chance, id, intBetween, iso, pick, weighted, ymd } = require('./utils');

/** Checklist template; `offset` is days from the joining date. */
const TASK_TEMPLATE = [
  { title: 'Collect signed offer letter', category: 'documentation', offset: -3 },
  { title: 'Collect ID proof and address proof', category: 'documentation', offset: 0 },
  { title: 'Collect educational certificates', category: 'documentation', offset: 2 },
  { title: 'Sign NDA and policy acknowledgement', category: 'compliance', offset: 1 },
  { title: 'Create company email account', category: 'it-setup', offset: 0 },
  { title: 'Issue laptop and accessories', category: 'asset', offset: 0 },
  { title: 'Grant system and tool access', category: 'it-setup', offset: 1 },
  { title: 'Add to payroll and benefits', category: 'payroll', offset: 3 },
  { title: 'First-day orientation session', category: 'orientation', offset: 0 },
  { title: 'Introduce to team and assign buddy', category: 'orientation', offset: 1 },
  { title: 'Workplace safety and security briefing', category: 'compliance', offset: 2 },
  { title: 'Set 30-day goals with manager', category: 'goal-setting', offset: 5 },
  { title: '30-day check-in', category: 'review', offset: 30 },
  { title: '60-day check-in', category: 'review', offset: 60 },
  { title: '90-day probation review', category: 'review', offset: 90 },
];

function buildOnboarding({ employees, candidates, hrUser }) {
  const now = config.TODAY;
  const cutoff = addDays(now, -180);

  const onboarding = [];
  const onboardingTasks = [];
  let recordIndex = 1;
  let taskIndex = 1;

  const recentHires = employees.filter((employee) => new Date(`${employee.joiningDate}T00:00:00Z`) >= cutoff);
  const joinedCandidates = candidates.filter((candidate) => candidate.stage === 'joined');

  for (const employee of recentHires) {
    const startDate = new Date(`${employee.joiningDate}T00:00:00Z`);
    const daysSinceJoining = Math.round((now - startDate) / 86400000);
    const recordId = id('onb', recordIndex++, 3);

    // Link a joined candidate to this hire where one is still free.
    const candidate = joinedCandidates.find((item) => !item.convertedEmployeeId);
    if (candidate) candidate.convertedEmployeeId = employee.id;

    const buddy = employees.find(
      (item) => item.departmentId === employee.departmentId && item.id !== employee.id && item.status === 'active',
    );

    let completed = 0;
    const tasks = TASK_TEMPLATE.map((template) => {
      const dueDate = addDays(startDate, template.offset);
      const due = dueDate <= now;
      // Tasks that are not yet due are pending; due ones are mostly done, a few are overdue.
      const status = !due
        ? 'pending'
        : weighted([
            { weight: 86, value: 'completed' },
            { weight: 9, value: 'in-progress' },
            { weight: 5, value: 'pending' },
          ]);
      if (status === 'completed') completed += 1;

      return {
        id: id('obt', taskIndex++, 4),
        onboardingId: recordId,
        employeeId: employee.id,
        title: template.title,
        category: template.category,
        description: '',
        ownerEmployeeId: ['it-setup', 'asset'].includes(template.category) ? null : hrUser.employeeId || null,
        ownerRole: ['it-setup', 'asset'].includes(template.category) ? 'IT' : 'HR',
        dueDate: ymd(dueDate),
        status,
        overdue: due && status !== 'completed',
        completedAt: status === 'completed' ? iso(addDays(dueDate, intBetween(-1, 2))) : null,
        documentId: null,
        aiGenerated: chance(0.25),
        order: taskIndex,
        createdAt: iso(addDays(startDate, -5)),
      };
    });

    onboardingTasks.push(...tasks);

    const completionPercent = Math.round((completed / tasks.length) * 100);
    const status = completionPercent === 100 ? 'completed' : daysSinceJoining < 0 ? 'not-started' : 'in-progress';

    onboarding.push({
      id: recordId,
      employeeId: employee.id,
      candidateId: candidate ? candidate.id : null,
      startDate: ymd(startDate),
      status,
      completionPercent,
      taskCount: tasks.length,
      completedTaskCount: completed,
      overdueTaskCount: tasks.filter((task) => task.overdue).length,
      template: '30-60-90 standard',
      buddyEmployeeId: buddy ? buddy.id : null,
      orientationDate: ymd(startDate),
      orientationNotes: pick(['Company overview and tooling walkthrough completed.', 'Orientation rescheduled to the second day.', '']),
      aiPlanGenerated: chance(0.5),
      createdBy: hrUser.id,
      createdAt: iso(addDays(startDate, -5)),
      updatedAt: iso(addDays(now, -intBetween(0, 10))),
    });
  }

  return { onboarding, onboardingTasks };
}

module.exports = { buildOnboarding, TASK_TEMPLATE };
