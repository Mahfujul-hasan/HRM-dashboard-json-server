/**
 * Employee and company documents (requirements §5.12).
 *
 * Expiry dates are spread on purpose: some already expired, some inside the next 30 days and
 * some far out, so the expiry alert widget and the AI document-expiry engine have real cases.
 * No binary files are produced — `fileUrl` stays null until the upload route stores something.
 */

const config = require('./config');
const { addDays, chance, id, intBetween, iso, weighted, ymd } = require('./utils');

/** `expires` marks the categories that carry an expiry date. */
const EMPLOYEE_DOCS = [
  { category: 'offer-letter', title: 'Offer Letter', expires: false, confidential: true, always: true },
  { category: 'appointment-letter', title: 'Appointment Letter', expires: false, confidential: true, always: true },
  { category: 'id-proof', title: 'Government ID', expires: true, confidential: true, always: true },
  { category: 'nda', title: 'Non-Disclosure Agreement', expires: false, confidential: true, always: true },
  { category: 'education-certificate', title: 'Degree Certificate', expires: false, confidential: false, always: false },
  { category: 'experience-letter', title: 'Experience Letter', expires: false, confidential: false, always: false },
  { category: 'contract', title: 'Employment Contract', expires: true, confidential: true, always: false },
  { category: 'certification', title: 'Professional Certification', expires: true, confidential: false, always: false },
  { category: 'work-authorization', title: 'Work Authorization', expires: true, confidential: true, always: false },
  { category: 'tax-form', title: 'Tax Form W-4', expires: false, confidential: true, always: false },
  { category: 'resume', title: 'Resume', expires: false, confidential: false, always: false },
];

const COMPANY_DOCS = [
  { category: 'policy', title: 'Employee Handbook', policySource: true },
  { category: 'policy', title: 'Leave Policy', policySource: true },
  { category: 'policy', title: 'Attendance and Working Hours Policy', policySource: true },
  { category: 'policy', title: 'Code of Conduct', policySource: true },
  { category: 'policy', title: 'Remote Work Policy', policySource: true },
  { category: 'policy', title: 'Travel and Expense Policy', policySource: true },
  { category: 'policy', title: 'Performance Review Guidelines', policySource: true },
  { category: 'policy', title: 'Data Protection and Privacy Policy', policySource: true },
  { category: 'template', title: 'Offer Letter Template', policySource: false },
  { category: 'template', title: 'Onboarding Checklist Template', policySource: false },
  { category: 'compliance', title: 'Workplace Safety Certificate', policySource: false },
  { category: 'compliance', title: 'Business Insurance Certificate', policySource: false },
];

/** Expiry spread: already expired, expiring soon, or comfortably in the future. */
function expiryDate(now) {
  return weighted([
    { weight: 6, value: addDays(now, -intBetween(1, 120)) },
    { weight: 14, value: addDays(now, intBetween(1, 30)) },
    { weight: 20, value: addDays(now, intBetween(31, 180)) },
    { weight: 60, value: addDays(now, intBetween(181, 1400)) },
  ]);
}

function buildDocuments({ employees, hrUser }) {
  const now = config.TODAY;
  const documents = [];
  let index = 1;

  for (const employee of employees) {
    const joined = new Date(`${employee.joiningDate}T00:00:00Z`);

    for (const template of EMPLOYEE_DOCS) {
      if (!template.always && !chance(0.45)) continue;

      const uploadedAt = addDays(joined, intBetween(-5, 60));
      const issueDate = addDays(uploadedAt, -intBetween(0, 400));
      const hasExpiry = template.expires;
      const version = chance(0.1) ? 2 : 1;

      documents.push({
        id: id('doc', index++, 4),
        ownerType: 'employee',
        employeeId: employee.id,
        title: `${template.title} — ${employee.fullName}`,
        category: template.category,
        fileName: `${template.category}-${employee.employeeId}.pdf`,
        fileUrl: null,
        mimeType: 'application/pdf',
        sizeBytes: intBetween(60000, 2400000),
        issueDate: ymd(issueDate),
        expiryDate: hasExpiry ? ymd(expiryDate(now)) : null,
        confidential: template.confidential,
        tags: [template.category, employee.employeeId],
        remarks: '',
        version,
        previousVersionId: null,
        archived: chance(0.03),
        aiClassified: chance(0.3),
        aiSummary: null,
        policySource: false,
        uploadedBy: hrUser.id,
        uploadedAt: iso(uploadedAt),
        updatedAt: iso(uploadedAt),
      });
    }
  }

  for (const template of COMPANY_DOCS) {
    const issueDate = addDays(now, -intBetween(100, 900));

    documents.push({
      id: id('doc', index++, 4),
      ownerType: 'company',
      employeeId: null,
      title: template.title,
      category: template.category,
      fileName: `${template.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.pdf`,
      fileUrl: null,
      mimeType: 'application/pdf',
      sizeBytes: intBetween(120000, 3500000),
      issueDate: ymd(issueDate),
      expiryDate: template.category === 'compliance' ? ymd(expiryDate(now)) : null,
      confidential: false,
      tags: [template.category],
      remarks: '',
      version: intBetween(1, 3),
      previousVersionId: null,
      archived: false,
      aiClassified: true,
      aiSummary: null,
      /** Policy sources are the only documents the Ask HR Policy tool is allowed to cite. */
      policySource: template.policySource,
      uploadedBy: hrUser.id,
      uploadedAt: iso(issueDate),
      updatedAt: iso(addDays(issueDate, intBetween(0, 200))),
    });
  }

  return { documents };
}

module.exports = { buildDocuments, COMPANY_DOCS };
