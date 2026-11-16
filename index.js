const fs = require("fs");
const path = require("path");
const jsonServer = require("json-server");
const { createAuthRoutes } = require("./auth");
const { createAuditMiddleware } = require("./audit");
const { createSimulation } = require("./simulate");
const { createUploadRoutes } = require("./uploads");
const { createAiRoutes } = require("./ai");

// DB_FILE env lets you run against a copy (e.g. to try changes without touching db.json).
const DB_FILE = process.env.DB_FILE || path.join(__dirname, "db.json");

/**
 * json-server 0.17 answers 404 for a collection missing from db.json (even for POST),
 * so every collection the dashboard talks to is created on start-up.
 */
const COLLECTIONS = [
  "users",
  "employees",
  "departments",
  "designations",
  "locations",
  "attendance",
  "leaveTypes",
  "leaveRequests",
  "leaveBalances",
  "holidays",
  "salaryStructures",
  "payrollRuns",
  "payslips",
  "jobs",
  "candidates",
  "interviews",
  "onboarding",
  "onboardingTasks",
  "performanceCycles",
  "performanceReviews",
  "goals",
  "trainings",
  "trainingEnrollments",
  "documents",
  "announcements",
  "surveys",
  "surveyResponses",
  "notifications",
  "auditLogs",
  "aiRuns",
  "aiConversations",
];

/**
 * Single-object resources (json-server serves these at `/settings`).
 * The default comes from the seed generator so a hand-made db.json gets the same shape
 * `npm run seed` produces.
 */
const SINGLETONS = {
  settings: require("./seed/system").buildSettings(),
};

/** The demo login, so a fresh database is usable before anything is seeded. */
const DEFAULT_USER = require("./seed/system").HR_USER;

function ensureShape() {
  // db.json is generated (and git-ignored), so a fresh clone starts with an empty one.
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: [DEFAULT_USER] }, null, 2) + "\n");
    console.log(`Created ${path.basename(DB_FILE)} — run "npm run seed" to fill it with demo data.`);
  }

  const db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  const added = [];

  if (!Array.isArray(db.users) || !db.users.length) db.users = [DEFAULT_USER];

  for (const name of COLLECTIONS) {
    if (!Array.isArray(db[name])) {
      db[name] = [];
      added.push(name);
    }
  }
  for (const [name, value] of Object.entries(SINGLETONS)) {
    if (db[name] === undefined) {
      db[name] = value;
      added.push(name);
    }
  }

  if (!added.length) return;
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2) + "\n");
  console.log(`Created collections: ${added.join(", ")}`);
}

ensureShape();

const server = jsonServer.create();
const router = jsonServer.router(DB_FILE);
const middlewares = jsonServer.defaults();

const port = process.env.PORT || 8080;

server.use(middlewares);
server.use(jsonServer.bodyParser);
// `?_delay=…` / `?_fail=…` and the SIM_* env vars, for testing loading and error states.
server.use(createSimulation());
// Identifies the caller and audits every create/update/delete on a tracked collection.
server.use(createAuditMiddleware(router));
// Mock auth (/auth/login, /auth/logout, /auth/forgot-password, /auth/reset-password,
// /auth/verify-otp, /auth/me) — local development only, see auth.js.
server.use(createAuthRoutes(router));
// /uploads — multipart upload, listing, download and delete.
server.use(createUploadRoutes(router));
// /ai/* — mock AI gateway: tool catalogue, runs, regenerate and review.
server.use(createAiRoutes(router));
server.use(router);

server.listen(port, "0.0.0.0", () => {
  console.log(`JSON Server running on port ${port}`);
  console.log(`Dashboard env: VITE_API_URL=http://localhost:${port}`);
});
