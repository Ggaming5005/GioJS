/**
 * SQLite with Drizzle ORM. The driver is Node's built-in node:sqlite, picked
 * over the alternatives on purpose:
 *
 *  - better-sqlite3 and @libsql/client are native addons. Their prebuilt
 *    binaries cover the common platforms (or better-sqlite3 falls back to a
 *    node-gyp compile), but no native addon can be bundled into the single
 *    worker.js `gio build standalone` produces - the db and docker features
 *    would not work together.
 *  - node:sqlite needs nothing installed or compiled and bundles cleanly. It
 *    is unflagged from Node 22.13; StatementSync#setReturnArrays and the
 *    `timeout` option this code relies on arrived in 22.16, hence the
 *    engines field. (Node still labels it experimental and prints one
 *    ExperimentalWarning.)
 *
 * Drizzle drives it through its sqlite-proxy driver; drizzle-kit (dev only)
 * generates SQL migrations from the schema, which lib/migrate.server applies
 * with Drizzle's own migration bookkeeping.
 */
import type { FileEdit, Overlay } from '../types.js';

export const DB_NODE_ENGINE = '>=22.16.0';

/**
 * drizzle-orm's declarations reference optional peers (gel, mysql2...) and
 * do not typecheck on their own - Drizzle's docs require skipLibCheck. The
 * edit keeps the file's formatting; a tsconfig that is not plain JSON (or
 * says skipLibCheck: false) becomes a manual step.
 */
export function enableSkipLibCheck(content: string): string | null {
  let config: { compilerOptions?: Record<string, unknown> };
  try {
    config = JSON.parse(content) as typeof config;
  } catch {
    return null;
  }
  const current = config.compilerOptions?.['skipLibCheck'];
  if (current === true) return content;
  if (current !== undefined) return null;
  const options = /("compilerOptions"\s*:\s*\{)([ \t]*\r?\n([ \t]+))?/.exec(content);
  if (options === null || Object.keys(config.compilerOptions ?? {}).length === 0) return null;
  const indent = options[3] ?? '    ';
  const at = options.index + (options[1] as string).length;
  return `${content.slice(0, at)}\n${indent}"skipLibCheck": true,${content.slice(at).replace(/^[ \t]*\r?\n/, '\n')}`;
}

const tsconfigEdit: FileEdit = {
  paths: ['tsconfig.json'],
  apply: content => enableSkipLibCheck(content),
  manual: 'tsconfig.json: set "skipLibCheck": true in compilerOptions (drizzle-orm\'s types need it).',
};

export const db: Overlay = {
  name: 'db',
  title: 'Database (SQLite + Drizzle)',
  hint: "Drizzle ORM on Node's built-in SQLite, with migrations",
  modes: ['server'],
  templateDirs: ['_forms', 'db'],
  agents:
    '- Database: SQLite (node:sqlite) + Drizzle ORM in `lib/db.server.*`, schema in `lib/schema.*`. After a\n' +
    '  schema change run the db:generate script (writes drizzle/); migrations apply when the database\n' +
    '  opens, or with db:migrate. The file is `data/app.db` (git-ignored, in `[dev] watch_ignore`).',
  dependencies: {
    'drizzle-orm': '^0.45.0',
  },
  devDependencies: {
    'drizzle-kit': '^0.31.0',
  },
  scripts: () => ({
    'db:generate': 'drizzle-kit generate',
    'db:migrate': 'node scripts/db-migrate.mjs',
  }),
  packageFields: {
    engines: { node: DB_NODE_ENGINE },
  },
  toml: {
    keys: [
      {
        table: 'dev',
        key: 'watch_ignore',
        values: ['data/**'],
        comment: ['The SQLite database: writes to it must not restart the dev server.'],
      },
    ],
  },
  env: {
    '.env.example': ['# The SQLite database file, relative to the project root.', 'DATABASE_PATH=data/app.db'],
  },
  gitignore: ['# SQLite database (created on first use)', 'data/'],
  edits: ctx => (ctx.language === 'ts' ? [tsconfigEdit] : []),
  postSteps: ctx => [
    'Open /notes: rows are read in getServerSideProps and added by the page action.',
    `After changing lib/schema, run \`${ctx.packageManager.run('db:generate')}\`; the server applies new migrations when it opens the database (\`${ctx.packageManager.run('db:migrate')}\` applies them without it).`,
    `node:sqlite needs Node ${DB_NODE_ENGINE.slice(2)} or newer.`,
  ],
};
