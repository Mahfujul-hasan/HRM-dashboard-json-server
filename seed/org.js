/**
 * Organisation reference data: locations, departments, teams, designations, holidays,
 * leave types and the settings singleton. Everything else in the seed is built on top of this.
 */

const { faker } = require('@faker-js/faker');
const config = require('./config');
const { id, iso, slug, ymd } = require('./utils');

const LOCATIONS = [
  { name: 'San Francisco HQ', type: 'head-office', city: 'San Francisco', state: 'CA', timezone: 'America/Los_Angeles' },
  { name: 'Austin Office', type: 'branch', city: 'Austin', state: 'TX', timezone: 'America/Chicago' },
  { name: 'New York Office', type: 'branch', city: 'New York', state: 'NY', timezone: 'America/New_York' },
  { name: 'Remote (US)', type: 'remote', city: null, state: null, timezone: 'America/New_York' },
];

/**
 * Departments, their teams and their designations.
 * `headcountWeight` decides how many of the 100 employees land in each department.
 * `requiredSkills` on a designation is what the skill-gap and candidate-match engines compare against.
 */
const DEPARTMENTS = [
  {
    name: 'Executive',
    headcountWeight: 1,
    teams: [],
    designations: [
      { title: 'Chief Executive Officer', level: 'executive', minExperienceYears: 15, band: [280000, 340000], skills: ['Leadership', 'Strategy', 'Fundraising', 'Governance'] },
    ],
  },
  {
    name: 'Engineering',
    headcountWeight: 32,
    teams: ['Frontend', 'Backend', 'Platform', 'QA'],
    designations: [
      { title: 'Engineering Manager', level: 'lead', minExperienceYears: 8, band: [150000, 190000], skills: ['People Management', 'System Design', 'Agile', 'Hiring'] },
      { title: 'Staff Engineer', level: 'principal', minExperienceYears: 9, band: [165000, 205000], skills: ['System Design', 'Architecture', 'Mentoring', 'TypeScript'] },
      { title: 'Senior Software Engineer', level: 'senior', minExperienceYears: 5, band: [130000, 165000], skills: ['TypeScript', 'React', 'Node.js', 'System Design', 'Testing'] },
      { title: 'Software Engineer', level: 'mid', minExperienceYears: 2, band: [100000, 130000], skills: ['JavaScript', 'React', 'REST APIs', 'SQL', 'Git'] },
      { title: 'Junior Software Engineer', level: 'junior', minExperienceYears: 0, band: [78000, 100000], skills: ['JavaScript', 'HTML', 'CSS', 'Git'] },
      { title: 'QA Engineer', level: 'mid', minExperienceYears: 2, band: [85000, 115000], skills: ['Test Automation', 'Playwright', 'Regression Testing', 'Bug Triage'] },
      { title: 'DevOps Engineer', level: 'senior', minExperienceYears: 4, band: [125000, 160000], skills: ['AWS', 'Terraform', 'CI/CD', 'Kubernetes', 'Monitoring'] },
    ],
  },
  {
    name: 'Product',
    headcountWeight: 9,
    teams: ['Core Product', 'Growth'],
    designations: [
      { title: 'Director of Product', level: 'lead', minExperienceYears: 9, band: [165000, 200000], skills: ['Product Strategy', 'Roadmapping', 'Stakeholder Management'] },
      { title: 'Senior Product Manager', level: 'senior', minExperienceYears: 5, band: [135000, 165000], skills: ['Product Discovery', 'Analytics', 'Roadmapping', 'User Research'] },
      { title: 'Product Manager', level: 'mid', minExperienceYears: 2, band: [105000, 135000], skills: ['Requirements', 'Analytics', 'Agile', 'Communication'] },
      { title: 'Product Analyst', level: 'junior', minExperienceYears: 1, band: [80000, 105000], skills: ['SQL', 'Dashboards', 'Reporting'] },
    ],
  },
  {
    name: 'Design',
    headcountWeight: 7,
    teams: ['Product Design', 'Brand'],
    designations: [
      { title: 'Design Lead', level: 'lead', minExperienceYears: 7, band: [140000, 170000], skills: ['Design Systems', 'Mentoring', 'Figma', 'Accessibility'] },
      { title: 'Senior Product Designer', level: 'senior', minExperienceYears: 5, band: [120000, 150000], skills: ['Figma', 'Prototyping', 'User Research', 'Design Systems'] },
      { title: 'Product Designer', level: 'mid', minExperienceYears: 2, band: [95000, 120000], skills: ['Figma', 'Wireframing', 'Visual Design'] },
      { title: 'UX Researcher', level: 'mid', minExperienceYears: 3, band: [100000, 130000], skills: ['User Interviews', 'Usability Testing', 'Synthesis'] },
    ],
  },
  {
    name: 'Sales',
    headcountWeight: 16,
    teams: ['Enterprise', 'Mid-Market', 'Sales Development'],
    designations: [
      { title: 'VP of Sales', level: 'executive', minExperienceYears: 12, band: [190000, 240000], skills: ['Revenue Strategy', 'Forecasting', 'Team Leadership'] },
      { title: 'Sales Manager', level: 'lead', minExperienceYears: 7, band: [130000, 165000], skills: ['Pipeline Management', 'Coaching', 'Forecasting'] },
      { title: 'Account Executive', level: 'senior', minExperienceYears: 4, band: [95000, 130000], skills: ['Negotiation', 'CRM', 'Discovery Calls', 'Closing'] },
      { title: 'Sales Development Representative', level: 'junior', minExperienceYears: 0, band: [62000, 85000], skills: ['Prospecting', 'Cold Outreach', 'CRM'] },
      { title: 'Solutions Engineer', level: 'mid', minExperienceYears: 3, band: [115000, 145000], skills: ['Technical Demos', 'Integrations', 'Presales'] },
    ],
  },
  {
    name: 'Marketing',
    headcountWeight: 9,
    teams: ['Content', 'Demand Generation'],
    designations: [
      { title: 'Head of Marketing', level: 'lead', minExperienceYears: 9, band: [150000, 185000], skills: ['Brand Strategy', 'Budgeting', 'Team Leadership'] },
      { title: 'Content Marketing Manager', level: 'senior', minExperienceYears: 4, band: [95000, 125000], skills: ['Content Strategy', 'SEO', 'Copywriting'] },
      { title: 'Marketing Specialist', level: 'mid', minExperienceYears: 2, band: [72000, 95000], skills: ['Campaign Management', 'Email Marketing', 'Analytics'] },
      { title: 'Graphic Designer', level: 'mid', minExperienceYears: 2, band: [70000, 95000], skills: ['Adobe Suite', 'Branding', 'Motion Graphics'] },
    ],
  },
  {
    name: 'Human Resources',
    headcountWeight: 8,
    teams: ['People Operations', 'Talent Acquisition'],
    designations: [
      { title: 'HR Director', level: 'lead', minExperienceYears: 10, band: [150000, 185000], skills: ['HR Strategy', 'Employment Law', 'Compensation', 'Leadership'] },
      { title: 'HR Business Partner', level: 'senior', minExperienceYears: 5, band: [105000, 135000], skills: ['Employee Relations', 'Performance Management', 'Coaching'] },
      { title: 'Recruiter', level: 'mid', minExperienceYears: 2, band: [80000, 110000], skills: ['Sourcing', 'Screening', 'ATS', 'Interviewing'] },
      { title: 'HR Coordinator', level: 'junior', minExperienceYears: 0, band: [58000, 78000], skills: ['Onboarding', 'HRIS Data Entry', 'Scheduling'] },
    ],
  },
  {
    name: 'Finance',
    headcountWeight: 7,
    teams: ['Accounting', 'Financial Planning'],
    designations: [
      { title: 'Finance Director', level: 'lead', minExperienceYears: 10, band: [160000, 195000], skills: ['Financial Planning', 'Audit', 'Compliance', 'Leadership'] },
      { title: 'Senior Accountant', level: 'senior', minExperienceYears: 5, band: [95000, 125000], skills: ['GAAP', 'Reconciliation', 'Month-End Close'] },
      { title: 'Payroll Specialist', level: 'mid', minExperienceYears: 3, band: [75000, 100000], skills: ['Payroll Processing', 'Tax Filing', 'Attention to Detail'] },
      { title: 'Financial Analyst', level: 'mid', minExperienceYears: 2, band: [85000, 115000], skills: ['Forecasting', 'Excel Modelling', 'Reporting'] },
    ],
  },
  {
    name: 'Customer Support',
    headcountWeight: 12,
    teams: ['Tier 1', 'Tier 2', 'Customer Success'],
    designations: [
      { title: 'Support Manager', level: 'lead', minExperienceYears: 6, band: [105000, 135000], skills: ['Team Leadership', 'SLA Management', 'Escalations'] },
      { title: 'Customer Success Manager', level: 'senior', minExperienceYears: 4, band: [90000, 120000], skills: ['Account Management', 'Retention', 'QBRs'] },
      { title: 'Support Engineer', level: 'mid', minExperienceYears: 2, band: [72000, 98000], skills: ['Troubleshooting', 'SQL', 'Ticketing Systems'] },
      { title: 'Support Specialist', level: 'junior', minExperienceYears: 0, band: [52000, 72000], skills: ['Customer Communication', 'Ticketing Systems', 'Documentation'] },
    ],
  },
];

const LEAVE_TYPES = [
  { name: 'Annual Leave', code: 'AL', paid: true, annualQuota: 20, carryForward: true, maxCarryForward: 5, requiresDocument: false, color: '#4f46e5' },
  { name: 'Sick Leave', code: 'SL', paid: true, annualQuota: 10, carryForward: false, maxCarryForward: 0, requiresDocument: true, color: '#e11d48' },
  { name: 'Casual Leave', code: 'CL', paid: true, annualQuota: 8, carryForward: false, maxCarryForward: 0, requiresDocument: false, color: '#0ea5e9' },
  { name: 'Maternity Leave', code: 'ML', paid: true, annualQuota: 84, carryForward: false, maxCarryForward: 0, requiresDocument: true, color: '#db2777' },
  { name: 'Paternity Leave', code: 'PL', paid: true, annualQuota: 14, carryForward: false, maxCarryForward: 0, requiresDocument: true, color: '#7c3aed' },
  { name: 'Unpaid Leave', code: 'UL', paid: false, annualQuota: 30, carryForward: false, maxCarryForward: 0, requiresDocument: false, color: '#64748b' },
  { name: 'Emergency Leave', code: 'EL', paid: true, annualQuota: 5, carryForward: false, maxCarryForward: 0, requiresDocument: false, color: '#f59e0b' },
];

/** US public holidays, generated for every year the seed covers. */
const HOLIDAY_RULES = [
  { name: "New Year's Day", month: 0, day: 1 },
  { name: 'Martin Luther King Jr. Day', month: 0, nth: 3, weekday: 1 },
  { name: 'Presidents Day', month: 1, nth: 3, weekday: 1 },
  { name: 'Memorial Day', month: 4, last: true, weekday: 1 },
  { name: 'Juneteenth', month: 5, day: 19 },
  { name: 'Independence Day', month: 6, day: 4 },
  { name: 'Labor Day', month: 8, nth: 1, weekday: 1 },
  { name: 'Thanksgiving Day', month: 10, nth: 4, weekday: 4 },
  { name: 'Day after Thanksgiving', month: 10, nth: 4, weekday: 4, offset: 1 },
  { name: 'Christmas Eve', month: 11, day: 24, type: 'company' },
  { name: 'Christmas Day', month: 11, day: 25 },
  { name: "New Year's Eve", month: 11, day: 31, type: 'company' },
];

/** The nth (or last) given weekday of a month, as a UTC date. */
function nthWeekday(year, month, weekday, nth, last) {
  if (last) {
    const date = new Date(Date.UTC(year, month + 1, 0));
    while (date.getUTCDay() !== weekday) date.setUTCDate(date.getUTCDate() - 1);
    return date;
  }
  const date = new Date(Date.UTC(year, month, 1));
  while (date.getUTCDay() !== weekday) date.setUTCDate(date.getUTCDate() + 1);
  date.setUTCDate(date.getUTCDate() + (nth - 1) * 7);
  return date;
}

function buildHolidays(years, locationIds) {
  const holidays = [];
  let index = 1;

  for (const year of years) {
    for (const rule of HOLIDAY_RULES) {
      let date;
      if (rule.day) {
        date = new Date(Date.UTC(year, rule.month, rule.day));
      } else {
        date = nthWeekday(year, rule.month, rule.weekday, rule.nth, rule.last);
        if (rule.offset) date.setUTCDate(date.getUTCDate() + rule.offset);
      }

      holidays.push({
        id: id('hol', index++),
        name: rule.name,
        date: ymd(date),
        year,
        type: rule.type || 'public',
        locationIds: [...locationIds],
        recurring: true,
      });
    }
  }

  return holidays.sort((a, b) => a.date.localeCompare(b.date));
}

function buildOrg() {
  const now = config.TODAY;
  const createdAt = iso(new Date(Date.UTC(now.getUTCFullYear() - 5, 0, 2)));

  const locations = LOCATIONS.map((location, index) => ({
    id: id('loc', index + 1, 2),
    name: location.name,
    code: slug(location.name).toUpperCase().slice(0, 6),
    type: location.type,
    addressLine: location.type === 'remote' ? null : faker.location.streetAddress(),
    city: location.city,
    state: location.state,
    country: 'United States',
    postalCode: location.type === 'remote' ? null : faker.location.zipCode(),
    timezone: location.timezone,
    isHeadOffice: location.type === 'head-office',
    createdAt,
  }));

  const departments = [];
  const designations = [];
  let departmentIndex = 1;
  let designationIndex = 1;

  for (const department of DEPARTMENTS) {
    const departmentId = id('dep', departmentIndex++, 2);

    departments.push({
      id: departmentId,
      name: department.name,
      code: slug(department.name).toUpperCase().replace(/-/g, '').slice(0, 4),
      parentId: null,
      headEmployeeId: null, // filled in once employees exist
      locationId: locations[0].id,
      description: `${department.name} department of ${config.COMPANY.name}.`,
      headcountWeight: department.headcountWeight,
      createdAt,
      updatedAt: createdAt,
    });

    for (const team of department.teams) {
      departments.push({
        id: id('dep', departmentIndex++, 2),
        name: team,
        code: `${slug(department.name).toUpperCase().slice(0, 3)}-${slug(team).toUpperCase().slice(0, 3)}`,
        parentId: departmentId,
        headEmployeeId: null,
        locationId: locations[0].id,
        description: `${team} team, part of ${department.name}.`,
        headcountWeight: 0,
        createdAt,
        updatedAt: createdAt,
      });
    }

    for (const designation of department.designations) {
      designations.push({
        id: id('des', designationIndex++),
        title: designation.title,
        code: slug(designation.title).toUpperCase().slice(0, 10),
        departmentId,
        level: designation.level,
        minExperienceYears: designation.minExperienceYears,
        requiredSkills: designation.skills,
        salaryBand: { min: designation.band[0], max: designation.band[1], currency: config.CURRENCY },
        createdAt,
        updatedAt: createdAt,
      });
    }
  }

  const leaveTypes = LEAVE_TYPES.map((leaveType, index) => ({
    id: id('lvt', index + 1, 2),
    ...leaveType,
    minNoticeDays: leaveType.code === 'EL' ? 0 : 2,
    maxConsecutiveDays: leaveType.code === 'AL' ? 15 : leaveType.annualQuota,
    active: true,
    createdAt,
  }));

  const currentYear = now.getUTCFullYear();
  const years = [currentYear - 1, currentYear, currentYear + 1];
  const holidays = buildHolidays(years, locations.map((location) => location.id));

  return { locations, departments, designations, leaveTypes, holidays };
}

module.exports = { buildOrg, DEPARTMENTS, LEAVE_TYPES };
