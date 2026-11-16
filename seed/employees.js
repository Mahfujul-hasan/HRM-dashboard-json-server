/**
 * Employee master data (requirements §5.3).
 *
 * Employees are spread across departments by `headcountWeight`, and each department gets
 * exactly one head, who reports to the CEO; everybody else reports to their department head.
 * Salary lives in the `salaryStructures` collection, not here.
 */

const { faker } = require('@faker-js/faker');
const config = require('./config');
const { addDays, addMonths, chance, id, intBetween, iso, pad, pick, picks, slug, weighted, ymd } = require('./utils');

const GENDERS = ['male', 'female', 'non-binary', 'prefer-not-to-say'];
const MARITAL = ['single', 'married', 'divorced', 'widowed'];
const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-'];
const EMPLOYMENT_TYPES = ['full-time', 'part-time', 'contract', 'intern'];
const RELATIONS = ['Spouse', 'Parent', 'Sibling', 'Friend', 'Child'];
const DEGREES = ['BSc Computer Science', 'BA Economics', 'BBA', 'MSc Information Systems', 'MBA', 'BFA Design', 'BSc Statistics', 'BA Communications'];
const EXIT_REASONS = ['Better opportunity', 'Relocation', 'Compensation', 'Career change', 'Higher studies', 'Personal reasons', 'Performance', 'Restructuring'];

/** How many employees each department gets, scaled to the configured total. */
function splitHeadcount(parentDepartments, total) {
  const weightTotal = parentDepartments.reduce((sum, department) => sum + department.headcountWeight, 0);
  const counts = parentDepartments.map((department) => ({
    departmentId: department.id,
    count: Math.max(1, Math.floor((department.headcountWeight / weightTotal) * total)),
  }));

  // Hand any rounding remainder to the largest departments, biggest first.
  let assigned = counts.reduce((sum, entry) => sum + entry.count, 0);
  const order = [...counts].sort((a, b) => b.count - a.count);
  let cursor = 0;
  while (assigned < total) {
    order[cursor % order.length].count += 1;
    assigned += 1;
    cursor += 1;
  }
  while (assigned > total) {
    const entry = order[cursor % order.length];
    if (entry.count > 1) {
      entry.count -= 1;
      assigned -= 1;
    }
    cursor += 1;
  }

  return counts;
}

/** Picks a designation for the nth person in a department: index 0 is always the most senior. */
function pickDesignation(designations, index) {
  const ranked = [...designations].sort((a, b) => b.minExperienceYears - a.minExperienceYears);
  if (index === 0) return ranked[0];

  const individualContributors = ranked.filter((designation) => !['lead', 'executive'].includes(designation.level));
  const pool = individualContributors.length ? individualContributors : ranked;
  return weighted(
    pool.map((designation) => ({
      weight: { principal: 1, senior: 4, mid: 6, junior: 4 }[designation.level] || 2,
      value: designation,
    })),
  );
}

function buildEmployee({ index, department, designation, teams, locations, managerId, now }) {
  const sex = weighted([
    { weight: 48, value: 'male' },
    { weight: 48, value: 'female' },
    { weight: 4, value: 'other' },
  ]);
  const firstName = faker.person.firstName(sex === 'other' ? undefined : sex);
  const lastName = faker.person.lastName();
  const fullName = `${firstName} ${lastName}`;

  const tenureDays = Math.round(
    weighted([
      { weight: 12, value: intBetween(1, 150) }, // recent hires, for the "new hires" widgets
      { weight: 40, value: intBetween(151, 900) },
      { weight: 30, value: intBetween(901, 1800) },
      { weight: 18, value: intBetween(1801, 2900) },
    ]),
  );
  const joiningDate = addDays(now, -tenureDays);
  const probationEndDate = addMonths(joiningDate, 6);
  const onProbation = probationEndDate > now;

  const status = onProbation
    ? 'probation'
    : weighted([
        { weight: 82, value: 'active' },
        { weight: 8, value: 'resigned' },
        { weight: 2, value: 'terminated' },
        { weight: 1, value: 'retired' },
        { weight: 3, value: 'inactive' },
      ]);
  const hasLeft = ['resigned', 'terminated', 'retired'].includes(status);

  const employmentType = weighted([
    { weight: 86, value: 'full-time' },
    { weight: 5, value: 'part-time' },
    { weight: 6, value: 'contract' },
    { weight: 3, value: 'intern' },
  ]);

  const location = weighted([
    { weight: 45, value: locations[0] },
    { weight: 18, value: locations[1] },
    { weight: 17, value: locations[2] },
    { weight: 20, value: locations[3] },
  ]);

  const experienceYears = Math.min(
    30,
    designation.minExperienceYears + intBetween(0, 4) + Math.floor(tenureDays / 365),
  );

  const lastWorkingDate = hasLeft ? addDays(now, -intBetween(5, 200)) : null;
  const exitDate = lastWorkingDate && lastWorkingDate < joiningDate ? addDays(joiningDate, 90) : lastWorkingDate;

  const history = [
    { type: 'joined', date: ymd(joiningDate), from: null, to: designation.title, note: 'Joined the company' },
  ];
  if (tenureDays > 900 && chance(0.55)) {
    history.push({
      type: 'promotion',
      date: ymd(addDays(joiningDate, Math.round(tenureDays * 0.6))),
      from: 'Previous title',
      to: designation.title,
      note: 'Promoted after annual review',
    });
  }
  if (tenureDays > 500 && chance(0.2)) {
    history.push({
      type: 'transfer',
      date: ymd(addDays(joiningDate, Math.round(tenureDays * 0.4))),
      from: pick(locations).name,
      to: location.name,
      note: 'Internal transfer',
    });
  }
  if (hasLeft && exitDate) {
    history.push({
      type: 'exit',
      date: ymd(exitDate),
      from: status === 'terminated' ? 'Active' : 'Active',
      to: status,
      note: 'Exit processed by HR',
    });
  }

  const officialEmail = `${slug(firstName)}.${slug(lastName)}${index}@${config.COMPANY.domain}`;

  return {
    id: id('emp', index),
    employeeId: `EMP-${pad(index, 4)}`,
    fullName,
    firstName,
    lastName,
    dateOfBirth: ymd(faker.date.birthdate({ min: 22, max: 60, mode: 'age' })),
    gender: sex === 'other' ? pick(GENDERS.slice(2)) : sex,
    maritalStatus: pick(MARITAL),
    nationality: 'American',
    bloodGroup: pick(BLOOD_GROUPS),
    emergencyContact: {
      name: faker.person.fullName(),
      relation: pick(RELATIONS),
      phone: faker.phone.number({ style: 'national' }),
    },
    personalEmail: faker.internet.email({ firstName, lastName, provider: 'example.com' }).toLowerCase(),
    officialEmail,
    phone: faker.phone.number({ style: 'national' }),
    presentAddress: `${faker.location.streetAddress()}, ${faker.location.city()}, ${faker.location.state({ abbreviated: true })} ${faker.location.zipCode()}`,
    permanentAddress: `${faker.location.streetAddress()}, ${faker.location.city()}, ${faker.location.state({ abbreviated: true })} ${faker.location.zipCode()}`,
    photoUrl: null,
    departmentId: department.id,
    teamId: teams.length ? pick(teams).id : null,
    designationId: designation.id,
    reportingManagerId: managerId,
    employmentType,
    joiningDate: ymd(joiningDate),
    probationEndDate: ymd(probationEndDate),
    confirmationDate: onProbation ? null : ymd(probationEndDate),
    locationId: location.id,
    status,
    workMode: location.type === 'remote' ? 'remote' : pick(['on-site', 'on-site', 'hybrid']),
    experienceYears,
    skills: [...new Set([...picks(designation.requiredSkills, Math.min(designation.requiredSkills.length, intBetween(2, 4))), ...picks(['Communication', 'Problem Solving', 'Jira', 'Presentation', 'Mentoring', 'Data Analysis'], intBetween(1, 2))])],
    education: [
      {
        degree: pick(DEGREES),
        institution: `${faker.location.state()} State University`,
        year: new Date().getUTCFullYear() - experienceYears - intBetween(1, 4),
      },
    ],
    exit: hasLeft
      ? {
          resignationDate: ymd(addDays(exitDate, -30)),
          lastWorkingDate: ymd(exitDate),
          reason: status === 'terminated' ? pick(['Performance', 'Policy violation']) : pick(EXIT_REASONS),
          interviewNotes: faker.lorem.sentence(),
          clearanceStatus: chance(0.85) ? 'completed' : 'pending',
          rehireEligible: status !== 'terminated',
        }
      : null,
    history,
    createdAt: iso(joiningDate),
    updatedAt: iso(addDays(now, -intBetween(0, 60))),
  };
}

function buildEmployees({ departments, designations, locations }) {
  const now = config.TODAY;
  const parents = departments.filter((department) => department.parentId === null);
  const headcount = splitHeadcount(parents, config.EMPLOYEE_COUNT);

  const employees = [];
  let index = 1;
  let ceoId = null;

  // Executive first, so the CEO is emp_001 and can be every head's manager.
  const ordered = [...headcount].sort((a, b) => {
    const nameOf = (entry) => parents.find((department) => department.id === entry.departmentId).name;
    if (nameOf(a) === 'Executive') return -1;
    if (nameOf(b) === 'Executive') return 1;
    return 0;
  });

  for (const entry of ordered) {
    const department = parents.find((item) => item.id === entry.departmentId);
    const departmentDesignations = designations.filter((designation) => designation.departmentId === department.id);
    const teams = departments.filter((item) => item.parentId === department.id);
    let headId = null;

    for (let position = 0; position < entry.count; position += 1) {
      const designation = pickDesignation(departmentDesignations, position);
      const managerId = position === 0 ? ceoId : headId;
      const employee = buildEmployee({ index, department, designation, teams, locations, managerId, now });

      if (position === 0) {
        headId = employee.id;
        department.headEmployeeId = employee.id;
        if (!ceoId) ceoId = employee.id;
        // A department head never sits on probation or in an exited state.
        employee.status = 'active';
        employee.exit = null;
      }

      employees.push(employee);
      index += 1;
    }

    // Teams point at a member of the department as their lead.
    for (const team of teams) {
      const candidates = employees.filter((employee) => employee.teamId === team.id && employee.status === 'active');
      team.headEmployeeId = candidates.length ? candidates[0].id : headId;
    }
  }

  return employees;
}

module.exports = { buildEmployees };
