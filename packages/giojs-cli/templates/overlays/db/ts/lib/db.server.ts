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
    if (method === 'get') return { rows: statement.get(...params) as unknown as unknown[] };
    return { rows: statement.all(...params) };
  },
  { schema },
);

export interface NoteItem {
  id: number;
  title: string;
  /** ISO 8601: page props travel to the browser as JSON. */
  createdAt: string;
}

export async function listNotes(): Promise<NoteItem[]> {
  const rows = await db.select().from(schema.notes).orderBy(desc(schema.notes.id)).limit(50);
  return rows.map(note => ({ id: note.id, title: note.title, createdAt: note.createdAt.toISOString() }));
}

export async function createNote(title: string): Promise<void> {
  await db.insert(schema.notes).values({ title });
}
