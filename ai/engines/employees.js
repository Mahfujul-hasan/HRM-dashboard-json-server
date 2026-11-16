/**
 * Employee engines (requirements §5.3): a written summary of one employee's profile,
 * employment history and documents.
 *
 * The summary is built only from what a colleague would be told about a person's role: where they
 * sit, how long they have been here, what they have done here, what is on file. It deliberately
 * leaves out pay, date of birth, home address, phone numbers and emergency contacts, and it does
 * not read documents marked confidential unless AI settings allow it (the gateway's read view
 * already hides them). It describes; it does not assess performance or recommend anything.
 */

const { bullets, compose, confidenceFrom, daysBetween, source } = require('../helpers');

const DAY = 86_400_000;

const TYPE_LABELS = { 'full-time': 'full-time', 'part-time': 'part-time', contract: 'contract', intern: 'intern' };
const STATUS_LABELS = {
  active: 'active',
  probation: 'on probation',
  resigned: 'resigned',
  terminated: 'terminated',
  retired: 'retired',
  inactive: 'inactive',
};
const HISTORY_LABELS = {
  joined: 'Joined',
  promotion: 'Promotion',
  transfer: 'Transfer',
  'status-change': 'Status change',
  'salary-revision': 'Pay revision',
  disciplinary: 'Disciplinary record',
  appraisal: 'Appraisal',
  exit: 'Left the company',
};

const dateOf = (value) => new Date(`${value}T00:00:00Z`);

/** "2 years, 3 months", "5 months", "under a month". */
function span(from, to) {
  const start = dateOf(from);
  const end = new Date(to);
  let months = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + (end.getUTCMonth() - start.getUTCMonth());
  if (end.getUTCDate() < start.getUTCDate()) months -= 1;
  if (months < 1) return 'under a month';
  const years = Math.floor(months / 12);
  const rest = months % 12;
  return [years ? `${years} year${years === 1 ? '' : 's'}` : null, rest ? `${rest} month${rest === 1 ? '' : 's'}` : null]
    .filter(Boolean)
    .join(', ');
}

const label = (map, key) => map[key] || key;
const nameOf = (db, collection, id, field) => {
  const row = id ? db.byId(collection, id) : null;
  return row ? row[field] : null;
};

module.exports = [
  {
    id: 'summarize-employee-profile',
    module: 'employees',
    label: 'Summarize Employee Profile',
    purpose: 'Summarizes an employee\'s role, employment history and documents on file',
    input: {
      employeeId: 'string — the employee to summarize',
    },
    prompt: (input) => `Summarize the profile of employee ${input.employeeId}`,

    run({ input, db, settings, now }) {
      if (!input.employeeId) {
        throw Object.assign(new Error('Say which employee to summarize'), { status: 400 });
      }
      const employee = db.byId('employees', input.employeeId);
      if (!employee) {
        throw Object.assign(new Error(`Employee ${input.employeeId} was not found`), { status: 404 });
      }

      const today = new Date(now);
      const todayIso = today.toISOString().slice(0, 10);
      const department = nameOf(db, 'departments', employee.departmentId, 'name');
      const team = nameOf(db, 'departments', employee.teamId, 'name');
      const designation = db.byId('designations', employee.designationId);
      const location = nameOf(db, 'locations', employee.locationId, 'name');
      const manager = employee.reportingManagerId ? db.byId('employees', employee.reportingManagerId) : null;
      const reports = db
        .get('employees')
        .filter((item) => item.reportingManagerId === employee.id && ['active', 'probation'].includes(item.status));

      const left = employee.exit && ['resigned', 'terminated', 'retired'].includes(employee.status);
      const tenureEnd = left ? employee.exit.lastWorkingDate : todayIso;
      const tenure = span(employee.joiningDate, tenureEnd);

      /* Role */
      const role = [
        `${employee.fullName} (${employee.employeeId}) is ${designation ? `a ${designation.title}` : 'an employee'}`,
        department ? `in ${department}${team ? `, ${team} team` : ''}` : null,
      ]
        .filter(Boolean)
        .join(' ');
      const where = [
        location ? `based at ${location}` : null,
        employee.workMode ? `working ${employee.workMode}` : null,
        manager ? `reporting to ${manager.fullName}` : 'with no reporting manager recorded',
        reports.length ? `and managing ${reports.length} ${reports.length === 1 ? 'person' : 'people'}` : null,
      ]
        .filter(Boolean)
        .join(', ');
      const tenureLine = left
        ? `Joined on ${employee.joiningDate} and left on ${employee.exit.lastWorkingDate} after ${tenure}; status is ${label(STATUS_LABELS, employee.status)}.`
        : `Joined on ${employee.joiningDate} (${tenure} ago); ${label(TYPE_LABELS, employee.employmentType)}, currently ${label(STATUS_LABELS, employee.status)}.`;

      /* Background */
      const required = designation ? designation.requiredSkills || [] : [];
      const skills = employee.skills || [];
      const haveRequired = required.filter((skill) => skills.some((own) => own.toLowerCase() === skill.toLowerCase()));
      const background = [
        employee.experienceYears ? `${employee.experienceYears} years of experience before joining.` : null,
        skills.length ? `Skills on record: ${skills.join(', ')}.` : 'No skills are recorded.',
        required.length
          ? `Matches ${haveRequired.length} of the ${required.length} skills listed for the ${designation.title} role.`
          : null,
        (employee.education || []).length
          ? `Education: ${employee.education.map((entry) => `${entry.degree}, ${entry.institution} (${entry.year})`).join('; ')}.`
          : null,
      ].filter(Boolean);

      /* History */
      const history = [...(employee.history || [])].sort((a, b) => b.date.localeCompare(a.date));
      const historyLines = history.slice(0, 6).map((entry) => {
        const move = entry.from || entry.to ? `: ${[entry.from, entry.to].filter(Boolean).join(' → ')}` : '';
        return `${entry.date} — ${label(HISTORY_LABELS, entry.type)}${move}${entry.note ? ` (${entry.note})` : ''}`;
      });
      const counts = history.reduce((acc, entry) => ({ ...acc, [entry.type]: (acc[entry.type] || 0) + 1 }), {});
      const promotions = counts.promotion || 0;
      const transfers = counts.transfer || 0;

      /* Documents (the gateway's view already hides confidential ones when settings say so) */
      const documents = db
        .get('documents')
        .filter((document) => document.employeeId === employee.id && !document.archived);
      const expired = documents.filter((document) => document.expiryDate && document.expiryDate < todayIso);
      const expiring = documents.filter((document) => {
        if (!document.expiryDate || document.expiryDate < todayIso) return false;
        return daysBetween(today, dateOf(document.expiryDate)) <= 30;
      });
      const byCategory = documents.reduce((acc, document) => ({ ...acc, [document.category]: (acc[document.category] || 0) + 1 }), {});

      /* Things worth a look: facts, not judgements. */
      const attention = [];
      if (employee.status === 'probation' && employee.probationEndDate) {
        const days = Math.round((dateOf(employee.probationEndDate) - today) / DAY);
        if (days < 0) attention.push(`Probation ended on ${employee.probationEndDate} but the status is still probation.`);
        else if (days <= 30) attention.push(`Probation ends in ${days} day${days === 1 ? '' : 's'} (${employee.probationEndDate}).`);
      }
      if (expired.length) attention.push(`${expired.length} document${expired.length === 1 ? ' has' : 's have'} expired: ${expired.map((d) => d.title.replace(/ — .*/, '')).join(', ')}.`);
      if (expiring.length) attention.push(`${expiring.length} document${expiring.length === 1 ? ' expires' : 's expire'} within 30 days: ${expiring.map((d) => d.title.replace(/ — .*/, '')).join(', ')}.`);
      if (!documents.length) attention.push('No documents are on file.');
      if (!employee.reportingManagerId && !reports.length) attention.push('No reporting line is recorded in either direction.');
      if (employee.status === 'active' && employee.exit) attention.push('The record is active but carries exit details.');
      if (['resigned', 'terminated', 'retired'].includes(employee.status) && !employee.exit) {
        attention.push(`Marked ${employee.status} but no exit details are recorded.`);
      }

      const facts = {
        employeeId: employee.id,
        status: employee.status,
        tenure,
        historyEntries: history.length,
        promotions,
        transfers,
        documentCount: documents.length,
        expiredDocuments: expired.length,
        expiringDocuments: expiring.length,
        directReports: reports.length,
      };

      return {
        output: compose([
          `${role}${where ? `, ${where}` : ''}. ${tenureLine}`,
          background.length ? `Background\n${bullets(background)}` : null,
          `Employment history\n${
            history.length
              ? `${history.length} entr${history.length === 1 ? 'y' : 'ies'}${promotions || transfers ? ` — ${promotions} promotion${promotions === 1 ? '' : 's'}, ${transfers} transfer${transfers === 1 ? '' : 's'}` : ''}. Most recent first:\n${bullets(historyLines)}`
              : 'Nothing is recorded beyond joining.'
          }`,
          `Documents on file\n${
            documents.length
              ? `${documents.length} document${documents.length === 1 ? '' : 's'}: ${Object.entries(byCategory).map(([category, count]) => `${category.replace(/-/g, ' ')}${count > 1 ? ` ×${count}` : ''}`).join(', ')}.`
              : 'None.'
          }${
            settings && settings.ai && settings.ai.allowConfidentialDocuments === false
              ? ' Confidential documents are left out by the AI settings, so the profile may list more.'
              : ''
          }`,
          attention.length ? `Worth a look\n${bullets(attention)}` : 'Nothing in the record needs attention.',
          'Pay, date of birth, address and phone numbers are not part of this summary.',
        ]),
        sources: [
          source('employee', employee.id, `${employee.fullName} — employee record`),
          ...documents.slice(0, 5).map((document) => source('document', document.id, document.title)),
        ],
        confidence: confidenceFrom({ evidence: history.length + documents.length + skills.length, max: 0.88, base: 0.7 }),
        limitation:
          'Built from the record, its history and the document register. The contents of documents were not read, pay and personal contact details are left out, and nothing here assesses performance or recommends an action.',
        data: { ...facts, attention },
      };
    },
  },
];
