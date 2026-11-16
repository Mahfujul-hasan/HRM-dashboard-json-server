/**
 * Onboarding plan generator (requirements §5.6).
 *
 * Produces a 30/60/90-day checklist tailored to the department, designation, employment type
 * and work mode of a new hire. HR edits and approves the plan before any task is created.
 */

const { addDays, bullets, compose, confidenceFrom, source, ymd } = require('../helpers');

/** `day` is the offset from the joining date. */
const CORE_TASKS = [
  { day: -3, title: 'Collect the signed offer letter', category: 'documentation' },
  { day: 0, title: 'Collect ID proof and address proof', category: 'documentation' },
  { day: 0, title: 'Create the company email account', category: 'it-setup' },
  { day: 0, title: 'Issue laptop and accessories', category: 'asset' },
  { day: 0, title: 'First-day orientation session', category: 'orientation' },
  { day: 1, title: 'Sign the NDA and policy acknowledgement', category: 'compliance' },
  { day: 1, title: 'Grant access to the tools the role needs', category: 'it-setup' },
  { day: 1, title: 'Introduce to the team and assign a buddy', category: 'orientation' },
  { day: 2, title: 'Collect educational and experience certificates', category: 'documentation' },
  { day: 3, title: 'Add to payroll and benefits', category: 'payroll' },
  { day: 5, title: 'Agree 30-day goals with the manager', category: 'goal-setting' },
  { day: 30, title: '30-day check-in', category: 'review' },
  { day: 60, title: '60-day check-in', category: 'review' },
  { day: 90, title: 'Probation review', category: 'review' },
];

/** Extra tasks by department name. */
const DEPARTMENT_TASKS = {
  Engineering: [
    { day: 2, title: 'Set up the development environment and repository access', category: 'it-setup' },
    { day: 7, title: 'Ship a first small change with a reviewer', category: 'ramp-up' },
    { day: 21, title: 'On-call or support rotation walkthrough', category: 'ramp-up' },
  ],
  Sales: [
    { day: 2, title: 'CRM access and territory assignment', category: 'it-setup' },
    { day: 7, title: 'Product and pitch training', category: 'ramp-up' },
    { day: 30, title: 'First pipeline review with the manager', category: 'review' },
  ],
  'Human Resources': [
    { day: 2, title: 'HRIS access and confidentiality briefing', category: 'compliance' },
    { day: 10, title: 'Walk through the HR policy set', category: 'ramp-up' },
  ],
  Finance: [
    { day: 2, title: 'Finance systems access and approval limits', category: 'compliance' },
    { day: 10, title: 'Month-end close walkthrough', category: 'ramp-up' },
  ],
  'Customer Support': [
    { day: 2, title: 'Ticketing system access and macros', category: 'it-setup' },
    { day: 5, title: 'Shadow a senior on live tickets', category: 'ramp-up' },
  ],
  Design: [{ day: 2, title: 'Design tool licences and design system walkthrough', category: 'it-setup' }],
  Product: [{ day: 5, title: 'Roadmap and discovery process walkthrough', category: 'ramp-up' }],
  Marketing: [{ day: 3, title: 'Brand guidelines and campaign tooling access', category: 'it-setup' }],
};

module.exports = [
  {
    id: 'generate-onboarding-plan',
    module: 'onboarding',
    label: 'Generate Onboarding Plan',
    purpose: 'Creates a 30/60/90-day onboarding checklist',
    input: {
      employeeId: 'string — the new hire (required)',
      startDate: 'string — overrides the joining date (optional)',
    },
    prompt: (input) => `Generate an onboarding plan for employee ${input.employeeId}`,

    run({ input, db }) {
      const employee = db.byId('employees', input.employeeId);
      if (!employee) throw Object.assign(new Error('employeeId is required and must exist'), { status: 400 });

      const department = db.byId('departments', employee.departmentId);
      const designation = db.byId('designations', employee.designationId);
      const location = db.byId('locations', employee.locationId);
      const manager = employee.reportingManagerId ? db.byId('employees', employee.reportingManagerId) : null;

      const startDate = new Date(`${input.startDate || employee.joiningDate}T00:00:00Z`);

      const tasks = [...CORE_TASKS, ...((department && DEPARTMENT_TASKS[department.name]) || [])];

      if (employee.workMode === 'remote') {
        tasks.push({ day: -1, title: 'Ship equipment to the home address and confirm delivery', category: 'asset' });
        tasks.push({ day: 1, title: 'Remote working setup and communication norms', category: 'orientation' });
      }
      if (employee.employmentType === 'contract') {
        tasks.push({ day: 0, title: 'Confirm contract end date and renewal owner', category: 'compliance' });
      }
      if (employee.employmentType === 'intern') {
        tasks.push({ day: 5, title: 'Assign a mentor and agree the learning plan', category: 'ramp-up' });
      }
      if (designation && ['lead', 'executive', 'principal'].includes(designation.level)) {
        tasks.push({ day: 10, title: 'Meet each direct report one to one', category: 'ramp-up' });
        tasks.push({ day: 20, title: 'Review team goals and budget', category: 'ramp-up' });
      }

      const withDates = tasks
        .sort((a, b) => a.day - b.day)
        .map((task) => ({ ...task, dueDate: ymd(addDays(startDate, task.day)) }));

      const phase = (from, to) => withDates.filter((task) => task.day >= from && task.day <= to);
      const render = (list) => bullets(list.map((task) => `${task.dueDate} — ${task.title} (${task.category})`));

      return {
        output: compose([
          `Onboarding plan — ${employee.fullName}, ${designation ? designation.title : ''}${department ? `, ${department.name}` : ''}`,
          `Start date ${ymd(startDate)}${location ? ` · ${location.name}` : ''}${manager ? ` · reports to ${manager.fullName}` : ''}`,
          `Before and first week\n${render(phase(-10, 7))}`,
          `Days 8–30\n${render(phase(8, 30))}`,
          `Days 31–60\n${render(phase(31, 60))}`,
          `Days 61–90\n${render(phase(61, 120))}`,
          `${withDates.length} tasks in total. Edit the list before the tasks are created — due dates do not yet account for public holidays.`,
        ]),
        sources: [
          source('employee', employee.id, employee.fullName),
          department ? source('dataset', department.id, `Department: ${department.name}`) : null,
          designation ? source('dataset', designation.id, `Designation: ${designation.title}`) : null,
        ].filter(Boolean),
        confidence: confidenceFrom({ evidence: withDates.length, max: 0.75, base: 0.55 }),
        limitation: 'A template assembled from the employee record; it does not know about team-specific steps or public holidays.',
        data: { taskCount: withDates.length, tasks: withDates, startDate: ymd(startDate) },
      };
    },
  },
];
