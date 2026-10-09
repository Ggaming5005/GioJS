/**
 * The app's SQLite database, through Drizzle ORM - server-only (the
 * `.server` name keeps it out of client bundles), for getServerSideProps,
 * actions and route handlers.
 *
 * The driver is Node's built-in node:sqlite: nothing to compile or
 * download, and it bundles into `gio build standalone` output. Drizzle
 * talks to it through its sqlite-proxy driver. The file is data/app.db
 * (git-ignored; DATABASE_PATH overrides it), and pending migrations from
 * drizzle/ are applied when it is first opened.
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { desc } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import { migrate } from './migrate.server';
import * as schema from './schema';

const path = resolve(process.env.DATABASE_PATH ?? 'data/app.db');
mkdirSync(dirname(path), { recursive: true });
// timeout: wait up to 5 s for a lock another worker holds instead of failing.
const sqlite = new DatabaseSync(path, { timeout: 5000 });
sqlite.exec('PRAGMA journal_mode = WAL');
migrate(sqlite);

// One connection per worker. db.transaction() works, but while its callback
// awaits, other requests' queries run on this same connection - inside the
// transaction - so keep transactions short and free of unrelated awaits.
export const db = drizzle(
  async (query, params, method) => {
    const statement = sqlite.prepare(query);
    // Drizzle maps rows from arrays (column names can repeat in a join).
    statement.setReturnArrays(true);
    if (method === 'run') {
      statement.run(...params);
      return { rows: [] };
    }
    // `get` answers with the row itself (or undefined), not a list of rows.
    if (method === 'get') return { rows: /** @type {any} */ (statement.get(...params)) };
    return { rows: statement.all(...params) };
  },
  { schema },
);

/** @typedef {{ id: number, title: string, createdAt: string }} NoteItem */

/** @returns {Promise<NoteItem[]>} */
export async function listNotes() {
  const rows = await db.select().from(schema.notes).orderBy(desc(schema.notes.id)).limit(50);
  // ISO strings: page props travel to the browser as JSON.
  return rows.map((note) => ({ id: note.id, title: note.title, createdAt: note.createdAt.toISOString() }));
}

/** @param {string} title */
export async function createNote(title) {
  await db.insert(schema.notes).values({ title });
}
