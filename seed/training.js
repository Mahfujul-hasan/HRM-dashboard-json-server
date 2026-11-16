/**
 * Training programs and enrollments (requirements §5.11).
 *
 * Skills covered by a program line up with the `requiredSkills` on designations, so the
 * skill-gap and training-recommendation engines can match the two sides.
 */

const config = require('./config');
const { addDays, chance, id, intBetween, iso, pick, picks, weighted, ymd } = require('./utils');

const PROGRAMS = [
  { title: 'Advanced TypeScript Patterns', mode: 'online', hours: 16, cost: 450, skills: ['TypeScript', 'System Design'], departments: ['Engineering'] },
  { title: 'System Design Fundamentals', mode: 'hybrid', hours: 24, cost: 900, skills: ['System Design', 'Architecture'], departments: ['Engineering', 'Product'] },
  { title: 'AWS Solutions Architect Prep', mode: 'online', hours: 40, cost: 1200, skills: ['AWS', 'CI/CD', 'Kubernetes'], departments: ['Engineering'] },
  { title: 'Test Automation with Playwright', mode: 'online', hours: 12, cost: 350, skills: ['Test Automation', 'Playwright'], departments: ['Engineering'] },
  { title: 'Product Discovery Workshop', mode: 'in-person', hours: 16, cost: 1100, skills: ['Product Discovery', 'User Research'], departments: ['Product', 'Design'] },
  { title: 'Design Systems in Practice', mode: 'online', hours: 10, cost: 300, skills: ['Design Systems', 'Figma'], departments: ['Design'] },
  { title: 'Accessibility for Product Teams', mode: 'online', hours: 8, cost: 250, skills: ['Accessibility'], departments: ['Design', 'Engineering', 'Product'] },
  { title: 'Consultative Selling', mode: 'in-person', hours: 20, cost: 1500, skills: ['Negotiation', 'Discovery Calls', 'Closing'], departments: ['Sales'] },
  { title: 'CRM Mastery', mode: 'online', hours: 6, cost: 150, skills: ['CRM', 'Pipeline Management'], departments: ['Sales'] },
  { title: 'Performance Marketing Analytics', mode: 'online', hours: 14, cost: 500, skills: ['Analytics', 'Campaign Management'], departments: ['Marketing'] },
  { title: 'Employment Law Essentials', mode: 'in-person', hours: 12, cost: 800, skills: ['Employment Law', 'Compliance'], departments: ['Human Resources'] },
  { title: 'Structured Interviewing', mode: 'hybrid', hours: 8, cost: 400, skills: ['Interviewing', 'Screening'], departments: ['Human Resources'] },
  { title: 'Financial Modelling in Excel', mode: 'online', hours: 18, cost: 600, skills: ['Excel Modelling', 'Forecasting'], departments: ['Finance'] },
  { title: 'De-escalation and Customer Empathy', mode: 'online', hours: 6, cost: 200, skills: ['Customer Communication', 'Escalations'], departments: ['Customer Support'] },
  { title: 'Workplace Safety and Security', mode: 'online', hours: 4, cost: 0, skills: ['Compliance'], departments: [] },
  { title: 'Manager Essentials', mode: 'hybrid', hours: 24, cost: 1400, skills: ['People Management', 'Coaching', 'Mentoring'], departments: [] },
];

const FEEDBACK = [
  'Practical content, the exercises were the most useful part.',
  'Good trainer, but the pace was fast in the second half.',
  'Too theoretical for day-to-day work.',
  'Helped me apply the material in my current project straight away.',
  'Would recommend to anyone new to the topic.',
];

function buildTraining({ employees, departments, hrUser }) {
  const now = config.TODAY;
  const historyStart = addDays(now, -Math.round(config.HISTORY_MONTHS * 30.4));
  const byName = new Map(departments.map((department) => [department.name, department.id]));

  const trainings = [];
  const trainingEnrollments = [];
  let trainingIndex = 1;
  let enrollmentIndex = 1;

  for (const program of PROGRAMS) {
    // Each program runs once or twice inside the history window.
    const sessions = chance(0.3) ? 2 : 1;

    for (let session = 0; session < sessions; session += 1) {
      const startDate = new Date(
        historyStart.getTime() + Math.round(((now - historyStart) * (session + 1)) / (sessions + 1)) + intBetween(-20, 40) * 86400000,
      );
      const endDate = addDays(startDate, Math.max(1, Math.round(program.hours / 8)));
      const upcoming = startDate > now;
      const running = !upcoming && endDate >= now;

      const trainingId = id('trn', trainingIndex++, 3);
      const departmentIds = program.departments.map((name) => byName.get(name)).filter(Boolean);

      trainings.push({
        id: trainingId,
        title: program.title,
        description: `${program.title} — ${program.hours} hours, ${program.mode}.`,
        trainerName: chance(0.5) ? 'Internal trainer' : 'External provider',
        trainerType: chance(0.5) ? 'internal' : 'external',
        provider: chance(0.5) ? 'In-house' : pick(['Coursera', 'Udemy Business', 'Pluralsight', 'Local training partner']),
        mode: program.mode,
        departmentIds,
        startDate: ymd(startDate),
        endDate: ymd(endDate),
        durationHours: program.hours,
        cost: program.cost,
        currency: config.CURRENCY,
        capacity: intBetween(10, 30),
        skillsCovered: program.skills,
        mandatory: program.departments.length === 0,
        status: upcoming ? 'scheduled' : running ? 'in-progress' : 'completed',
        certificateIssued: !upcoming && !running,
        createdBy: hrUser.id,
        createdAt: iso(addDays(startDate, -30)),
        updatedAt: iso(addDays(endDate, 1)),
      });

      const pool = departmentIds.length
        ? employees.filter((employee) => departmentIds.includes(employee.departmentId))
        : employees;
      const eligible = pool.filter((employee) => new Date(`${employee.joiningDate}T00:00:00Z`) < startDate);
      const enrolled = picks(eligible, Math.min(eligible.length, intBetween(5, 18)));

      for (const employee of enrolled) {
        const status = upcoming
          ? 'assigned'
          : running
            ? 'in-progress'
            : weighted([
                { weight: 78, value: 'completed' },
                { weight: 14, value: 'in-progress' },
                { weight: 8, value: 'dropped' },
              ]);
        const completed = status === 'completed';

        trainingEnrollments.push({
          id: id('tre', enrollmentIndex++, 4),
          trainingId,
          employeeId: employee.id,
          status,
          assignedAt: iso(addDays(startDate, -14)),
          attendancePercent: upcoming ? 0 : completed ? intBetween(80, 100) : intBetween(20, 90),
          score: completed ? intBetween(60, 100) : null,
          certificateUrl: null,
          certificateFileName: completed ? `${program.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${employee.employeeId}.pdf` : null,
          completedAt: completed ? iso(endDate) : null,
          feedback: completed && chance(0.6) ? pick(FEEDBACK) : '',
          rating: completed ? intBetween(3, 5) : null,
          createdAt: iso(addDays(startDate, -14)),
        });
      }
    }
  }

  return { trainings, trainingEnrollments };
}

module.exports = { buildTraining };
