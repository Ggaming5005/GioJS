/**
 * The database schema, in Drizzle's schema DSL. After changing it, run the
 * db:generate script: drizzle-kit writes the SQL migration into drizzle/,
 * and the server applies it when it next opens the database.
 */
import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const notes = sqliteTable('notes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});
