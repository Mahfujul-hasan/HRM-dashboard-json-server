/**
 * Announcements, surveys and survey responses (requirements §5.13, §5.14).
 *
 * Free-text answers are drawn from a comment bank that deliberately clusters around the themes
 * the requirements name — workload, salary, management, facilities, career growth, work
 * environment — in positive, neutral and negative wording. The theme and sentiment are NOT
 * stored on the response: the AI engines have to derive them, which is what makes the output
 * worth reviewing.
 */

const config = require('./config');
const { addDays, chance, id, intBetween, iso, pick, picks, weighted, ymd } = require('./utils');

const ANNOUNCEMENTS = [
  { title: 'Updated Remote Work Policy', category: 'policy', body: 'The remote work policy has been updated. From next month, hybrid employees are expected on site two days a week, coordinated within each team.' },
  { title: 'Holiday Schedule for Next Year', category: 'holiday', body: 'The approved holiday calendar for next year is attached. Please plan your annual leave around these dates.' },
  { title: 'Open Enrollment for Health Benefits', category: 'benefits', body: 'Open enrollment runs for the next three weeks. Confirm or change your plan before the closing date.' },
  { title: 'Quarterly Town Hall', category: 'event', body: 'The quarterly town hall takes place on Friday at 3pm in the main hall, with a video link for remote colleagues.' },
  { title: 'Mandatory Security Training', category: 'training', body: 'All employees must complete the workplace security training module before the end of the month.' },
  { title: 'New Performance Review Cycle', category: 'performance', body: 'The annual review cycle opens this week. Self-reviews are due by the end of the month.' },
  { title: 'Office Maintenance This Weekend', category: 'facility', body: 'The San Francisco office will be closed this weekend for electrical maintenance. Badge access is suspended.' },
  { title: 'Employee Referral Bonus Increase', category: 'policy', body: 'The referral bonus has been increased for engineering and sales roles. Details are in the handbook.' },
  { title: 'Payroll Date Change for December', category: 'payroll', body: 'December salaries will be paid two days early because of the holiday schedule.' },
  { title: 'Welcome to Our New Joiners', category: 'general', body: 'Please join us in welcoming the colleagues who joined this month across engineering, sales and support.' },
];

const COMMENT_BANK = [
  'The workload has been heavy for the last two quarters and it is hard to keep up.',
  'Too many parallel projects, we need clearer priorities from leadership.',
  'Deadlines are realistic now compared to last year, that has helped a lot.',
  'Salary has not kept pace with the market for my role.',
  'The compensation review was handled fairly and communicated clearly.',
  'Bonus criteria are still not transparent.',
  'My manager gives useful feedback and backs the team.',
  'Management changes direction too often without explaining why.',
  'One-to-ones are consistent and genuinely helpful.',
  'There is no clear career path for individual contributors.',
  'I would like more opportunities to move into a lead role.',
  'The learning budget is a real benefit and I have used it twice.',
  'The office is noisy in the afternoon and meeting rooms are hard to book.',
  'Remote setup support has been excellent.',
  'Parking and commute remain a problem for the Austin office.',
  'The team culture is supportive and people help each other.',
  'Communication between departments is slow.',
  'Onboarding was smooth and well organised.',
  'Tools and access took two weeks to arrive when I joined.',
  'Recognition for good work is rare outside of review season.',
  'Work-life balance has improved since the meeting-free Wednesday policy.',
  'I am considering other options because growth here feels blocked.',
];

const EXIT_COMMENTS = [
  'Left for a role with a clearer promotion path.',
  'Compensation was the main reason for leaving.',
  'Relocating to another state for family reasons.',
  'The workload was not sustainable over the long term.',
  'Good team, but the role stopped growing.',
  'Manager support was limited after the reorganisation.',
];

const SURVEY_DEFS = [
  {
    title: 'Quarterly Engagement Survey',
    type: 'engagement',
    anonymous: true,
    questions: [
      { type: 'rating', text: 'How satisfied are you with your current role?', scale: 5 },
      { type: 'rating', text: 'How would you rate work-life balance?', scale: 5 },
      { type: 'rating', text: 'How clear are your goals and expectations?', scale: 5 },
      { type: 'single-choice', text: 'Which area needs the most improvement?', options: ['Workload', 'Salary', 'Management', 'Facilities', 'Career growth'] },
      { type: 'text', text: 'What would you change about working here?' },
    ],
  },
  {
    title: 'Manager Effectiveness Pulse',
    type: 'pulse',
    anonymous: true,
    questions: [
      { type: 'rating', text: 'My manager gives me useful feedback.', scale: 5 },
      { type: 'rating', text: 'I feel comfortable raising concerns with my manager.', scale: 5 },
      { type: 'text', text: 'Any comments about team leadership?' },
    ],
  },
  {
    title: 'Exit Interview',
    type: 'exit',
    anonymous: false,
    questions: [
      { type: 'single-choice', text: 'Main reason for leaving', options: ['Compensation', 'Career growth', 'Management', 'Relocation', 'Work-life balance', 'Other'] },
      { type: 'rating', text: 'How likely are you to recommend us as an employer?', scale: 5 },
      { type: 'text', text: 'What could we have done differently?' },
    ],
  },
  {
    title: 'Training Feedback',
    type: 'training-feedback',
    anonymous: false,
    questions: [
      { type: 'rating', text: 'How useful was the training?', scale: 5 },
      { type: 'rating', text: 'How would you rate the trainer?', scale: 5 },
      { type: 'text', text: 'Suggestions for future sessions' },
    ],
  },
];

function buildEngagement({ employees, departments, locations, hrUser }) {
  const now = config.TODAY;
  const announcements = [];
  const surveys = [];
  const surveyResponses = [];

  let announcementIndex = 1;
  let surveyIndex = 1;
  let responseIndex = 1;

  for (const template of ANNOUNCEMENTS) {
    const publishAt = addDays(now, -intBetween(-10, 200));
    const future = publishAt > now;
    const audienceType = weighted([
      { weight: 6, value: 'all' },
      { weight: 2, value: 'department' },
      { weight: 1, value: 'location' },
      { weight: 1, value: 'designation' },
    ]);

    announcements.push({
      id: id('ann', announcementIndex++, 3),
      title: template.title,
      body: template.body,
      category: template.category,
      audience: {
        type: audienceType,
        departmentIds:
          audienceType === 'department'
            ? [pick(departments.filter((department) => department.parentId === null)).id]
            : [],
        designationIds: [],
        locationIds: audienceType === 'location' ? [pick(locations).id] : [],
        employeeIds: [],
      },
      attachments: [],
      status: future
        ? 'draft'
        : weighted([
            { weight: 8, value: 'published' },
            { weight: 1, value: 'unpublished' },
            { weight: 1, value: 'draft' },
          ]),
      pinned: chance(0.2),
      publishAt: ymd(publishAt),
      expiryDate: ymd(addDays(publishAt, intBetween(30, 120))),
      emailNotification: chance(0.6),
      aiGenerated: chance(0.4),
      aiApprovedBy: null,
      createdBy: hrUser.id,
      createdAt: iso(addDays(publishAt, -2)),
      updatedAt: iso(addDays(publishAt, intBetween(0, 5))),
    });
  }

  for (const definition of SURVEY_DEFS) {
    const startDate = addDays(now, -intBetween(20, 160));
    const endDate = addDays(startDate, 21);
    const surveyId = id('srv', surveyIndex++, 2);

    const questions = definition.questions.map((question, questionIndex) => ({
      id: `q${questionIndex + 1}`,
      type: question.type,
      text: question.text,
      options: question.options || [],
      scale: question.scale || null,
      required: question.type !== 'text',
    }));

    surveys.push({
      id: surveyId,
      title: definition.title,
      description: `${definition.title} for ${config.COMPANY.name}.`,
      type: definition.type,
      anonymous: definition.anonymous,
      questions,
      status: endDate < now ? 'closed' : 'running',
      startDate: ymd(startDate),
      endDate: ymd(endDate),
      targetAudience: definition.type === 'exit' ? 'leavers' : 'all',
      responseCount: 0,
      createdBy: hrUser.id,
      createdAt: iso(addDays(startDate, -5)),
      updatedAt: iso(endDate),
    });

    const pool =
      definition.type === 'exit'
        ? employees.filter((employee) => employee.exit)
        : employees.filter((employee) => ['active', 'probation'].includes(employee.status));
    const respondents = picks(
      pool,
      Math.min(pool.length, definition.type === 'exit' ? pool.length : intBetween(40, 70)),
    );

    for (const employee of respondents) {
      const submittedAt = addDays(startDate, intBetween(1, 20));

      const answers = questions.map((question) => {
        if (question.type === 'rating') {
          return {
            questionId: question.id,
            value: weighted([
              { weight: 10, value: 5 },
              { weight: 30, value: 4 },
              { weight: 32, value: 3 },
              { weight: 18, value: 2 },
              { weight: 10, value: 1 },
            ]),
          };
        }
        if (question.type === 'single-choice') {
          return { questionId: question.id, value: pick(question.options) };
        }
        const bank = definition.type === 'exit' ? EXIT_COMMENTS : COMMENT_BANK;
        return { questionId: question.id, value: chance(0.75) ? pick(bank) : '' };
      });

      surveyResponses.push({
        id: id('srr', responseIndex++, 4),
        surveyId,
        employeeId: definition.anonymous ? null : employee.id,
        departmentId: employee.departmentId,
        tenureMonths: Math.max(
          0,
          Math.round((now - new Date(`${employee.joiningDate}T00:00:00Z`)) / 2628000000),
        ),
        employmentType: employee.employmentType,
        answers,
        source: chance(0.3) ? 'import' : 'manual',
        submittedAt: iso(submittedAt),
      });
    }

    surveys[surveys.length - 1].responseCount = respondents.length;
  }

  return { announcements, surveys, surveyResponses };
}

module.exports = { buildEngagement, COMMENT_BANK };
