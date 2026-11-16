/**
 * Appraisal cycles, goals and performance reviews (requirements §5.10).
 *
 * The previous annual cycle is closed and fully rated; the current cycle is active with a mix
 * of pending and completed reviews, which is what the pending-review dashboard widget counts.
 * Ratings are only ever set by HR, never generated as an AI decision.
 */

const { faker } = require('@faker-js/faker');
const config = require('./config');
const { addDays, chance, id, intBetween, iso, pick, picks, weighted } = require('./utils');

const GOAL_TEMPLATES = [
  { title: 'Ship the quarterly roadmap commitments', metric: 'Delivered items', target: '4' },
  { title: 'Reduce customer-reported defects', metric: 'Defects per month', target: '< 5' },
  { title: 'Improve response time on assigned tickets', metric: 'Median first response', target: '< 2h' },
  { title: 'Complete the assigned certification', metric: 'Certification', target: '1' },
  { title: 'Mentor a junior team member', metric: 'Mentoring sessions', target: '12' },
  { title: 'Grow pipeline in the assigned territory', metric: 'Qualified opportunities', target: '18' },
  { title: 'Document two internal processes', metric: 'Documents published', target: '2' },
  { title: 'Improve code review turnaround', metric: 'Median review time', target: '< 8h' },
];

const STRENGTHS = ['Ownership', 'Collaboration', 'Technical depth', 'Customer focus', 'Communication', 'Consistency', 'Initiative'];
const IMPROVEMENTS = ['Time management', 'Documentation', 'Stakeholder updates', 'Delegation', 'Estimation accuracy', 'Presentation skills'];

function buildPerformance({ employees, hrUser }) {
  const now = config.TODAY;
  const year = now.getUTCFullYear();

  const performanceCycles = [
    {
      id: id('pfc', 1, 2),
      name: `Annual Review ${year - 1}`,
      type: 'annual',
      periodStart: `${year - 1}-01-01`,
      periodEnd: `${year - 1}-12-31`,
      reviewDeadline: `${year}-01-31`,
      status: 'closed',
      ratingScale: { min: 1, max: 5 },
      departmentIds: [],
      createdAt: iso(new Date(Date.UTC(year - 1, 0, 2))),
    },
    {
      id: id('pfc', 2, 2),
      name: `Mid-Year Review ${year}`,
      type: 'mid-year',
      periodStart: `${year}-01-01`,
      periodEnd: `${year}-06-30`,
      reviewDeadline: `${year}-07-31`,
      status: 'closed',
      ratingScale: { min: 1, max: 5 },
      departmentIds: [],
      createdAt: iso(new Date(Date.UTC(year, 0, 5))),
    },
    {
      id: id('pfc', 3, 2),
      name: `Annual Review ${year}`,
      type: 'annual',
      periodStart: `${year}-01-01`,
      periodEnd: `${year}-12-31`,
      reviewDeadline: `${year + 1}-01-31`,
      status: 'active',
      ratingScale: { min: 1, max: 5 },
      departmentIds: [],
      createdAt: iso(new Date(Date.UTC(year, 0, 5))),
    },
  ];

  const goals = [];
  const performanceReviews = [];
  let goalIndex = 1;
  let reviewIndex = 1;

  const activeCycle = performanceCycles[2];

  for (const employee of employees) {
    const joined = new Date(`${employee.joiningDate}T00:00:00Z`);
    const left = employee.exit ? new Date(`${employee.exit.lastWorkingDate}T00:00:00Z`) : null;

    for (const cycle of performanceCycles) {
      const periodEnd = new Date(`${cycle.periodEnd}T00:00:00Z`);
      const periodStart = new Date(`${cycle.periodStart}T00:00:00Z`);
      // Only employees who were on the payroll for most of the period are reviewed.
      if (joined > addDays(periodEnd, -90)) continue;
      if (left && left < periodStart) continue;

      const isActive = cycle.status === 'active';

      for (const template of picks(GOAL_TEMPLATES, intBetween(2, 4))) {
        const progress = isActive ? intBetween(10, 100) : intBetween(60, 100);
        goals.push({
          id: id('gol', goalIndex++, 4),
          employeeId: employee.id,
          cycleId: cycle.id,
          title: template.title,
          description: '',
          metric: template.metric,
          target: template.target,
          weight: 25,
          progress,
          status: progress === 100 ? 'achieved' : isActive ? 'in-progress' : progress >= 70 ? 'achieved' : 'partially-achieved',
          dueDate: cycle.periodEnd,
          createdAt: iso(periodStart),
          updatedAt: iso(addDays(now, -intBetween(1, 60))),
        });
      }

      const status = isActive
        ? weighted([
            { weight: 45, value: 'pending' },
            { weight: 25, value: 'in-review' },
            { weight: 30, value: 'completed' },
          ])
        : 'completed';
      const rating =
        status === 'completed'
          ? weighted([
              { weight: 5, value: 5 },
              { weight: 25, value: 4 },
              { weight: 50, value: 3 },
              { weight: 15, value: 2 },
              { weight: 5, value: 1 },
            ])
          : null;

      performanceReviews.push({
        id: id('pfr', reviewIndex++, 4),
        cycleId: cycle.id,
        employeeId: employee.id,
        reviewerEmployeeId: employee.reportingManagerId,
        selfReview: status === 'pending' ? '' : faker.lorem.sentences(2),
        managerFeedback: status === 'pending' ? '' : faker.lorem.sentences(2),
        hrComments: status === 'completed' ? pick(['Discussed in the calibration meeting.', 'Agreed with the manager rating.', '']) : '',
        strengths: status === 'pending' ? [] : picks(STRENGTHS, intBetween(1, 3)),
        improvements: status === 'pending' ? [] : picks(IMPROVEMENTS, intBetween(1, 2)),
        goalAchievementPercent: status === 'pending' ? null : intBetween(55, 100),
        rating,
        ratingLabel: rating ? ['', 'Needs improvement', 'Below expectations', 'Meets expectations', 'Exceeds expectations', 'Outstanding'][rating] : null,
        promotionRecommended: rating === 5 && chance(0.4),
        trainingRecommended: rating !== null && rating <= 3 && chance(0.6),
        status,
        aiDraftUsed: chance(0.35),
        ratedBy: rating ? hrUser.id : null,
        ratedAt: rating ? iso(addDays(periodEnd, intBetween(5, 30))) : null,
        createdAt: iso(addDays(periodEnd, -20)),
        updatedAt: iso(addDays(now, -intBetween(0, 45))),
      });
    }
  }

  return { performanceCycles, goals, performanceReviews, activeCycleId: activeCycle.id };
}

module.exports = { buildPerformance };
