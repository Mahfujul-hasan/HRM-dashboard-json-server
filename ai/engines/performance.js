/**
 * Performance feedback summary (requirements §5.10).
 *
 * Combines goals, self-review, manager feedback and history into a draft for HR to edit.
 * It never sets a rating: the draft deliberately leaves the rating blank and says who decides.
 */

const { average, bullets, compose, confidenceFrom, percent, round, source, themesOf } = require('../helpers');

const RATING_LABELS = ['', 'Needs improvement', 'Below expectations', 'Meets expectations', 'Exceeds expectations', 'Outstanding'];

module.exports = [
  {
    id: 'performance-feedback-summary',
    module: 'performance',
    label: 'Performance Feedback Summary',
    purpose: 'Combines goals, feedback and achievements into a draft',
    input: {
      employeeId: 'string (required)',
      cycleId: 'string — defaults to the active cycle',
    },
    prompt: (input) => `Draft a performance summary for employee ${input.employeeId}`,

    run({ input, db }) {
      const employee = db.byId('employees', input.employeeId);
      if (!employee) throw Object.assign(new Error('employeeId is required and must exist'), { status: 400 });

      const cycles = db.get('performanceCycles');
      const cycle = input.cycleId
        ? cycles.find((item) => item.id === input.cycleId)
        : cycles.find((item) => item.status === 'active') || cycles[cycles.length - 1];
      if (!cycle) throw Object.assign(new Error('No performance cycle is available'), { status: 404 });

      const goals = db.get('goals').filter((goal) => goal.employeeId === employee.id && goal.cycleId === cycle.id);
      const review = db
        .get('performanceReviews')
        .find((item) => item.employeeId === employee.id && item.cycleId === cycle.id);
      const history = db
        .get('performanceReviews')
        .filter((item) => item.employeeId === employee.id && item.rating !== null && item.cycleId !== cycle.id);

      const designation = db.byId('designations', employee.designationId);
      const manager = employee.reportingManagerId ? db.byId('employees', employee.reportingManagerId) : null;

      const achieved = goals.filter((goal) => goal.status === 'achieved');
      const goalProgress = goals.length ? round(average(goals.map((goal) => goal.progress)), 0) : null;

      const trainings = db
        .get('trainingEnrollments')
        .filter((item) => item.employeeId === employee.id && item.status === 'completed');

      const feedbackText = [review ? review.managerFeedback : '', review ? review.selfReview : ''].join(' ');
      const themes = themesOf(feedbackText);
      const historyRatings = history.map((item) => item.rating);
      const trend =
        historyRatings.length >= 2
          ? historyRatings[historyRatings.length - 1] > historyRatings[0]
            ? 'improving across cycles'
            : historyRatings[historyRatings.length - 1] < historyRatings[0]
              ? 'declining across cycles'
              : 'steady across cycles'
          : 'not enough history to show a trend';

      const strengths = review && review.strengths.length ? review.strengths : [];
      const improvements = review && review.improvements.length ? review.improvements : [];

      const draft = compose([
        `Performance summary draft — ${employee.fullName}${designation ? `, ${designation.title}` : ''} (${cycle.name})`,
        `Goals\n${
          goals.length
            ? bullets([
                `${achieved.length} of ${goals.length} goals achieved (${percent(achieved.length, goals.length)}%), average progress ${goalProgress}%.`,
                ...goals.slice(0, 6).map((goal) => `${goal.title} — ${goal.progress}% (${goal.status})`),
              ])
            : '  No goals were recorded for this cycle.'
        }`,
        review && review.managerFeedback ? `Manager feedback\n  ${review.managerFeedback}` : null,
        review && review.selfReview ? `Self-review\n  ${review.selfReview}` : null,
        strengths.length ? `Recorded strengths\n${bullets(strengths)}` : null,
        improvements.length ? `Development areas\n${bullets(improvements)}` : null,
        themes.length ? `Themes in the written feedback: ${themes.join(', ')}.` : null,
        trainings.length
          ? `Completed ${trainings.length} training programme(s) during the period.`
          : 'No training was completed during the period.',
        history.length
          ? `Rating history: ${history.map((item) => `${item.rating}/5`).join(' → ')} — ${trend}.`
          : 'No previous rated cycle on record.',
        'Suggested wording:\n  Over this cycle, ' +
          `${employee.firstName} delivered ${achieved.length} of ${goals.length || 0} agreed goals` +
          `${strengths.length ? `, showing particular strength in ${strengths.slice(0, 2).join(' and ').toLowerCase()}` : ''}` +
          `${improvements.length ? `. The main development area is ${improvements[0].toLowerCase()}` : ''}.`,
        'Rating: _____ (set by HR after calibration)',
        'The rating is deliberately left blank. AI must not assign a performance rating — HR enters it after the calibration discussion.',
      ]);

      return {
        output: draft,
        sources: [
          source('employee', employee.id, employee.fullName),
          source('dataset', cycle.id, `Cycle: ${cycle.name}`),
          review ? source('dataset', review.id, 'Performance review record') : null,
          ...goals.slice(0, 3).map((goal) => source('dataset', goal.id, `Goal: ${goal.title}`)),
        ].filter(Boolean),
        confidence: confidenceFrom({ evidence: goals.length + (review ? 3 : 0) + history.length, max: 0.72 }),
        limitation:
          'Assembled from recorded goals and feedback only. Work done outside the recorded goals, and anything discussed verbally, is not represented here.',
        data: {
          cycleId: cycle.id,
          goalCount: goals.length,
          achievedCount: achieved.length,
          goalProgress,
          themes,
          ratingHistory: historyRatings,
          suggestedRating: null,
          ratingAllowed: false,
          managerName: manager ? manager.fullName : null,
          ratingLabels: RATING_LABELS,
        },
      };
    },
  },
];
