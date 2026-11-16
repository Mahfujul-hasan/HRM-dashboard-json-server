/**
 * Checks for the employee-field extractor. Run: `node ai/extraction-test.js`.
 * Plain assertions, no framework, like the other scripts in this folder.
 */
const assert = require('node:assert/strict');
const { extractEmployeeProposals, toIsoDate } = require('./employee-extraction');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    console.error(`FAIL  ${name}\n      ${error.message}`);
    process.exitCode = 1;
  }
}

const byField = (proposals, field) => proposals.filter((item) => item.field === field);
const one = (proposals, field) => byField(proposals, field)[0];

const CV = `Ada Lovelace
Email: ada.lovelace@example.com
Phone: (415) 555-0100
Date of Birth: December 10, 1990
Gender: Female
Nationality: British
Marital Status: Single
Address: 12 Analytical Way, London

Summary
Software engineer with 7 years of experience building data systems.

Skills: TypeScript, React, SQL, Agile

Education
BSc Mathematics, Oxford University, 2012
MSc in Computer Science - Imperial College, 2014
Emergency contact: Vern Hills (208) 897-4563
`;

check('reads an unambiguous date written with a month name', () => {
  assert.deepEqual(toIsoDate('December 10, 1990'), { iso: '1990-12-10', ambiguous: false });
  assert.deepEqual(toIsoDate('10 Dec 1990'), { iso: '1990-12-10', ambiguous: false });
  assert.deepEqual(toIsoDate('1990-12-10'), { iso: '1990-12-10', ambiguous: false });
});

check('reads a slash date as unambiguous when only one order is possible', () => {
  assert.deepEqual(toIsoDate('25/12/1990'), { iso: '1990-12-25', ambiguous: false });
  assert.deepEqual(toIsoDate('12/25/1990'), { iso: '1990-12-25', ambiguous: false });
});

check('flags a slash date that could be read either way', () => {
  assert.deepEqual(toIsoDate('03/04/1990'), { iso: '1990-03-04', ambiguous: true });
  assert.deepEqual(toIsoDate('05/05/1990'), { iso: '1990-05-05', ambiguous: false });
});

check('refuses things that are not real dates', () => {
  assert.equal(toIsoDate('1990-02-31'), null);
  assert.equal(toIsoDate('13/13/1990'), null);
  assert.equal(toIsoDate('12/10/90'), null);
  assert.equal(toIsoDate('soon'), null);
});

check('proposes the fields a CV states, in the form shape', () => {
  const p = extractEmployeeProposals(CV);
  assert.equal(one(p, 'firstName').value, 'Ada');
  assert.equal(one(p, 'lastName').value, 'Lovelace');
  assert.equal(one(p, 'dateOfBirth').value, '1990-12-10');
  assert.equal(one(p, 'gender').value, 'female');
  assert.equal(one(p, 'nationality').value, 'British');
  assert.equal(one(p, 'maritalStatus').value, 'single');
  assert.equal(one(p, 'personalEmail').value, 'ada.lovelace@example.com');
  assert.equal(one(p, 'phone').value, '(415) 555-0100');
  assert.equal(one(p, 'presentAddress').value, '12 Analytical Way, London');
  assert.equal(one(p, 'experienceYears').value, 7);
  assert.deepEqual(one(p, 'skills').value, ['TypeScript', 'React', 'SQL', 'Agile']);
});

check('every proposal carries the line it came from and a confidence', () => {
  for (const item of extractEmployeeProposals(CV)) {
    assert.ok(item.evidence && item.evidence.length > 0, `${item.field} has no evidence`);
    assert.ok(item.confidence > 0 && item.confidence <= 1, `${item.field} confidence ${item.confidence}`);
  }
  assert.equal(one(extractEmployeeProposals(CV), 'dateOfBirth').evidence, 'Date of Birth: December 10, 1990');
});

check('reads each education line into degree, institution and year', () => {
  const education = byField(extractEmployeeProposals(CV), 'education').map((item) => item.value);
  assert.deepEqual(education, [
    { degree: 'BSc', institution: 'Oxford University', year: 2012 },
    { degree: 'MSc in Computer Science', institution: 'Imperial College', year: 2014 },
  ]);
});

check('does not take an emergency contact number for the employee', () => {
  const text = 'Grace Hopper\nEmergency contact: Vern Hills (208) 897-4563\n';
  assert.equal(one(extractEmployeeProposals(text), 'phone'), undefined);
});

check('proposes a labelled official email separately from a personal one', () => {
  const p = extractEmployeeProposals(
    'Name: Grace Hopper\nOfficial Email: grace@acme.test\nPersonal Email: grace@home.test',
  );
  assert.equal(one(p, 'officialEmail').value, 'grace@acme.test');
  assert.equal(one(p, 'personalEmail').value, 'grace@home.test');
});

check('does not repeat the official email as the personal one', () => {
  const p = extractEmployeeProposals('Name: Grace Hopper\nWork Email: grace@acme.test');
  assert.equal(one(p, 'officialEmail').value, 'grace@acme.test');
  assert.equal(one(p, 'personalEmail'), undefined);
});

check('proposes an ambiguous date, but says so and lowers the confidence', () => {
  const item = one(extractEmployeeProposals('Name: Grace Hopper\nDOB: 03/04/1990'), 'dateOfBirth');
  assert.equal(item.value, '1990-03-04');
  assert.ok(item.confidence < 0.5);
  assert.match(item.note, /day-first or month-first/);
});

check('drops a date of birth that is not a real date rather than guessing', () => {
  const p = extractEmployeeProposals('Name: Grace Hopper\nDate of Birth: 1990-02-31');
  assert.equal(one(p, 'dateOfBirth'), undefined);
});

check('only proposes a gender or marital status the form can hold', () => {
  const p = extractEmployeeProposals('Name: Grace Hopper\nGender: Other\nMarital Status: Complicated');
  assert.equal(one(p, 'gender'), undefined);
  assert.equal(one(p, 'maritalStatus'), undefined);
});

check('falls back to a first-line name, with less confidence than a labelled one', () => {
  const unlabelled = one(extractEmployeeProposals('Grace Hopper\nSoftware engineer'), 'firstName');
  const labelledName = one(extractEmployeeProposals('Name: Grace Hopper'), 'firstName');
  assert.equal(unlabelled.value, 'Grace');
  assert.ok(unlabelled.confidence < labelledName.confidence);
});

check('splits a middle name into the first name', () => {
  const p = extractEmployeeProposals('Full Name: Anne Marie Clark');
  assert.equal(one(p, 'firstName').value, 'Anne Marie');
  assert.equal(one(p, 'lastName').value, 'Clark');
});

check('matches known skills when there is no skills line, and says how', () => {
  const item = one(extractEmployeeProposals('Grace Hopper\nBuilt services in Python and Docker.'), 'skills');
  assert.deepEqual(item.value, ['Python', 'Docker']);
  assert.match(item.note, /known skills/);
});

check('says nothing for a document with nothing in it to read', () => {
  assert.deepEqual(extractEmployeeProposals('Quarterly newsletter. Welcome to spring.'), []);
  assert.deepEqual(extractEmployeeProposals(''), []);
});

check('flags several emails or phones rather than silently picking one', () => {
  const p = extractEmployeeProposals('Grace Hopper\nreach me at a@x.test or b@y.test, 415-555-0100 or 415-555-0101');
  assert.match(one(p, 'personalEmail').note, /2 email addresses/);
  assert.match(one(p, 'phone').note, /2 phone numbers/);
});

console.log(`extraction: ${passed} checks passed`);
