/**
 * Employee search for the mock API.
 *
 * json-server's `?q=` matches text stored on a row, and an employee row stores a department
 * *id*, not its name — so "engineering" finds nobody, although requirements §5.3 ask for search
 * by department and designation. A real backend joins; this does the same:
 *
 *   GET /employees?q=senior engineer           names of the designation, department, team,
 *                                              location, skills, phone (any format), email...
 *
 * The match is turned into a list of employee ids and handed back to json-server as
 * `?id=a&id=b`, which it ORs. Everything else — filters, sorting, `_page`/`_limit` and the
 * `X-Total-Count` header — then works on the matched rows with no code here.
 *
 * Every word of the query must match somewhere ("john eng" finds a John in Engineering).
 * Fields with a fixed vocabulary (status, type, work mode, gender) match whole words only, or
 * "active" would also find everyone who is "inactive" and "male" everyone who is "female".
 *
 * Local development only.
 */

const MATCHABLE_WORD = /[^\s,]+/g;
const PHONE_LIKE = /^[\d\s()+.\-]+$/;

const digitsOf = (value) => String(value || '').replace(/\D/g, '');

function lookup(rows) {
  return new Map((rows || []).map((row) => [row.id, row]));
}

/**
 * Builds a matcher over the current database state.
 * Pure — takes the state, returns `ids(query)` — so it can be tested without a server.
 */
function buildEmployeeSearch(state) {
  const departments = lookup(state.departments);
  const designations = lookup(state.designations);
  const locations = lookup(state.locations);

  const index = (state.employees || []).map((employee) => {
    const department = departments.get(employee.departmentId);
    const team = departments.get(employee.teamId);
    const designation = designations.get(employee.designationId);
    const location = locations.get(employee.locationId);

    const text = [
      employee.fullName,
      employee.employeeId,
      employee.officialEmail,
      employee.personalEmail,
      employee.phone,
      department && department.name,
      team && team.name,
      designation && designation.title,
      location && location.name,
      location && location.city,
      ...(employee.skills || []),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    return {
      id: employee.id,
      text,
      // Matched as whole words so "active" does not find "inactive".
      words: new Set(
        [employee.status, employee.employmentType, employee.workMode, employee.gender]
          .filter(Boolean)
          .map((value) => String(value).toLowerCase()),
      ),
      phoneDigits: digitsOf(employee.phone),
    };
  });

  return function ids(query) {
    const tokens = String(query || '')
      .toLowerCase()
      .match(MATCHABLE_WORD);
    if (!tokens || tokens.length === 0) return null;

    return index
      .filter((entry) =>
        tokens.every((token) => {
          if (entry.words.has(token) || entry.text.includes(token)) return true;
          // "897-4563" or "(208) 897" against a phone stored in another format.
          return PHONE_LIKE.test(token) && digitsOf(token).length >= 3 && entry.phoneDigits.includes(digitsOf(token));
        }),
      )
      .map((entry) => entry.id);
  };
}

/** Rewrites `GET /employees?q=…` into an id filter; passes everything else through. */
function createSearchMiddleware(router) {
  return (req, res, next) => {
    if (req.method !== 'GET' || req.path !== '/employees') return next();

    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!query) return next();

    const matched = buildEmployeeSearch(router.db.getState())(query);
    if (matched === null) return next();

    delete req.query.q;
    // json-server ORs repeated keys; an empty match must still filter to nothing, not to all.
    req.query.id = matched.length > 0 ? matched : ['__no-match__'];
    return next();
  };
}

module.exports = { buildEmployeeSearch, createSearchMiddleware };
