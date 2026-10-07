// drizzle-kit configuration: `db:generate` diffs lib/schema.ts against the
// last snapshot in drizzle/meta and writes the next SQL migration.
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './lib/schema.ts',
  out: './drizzle',
});
