/**
 * Jobs, candidates and interviews (requirements §5.5).
 *
 * Candidate stages follow the pipeline in the requirements, and a candidate never sits in a
 * later stage than the interviews recorded for them. `matchScore` is left null: it is produced
 * by the AI match engine at runtime, not stored as ground truth here.
 */

const { faker } = require('@faker-js/faker');
const config = require('./config');
const { addDays, chance, id, intBetween, iso, pick, picks, weighted, ymd } = require('./utils');

const STAGES = [
  'new',
  'screened',
  'shortlisted',
  'interview-scheduled',
  'interview-completed',
  'selected',
  'rejected',
  'offer-sent',
  'offer-accepted',
  'joined',
];

const SOURCES = ['Careers page', 'LinkedIn', 'Referral', 'Job board', 'Recruiter outreach', 'Campus drive'];
const REJECTION_REASONS = [
  'Experience below the requirement',
  'Skill mismatch for the role',
  'Salary expectation above band',
  'Withdrew from the process',
  'Stronger candidates in the pipeline',
];

function jobDescription(title, department, skills) {
  return [
    `${config.COMPANY.name} is hiring a ${title} for the ${department} team.`,
    '',
    'Responsibilities',
    `- Own day-to-day ${department.toLowerCase()} delivery and quality.`,
    '- Work with partner teams to move projects from idea to release.',
    '- Document decisions and keep stakeholders informed.',
    '',
    'Requirements',
    ...skills.map((skill) => `- Practical experience with ${skill}`),
    '',
    'We offer a competitive salary, health cover, paid leave and a learning budget.',
  ].join('\n');
}

function buildRecruitment({ departments, designations, locations, employees, hrUser }) {
  const now = config.TODAY;
  const parents = departments.filter((department) => department.parentId === null && department.name !== 'Executive');
  const recruiters = employees.filter((employee) => employee.status === 'active');

  const jobs = [];
  const candidates = [];
  const interviews = [];

  let jobIndex = 1;
  let candidateIndex = 1;
  let interviewIndex = 1;

  // 14 openings across departments, mostly open, a few closed or on hold.
  for (let n = 0; n < 14; n += 1) {
    const department = pick(parents);
    const departmentDesignations = designations.filter(
      (designation) => designation.departmentId === department.id && designation.level !== 'executive',
    );
    const designation = pick(departmentDesignations);
    const postedAt = addDays(now, -intBetween(5, 170));
    const status = weighted([
      { weight: 9, value: 'open' },
      { weight: 2, value: 'closed' },
      { weight: 1, value: 'on-hold' },
      { weight: 1, value: 'draft' },
    ]);

    jobs.push({
      id: id('job', jobIndex++, 3),
      code: `JOB-${String(jobIndex).padStart(3, '0')}`,
      title: designation.title,
      departmentId: department.id,
      designationId: designation.id,
      locationId: pick(locations).id,
      employmentType: weighted([
        { weight: 9, value: 'full-time' },
        { weight: 1, value: 'contract' },
      ]),
      openings: weighted([
        { weight: 7, value: 1 },
        { weight: 2, value: 2 },
        { weight: 1, value: 3 },
      ]),
      experienceLevel: designation.level,
      minExperienceYears: designation.minExperienceYears,
      salaryRange: designation.salaryBand,
      requiredSkills: designation.requiredSkills,
      niceToHaveSkills: picks(['Docker', 'GraphQL', 'Figma', 'Salesforce', 'Python', 'Public Speaking'], 2),
      description: jobDescription(designation.title, department.name, designation.requiredSkills),
      status,
      hiringManagerId: department.headEmployeeId,
      postedAt: ymd(postedAt),
      closingDate: ymd(addDays(postedAt, intBetween(30, 90))),
      aiGenerated: chance(0.4),
      createdBy: hrUser.id,
      createdAt: iso(postedAt),
      updatedAt: iso(addDays(postedAt, intBetween(1, 30))),
    });
  }

  for (const job of jobs) {
    if (job.status === 'draft') continue;
    const designation = designations.find((item) => item.id === job.designationId);
    const candidateCount = intBetween(4, 14);

    for (let n = 0; n < candidateCount; n += 1) {
      const firstName = faker.person.firstName();
      const lastName = faker.person.lastName();
      const appliedAt = addDays(new Date(`${job.postedAt}T00:00:00Z`), intBetween(0, 40));
      if (appliedAt > now) continue;

      const stage = weighted([
        { weight: 20, value: 'new' },
        { weight: 14, value: 'screened' },
        { weight: 12, value: 'shortlisted' },
        { weight: 9, value: 'interview-scheduled' },
        { weight: 8, value: 'interview-completed' },
        { weight: 4, value: 'selected' },
        { weight: 18, value: 'rejected' },
        { weight: 4, value: 'offer-sent' },
        { weight: 3, value: 'offer-accepted' },
        { weight: 4, value: 'joined' },
      ]);

      const experienceYears = Math.max(0, designation.minExperienceYears + intBetween(-2, 6));
      // Candidates matched against the role keep most of its required skills; weak ones do not.
      const strong = ['shortlisted', 'selected', 'offer-sent', 'offer-accepted', 'joined'].includes(stage);
      const skills = [
        ...picks(designation.requiredSkills, strong ? designation.requiredSkills.length : intBetween(1, 2)),
        ...picks(['Docker', 'Python', 'Public Speaking', 'Jira', 'Tableau', 'Kotlin'], intBetween(1, 3)),
      ];

      const candidateId = id('can', candidateIndex++, 4);

      candidates.push({
        id: candidateId,
        jobId: job.id,
        fullName: `${firstName} ${lastName}`,
        email: faker.internet.email({ firstName, lastName, provider: 'example.com' }).toLowerCase(),
        phone: faker.phone.number({ style: 'national' }),
        source: pick(SOURCES),
        referredByEmployeeId: chance(0.12) ? pick(recruiters).id : null,
        currentCompany: faker.company.name(),
        currentTitle: designation.title,
        experienceYears,
        education: pick(['BSc Computer Science', 'BBA', 'MSc Data Science', 'BA Design', 'MBA']),
        skills: [...new Set(skills)],
        expectedSalary: Math.round(job.salaryRange.min + (job.salaryRange.max - job.salaryRange.min) * (0.3 + Math.min(0.7, experienceYears / 15))),
        noticePeriodDays: pick([0, 14, 30, 60]),
        locationPreference: pick(locations).name,
        cvFileName: `${firstName}-${lastName}-CV.pdf`.toLowerCase(),
        cvUrl: null,
        stage,
        matchScore: null,
        rating: ['new', 'rejected'].includes(stage) ? null : intBetween(2, 5),
        rejectionReason: stage === 'rejected' ? pick(REJECTION_REASONS) : null,
        notes: chance(0.4) ? faker.lorem.sentence() : '',
        convertedEmployeeId: null,
        appliedAt: iso(appliedAt),
        updatedAt: iso(addDays(appliedAt, intBetween(1, 25))),
      });

      // Interviews for anyone who reached the interview stage or beyond.
      const stageIndex = STAGES.indexOf(stage);
      const interviewed = stageIndex >= STAGES.indexOf('interview-scheduled') && stage !== 'rejected' ? intBetween(1, 2) : stage === 'rejected' && chance(0.4) ? 1 : 0;

      for (let round = 1; round <= interviewed; round += 1) {
        const scheduledAt = addDays(appliedAt, 7 * round + intBetween(0, 4));
        const done = scheduledAt < now;
        const panel = picks(
          recruiters.filter((employee) => employee.departmentId === job.departmentId),
          Math.min(2, Math.max(1, intBetween(1, 2))),
        );

        interviews.push({
          id: id('int', interviewIndex++, 4),
          candidateId,
          jobId: job.id,
          round,
          roundName: round === 1 ? 'Screening' : 'Technical',
          scheduledAt: iso(scheduledAt),
          durationMinutes: pick([30, 45, 60]),
          mode: pick(['video', 'phone', 'on-site']),
          interviewerEmployeeIds: panel.map((employee) => employee.id),
          status: done ? 'completed' : 'scheduled',
          score: done ? intBetween(2, 5) : null,
          feedback: done
            ? pick([
                'Clear communication, solid fundamentals.',
                'Good depth on past projects, some gaps on system design.',
                'Strong culture fit, needs mentoring on the technical side.',
                'Struggled with the practical exercise.',
              ])
            : '',
          recommendation: done ? weighted([
            { weight: 5, value: 'proceed' },
            { weight: 3, value: 'hold' },
            { weight: 2, value: 'reject' },
          ]) : null,
          createdAt: iso(addDays(scheduledAt, -3)),
        });
      }
    }
  }

  return { jobs, candidates, interviews, STAGES };
}

module.exports = { buildRecruitment, STAGES };
