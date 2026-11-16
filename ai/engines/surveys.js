/**
 * Survey and exit-interview analysis (requirements §5.14).
 *
 * Sentiment comes from a word lexicon and themes from keyword clusters — neither is stored on
 * the responses, so this is real derivation rather than a lookup. Both results end with an
 * action-plan draft that HR owns.
 */

const { average, bullets, compose, confidenceFrom, percent, round, sentimentOf, source, table, tally, themesOf } = require('../helpers');

/** Free-text answers from a set of responses, with their question. */
function comments(survey, responses) {
  const textQuestions = new Set(survey.questions.filter((question) => question.type === 'text').map((question) => question.id));
  const collected = [];

  for (const response of responses) {
    for (const answer of response.answers) {
      if (!textQuestions.has(answer.questionId)) continue;
      const value = String(answer.value || '').trim();
      if (value.length < 3) continue;
      collected.push({ text: value, response });
    }
  }

  return collected;
}

function ratingSummary(survey, responses) {
  return survey.questions
    .filter((question) => question.type === 'rating')
    .map((question) => {
      const values = responses
        .map((response) => response.answers.find((answer) => answer.questionId === question.id))
        .filter((answer) => answer && typeof answer.value === 'number')
        .map((answer) => answer.value);
      return { question: question.text, average: round(average(values), 2), count: values.length, scale: question.scale || 5 };
    });
}

module.exports = [
  {
    id: 'analyze-survey-feedback',
    module: 'surveys',
    label: 'Analyze Survey Feedback',
    purpose: 'Finds themes, sentiment and urgent issues in feedback',
    input: { surveyId: 'string (required)', departmentId: 'string — limit to one department (optional)' },
    prompt: (input) => `Analyse the responses to survey ${input.surveyId}`,

    run({ input, db }) {
      const survey = db.byId('surveys', input.surveyId);
      if (!survey) throw Object.assign(new Error('surveyId is required and must exist'), { status: 400 });

      let responses = db.get('surveyResponses').filter((response) => response.surveyId === survey.id);
      if (input.departmentId) responses = responses.filter((response) => response.departmentId === input.departmentId);
      if (!responses.length) {
        throw Object.assign(new Error('This survey has no responses to analyse'), { status: 404 });
      }

      const texts = comments(survey, responses);
      const ratings = ratingSummary(survey, responses);

      const sentiments = texts.map((item) => ({ ...item, sentiment: sentimentOf(item.text) }));
      const positive = sentiments.filter((item) => item.sentiment.label === 'positive').length;
      const negative = sentiments.filter((item) => item.sentiment.label === 'negative').length;
      const neutral = sentiments.length - positive - negative;

      // Theme counts, and how negative each theme runs.
      const themeHits = [];
      for (const item of sentiments) {
        for (const theme of themesOf(item.text)) themeHits.push({ theme, sentiment: item.sentiment.label });
      }
      const themeCounts = tally(themeHits.map((hit) => hit.theme));
      const themeDetail = themeCounts.map((entry) => {
        const hits = themeHits.filter((hit) => hit.theme === entry.key);
        const negativeShare = percent(hits.filter((hit) => hit.sentiment === 'negative').length, hits.length);
        return { theme: entry.key, count: entry.count, share: percent(entry.count, texts.length || 1), negativeShare };
      });

      // Urgent = mentioned repeatedly and mostly negative.
      const urgent = themeDetail.filter((item) => item.count >= 3 && item.negativeShare >= 60);

      const choiceQuestions = survey.questions.filter((question) => question.type === 'single-choice');
      const choiceSummary = choiceQuestions.map((question) => ({
        question: question.text,
        counts: tally(
          responses
            .map((response) => response.answers.find((answer) => answer.questionId === question.id))
            .filter(Boolean)
            .map((answer) => String(answer.value)),
        ),
      }));

      const lowestRating = [...ratings].sort((a, b) => a.average - b.average)[0];

      const actionPlan = urgent.length
        ? urgent.map((item, index) => `${index + 1}. ${item.theme}: raised in ${item.count} comment(s), ${item.negativeShare}% negative. Agree an owner and a first action within two weeks, then report back to the respondents.`)
        : ['1. No theme crossed the urgency threshold. Share the results and keep the current actions running.'];

      return {
        output: compose([
          `${survey.title} — ${responses.length} response(s)${input.departmentId ? ' (filtered by department)' : ''}, ${texts.length} written comment(s).`,
          `Sentiment\n${table([
            { label: 'Positive', value: `${positive} (${percent(positive, texts.length || 1)}%)` },
            { label: 'Neutral', value: `${neutral} (${percent(neutral, texts.length || 1)}%)` },
            { label: 'Negative', value: `${negative} (${percent(negative, texts.length || 1)}%)` },
          ])}`,
          ratings.length
            ? `Rating questions\n${table(ratings.map((item) => ({ label: item.question, value: `${item.average}/${item.scale} (n=${item.count})` })))}`
            : null,
          themeDetail.length
            ? `Themes\n${table(themeDetail.slice(0, 8).map((item) => ({ label: item.theme, value: `${item.count} mention(s), ${item.share}% of comments, ${item.negativeShare}% negative` })))}`
            : 'No recognised themes in the written comments.',
          choiceSummary.length
            ? choiceSummary
                .map((item) => `${item.question}\n${table(item.counts.map((entry) => ({ label: entry.key, value: `${entry.count} (${percent(entry.count, responses.length)}%)` })))}`)
                .join('\n\n')
            : null,
          urgent.length
            ? `Urgent\n${bullets(urgent.map((item) => `${item.theme} — ${item.count} mentions, ${item.negativeShare}% negative`))}`
            : null,
          lowestRating ? `Lowest-scoring question: "${lowestRating.question}" at ${lowestRating.average}/${lowestRating.scale}.` : null,
          `Action plan draft\n${actionPlan.join('\n')}`,
          'Review and edit before anything is published. Lexicon sentiment misreads sarcasm and negation, and anonymous responses cannot be followed up individually.',
        ]),
        sources: [
          source('dataset', survey.id, `Survey: ${survey.title}`),
          source('dataset', 'surveyResponses', `${responses.length} responses`),
        ],
        confidence: confidenceFrom({ evidence: texts.length, max: 0.68 }),
        limitation:
          'Word-list sentiment and keyword themes. Short comments, sarcasm and negation are read wrongly, and themes outside the keyword list are missed entirely.',
        data: {
          responseCount: responses.length,
          commentCount: texts.length,
          sentiment: { positive, neutral, negative },
          themes: themeDetail,
          ratings,
          urgent,
        },
      };
    },
  },

  {
    id: 'analyze-exit-interview',
    module: 'surveys',
    label: 'Analyze Exit Interview',
    purpose: 'Groups exit reasons and attrition patterns',
    input: { surveyId: 'string — the exit survey (optional)', months: 'number — window, default 12' },
    prompt: (input) => `Analyse exit interviews over the last ${input.months || 12} months`,

    run({ input, db, now }) {
      const months = Number(input.months || 12);
      const cutoff = new Date(now.getTime() - months * 30.4 * 86400000).toISOString().slice(0, 10);

      const leavers = db
        .get('employees')
        .filter((employee) => employee.exit && employee.exit.lastWorkingDate >= cutoff);

      const survey = input.surveyId
        ? db.byId('surveys', input.surveyId)
        : db.get('surveys').find((item) => item.type === 'exit');
      const responses = survey
        ? db.get('surveyResponses').filter((response) => response.surveyId === survey.id)
        : [];

      if (!leavers.length && !responses.length) {
        throw Object.assign(new Error('No exits or exit-interview responses in this window'), { status: 404 });
      }

      const reasonCounts = tally(leavers.map((employee) => employee.exit.reason));
      const byDepartment = tally(
        leavers.map((employee) => {
          const department = db.byId('departments', employee.departmentId);
          return department ? department.name : employee.departmentId;
        }),
      );

      const tenureBuckets = tally(
        leavers.map((employee) => {
          const monthsServed = Math.round(
            (new Date(`${employee.exit.lastWorkingDate}T00:00:00Z`) - new Date(`${employee.joiningDate}T00:00:00Z`)) / 2628000000,
          );
          if (monthsServed <= 6) return '0–6 months';
          if (monthsServed <= 12) return '7–12 months';
          if (monthsServed <= 24) return '1–2 years';
          return 'over 2 years';
        }),
      );

      const texts = survey ? comments(survey, responses) : [];
      const themeCounts = tally(texts.flatMap((item) => themesOf(item.text)));
      const negative = texts.filter((item) => sentimentOf(item.text).label === 'negative').length;

      const headcount = db.get('employees').filter((employee) => employee.status === 'active').length;
      const attritionRate = percent(leavers.length, headcount + leavers.length);

      const earlyExits = tenureBuckets.find((bucket) => bucket.key === '0–6 months');
      const patterns = [
        reasonCounts[0] ? `"${reasonCounts[0].key}" is the most common recorded reason (${reasonCounts[0].count} of ${leavers.length}).` : null,
        byDepartment[0] && byDepartment[0].count >= 3 ? `${byDepartment[0].name || byDepartment[0].key} accounts for ${byDepartment[0].count} of the exits — worth a closer look.` : null,
        earlyExits && earlyExits.count >= 2 ? `${earlyExits.count} people left within six months, which points at hiring fit or onboarding rather than long-term engagement.` : null,
        themeCounts[0] ? `The written comments cluster on ${themeCounts.slice(0, 3).map((item) => item.key).join(', ')}.` : null,
      ].filter(Boolean);

      return {
        output: compose([
          `Exit analysis — ${leavers.length} exit(s) in the last ${months} months, attrition rate ${attritionRate}%.`,
          reasonCounts.length ? `Reasons\n${table(reasonCounts.map((item) => ({ label: item.key, value: `${item.count} (${percent(item.count, leavers.length)}%)` })))}` : null,
          byDepartment.length ? `By department\n${table(byDepartment.map((item) => ({ label: item.key, value: item.count })))}` : null,
          tenureBuckets.length ? `By tenure at exit\n${table(tenureBuckets.map((item) => ({ label: item.key, value: item.count })))}` : null,
          texts.length
            ? `Exit-interview comments: ${texts.length}, of which ${negative} read as negative. Themes: ${themeCounts.slice(0, 5).map((item) => `${item.key} (${item.count})`).join(', ') || 'none recognised'}.`
            : 'No exit-interview comments are recorded for this window.',
          patterns.length ? `Patterns\n${bullets(patterns)}` : null,
          'Action plan draft\n1. Review the top reason with the departments most affected.\n2. If early exits dominate, check hiring expectations and the onboarding plan.\n3. Report back on what will change, then re-measure next quarter.',
          'Recorded exit reasons are what people were willing to write down, which is rarely the whole story.',
        ]),
        sources: [
          source('dataset', 'employees', `${leavers.length} exited employees`),
          survey ? source('dataset', survey.id, `Survey: ${survey.title}`) : null,
        ].filter(Boolean),
        confidence: confidenceFrom({ evidence: leavers.length + texts.length, max: 0.7 }),
        limitation:
          'Small numbers make percentages unstable, and exit reasons are self-reported on the way out.',
        data: { months, exitCount: leavers.length, attritionRate, reasonCounts, byDepartment, tenureBuckets, themeCounts },
      };
    },
  },
];
