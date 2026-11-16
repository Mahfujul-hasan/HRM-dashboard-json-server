/**
 * Recruitment engines: job description, interview questions, CV analysis, match score and
 * HR email drafts.
 *
 * The match engine scores and explains — it never moves a candidate's stage, and every result
 * says so, because the requirements forbid AI from selecting or rejecting a candidate (§5.5).
 */

const { bullets, compose, confidenceFrom, matchSkills, money, percent, round, source } = require('../helpers');

const QUESTION_BANK = {
  behavioural: [
    'Tell me about a project where the requirements changed late. What did you do?',
    'Describe a disagreement with a colleague and how it was resolved.',
    'When did you last miss a deadline, and what changed afterwards?',
    'Give an example of feedback that changed how you work.',
  ],
  situational: [
    'You inherit work with no documentation and a deadline in two weeks. What are your first three steps?',
    'A stakeholder asks for something outside the agreed scope. How do you handle it?',
    'You spot a mistake in work that has already shipped. What do you do?',
  ],
  closing: [
    'What would make the first 90 days here a success for you?',
    'What questions do you have about the team or the role?',
  ],
};

/** Turns a skill into a usable technical question. */
function skillQuestion(skill) {
  return `Walk me through a piece of work where you used ${skill}. What was hard about it, and what would you do differently now?`;
}

function emailTemplate(kind, context) {
  const { candidateName, jobTitle, company, interviewDate, reason } = context;

  const templates = {
    'interview-invitation': {
      subject: `Interview invitation — ${jobTitle} at ${company}`,
      body: [
        `Hello ${candidateName},`,
        '',
        `Thank you for applying for the ${jobTitle} role. We would like to invite you to an interview${interviewDate ? ` on ${interviewDate}` : ''}.`,
        '',
        'The conversation will take about 45 minutes and will cover your experience and the work the team is doing. Please reply with a time that suits you.',
        '',
        'Best regards,',
        'HR',
      ],
    },
    'follow-up': {
      subject: `Following up — ${jobTitle}`,
      body: [
        `Hello ${candidateName},`,
        '',
        `Thank you for your time during the ${jobTitle} process. Your application is still with the hiring team and we expect to have an update within the next few days.`,
        '',
        'Best regards,',
        'HR',
      ],
    },
    rejection: {
      subject: `Update on your application — ${jobTitle}`,
      body: [
        `Hello ${candidateName},`,
        '',
        `Thank you for taking the time to interview for the ${jobTitle} role. After careful consideration we have decided not to move forward with your application${reason ? ` (${reason})` : ''}.`,
        '',
        'We appreciate your interest and would be glad to stay in touch about future openings.',
        '',
        'Best regards,',
        'HR',
      ],
    },
    offer: {
      subject: `Offer of employment — ${jobTitle} at ${company}`,
      body: [
        `Hello ${candidateName},`,
        '',
        `We are pleased to offer you the position of ${jobTitle} at ${company}. The full terms, including compensation, start date and benefits, are in the attached letter.`,
        '',
        'Please review it and let us know if you have questions. We would be glad to welcome you to the team.',
        '',
        'Best regards,',
        'HR',
      ],
    },
    'leave-approval': {
      subject: 'Your leave request has been approved',
      body: [
        `Hello ${candidateName},`,
        '',
        'Your leave request has been approved. Please hand over any ongoing work to your team before you go.',
        '',
        'Best regards,',
        'HR',
      ],
    },
    'leave-rejection': {
      subject: 'Your leave request',
      body: [
        `Hello ${candidateName},`,
        '',
        `We are not able to approve your leave request for the dates you asked for${reason ? `: ${reason}` : '.'}`,
        '',
        'Please speak to HR about alternative dates.',
        '',
        'Best regards,',
        'HR',
      ],
    },
  };

  return templates[kind] || templates['follow-up'];
}

module.exports = [
  {
    id: 'generate-job-description',
    module: 'recruitment',
    label: 'Generate Job Description',
    purpose: 'Drafts a job description from title, department and skills',
    input: {
      jobId: 'string — an existing job (optional)',
      title: 'string',
      departmentId: 'string',
      skills: 'string[] — required skills',
      experienceYears: 'number',
    },
    prompt: (input) => `Draft a job description for ${input.title || input.jobId}`,

    run({ input, db, settings }) {
      const job = input.jobId ? db.byId('jobs', input.jobId) : null;
      const designation = job ? db.byId('designations', job.designationId) : null;
      const department = db.byId('departments', (job && job.departmentId) || input.departmentId);

      const title = input.title || (job && job.title) || (designation && designation.title);
      if (!title) throw Object.assign(new Error('A job title (or jobId) is required'), { status: 400 });

      const skills = input.skills || (job && job.requiredSkills) || (designation && designation.requiredSkills) || [];
      const experienceYears = input.experienceYears ?? (job && job.minExperienceYears) ?? 2;
      const band = (job && job.salaryRange) || (designation && designation.salaryBand);
      const company = settings.company.name;

      const draft = [
        `${title}`,
        department ? `${department.name} · ${company}` : company,
        '',
        'About the role',
        `${company} is looking for a ${title}${department ? ` to join the ${department.name} team` : ''}. You will own day-to-day delivery, work closely with partner teams, and help raise the quality of what the team ships.`,
        '',
        'What you will do',
        bullets([
          'Own and deliver work in your area from planning through release.',
          'Collaborate with colleagues across the business on shared goals.',
          'Document decisions and keep stakeholders informed.',
          'Contribute to improving how the team works.',
        ]),
        '',
        'What we are looking for',
        bullets([
          `${experienceYears}+ years of relevant experience.`,
          ...skills.map((skill) => `Practical experience with ${skill}.`),
          'Clear written and spoken communication.',
        ]),
        '',
        'What we offer',
        bullets([
          band ? `Salary range ${money(band.min)} – ${money(band.max)} ${band.currency || settings.company.currency}.` : 'Competitive salary.',
          `${settings.work.weeklyHours}-hour week, ${settings.work.workingDays.join('–')}.`,
          'Health cover, paid leave and a learning budget.',
        ]),
      ].join('\n');

      return {
        output: draft,
        sources: [
          job ? source('dataset', job.id, `Job: ${job.title}`) : null,
          designation ? source('dataset', designation.id, `Designation: ${designation.title}`) : null,
          department ? source('dataset', department.id, `Department: ${department.name}`) : null,
        ].filter(Boolean),
        confidence: confidenceFrom({ evidence: skills.length, max: 0.7 }),
        limitation: 'A template filled from the role record — check the wording, the salary range and anything legally required in your region before publishing.',
        data: { title, skills, experienceYears },
      };
    },
  },

  {
    id: 'generate-interview-questions',
    module: 'recruitment',
    label: 'Generate Interview Questions',
    purpose: 'Creates structured interview questions for a role',
    input: { jobId: 'string', skills: 'string[]', round: 'string — screening | technical | final' },
    prompt: (input) => `Draft interview questions for ${input.jobId || 'the role'} (${input.round || 'technical'})`,

    run({ input, db }) {
      const job = input.jobId ? db.byId('jobs', input.jobId) : null;
      const designation = job ? db.byId('designations', job.designationId) : null;
      const skills = input.skills || (job && job.requiredSkills) || (designation && designation.requiredSkills) || [];
      if (!skills.length) throw Object.assign(new Error('Provide a jobId or a list of skills'), { status: 400 });

      const round = input.round || 'technical';
      const technical = skills.slice(0, 5).map(skillQuestion);

      return {
        output: compose([
          `Interview questions — ${job ? job.title : 'role'} (${round} round)`,
          `Role-specific\n${bullets(technical)}`,
          `Behavioural\n${bullets(QUESTION_BANK.behavioural.slice(0, 3))}`,
          `Situational\n${bullets(QUESTION_BANK.situational.slice(0, 2))}`,
          `Closing\n${bullets(QUESTION_BANK.closing)}`,
          'Ask every candidate for the role the same core questions and score them on the same scale — it keeps the process comparable and defensible.',
        ]),
        sources: job ? [source('dataset', job.id, `Job: ${job.title}`)] : [source('dataset', 'skills', 'Skills supplied in the request')],
        confidence: confidenceFrom({ evidence: skills.length, max: 0.7 }),
        limitation: 'Generic question templates built around the listed skills — adapt them to the seniority of the role.',
        data: { round, questionCount: technical.length + 5 },
      };
    },
  },

  {
    id: 'analyze-candidate-cv',
    module: 'recruitment',
    label: 'Analyze Candidate CV',
    purpose: 'Summarizes a CV and extracts candidate data',
    input: { candidateId: 'string', cvText: 'string — text extracted in the browser' },
    prompt: (input) => `Summarize the CV of candidate ${input.candidateId || '(uploaded)'}`,

    run({ input, db }) {
      const candidate = input.candidateId ? db.byId('candidates', input.candidateId) : null;
      const cvText = String(input.cvText || '').trim();
      if (!candidate && !cvText) {
        throw Object.assign(new Error('Provide a candidateId or the CV text'), { status: 400 });
      }

      const job = candidate ? db.byId('jobs', candidate.jobId) : null;
      const facts = candidate
        ? [
            `Applied for: ${job ? job.title : candidate.jobId}`,
            `Experience: ${candidate.experienceYears} year(s)`,
            `Current role: ${candidate.currentTitle} at ${candidate.currentCompany}`,
            `Education: ${candidate.education}`,
            `Skills on record: ${candidate.skills.join(', ')}`,
            `Notice period: ${candidate.noticePeriodDays} day(s)`,
            `Expected salary: ${money(candidate.expectedSalary)}`,
            `Source: ${candidate.source}`,
          ]
        : [`CV text length: ${cvText.split(/\s+/).length} words`];

      const summary = candidate
        ? `${candidate.fullName} has ${candidate.experienceYears} year(s) of experience, currently working as ${candidate.currentTitle} at ${candidate.currentCompany}. Their recorded skills cover ${candidate.skills.slice(0, 4).join(', ')}.`
        : 'Summary built from the uploaded CV text only — no candidate record is linked yet.';

      return {
        output: compose([
          candidate ? `CV summary — ${candidate.fullName}` : 'CV summary — uploaded document',
          summary,
          bullets(facts),
          'Verify the claims in the CV during the interview; nothing here has been checked against evidence.',
        ]),
        sources: [
          candidate ? source('dataset', candidate.id, `Candidate: ${candidate.fullName}`) : null,
          cvText ? source('document', 'cv-upload', 'CV text supplied by the browser') : null,
          job ? source('dataset', job.id, `Job: ${job.title}`) : null,
        ].filter(Boolean),
        confidence: confidenceFrom({ evidence: candidate ? candidate.skills.length : 3, max: 0.72 }),
        limitation: 'A restatement of recorded data, not verified fact. It must not be used on its own to screen anyone out.',
        data: candidate ? { candidateId: candidate.id, skills: candidate.skills } : { skills: [] },
      };
    },
  },

  {
    id: 'candidate-match-score',
    module: 'recruitment',
    label: 'Candidate Match Score',
    purpose: 'Scores candidate fit with strengths, gaps and explanation',
    input: { candidateId: 'string (required)', jobId: 'string — defaults to the applied job' },
    prompt: (input) => `Score candidate ${input.candidateId} against job ${input.jobId || '(applied role)'}`,

    run({ input, db }) {
      const candidate = db.byId('candidates', input.candidateId);
      if (!candidate) throw Object.assign(new Error('candidateId is required and must exist'), { status: 400 });

      const job = db.byId('jobs', input.jobId || candidate.jobId);
      if (!job) throw Object.assign(new Error('The job for this candidate was not found'), { status: 404 });

      const { matched, missing } = matchSkills(job.requiredSkills, candidate.skills);
      const skillScore = percent(matched.length, job.requiredSkills.length || 1);

      // Experience at or above the requirement scores full marks; below scales down.
      const required = job.minExperienceYears || 0;
      const experienceScore = required === 0 ? 100 : Math.min(100, Math.round((candidate.experienceYears / required) * 100));

      const band = job.salaryRange;
      const salaryFit = candidate.expectedSalary <= band.max ? 100 : Math.max(0, 100 - percent(candidate.expectedSalary - band.max, band.max));

      // Weighted: skills matter most, then experience, then whether the expectation fits the band.
      const total = Math.round(skillScore * 0.55 + experienceScore * 0.3 + salaryFit * 0.15);

      const niceMatched = matchSkills(job.niceToHaveSkills || [], candidate.skills).matched;
      const interviews = db.get('interviews').filter((item) => item.candidateId === candidate.id && item.status === 'completed');
      const averageScore = interviews.length
        ? round(interviews.reduce((sum, item) => sum + (item.score || 0), 0) / interviews.length, 1)
        : null;

      const nextAction =
        total >= 70
          ? 'Suggested next step: schedule a screening call.'
          : total >= 45
            ? 'Suggested next step: HR review — partial fit, worth a conversation about the gaps.'
            : 'Suggested next step: HR review — the recorded profile is far from the requirement.';

      return {
        output: compose([
          `Match score ${total}% — ${candidate.fullName} for ${job.title}`,
          `Breakdown\n${bullets([
            `Required skills: ${matched.length} of ${job.requiredSkills.length} (${skillScore}%)`,
            `Experience: ${candidate.experienceYears} year(s) against ${required} required (${experienceScore}%)`,
            `Salary expectation ${money(candidate.expectedSalary)} against band ${money(band.min)}–${money(band.max)} (${salaryFit}%)`,
            niceMatched.length ? `Nice-to-have skills present: ${niceMatched.join(', ')}` : null,
            averageScore !== null ? `Average interview score so far: ${averageScore}/5 over ${interviews.length} round(s)` : null,
          ])}`,
          matched.length ? `Strengths\n${bullets(matched.map((skill) => `Has ${skill}`))}` : null,
          missing.length ? `Gaps\n${bullets(missing.map((skill) => `No recorded experience with ${skill}`))}` : 'No gaps against the required skills.',
          nextAction,
          'This score ranks and explains only. It cannot select or reject a candidate — the hiring decision is yours, and the score is based on recorded data that may be incomplete.',
        ]),
        sources: [
          source('dataset', candidate.id, `Candidate: ${candidate.fullName}`),
          source('dataset', job.id, `Job: ${job.title}`),
          ...interviews.slice(0, 3).map((item) => source('dataset', item.id, `Interview round ${item.round}`)),
        ],
        confidence: confidenceFrom({ evidence: job.requiredSkills.length + interviews.length, max: 0.7 }),
        limitation:
          'Keyword overlap on recorded skills, not an assessment of ability. A skill the candidate has but did not list will read as a gap.',
        data: {
          score: total,
          skillScore,
          experienceScore,
          salaryFit,
          matched,
          missing,
          decisionAllowed: false,
        },
      };
    },
  },

  {
    id: 'draft-hr-email',
    module: 'recruitment',
    label: 'Draft HR Email',
    purpose: 'Drafts offers, invitations, reminders and rejection emails',
    input: {
      kind: 'string — interview-invitation | follow-up | rejection | offer | leave-approval | leave-rejection',
      candidateId: 'string (optional)',
      employeeId: 'string (optional)',
      recipientName: 'string (optional)',
      interviewDate: 'string (optional)',
      reason: 'string (optional)',
    },
    prompt: (input) => `Draft a ${input.kind || 'follow-up'} email`,

    run({ input, db, settings }) {
      const kind = input.kind || 'follow-up';
      const candidate = input.candidateId ? db.byId('candidates', input.candidateId) : null;
      const employee = input.employeeId ? db.byId('employees', input.employeeId) : null;
      const job = candidate ? db.byId('jobs', candidate.jobId) : null;

      const recipientName = input.recipientName || (candidate && candidate.fullName) || (employee && employee.fullName) || 'there';
      const template = emailTemplate(kind, {
        candidateName: recipientName,
        jobTitle: job ? job.title : input.jobTitle || 'the role',
        company: settings.company.name,
        interviewDate: input.interviewDate || null,
        reason: input.reason || null,
      });

      const sources = [
        candidate ? source('dataset', candidate.id, `Candidate: ${candidate.fullName}`) : null,
        employee ? source('employee', employee.id, employee.fullName) : null,
        job ? source('dataset', job.id, `Job: ${job.title}`) : null,
      ].filter(Boolean);

      return {
        output: compose([
          `Subject: ${template.subject}`,
          template.body.join('\n'),
          'Nothing is sent automatically — review, edit, then send and mark it as sent.',
        ]),
        sources: sources.length ? sources : [source('dataset', 'manual', 'Details supplied in the request')],
        confidence: 0.6,
        limitation: 'A template, not legal wording. Check anything contractual — an offer or a rejection — before sending.',
        data: { kind, subject: template.subject, recipientName },
      };
    },
  },
];
