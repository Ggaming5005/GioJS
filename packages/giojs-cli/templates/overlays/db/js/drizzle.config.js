// drizzle-kit configuration: `db:generate` diffs lib/schema.js against the
// last snapshot in drizzle/meta and writes the next SQL migration.
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './lib/schema.js',
  out: './drizzle',
});
