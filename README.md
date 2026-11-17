# HRM Dashboard — mock API

json-server backend for [`HRM-dashboard-admin`](../HRM-dashboard-admin).

```bash
npm install
npm run seed       # generate demo data into db.json
npm start          # http://localhost:8080  (PORT=... to change)
```

`db.json` is generated and not in git. `npm start` creates an empty one with just the demo
login if it is missing, so seeding first is what gives you data to work with.

The dashboard reads the URL from `VITE_API_URL` in its `.env`.

Demo HR login: `admin@hrm.dev` / `admin123`.

## Routes

- REST collections from `db.json`: `/employees`, `/departments`, `/designations`, `/locations`,
  `/attendance`, `/leaveTypes`, `/leaveRequests`, `/leaveBalances`, `/holidays`,
  `/salaryStructures`, `/payrollRuns`, `/payslips`, `/jobs`, `/candidates`, `/interviews`,
  `/onboarding`, `/onboardingTasks`, `/performanceCycles`, `/performanceReviews`, `/goals`,
  `/trainings`, `/trainingEnrollments`, `/documents`, `/announcements`, `/surveys`,
  `/surveyResponses`, `/notifications`, `/auditLogs`, `/aiRuns`, `/attendanceFlags` (HR's confirm /
  dismiss decisions on AI attendance flags, keyed by the flag), plus the `/settings` object.
  Missing collections are created on start-up (json-server 404s otherwise).
- Mock auth (`auth.js`): `POST /auth/login`, `/auth/logout`, `/auth/forgot-password`,
  `/auth/reset-password`, `/auth/verify-otp`, and `GET /auth/me`. Login and failed login are
  written to `/auditLogs`. `verify-otp` accepts any 6-digit code except `000000`.

- Leave decisions (`leave.js`, rules in `leave-decision.js`): `POST /leave/requests/:id/decision`
  with `{ decision: "approve" | "reject" | "cancel", remarks? }`. One call changes the request,
  the person's balance and the attendance days together, or none of them: approve moves the days
  from `pending` to `used` and marks each working day of the request as leave in `/attendance`
  (remembering what each day was); reject releases the pending days; cancel gives the days back
  and, for an approved request, puts the attendance days back as they were. Reject and cancel
  need `remarks`. Answers `409` for a request that is not in a state the decision applies to.
  The request, balance and attendance changes are audited with old and new values
  (`leave.approve`, `leave.reject`, `leave.cancel`, `attendance.leave-sync`). `npm run test:leave`.

- Uploads (`uploads.js`): `POST /uploads` (multipart, field `file`, optional `category`,
  `employeeId`, `title`), `GET /uploads` to list, `GET /uploads/:name` to download and
  `DELETE /uploads/:name`. Files are stored in `uploads/` under a generated name (random id
  plus an extension derived from the detected MIME type), so an uploaded file name can never
  escape the folder; the original name comes back in the response. PDF, PNG, JPEG, WebP, GIF,
  CSV, TXT, DOC, DOCX, XLS and XLSX are accepted, up to 20 MB (`UPLOAD_MAX_BYTES`,
  `UPLOAD_DIR`). Uploads are written to the audit log.

json-server query syntax works as usual: `?_page=1&_limit=20`, `?department=eng`, `?q=search`,
`?_sort=createdAt&_order=desc`, `?_expand=`/`?_embed=`.

## Mock AI gateway

22 rule-based engines stand in for a model (`ai/engines/`), computing over the data already in
`db.json`. They exist so the dashboard can build and test the whole review flow — sources,
confidence, edit, approve, reject, regenerate, audit — before any model is wired in.

**The assistant is a chat box, not a menu of tools.** HR types one question; `ai/router.js`
works out which engine answers it, pulls the entities out of the sentence (a name, a month, a
record id, a date range) and runs it. The specialist engines stay addressable at `/ai/run` so
module screens can call one directly in context — "check conflicts" on a leave request, for
example — but nobody has to pick a category to ask a question.

```
POST /ai/chat                  { message, conversationId?, text? } → reply + routing + run
GET  /ai/tools                 the catalogue, with each tool's enabled state
POST /ai/run                   { toolId, input, entityType?, entityId? } → a draft run
POST /ai/runs/:id/regenerate   re-runs the same tool and input as a new draft
POST /ai/runs/:id/review       { action: approve | reject | edit, editedOutput?, note? }
GET  /aiConversations          chat threads, with every message and its run
GET  /aiRuns                   the usage log (plain json-server collection)
```

A chat answer is an ordinary run: it carries the same sources, confidence, limitation and
`status: "draft"`, and can be edited, approved, rejected or regenerated like any other.

**Leave AI** (`ai/engines/leave.js`, rules in `ai/leave-model.js`, which mirrors how the dashboard
charges leave: leave year, accrual, sandwich rule, holidays by location). Three tools, all pure reads:
`leave-conflict-check` (balance incl. accrual and adjustments, notice from the day the request was
received, length, documents, the person's own overlaps, team cover judged on the worst day,
attendance already recorded), `leave-decision-email` (an approval, rejection or cancellation draft
for HR to edit and send) and `leave-trend-explainer` (this period against the one before). Leave
policy questions go to `ask-hr-policy`. None of them approves or rejects anything: that is
`POST /leave/requests/:id/decision`, called by HR from the dashboard. `npm run test:leave-ai`.

Conversations remember the subject, so a follow-up works: "tell me about Stan Marquardt" then
"what is his skill gap?" runs the skill-gap engine for Stan. Naming someone else replaces the
subject, and carried context is not passed to tools that were not asked about a person — "are
there duplicate records?" checks all 100, not the one in the previous question.

Questions that fit no specialist engine go to `hr-data-query`, which answers the everyday
ones from the collections: headcount, who is on leave today, who was late, new joiners, what
needs approval, probation endings, birthdays, open jobs, payroll totals, department
breakdowns, training completion, top performers, and a full profile lookup by name (salary
only when explicitly asked, and the view is audit-logged). If it still cannot tell what is
being asked, it says so and lists what it can do, rather than guessing.

```bash
node ai/router-test.js                # 33 routing cases + entity and context checks
```

A run always comes back with `output`, at least one `sources` entry, a `confidence` between 0
and 1, a `limitation` note and `status: "draft"`. The gateway refuses to return a result with
no source, so an unreviewable answer can never reach the UI.

Rules enforced by the gateway, not by each engine:

- Engines only read. Nothing in `ai/` writes to a collection, so no AI result can change an
  employee, a leave decision, a payroll run or a rating.
- Reviewing requires a signed-in user; generation, edit, approval, rejection and regeneration
  are each written to the audit log with the old and new status.
- Confidential documents are hidden from every engine unless `settings.ai.allowConfidentialDocuments`
  is true.
- `settings.ai.enabled` and `settings.ai.features.<camelCaseToolId>` gate each tool (403 when off),
  and `settings.ai.logPrompts: false` stores the run without its prompt and input.

```bash
npm run test:ai                       # runs every engine once against db.json
npm run test:attendance                # attendance AI: flags, calendar, trends, data check
node ai/smoke.js --print ask-hr-policy   # and prints that engine's full output
```

Swapping in a real model is a change inside each engine's `run()`. The route contract, the
review flow and the audit trail stay as they are.

## Audit log

`audit.js` records every successful create, update and delete on a tracked collection in
`/auditLogs`, with the changed fields only (`oldValue` / `newValue`), the acting user taken
from the `Authorization` header, plus IP and user agent. Passwords and tokens are never
copied into an entry, and an update that changed nothing is not logged.

Status changes get their own action name instead of a plain update: `leave.approve`,
`leave.reject`, `leave.cancel`, `payroll.finalize`, `payroll.validate`, `recruitment.select`,
`recruitment.reject`, `recruitment.join`, `ai.approve`, `ai.reject`.

The dashboard only has to log what the server cannot infer — report exports, document
downloads, AI prompts — by posting to `/auditLogs` itself.

Entries are appended in memory and flushed to disk shortly after, so a burst of mutations
costs one file rewrite instead of several.

## Simulating slow and failing requests

```bash
curl "localhost:8080/employees?_delay=1500"   # answer after 1.5s (max 10s)
curl "localhost:8080/employees?_fail=401"     # answer 401 instead of the real response
SIM_DELAY=300 npm start                       # add 300ms to every response
SIM_FAIL_RATE=0.1 npm start                   # fail 10% of requests at random
```

`_delay` and `_fail` are stripped before json-server sees them, so they never act as filters.

## Seed data

`npm run seed` fills every collection with a linked demo data set: 100 employees across 8
departments, 12 months of attendance, leave, payroll and audit history, plus recruitment,
onboarding, performance, training, documents, announcements, surveys and sample AI runs.

```bash
npm run seed                           # 100 employees, 12 months (~13 MB db.json)
EMPLOYEES=25 MONTHS=3 npm run seed     # smaller, faster set
SEED_TODAY=2026-11-16 npm run seed     # pin "today" for a byte-identical run
FLAWS=off npm run seed                 # skip the deliberate data flaws
DB_FILE=./try.json npm run seed        # write somewhere else

npm run validate                       # foreign keys + business-rule checks
```

The generator is seeded (`SEED=…`), so the same inputs always produce the same data. The
existing database is copied to `db.backup.json` before it is replaced.

Deliberate imperfections are part of the data, because the AI and validation features need
something to find: missing attendance days, late and absence patterns on specific employees,
expired and soon-to-expire documents, overdue onboarding tasks, payroll warnings on the draft
run, and survey comments clustered around real themes. Sentiment and themes are **not** stored
on survey responses — the analysis engines have to derive them.

`seed/flaws.js` additionally damages nine employee records on purpose (a cleared phone number,
a duplicate email, a shared phone, an impossible date of birth, probation ending before
joining, an active employee carrying exit data, a designation from another department, a
missing salary structure, a malformed email). Their ids are listed in
`settings.seed.flawedEmployeeIds` so `npm run validate` can tell them from real breakage.

Dates are generated relative to the current date, so re-seed occasionally to keep "today"
widgets meaningful.

**Size note.** json-server rewrites the whole file on every write, so at 12 months of history a
POST or PATCH takes roughly 0.6–0.8 s. `MONTHS=6` roughly halves the file and that latency.

## Local development only

Passwords are stored in plain text in `db.json` and the token is an unsigned base64 payload —
there is no real authentication here. Do not deploy this server or point it at real HR data.
`DB_FILE=./copy.json npm start` runs against a copy.
