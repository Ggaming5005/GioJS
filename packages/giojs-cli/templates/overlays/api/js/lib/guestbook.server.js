/**
 * The guestbook's data and validation, shared by the JSON API
 * (app/api/guestbook/route.js) and the form page (app/guestbook/page.jsx).
 *
 * Entries live in memory: they reset when the server restarts, and with
 * `[server] workers = N` in gio.toml each worker keeps its own list. Keep
 * real data in a database (`npx create-giojs add db` sets one up).
 */

/** @typedef {{ id: number, name: string, message: string, createdAt: string }} Entry */
/** @typedef {{ name: string, message: string }} EntryInput */
/** @typedef {{ name?: string, message?: string }} EntryErrors */

const MAX_NAME = 60;
const MAX_MESSAGE = 500;
/** Anyone can post: keep memory bounded by dropping the oldest entries. */
const MAX_ENTRIES = 100;

/** @type {Entry[]} */
const entries = [
  {
    id: 1,
    name: 'GioJS',
    message: 'Sign the guestbook with the form, or POST JSON to /api/guestbook.',
    createdAt: new Date().toISOString(),
  },
];
let nextId = 2;

/** Newest first. @returns {Entry[]} */
export function listEntries() {
  return [...entries].reverse();
}

/** @param {unknown} value */
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Validate untrusted input: form fields or a parsed JSON body.
 * @param {unknown} input
 * @returns {{ ok: true, value: EntryInput } | { ok: false, errors: EntryErrors }}
 */
export function validateEntry(input) {
  const fields = typeof input === 'object' && input !== null ? /** @type {Record<string, unknown>} */ (input) : {};
  const name = text(fields['name']);
  const message = text(fields['message']);
  /** @type {EntryErrors} */
  const errors = {};
  if (name === '') errors.name = 'Enter your name.';
  else if (name.length > MAX_NAME) errors.name = `Keep your name under ${MAX_NAME} characters.`;
  if (message === '') errors.message = 'Write a message.';
  else if (message.length > MAX_MESSAGE) errors.message = `Keep it under ${MAX_MESSAGE} characters.`;
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, value: { name, message } };
}

/** @param {EntryInput} input @returns {Entry} */
export function addEntry(input) {
  const entry = { id: nextId++, ...input, createdAt: new Date().toISOString() };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  return entry;
}
