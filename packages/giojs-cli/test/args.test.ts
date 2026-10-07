/**
 * giojs-cli/test/args.test.ts
 *
 * create-giojs flag parsing: every documented flag, --help/--version that
 * exit without scaffolding, and unknown flags that fail with a hint instead
 * of being ignored (a mistyped --statc used to scaffold a server app).
 *   npm test   (runs tsc first: these import the built dist/)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliDir, runCli } from './helpers.ts';
import { didYouMean, parseArgs, UsageError } from '../dist/args.js';
import { detectPackageManager, installCommand, runCommand } from '../dist/package-manager.js';

test('parseArgs reads every flag and one positional directory', () => {
  const args = parseArgs(['my-app', '--js', '--static', '--no-install', '--no-git', '--pm', 'pnpm', '--force', '-y']);
  assert.deepEqual(args, {
    projectDir: 'my-app',
    language: 'js',
    mode: 'static',
    installDeps: false,
    git: false,
    packageManager: 'pnpm',
    force: true,
    yes: true,
    help: false,
    version: false,
  });
  assert.equal(parseArgs(['--pm=bun']).packageManager, 'bun');
  assert.equal(parseArgs(['.']).projectDir, '.');
  assert.equal(parseArgs(['-h']).help, true);
  assert.equal(parseArgs(['-v']).version, true);
  assert.deepEqual(parseArgs([]), { force: false, yes: false, help: false, version: false });
  // Names that are Object.prototype keys are directories, not flags.
  assert.equal(parseArgs(['constructor']).projectDir, 'constructor');
  assert.equal(parseArgs(['toString']).projectDir, 'toString');
});

test('parseArgs skips the npm-style -- separator that pnpm, yarn and bun pass on', () => {
  // `pnpm create giojs my-app -- --js` reaches the bin as exactly this argv.
  const args = parseArgs(['my-app', '--', '--js']);
  assert.equal(args.projectDir, 'my-app');
  assert.equal(args.language, 'js');
  assert.equal(parseArgs(['--', 'my-app', '--static']).mode, 'static');
  assert.equal(parseArgs(['--', 'my-app']).projectDir, 'my-app');
});

test('parseArgs rejects unknown flags, bad --pm values and a second directory', () => {
  assert.throws(() => parseArgs(['--statc']), (err: unknown) =>
    err instanceof UsageError && /Unknown option --statc - did you mean --static\?/.test(err.message));
  assert.throws(() => parseArgs(['--template', 'x']), /Unknown option --template\n/);
  assert.throws(() => parseArgs(['--pm']), /--pm needs a value/);
  assert.throws(() => parseArgs(['--pm', 'deno']), /Unknown package manager "deno"/);
  // A known boolean flag with a value says so, not "did you mean" itself.
  for (const flag of ['--yes', '--force', '--help']) {
    assert.throws(() => parseArgs([`${flag}=1`]), (err: unknown) =>
      err instanceof UsageError && err.message === `${flag} does not take a value`);
  }
  assert.throws(() => parseArgs(['a', 'b']), /Unexpected argument "b"/);
});

test('didYouMean suggests near misses only', () => {
  const flags = ['--static', '--server', '--no-install', '--help', '--ts', '-y'];
  assert.equal(didYouMean('--hepl', flags), '--help');
  assert.equal(didYouMean('--no-instal', flags), '--no-install');
  assert.equal(didYouMean('--tss', flags), '--ts');
  assert.equal(didYouMean('-x', flags), undefined);
  assert.equal(didYouMean('--template', flags), undefined);
});

test('the package manager comes from npm_config_user_agent', () => {
  assert.equal(detectPackageManager('pnpm/9.1.0 npm/? node/v22.2.0 linux x64'), 'pnpm');
  assert.equal(detectPackageManager('yarn/1.22.19 npm/? node/v20.0.0 darwin arm64'), 'yarn');
  assert.equal(detectPackageManager('bun/1.1.0 npm/? node/v21.0.0 linux x64'), 'bun');
  assert.equal(detectPackageManager('npm/10.8.0 node/v22.2.0 linux x64 workspaces/false'), 'npm');
  assert.equal(detectPackageManager(undefined), 'npm');
  assert.equal(detectPackageManager('cnpm/9.0.0 node/v20'), 'npm');
  assert.equal(installCommand('yarn'), 'yarn install');
  assert.deepEqual(['npm', 'pnpm', 'yarn', 'bun'].map(pm => runCommand(pm as 'npm', 'dev')),
    ['npm run dev', 'pnpm dev', 'yarn dev', 'bun run dev']);
});

test('--help prints the usage, flags, features and subcommands, and writes nothing', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'gio-create-help-'));
  try {
    for (const flag of ['--help', '-h']) {
      const result = runCli([flag], { cwd });
      assert.equal(result.status, 0, result.stderr);
      for (const text of [
        '--static', '--pm <name>', '--no-git', '--force', '--version', 'migrate', 'Examples:',
        // The starter feature flags and the add subcommand (`gio add` runs it).
        '--tailwind', '--api', '--auth', '--db', '--docker', '--ci', '--features a,b,c', 'add <feature...>',
      ]) {
        assert.ok(result.stdout.includes(text), `${flag} output lacks ${text}:\n${result.stdout}`);
      }
    }
    assert.deepEqual(await readdir(cwd), []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('--version prints the package version', async () => {
  const { version } = JSON.parse(await readFile(join(cliDir, 'package.json'), 'utf8')) as { version: string };
  for (const flag of ['--version', '-v']) {
    const result = runCli([flag], { cwd: tmpdir() });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), version);
  }
});

test('`pnpm create giojs my-app -- --js` scaffolds the JS app', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'gio-create-separator-'));
  try {
    const result = runCli(['my-app', '--', '--js', '--no-install', '--no-git'], { cwd });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const app = await readdir(join(cwd, 'my-app', 'app'));
    assert.ok(app.includes('page.jsx'), app.join(', '));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('an unknown flag fails with a hint before anything is written', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'gio-create-unknown-'));
  try {
    const result = runCli(['app', '--statc'], { cwd });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Unknown option --statc - did you mean --static\?/);
    assert.deepEqual(await readdir(cwd), []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
