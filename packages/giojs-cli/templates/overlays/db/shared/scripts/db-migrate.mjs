// The db:migrate script: applies pending migrations from drizzle/ to the
// database without starting the server (CI, or a deploy step). The server
// applies them too, when it first opens the database.
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../lib/migrate.server.js';

const path = resolve(process.env.DATABASE_PATH ?? 'data/app.db');
mkdirSync(dirname(path), { recursive: true });
const sqlite = new DatabaseSync(path, { timeout: 5000 });
try {
  const applied = migrate(sqlite);
  console.log(applied === 0 ? `${path} is up to date` : `${path}: applied ${applied} migration(s)`);
} finally {
  sqlite.close();
}
