/**
 * packages/giojs-cli/src/migrate-command.ts
 *
 * The `migrate` command line, shared by every entry point:
 *   npm create giojs@latest -- migrate [dir]   (create-giojs subcommand)
 *   npx create-giojs migrate [dir]
 *   npx -p create-giojs gio-migrate [dir]       (standalone bin; a bare
 *                                               `npx gio-migrate` would fetch
 *                                               whatever npm package has that name)
 * Other CLIs (e.g. `gio migrate`) can import `runMigrate` from
 * `create-giojs/migrate` and pass their remaining argv.
 *
 * The plan is always computed first; a real run shows the summary and asks
 * before writing (or needs --yes when there is no terminal to ask on).
 */
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { basename, dirname, join, resolve } from 'path';
import { createInterface } from 'readline/promises';
import { unifiedDiff } from './migrate-edits.js';
import { applyMigration, planMigration, type MigrationPlan } from './migrate.js';
import { convertConfigSource, planToml } from './next-config-converter.js';

export const MIGRATE_USAGE = `Usage: create-giojs migrate [dir] [options]

Migrate a Next.js project (pages or app router) to GioJS, in place.

  npm create giojs@latest -- migrate [dir]
  npx create-giojs migrate [dir]
  npx -p create-giojs gio-migrate [dir]

Arguments:
  dir              Project root (default: the current directory)

Options:
  --dry-run        Show the plan and a diff of every change; write nothing
  -y, --yes        Apply without asking for confirmation
  --config <file>  Only convert a next.config file to gio.toml
  -h, --help       Show this help

What it does:
  - moves pages/ to app/ (pages/about.tsx -> app/about/page.tsx,
    pages/api/x.ts -> app/api/x/route.ts, _app/_document -> app/layout.tsx)
  - rewrites next/link, next/image, next/router, next/navigation, next/head,
    next/script, next/dynamic and next/font code; getStaticProps becomes
    getServerSideProps + export const revalidate
  - converts next.config redirects, rewrites, headers, images and i18n to
    gio.toml (merged into an existing gio.toml only when safe, otherwise
    written to gio.migrated.toml)
  - swaps the next dependency for @gio.js/* in package.json and sets
    "type": "module" (CommonJS .js files such as postcss.config.js become
    .cjs); .js files with JSX become .jsx
  - writes MIGRATION_REPORT.md listing every change and every TODO

Commit your work first: the migration edits files in place.`;

export interface MigrateArgs {
  dir: string;
  dryRun: boolean;
  yes: boolean;
  help: boolean;
  config?: string;
}

export function parseMigrateArgs(argv: string[], cwd = process.cwd()): MigrateArgs | { error: string } {
  const args: MigrateArgs = { dir: cwd, dryRun: false, yes: false, help: false };
  let dirSet = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--dry-run' || arg === '-n') args.dryRun = true;
    else if (arg === '--yes' || arg === '-y') args.yes = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--config') {
      const value = argv[++i];
      if (value === undefined) return { error: '--config needs a file path' };
      args.config = resolve(cwd, value);
    } else if (arg.startsWith('-')) {
      return { error: `unknown option ${arg}` };
    } else if (!dirSet) {
      args.dir = resolve(cwd, arg);
      dirSet = true;
    } else {
      return { error: `unexpected argument ${arg}` };
    }
  }
  return args;
}

export interface MigrateIO {
  log(line: string): void;
  error(line: string): void;
  /** Ask a yes/no question; only called when `interactive`. */
  confirm(question: string): Promise<boolean>;
  interactive: boolean;
  color: boolean;
}

function defaultIO(): MigrateIO {
  return {
    log: line => console.log(line),
    error: line => console.error(line),
    async confirm(question) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
      } finally {
        rl.close();
      }
    },
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    color: process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined,
  };
}

function paint(io: MigrateIO, code: string, text: string): string {
  return io.color ? `\x1b[${code}m${text}\x1b[0m` : text;
}

function printDiff(io: MigrateIO, diff: string): void {
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) io.log(paint(io, '1', line));
    else if (line.startsWith('+')) io.log(paint(io, '32', line));
    else if (line.startsWith('-')) io.log(paint(io, '31', line));
    else if (line.startsWith('@@')) io.log(paint(io, '36', line));
    else io.log(line);
  }
}

export function summarize(plan: MigrationPlan): string[] {
  const out: string[] = [];
  const todoCount = plan.files.reduce((n, f) => n + f.todos.length, 0) + plan.todos.length;
  const label = { pages: 'pages router', app: 'app router', both: 'pages + app router', none: 'no pages/ or app/ directory' }[plan.router];
  out.push(`Next.js project (${label}) at ${plan.root}`, '');
  for (const f of plan.files) {
    const marker = f.kind === 'created' ? '+' : f.kind === 'moved' ? '→' : '~';
    const what = f.kind === 'moved' ? `${f.from ?? ''} → ${f.to}` : f.mergedFrom !== undefined ? `${f.to} (from ${f.mergedFrom.join(' + ')})` : f.to;
    const detail = [
      f.changes.length > 0 ? `${f.changes.length} change${f.changes.length === 1 ? '' : 's'}` : '',
      f.todos.length > 0 ? `${f.todos.length} TODO${f.todos.length === 1 ? '' : 's'}` : '',
    ].filter(Boolean).join(', ');
    out.push(`  ${marker} ${what}${detail !== '' ? `  (${detail})` : ''}`);
  }
  if (plan.config !== undefined && plan.config.toml.mode === 'separate') {
    out.push('', `  gio.toml was not merged (${plan.config.toml.reason ?? 'unsafe'}): converted config goes to ${plan.config.toml.target}`);
  }
  out.push('', `${todoCount} TODO${todoCount === 1 ? '' : 's'} for you - see MIGRATION_REPORT.md`);
  return out;
}

function gitWarning(dir: string): string | undefined {
  const result = spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' });
  if (result.error !== undefined || result.status !== 0) {
    return 'This directory is not a git repository: back it up first so the migration can be undone.';
  }
  if (result.stdout.trim() !== '') return 'You have uncommitted changes: commit them first so the migration shows up as a reviewable diff.';
  return undefined;
}

async function runConfigOnly(args: MigrateArgs, io: MigrateIO): Promise<number> {
  const file = args.config as string;
  const source = await readFile(file, 'utf8');
  const converted = convertConfigSource(source, basename(file));
  const tomlPath = join(dirname(file), 'gio.toml');
  const existing = existsSync(tomlPath) ? await readFile(tomlPath, 'utf8') : undefined;
  const toml = planToml(existing, converted, 'my-app');
  const target = join(dirname(file), toml.target);
  for (const c of converted.converted) io.log(`  ✔ ${c}`);
  for (const t of converted.todos) io.log(`  TODO ${t}`);
  if (args.dryRun) {
    printDiff(io, unifiedDiff(toml.before ?? '', toml.content, toml.target, toml.target));
    io.log('\nDry run - nothing was written.');
    return 0;
  }
  if (toml.target !== 'gio.toml' && existsSync(target)) {
    io.error(`${target} already exists - remove it or merge it first.`);
    return 1;
  }
  await writeFile(target, toml.content, 'utf8');
  io.log(`\n${toml.mode === 'merged' ? 'Merged into' : 'Wrote'} ${target}${toml.reason !== undefined ? ` (gio.toml not merged: ${toml.reason})` : ''}`);
  return 0;
}

/** Run the migrate command; resolves to the process exit code. */
export async function runMigrate(argv: string[], io: MigrateIO = defaultIO()): Promise<number> {
  const args = parseMigrateArgs(argv);
  if ('error' in args) {
    io.error(`create-giojs migrate: ${args.error}\n`);
    io.error(MIGRATE_USAGE);
    return 1;
  }
  if (args.help) {
    io.log(MIGRATE_USAGE);
    return 0;
  }
  if (args.config !== undefined) return runConfigOnly(args, io);

  let plan: MigrationPlan;
  try {
    plan = await planMigration(args.dir);
  } catch (err) {
    io.error(`create-giojs migrate: ${err instanceof Error ? err.message : String(err)}`);
    if (basename(args.dir) === 'migrate' && !existsSync(args.dir)) {
      io.error('(To scaffold a new app named "migrate", run npm create giojs@latest and enter the name at the prompt.)');
    }
    return 1;
  }

  for (const line of summarize(plan)) io.log(line);
  if (args.dryRun) {
    for (const f of plan.files) {
      if (typeof f.content !== 'string') continue;
      io.log('');
      printDiff(io, unifiedDiff(f.before ?? '', f.content, f.kind === 'created' ? '/dev/null' : f.from ?? f.to, f.to));
    }
    io.log('\nDry run - nothing was written.');
    return 0;
  }

  const warning = gitWarning(args.dir);
  if (warning !== undefined) io.log(`\n${paint(io, '33', warning)}`);
  if (!args.yes) {
    if (!io.interactive) {
      io.error('\nRefusing to modify files without confirmation: re-run with --yes to apply, or --dry-run to preview.');
      return 1;
    }
    if (!(await io.confirm(`\nApply these changes to ${plan.root}?`))) {
      io.log('Nothing was written.');
      return 0;
    }
  }
  await applyMigration(plan);
  io.log(`\nDone. Read MIGRATION_REPORT.md, then:\n\n  npm install\n  npx tsc --noEmit\n  npm run dev\n`);
  return 0;
}
