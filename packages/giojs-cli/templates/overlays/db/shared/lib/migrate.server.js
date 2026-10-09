/**
 * Applies the SQL migrations in drizzle/ (written by the db:generate script)
 * to a node:sqlite database, recording them in Drizzle's
 * __drizzle_migrations table. lib/db.server runs it when the database is
 * first opened, so a fresh checkout just works; scripts/db-migrate.mjs runs
 * it on its own (the db:migrate script - CI, or before starting a deploy).
 *
 * It runs in one IMMEDIATE transaction: several workers starting together
 * (gio.toml [server] workers) wait for each other instead of racing, and a
 * failing migration leaves the database as it was.
 */
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { join } from 'node:path';

export const MIGRATIONS_FOLDER = join(process.cwd(), 'drizzle');

/**
 * @param {import('node:sqlite').DatabaseSync} sqlite
 * @param {string} [migrationsFolder]
 * @returns {number} how many migrations ran
 */
export function migrate(sqlite, migrationsFolder = MIGRATIONS_FOLDER) {
  const migrations = readMigrationFiles({ migrationsFolder });
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    sqlite.exec(
      'CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric)',
    );
    const last = sqlite.prepare('SELECT max(created_at) AS at FROM "__drizzle_migrations"').get();
    const lastAt = last?.at == null ? -1 : Number(last.at);
    const record = sqlite.prepare('INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?, ?)');
    let applied = 0;
    for (const migration of migrations) {
      if (migration.folderMillis <= lastAt) continue;
      for (const statement of migration.sql) {
        if (statement.trim() !== '') sqlite.exec(statement);
      }
      record.run(migration.hash, migration.folderMillis);
      applied++;
    }
    sqlite.exec('COMMIT');
    return applied;
  } catch (error) {
    sqlite.exec('ROLLBACK');
    throw error;
  }
}
