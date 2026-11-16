/**
 * Employee-form field extraction from document text (CV, ID document, offer or appointment
 * letter). Rule-based stand-in for a model: the contract is what matters, not the cleverness.
 *
 * Each proposal is `{ field, value, confidence, evidence }`:
 *   field       a key of the employee form (`firstName`, `dateOfBirth`, `skills`, ...)
 *   value       already in the form's shape — ISO dates, enum codes, arrays
 *   confidence  0-1, lower when the text was ambiguous
 *   evidence    the line of the document the value came from, so a person can check it
 *
 * Nothing is guessed silently. A date like 03/04/1990 could be March 4 or April 3; it is read
 * month-first (the company is US-based) but proposed with low confidence and a note, never as
 * a certainty. A field with no evidence in the text is simply absent.
 */

const SKILL_WORDS = [
  'JavaScript', 'TypeScript', 'React', 'Node.js', 'Python', 'Java', 'SQL', 'AWS', 'Azure', 'Docker',
  'Kubernetes', 'Terraform', 'GraphQL', 'Figma', 'Salesforce', 'Excel', 'Tableau', 'Power BI',
  'Project Management', 'Agile', 'Scrum', 'Testing', 'Playwright', 'Cypress', 'Negotiation',
  'Recruiting', 'Payroll', 'Accounting', 'Customer Support', 'Communication', 'Leadership',
];

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]{2,}/g;
const PHONE = /(?:\+\d{1,3}[\s-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}/g;
const DATE =
  /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{4}|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?,?\s+\d{4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})\b/i;

const pad = (n) => String(n).padStart(2, '0');

function isoIfReal(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  const real =
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return real ? `${year}-${pad(month)}-${pad(day)}` : null;
}

/** `{ iso, ambiguous }` for a date as written, or null if it is not a real date. */
function toIsoDate(raw) {
  const text = String(raw).trim();
  let match;

  if ((match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text))) {
    const iso = isoIfReal(Number(match[1]), Number(match[2]), Number(match[3]));
    return iso ? { iso, ambiguous: false } : null;
  }

  if ((match = /^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})$/.exec(text))) {
    const iso = isoIfReal(Number(match[3]), MONTHS[match[2].toLowerCase()], Number(match[1]));
    return iso ? { iso, ambiguous: false } : null;
  }

  if ((match = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(text))) {
    const iso = isoIfReal(Number(match[3]), MONTHS[match[1].toLowerCase()], Number(match[2]));
    return iso ? { iso, ambiguous: false } : null;
  }

  if ((match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(text))) {
    const a = Number(match[1]);
    const b = Number(match[2]);
    const year = Number(match[3]);
    if (a > 12) {
      const iso = isoIfReal(year, b, a);
      return iso ? { iso, ambiguous: false } : null;
    }
    if (b > 12) {
      const iso = isoIfReal(year, a, b);
      return iso ? { iso, ambiguous: false } : null;
    }
    const iso = isoIfReal(year, a, b);
    return iso ? { iso, ambiguous: a !== b } : null;
  }

  return null;
}

/** The first line of the form `Label: value` for any of the labels, or null. */
function labelled(lines, labels) {
  const pattern = new RegExp(`^\\s*(?:${labels.join('|')})\\s*[:\\-\\u2013]\\s*(.+?)\\s*$`, 'i');
  for (const line of lines) {
    const match = pattern.exec(line);
    if (match && match[1]) return { value: match[1], line: line.trim() };
  }
  return null;
}

const GENDERS = { male: 'male', m: 'male', female: 'female', f: 'female', 'non-binary': 'non-binary', nonbinary: 'non-binary' };
const MARITAL = ['single', 'married', 'divorced', 'widowed'];

const DEGREE =
  /\b(Ph\.?D\.?|Doctorate|M\.?B\.?A\.?|M\.?Sc\.?|M\.?Eng\.?|M\.?A\.?|B\.?Sc\.?|B\.?Eng\.?|B\.?Tech\.?|B\.?A\.?|Bachelor(?:'s)?(?: of [A-Za-z]+(?: [A-Za-z]+)?)?|Master(?:'s)?(?: of [A-Za-z]+(?: [A-Za-z]+)?)?|Diploma|Associate(?: degree)?)(?:\s+in\s+([A-Za-z]+(?:\s+(?:and|&)?\s*[A-Za-z]+){0,3}))?/;
const INSTITUTION =
  /((?:University|Institute|College) of [A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+)*|[A-Z][\w&'.-]*(?: [A-Z&][\w&'.-]*)* (?:University|College|Institute|School|Academy))/;

function parseEducation(lines) {
  const entries = [];
  for (const line of lines) {
    const degree = DEGREE.exec(line);
    const institution = INSTITUTION.exec(line);
    const years = line.match(/\b(?:19|20)\d{2}\b/g);
    if (!degree || !institution || !years) continue;

    const name = degree[2] ? `${degree[1]} in ${degree[2].trim()}` : degree[1];
    entries.push({
      value: { degree: name, institution: institution[1], year: Number(years[years.length - 1]) },
      evidence: line.trim(),
    });
  }
  return entries;
}

function parseExperience(text, lines) {
  const pattern =
    /(\d+(?:\.\d+)?)\s*\+?\s*(?:years?|yrs?)(?:\s+of)?\s+(?:(?:professional|work|relevant|total)\s+)?experience/i;
  const sentence = pattern.exec(text);
  if (sentence) {
    const line = lines.find((item) => pattern.test(item)) || sentence[0];
    return { value: Number(sentence[1]), evidence: line.trim(), confidence: 0.75 };
  }
  const found = labelled(lines, ['total experience', 'years of experience', 'experience']);
  const digits = found && /^(\d+(?:\.\d+)?)/.exec(found.value);
  return digits ? { value: Number(digits[1]), evidence: found.line, confidence: 0.7 } : null;
}

/**
 * Field proposals for the employee form.
 * @param {string} text  document text extracted in the browser
 */
function extractEmployeeProposals(text) {
  const source = String(text || '');
  const lines = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const proposals = [];
  const propose = (field, value, confidence, evidence, note) => {
    if (value === null || value === undefined || value === '') return;
    proposals.push({ field, value, confidence, evidence, ...(note ? { note } : {}) });
  };

  /* Name */
  let fullName = labelled(lines, ['full name', 'candidate name', 'employee name', 'name']);
  let nameConfidence = 0.85;
  if (!fullName) {
    const first = lines.find((line) => line.length > 2 && line.length < 60);
    if (first && /^[A-Z][a-z]+(?:\s+[A-Z][a-z'.-]+){1,3}$/.test(first)) {
      fullName = { value: first, line: first };
      nameConfidence = 0.55;
    }
  }
  if (fullName) {
    const words = fullName.value.replace(/\s+/g, ' ').trim().split(' ');
    if (words.length >= 2) {
      propose('firstName', words.slice(0, -1).join(' '), nameConfidence, fullName.line);
      propose('lastName', words[words.length - 1], nameConfidence, fullName.line);
    }
  }

  /* Personal */
  const dob = labelled(lines, ['date of birth', 'birth date', 'dob', 'born']);
  if (dob) {
    const written = DATE.exec(dob.value);
    const parsed = written && toIsoDate(written[0]);
    if (parsed) {
      propose(
        'dateOfBirth',
        parsed.iso,
        parsed.ambiguous ? 0.45 : 0.85,
        dob.line,
        parsed.ambiguous
          ? `Written as ${written[0]}, which could be day-first or month-first. Read as month-first.`
          : undefined,
      );
    }
  }

  const gender = labelled(lines, ['gender', 'sex']);
  if (gender && GENDERS[gender.value.toLowerCase()]) {
    propose('gender', GENDERS[gender.value.toLowerCase()], 0.85, gender.line);
  }

  const marital = labelled(lines, ['marital status']);
  if (marital && MARITAL.includes(marital.value.toLowerCase())) {
    propose('maritalStatus', marital.value.toLowerCase(), 0.85, marital.line);
  }

  const nationality = labelled(lines, ['nationality', 'citizenship']);
  if (nationality && /^[A-Za-z][A-Za-z .'-]{1,39}$/.test(nationality.value)) {
    propose('nationality', nationality.value, 0.8, nationality.line);
  }

  /* Contact */
  const officialEmail = labelled(lines, ['official email', 'work email', 'company email']);
  const officialMatch = officialEmail && (officialEmail.value.match(EMAIL) || [])[0];
  if (officialMatch) propose('officialEmail', officialMatch.toLowerCase(), 0.85, officialEmail.line);

  const personalLabel = labelled(lines, ['personal email', 'e-?mail']);
  const personalMatch = personalLabel && (personalLabel.value.match(EMAIL) || [])[0];
  if (personalMatch && personalMatch.toLowerCase() !== (officialMatch || '').toLowerCase()) {
    propose('personalEmail', personalMatch.toLowerCase(), 0.85, personalLabel.line);
  } else if (!personalMatch) {
    const all = [...new Set(source.match(EMAIL) || [])].filter(
      (email) => email.toLowerCase() !== (officialMatch || '').toLowerCase(),
    );
    if (all.length) {
      const line = lines.find((item) => item.includes(all[0])) || all[0];
      propose('personalEmail', all[0].toLowerCase(), all.length === 1 ? 0.7 : 0.5, line,
        all.length > 1 ? `${all.length} email addresses were found; the first is proposed.` : undefined);
    }
  }

  const phoneLabel = labelled(lines, ['phone', 'mobile', 'telephone', 'tel', 'cell', 'contact number']);
  const phoneMatch = phoneLabel && (phoneLabel.value.match(PHONE) || [])[0];
  if (phoneMatch) {
    propose('phone', phoneMatch, 0.85, phoneLabel.line);
  } else {
    // An emergency contact's number is not the employee's.
    const own = lines.filter((line) => !/emergency/i.test(line));
    const all = [...new Set(own.join('\n').match(PHONE) || [])];
    if (all.length) {
      const line = own.find((item) => item.includes(all[0])) || all[0];
      propose('phone', all[0], all.length === 1 ? 0.7 : 0.5, line,
        all.length > 1 ? `${all.length} phone numbers were found; the first is proposed.` : undefined);
    }
  }

  const permanent = labelled(lines, ['permanent address']);
  const present = labelled(lines, ['present address', 'current address', 'residential address', 'home address', 'address']);
  if (present) propose('presentAddress', present.value, 0.8, present.line);
  if (permanent) propose('permanentAddress', permanent.value, 0.8, permanent.line);

  /* Qualifications */
  const experience = parseExperience(source, lines);
  if (experience) propose('experienceYears', experience.value, experience.confidence, experience.evidence);

  const skillLine = labelled(lines, ['technical skills', 'key skills', 'core skills', 'skills']);
  if (skillLine) {
    const skills = skillLine.value
      .split(/[,;|•]/)
      .map((skill) => skill.trim())
      .filter((skill) => skill.length >= 2 && skill.length <= 40)
      .slice(0, 25);
    propose('skills', skills.length ? skills : null, 0.8, skillLine.line);
  } else {
    const found = SKILL_WORDS.filter((skill) => source.toLowerCase().includes(skill.toLowerCase()));
    propose('skills', found.length ? found : null, 0.55, 'Skill words found in the text',
      'No "Skills:" line was found, so these were matched from a list of known skills.');
  }

  for (const entry of parseEducation(lines)) {
    propose('education', entry.value, 0.7, entry.evidence);
  }

  return proposals;
}

module.exports = { extractEmployeeProposals, toIsoDate };
