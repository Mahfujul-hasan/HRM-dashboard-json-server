/**
 * Brings the minutes on existing attendance records in line with the rules in settings.
 *
 *   node seed/align-attendance.js            rewrites db.json
 *   DB_FILE=./copy.json node seed/align-attendance.js
 *
 * Late, early-leave, worked and overtime minutes are derived from the punches, so they can be
 * recomputed without losing anything. Used when the rules changed (or the generator did) and a
 * database was seeded under the old ones; a fresh `npm run seed` needs nothing. Stop the server
 * first, or let its file watcher reload the result. Safe to run twice.
 */

const fs = require('fs');
const path = require('path');
const { deriveMinutes, deriveStatus, hasPunches } = require('./attendance-rules');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'db.json');
/** Statuses the clock decides; the rest (leave, remote, on duty) are stated, not derived. */
const DERIVED = new Set(['present', 'late', 'half-day', 'absent']);

const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
let changed = 0;

for (const record of db.attendance) {
  if (!hasPunches(record)) continue;
  const derived = deriveMinutes(record, db.settings);
  const status = DERIVED.has(record.status) ? deriveStatus(derived, db.settings) : record.status;

  const next = { ...derived, status };
  if (Object.keys(next).some((key) => record[key] !== next[key])) {
    Object.assign(record, next);
    changed += 1;
  }
}

if (changed) fs.writeFileSync(DB_FILE, `${JSON.stringify(db, null, 2)}\n`);
console.log(`${changed} attendance record(s) updated${changed ? '' : ' — already in line'}.`);
