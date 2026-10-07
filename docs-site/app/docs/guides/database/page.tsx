import React from 'react';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Guides</div>
      <h1>Database Example</h1>
      <p className="page-subtitle">
        SQLite with Drizzle ORM: a typed schema, SQL migrations, server-only queries, and a page
        that reads and writes rows.
      </p>

      <CodeBlock lang="bash" code={`npm create giojs@latest my-app -- --db   # a new app
npx create-giojs add db                    # an existing app`} />
      <p>
        Run <code>npm run dev</code> and open <code>/notes</code>: the rows come from{' '}
        <code>data/app.db</code>, created and migrated on first use.
      </p>

      <h2>Why node:sqlite</h2>
      <p>
        The driver is Node&apos;s built-in <code>node:sqlite</code>, so there is nothing to
        compile or download. The native drivers (<code>better-sqlite3</code>,{' '}
        <code>@libsql/client</code>) ship prebuilt binaries for common platforms, but a native
        addon cannot be bundled into the single <code>worker.js</code> that{' '}
        <code>gio build standalone</code> produces, so they would not survive a{' '}
        <a href="/docs/standalone">standalone</a> or <a href="/docs/guides/docker">Docker</a>{' '}
        deploy. <code>node:sqlite</code> needs Node 22.16 or newer (the feature sets{' '}
        <code>engines</code>); Node still labels it experimental and prints one warning at
        startup. Drizzle talks to it through its <code>sqlite-proxy</code> driver.
      </p>

      <h2>The schema</h2>
      <CodeBlock lang="ts" code={`// lib/schema.ts
export const notes = sqliteTable('notes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql\`(unixepoch())\`),
});`} />

      <h2>Queries</h2>
      <p>
        <code>lib/db.server.ts</code> opens the database, applies pending migrations, and
        exports <code>db</code> plus the queries the page uses. The <code>.server</code> name
        keeps it out of client bundles; use it from <code>getServerSideProps</code>, actions and
        route handlers.
      </p>
      <CodeBlock lang="ts" code={`export async function listNotes(): Promise<NoteItem[]> {
  const rows = await db.select().from(schema.notes).orderBy(desc(schema.notes.id)).limit(50);
  return rows.map(note => ({ id: note.id, title: note.title, createdAt: note.createdAt.toISOString() }));
}

export async function createNote(title: string): Promise<void> {
  await db.insert(schema.notes).values({ title });
}`} />
      <p>
        Page props travel to the browser as JSON, so dates become ISO strings. Each worker has
        one connection: <code>db.transaction()</code> works, but other requests&apos; queries can
        run inside it while its callback awaits, so keep transactions short.
      </p>

      <h2>The page</h2>
      <CodeBlock lang="tsx" code={`// app/(site)/notes/page.tsx
export const getServerSideProps: GetServerSideProps<Props> = async () => ({
  props: { notes: await listNotes() },
});

export async function action(req: ActionArgs) {
  const value = (await req.formData()).get('title');
  const title = typeof value === 'string' ? value.trim() : '';
  if (title === '' || title.length > MAX_TITLE) {
    return { status: 422, data: { error: 'Write something first.', title } };
  }
  await createNote(title);
  return redirect('/notes');
}`} />

      <h2>Changing the schema</h2>
      <CodeBlock lang="bash" code={`npm run db:generate   # drizzle-kit writes drizzle/0002_<name>.sql
npm run db:migrate    # optional: apply now, without starting the server`} />
      <p>
        Migrations live in <code>drizzle/</code> (commit them). The server applies pending ones
        when it first opens the database, inside one <code>BEGIN IMMEDIATE</code> transaction,
        so several workers starting together wait for each other and a failing migration
        changes nothing. Applied migrations are recorded in Drizzle&apos;s own{' '}
        <code>__drizzle_migrations</code> table. Seed data is a migration too (
        <code>drizzle/0001_seed.sql</code>), so it runs once per database; write one with{' '}
        <code>npx drizzle-kit generate --custom</code>.
      </p>

      <h2>Where the data lives</h2>
      <ul>
        <li>
          <code>data/app.db</code> by default; <code>DATABASE_PATH</code> overrides it.{' '}
          <code>data/</code> is git-ignored.
        </li>
        <li>
          <code>gio.toml</code> lists it in <code>[dev] watch_ignore</code>, so writes never
          restart the dev server:
        </li>
      </ul>
      <CodeBlock lang="toml" code={`[dev]
watch_ignore = ["data/**"]`} />
      <p>
        In a standalone deploy the paths are relative to the deploy folder (its{' '}
        <code>run.mjs</code> starts the server there): copy <code>drizzle/</code> next to it and
        keep <code>data/</code> on persistent storage. The Docker feature does both.
      </p>
    </>
  );
}
