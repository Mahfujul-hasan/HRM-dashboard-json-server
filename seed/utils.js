/** Shared helpers for the seed modules: ids, dates, times and random picks. */

const { faker } = require('@faker-js/faker');

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** `pad(7, 3)` → `"007"`. */
function pad(value, width = 3) {
  return String(value).padStart(width, '0');
}

/** `id('emp', 7)` → `"emp_007"`. */
function id(prefix, index, width = 3) {
  return `${prefix}_${pad(index, width)}`;
}

/** A Date as `YYYY-MM-DD` (UTC), the format used by every date-only field. */
function ymd(date) {
  return new Date(date).toISOString().slice(0, 10);
}

/** A Date as a full ISO timestamp, the format used by every `*At` field. */
function iso(date) {
  return new Date(date).toISOString();
}

function addDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function addMonths(date, months) {
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}

function startOfMonth(date) {
  const next = new Date(date);
  next.setUTCDate(1);
  next.setUTCHours(0, 0, 0, 0);
  return next;
}

function endOfMonth(date) {
  const next = startOfMonth(date);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return addDays(next, -1);
}

/** `"2026-11"` — the key payroll runs and payslips are grouped by. */
function monthKey(date) {
  return new Date(date).toISOString().slice(0, 7);
}

/** Every date from `from` to `to`, inclusive. */
function eachDate(from, to) {
  const dates = [];
  for (let cursor = new Date(from); cursor <= to; cursor = addDays(cursor, 1)) {
    dates.push(new Date(cursor));
  }
  return dates;
}

function dayName(date) {
  return DAY_NAMES[new Date(date).getUTCDay()];
}

function isWorkingDay(date, workingDays) {
  return workingDays.includes(dayName(date));
}

/** Whole days between two dates, inclusive of both ends. */
function daysBetween(from, to) {
  return Math.round((new Date(to) - new Date(from)) / 86400000) + 1;
}

/** `"09:00"` → minutes since midnight. */
function toMinutes(time) {
  const [hours, minutes] = String(time).split(':').map(Number);
  return hours * 60 + minutes;
}

/** Minutes since midnight → `"09:05"`. */
function toTime(minutes) {
  const clamped = Math.max(0, Math.min(24 * 60 - 1, Math.round(minutes)));
  return `${pad(Math.floor(clamped / 60), 2)}:${pad(clamped % 60, 2)}`;
}

/** `chance(0.25)` is true a quarter of the time. */
function chance(probability) {
  return faker.number.float({ min: 0, max: 1 }) < probability;
}

function pick(items) {
  return faker.helpers.arrayElement(items);
}

function picks(items, count) {
  return faker.helpers.arrayElements(items, count);
}

/** `weighted([{ weight: 8, value: 'present' }, …])`. */
function weighted(options) {
  return faker.helpers.weightedArrayElement(options);
}

function intBetween(min, max) {
  return faker.number.int({ min, max });
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

/** Rounds to whole dollars — every money field in the seed is an integer. */
function money(value) {
  return Math.round(value);
}

/** A stable slug for codes and emails. */
function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

module.exports = {
  DAY_NAMES,
  addDays,
  addMonths,
  chance,
  dayName,
  daysBetween,
  eachDate,
  endOfMonth,
  id,
  intBetween,
  isWorkingDay,
  iso,
  money,
  monthKey,
  pad,
  pick,
  picks,
  round2,
  slug,
  startOfMonth,
  toMinutes,
  toTime,
  weighted,
  ymd,
};
