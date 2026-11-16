/**
 * Skill-gap analysis and training recommendations (requirements §5.11).
 *
 * Both engines compare recorded employee skills with the `requiredSkills` on their designation
 * and with the skills each training programme covers. Missing data reads as a gap, which is
 * why both results say so explicitly.
 */

const { bullets, compose, confidenceFrom, matchSkills, money, percent, source } = require('../helpers');

/** Employees whose recorded skills can be compared against a role. */
function employeeContext(db, employeeId) {
  const employee = db.byId('employees', employeeId);
  if (!employee) throw Object.assign(new Error('employeeId is required and must exist'), { status: 400 });

  const designation = db.byId('designations', employee.designationId);
  const department = db.byId('departments', employee.departmentId);
  const enrollments = db.get('trainingEnrollments').filter((item) => item.employeeId === employee.id);
  const completed = enrollments.filter((item) => item.status === 'completed');
  const trainings = db.get('trainings');

  // Skills the employee has picked up from completed training count towards their profile.
  const trainedSkills = completed.flatMap((item) => {
    const training = trainings.find((entry) => entry.id === item.trainingId);
    return training ? training.skillsCovered : [];
  });

  return { employee, designation, department, enrollments, completed, trainings, trainedSkills };
}

module.exports = [
  {
    id: 'skill-gap-analyzer',
    module: 'training',
    label: 'Skill-Gap Analyzer',
    purpose: 'Compares employee skills with role requirements',
    input: {
      employeeId: 'string (required)',
      targetDesignationId: 'string — compare against a future role instead (optional)',
    },
    prompt: (input) => `Analyse the skill gap for employee ${input.employeeId}`,

    run({ input, db }) {
      const { employee, designation, trainings, trainedSkills, completed } = employeeContext(db, input.employeeId);

      const target = input.targetDesignationId ? db.byId('designations', input.targetDesignationId) : designation;
      if (!target) throw Object.assign(new Error('No designation to compare against'), { status: 404 });

      const owned = [...new Set([...(employee.skills || []), ...trainedSkills])];
      const { matched, missing } = matchSkills(target.requiredSkills, owned);
      const coverage = percent(matched.length, target.requiredSkills.length || 1);

      // Which programmes would close each gap.
      const remedies = missing.map((skill) => ({
        skill,
        trainings: trainings
          .filter((training) => training.skillsCovered.some((covered) => covered.toLowerCase() === skill.toLowerCase()))
          .map((training) => training.title),
      }));

      const experienceGap = target.minExperienceYears - employee.experienceYears;

      return {
        output: compose([
          `Skill coverage ${coverage}% — ${employee.fullName} against ${target.title}${input.targetDesignationId ? ' (target role)' : ''}`,
          matched.length ? `Has\n${bullets(matched)}` : 'None of the required skills are recorded.',
          missing.length ? `Missing\n${bullets(missing)}` : 'No gaps against the required skills.',
          experienceGap > 0
            ? `Experience: ${employee.experienceYears} year(s) against ${target.minExperienceYears} expected — ${experienceGap} year(s) short.`
            : `Experience: ${employee.experienceYears} year(s), at or above the ${target.minExperienceYears} expected.`,
          remedies.some((item) => item.trainings.length)
            ? `Available training for the gaps\n${bullets(
                remedies
                  .filter((item) => item.trainings.length)
                  .map((item) => `${item.skill} → ${item.trainings.join(', ')}`),
              )}`
            : null,
          remedies.some((item) => !item.trainings.length)
            ? `No programme currently covers: ${remedies.filter((item) => !item.trainings.length).map((item) => item.skill).join(', ')}`
            : null,
          completed.length ? `${completed.length} training programme(s) already completed.` : null,
          'A skill the employee has but never recorded will show as a gap — confirm with them before acting on this.',
        ]),
        sources: [
          source('employee', employee.id, employee.fullName),
          source('dataset', target.id, `Designation: ${target.title}`),
          ...completed.slice(0, 3).map((item) => source('dataset', item.id, 'Completed training')),
        ],
        confidence: confidenceFrom({ evidence: target.requiredSkills.length + owned.length, max: 0.7 }),
        limitation:
          'Exact name matching on recorded skills. Equivalent skills under different names will not match, and nothing here measures how well a skill is held.',
        data: { coverage, matched, missing, experienceGap, remedies, targetDesignationId: target.id },
      };
    },
  },

  {
    id: 'training-recommendation',
    module: 'training',
    label: 'Training Recommendation',
    purpose: 'Suggests training from role, skills and performance',
    input: { employeeId: 'string (required)', limit: 'number — how many to suggest, default 5' },
    prompt: (input) => `Recommend training for employee ${input.employeeId}`,

    run({ input, db }) {
      const { employee, designation, department, trainings, trainedSkills, enrollments } = employeeContext(db, input.employeeId);
      const limit = Number(input.limit || 5);

      const owned = [...new Set([...(employee.skills || []), ...trainedSkills])];
      const { missing } = matchSkills(designation ? designation.requiredSkills : [], owned);

      const review = db
        .get('performanceReviews')
        .filter((item) => item.employeeId === employee.id && item.rating !== null)
        .sort((a, b) => String(b.ratedAt).localeCompare(String(a.ratedAt)))[0];

      const takenIds = new Set(enrollments.map((item) => item.trainingId));

      const scored = trainings
        .filter((training) => !takenIds.has(training.id))
        .filter((training) => training.status !== 'completed' || training.mode === 'online')
        .map((training) => {
          let score = 0;
          const reasons = [];

          const closes = training.skillsCovered.filter((skill) =>
            missing.some((gap) => gap.toLowerCase() === skill.toLowerCase()),
          );
          if (closes.length) {
            score += closes.length * 40;
            reasons.push(`closes ${closes.join(', ')}`);
          }
          if (department && training.departmentIds.includes(department.id)) {
            score += 20;
            reasons.push('targeted at this department');
          }
          if (training.mandatory) {
            score += 35;
            reasons.push('mandatory for all employees');
          }
          if (review && review.rating <= 3 && training.skillsCovered.some((skill) => ['Communication', 'Time management', 'People Management', 'Coaching', 'Mentoring'].includes(skill))) {
            score += 15;
            reasons.push('supports the development areas in the last review');
          }
          if (designation && ['lead', 'executive'].includes(designation.level) && /manager|leadership/i.test(training.title)) {
            score += 15;
            reasons.push('suited to a leadership role');
          }
          if (training.status === 'scheduled') {
            score += 10;
            reasons.push(`next run starts ${training.startDate}`);
          }

          return { training, score, reasons };
        })
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      const path = scored.map((item, index) => `${index + 1}. ${item.training.title} (${item.training.durationHours}h, ${item.training.mode}${item.training.cost ? `, ${money(item.training.cost)}` : ', no cost'})`);

      return {
        output: compose([
          `Training recommendations — ${employee.fullName}${designation ? `, ${designation.title}` : ''}`,
          missing.length ? `Open skill gaps: ${missing.join(', ')}.` : 'No open skill gaps against the current role.',
          review ? `Last recorded rating: ${review.rating}/5.` : 'No rated review on record.',
          scored.length
            ? `Suggested order\n${path.join('\n')}`
            : 'No unenrolled programme matches this profile. Consider adding one that covers the open gaps.',
          scored.length
            ? `Why\n${bullets(scored.map((item) => `${item.training.title} — ${item.reasons.join('; ')}`))}`
            : null,
          scored.length
            ? `Total cost if all are taken: ${money(scored.reduce((sum, item) => sum + item.training.cost, 0))}, ${scored.reduce((sum, item) => sum + item.training.durationHours, 0)} hours.`
            : null,
          'Discuss with the employee and their manager before assigning — this ranking does not know their current workload or interests.',
        ]),
        sources: [
          source('employee', employee.id, employee.fullName),
          designation ? source('dataset', designation.id, `Designation: ${designation.title}`) : null,
          review ? source('dataset', review.id, 'Latest performance review') : null,
          ...scored.slice(0, 3).map((item) => source('dataset', item.training.id, `Training: ${item.training.title}`)),
        ].filter(Boolean),
        confidence: confidenceFrom({ evidence: scored.length * 2 + missing.length, max: 0.68 }),
        limitation:
          'Ranked by keyword overlap and simple rules, with no knowledge of workload, budget approval or the employee\'s own goals.',
        data: {
          missing,
          recommendations: scored.map((item) => ({ trainingId: item.training.id, title: item.training.title, score: item.score, reasons: item.reasons })),
        },
      };
    },
  },
];
