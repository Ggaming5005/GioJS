/**
 * giojs-cli/test/scaffold.test.ts
 *
 * End-to-end create-giojs runs: the target directory rules (positional dir,
 * '.', non-empty refusal and --force), package name sanitizing, the
 * package manager in the install and the printed steps, git init (with and
 * without git or an identity, inside an existing repository), the
 * non-interactive defaults, the .gitignore rename and the static variant.
 * Every run has piped stdin - not a terminal - so none may ever prompt.
 *   npm test   (runs tsc first: the CLI runs from dist/)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanEnv, cliDir, runCli, type CliResult } from './helpers.ts';
import { parseFontEntries } from '../dist/static-variant.js';

let root = '';
let home = '';
let caseNumber = 0;

/** An isolated git setup: no system config, a global config the test writes. */
function gitEnv(globalConfig: string): Record<string, string> {
  return {
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: globalConfig,
    // Never discover a repository above the test directory.
    GIT_CEILING_DIRECTORIES: root,
  };
}

const withIdentity = (): Record<string, string> => gitEnv(join(home, 'identity.gitconfig'));
const withoutIdentity = (): Record<string, string> => gitEnv(join(home, 'anonymous.gitconfig'));

function git(args: string[], cwd: string, env: Record<string, string>): string {
  const result = spawnSync('git', args, { cwd, env: cleanEnv(env), encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

async function newCaseDir(): Promise<string> {
  const dir = join(root, `case-${++caseNumber}`);
  await mkdir(dir);
  return dir;
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

function assertOk(result: CliResult): void {
  assert.equal(result.status, 0, `create-giojs failed:\n${result.stdout}\n${result.stderr}`);
}

async function packageJson(dir: string): Promise<{ name: string; scripts: Record<string, string> }> {
  return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { name: string; scripts: Record<string, string> };
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'gio-scaffold-'));
  home = join(root, 'home');
  await mkdir(home);
  await writeFile(join(home, 'identity.gitconfig'), '[user]\n\tname = Gio Test\n\temail = test@example.com\n');
  // useConfigOnly: git must not invent an identity from the hostname.
  await writeFile(join(home, 'anonymous.gitconfig'), '[user]\n\tuseConfigOnly = true\n');
});

after(async () => {
  if (root !== '') await rm(root, { recursive: true, force: true });
});

test('without a terminal and without --yes, every question takes its default', async () => {
  const cwd = await newCaseDir();
  const result = runCli(['--no-install', '--no-git'], { cwd });
  assertOk(result);
  const appDir = join(cwd, 'my-giojs-app');
  assert.equal((await packageJson(appDir)).name, 'my-giojs-app');
  assert.ok(await exists(join(appDir, 'tsconfig.json')), 'TypeScript is the default');
  assert.equal((await packageJson(appDir)).scripts['start']?.includes('NODE_ENV=production'), true, 'server app is the default');
  assert.doesNotMatch(result.stdout, /\?/, 'no prompt was printed');
});

test('the template ships _gitignore and the scaffold gets .gitignore and .env.example', async () => {
  const cwd = await newCaseDir();
  assertOk(runCli(['app', '--no-install', '--no-git'], { cwd }));
  const entries = await readdir(join(cwd, 'app'));
  assert.ok(entries.includes('.gitignore'), entries.join(', '));
  assert.ok(!entries.includes('_gitignore'), entries.join(', '));
  const ignore = await readFile(join(cwd, 'app', '.gitignore'), 'utf8');
  for (const line of ['node_modules/', '.gio/', 'out/', 'dist/', 'standalone/', '.env*.local', '.env.local', '*.log', '.DS_Store']) {
    assert.ok(ignore.split('\n').includes(line), `.gitignore lacks ${line}`);
  }
  assert.match(await readFile(join(cwd, 'app', '.env.example'), 'utf8'), /# GIO_SESSION_SECRET=/);
});

test("'.' scaffolds into the current directory and names the package after it", async () => {
  const cwd = join(await newCaseDir(), 'dot-app');
  await mkdir(join(cwd, '.git'), { recursive: true });
  await writeFile(join(cwd, 'README.md'), '# notes\n');
  const result = runCli(['.', '--no-install', '--no-git'], { cwd });
  assertOk(result);
  assert.equal((await packageJson(cwd)).name, 'dot-app');
  assert.equal(await readFile(join(cwd, 'README.md'), 'utf8'), '# notes\n', 'harmless files are kept');
  assert.doesNotMatch(result.stdout, /\bcd\b/, 'no cd step for the current directory');
});

test('an invalid directory name gets a sanitized package name, also in the templates', async () => {
  const cwd = await newCaseDir();
  const result = runCli(['My App', '--no-install', '--no-git'], { cwd });
  assertOk(result);
  assert.match(result.stdout, /Using the package name "my-app" - "My App" is not a valid npm package name: the name must be lowercase/);
  const appDir = join(cwd, 'My App');
  assert.equal((await packageJson(appDir)).name, 'my-app');
  assert.match(await readFile(join(appDir, 'gio.toml'), 'utf8'), /name = "my-app"/);
  assert.match(result.stdout, /cd "My App"/);
});

test('a non-empty directory is refused, listing its contents, unless --force', async () => {
  const cwd = await newCaseDir();
  const target = join(cwd, 'taken');
  await mkdir(join(target, 'src'), { recursive: true });
  await writeFile(join(target, 'package.json'), '{"name":"mine"}\n');

  const refused = runCli(['taken', '--no-install', '--no-git'], { cwd });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /taken is not empty:\n {2}package\.json\n {2}src\n/);
  assert.match(refused.stderr, /--force/);
  assert.deepEqual((await readdir(target)).sort(), ['package.json', 'src'], 'nothing was written');

  // Without a positional directory the default one is checked the same way.
  await mkdir(join(cwd, 'my-giojs-app'));
  await writeFile(join(cwd, 'my-giojs-app', 'notes.txt'), '');
  assert.equal(runCli(['--no-install', '--no-git'], { cwd }).status, 2);

  assertOk(runCli(['taken', '--no-install', '--no-git', '--force'], { cwd }));
  assert.ok(await exists(join(target, 'src')), 'unrelated files survive --force');
  assert.ok(await exists(join(target, 'app', '(site)', 'page.tsx')));

  await writeFile(join(cwd, 'a-file'), '');
  const notDir = runCli(['a-file', '--no-install', '--no-git'], { cwd });
  assert.equal(notDir.status, 2);
  assert.match(notDir.stderr, /a-file exists and is not a directory/);
});

test('the package manager that ran create-giojs installs and appears in the steps', async () => {
  const cwd = await newCaseDir();
  const pnpm = runCli(['a', '--no-install', '--no-git'], {
    cwd,
    env: { npm_config_user_agent: 'pnpm/9.1.0 npm/? node/v22.2.0 linux x64' },
  });
  assertOk(pnpm);
  assert.match(pnpm.stdout, /\n {2}pnpm install\n {2}pnpm dev\n/);

  const yarn = runCli(['b', '--no-install', '--no-git', '--pm', 'yarn'], {
    cwd,
    env: { npm_config_user_agent: 'pnpm/9.1.0 npm/? node/v22.2.0 linux x64' },
  });
  assertOk(yarn);
  assert.match(yarn.stdout, /\n {2}yarn install\n {2}yarn dev\n/);

  // The install runs with that package manager; one that is not installed
  // fails the install, not the scaffold - the project is complete.
  const emptyPath = join(cwd, 'empty-path');
  await mkdir(emptyPath);
  const bun = runCli(['c', '--no-git', '--pm', 'bun'], { cwd, env: { PATH: emptyPath } });
  assertOk(bun);
  assert.match(bun.stdout, /Installing dependencies with bun/);
  assert.match(bun.stdout, /bun install failed/);
  assert.match(bun.stdout, /\n {2}bun install\n {2}bun run dev\n/);
  assert.ok(await exists(join(cwd, 'c', 'app', '(site)', 'page.tsx')));
});

test('git init makes an initial commit of the scaffold', async () => {
  const cwd = await newCaseDir();
  const env = withIdentity();
  const result = runCli(['app', '--no-install'], { cwd, env });
  assertOk(result);
  assert.match(result.stdout, /Initialized a git repository with an initial commit/);
  const appDir = join(cwd, 'app');
  assert.equal(git(['log', '--format=%s'], appDir, env), 'Initial commit from create-giojs');
  const files = git(['ls-files'], appDir, env).split('\n');
  assert.ok(files.includes('.gitignore') && files.includes('app/(site)/page.tsx'), files.join(', '));
  assert.equal(git(['status', '--porcelain'], appDir, env), '', 'everything is committed');
});

test('a --force scaffold commits only what it created, never the files already there', async () => {
  const cwd = await newCaseDir();
  const target = join(cwd, 'taken');
  await mkdir(join(target, 'notes'), { recursive: true });
  await mkdir(join(target, 'app'), { recursive: true });
  await writeFile(join(target, '.env'), 'API_KEY=sk-secret\n');
  await writeFile(join(target, 'notes', 'todo.txt'), 'mine\n');
  await writeFile(join(target, 'app', 'mine.tsx'), 'export {};\n');
  await writeFile(join(target, 'package.json'), '{"name":"mine"}\n');
  // A stand-in package manager whose install writes a lockfile, as npm does.
  const bin = join(cwd, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'npm'), '#!/bin/sh\necho "{}" > package-lock.json\n', { mode: 0o755 });
  const env = withIdentity();
  const pathWithNpm = process.platform === 'win32' ? undefined : `${bin}:${process.env['PATH'] ?? ''}`;

  const result = runCli(
    ['taken', '--force', ...(pathWithNpm === undefined ? ['--no-install'] : [])],
    { cwd, env: { ...env, ...(pathWithNpm === undefined ? {} : { PATH: pathWithNpm }) } },
  );
  assertOk(result);
  assert.match(result.stdout, /Initialized a git repository with an initial commit/);
  assert.match(result.stdout, /not in the commit: .*\.env/);
  const files = git(['ls-files'], target, env).split('\n');
  for (const file of ['.gitignore', 'package.json', 'app/(site)/page.tsx', 'gio.toml']) {
    assert.ok(files.includes(file), `${file} is not committed: ${files.join(', ')}`);
  }
  if (pathWithNpm !== undefined) assert.ok(files.includes('package-lock.json'), 'the new lockfile is committed');
  for (const file of ['.env', 'notes/todo.txt', 'app/mine.tsx']) {
    assert.ok(!files.includes(file), `${file} was already there and must not be committed`);
  }
  const untracked = git(['status', '--porcelain', '--untracked-files=all'], target, env).split('\n').sort();
  assert.deepEqual(untracked, ['?? .env', '?? app/mine.tsx', '?? notes/todo.txt']);
});

test('a failed initial commit (no git identity) leaves the repository and a note', async () => {
  const cwd = await newCaseDir();
  const result = runCli(['app', '--no-install'], { cwd, env: withoutIdentity() });
  assertOk(result);
  assert.match(result.stdout, /initialized a git repository, but the initial commit failed/);
  assert.match(result.stdout, /user\.name/);
  assert.ok(await exists(join(cwd, 'app', '.git')));
});

test('without git, or inside an existing repository, no repository is created', async () => {
  const cwd = await newCaseDir();
  const emptyPath = join(cwd, 'empty-path');
  await mkdir(emptyPath);
  const noGit = runCli(['app', '--no-install'], { cwd, env: { ...withIdentity(), PATH: emptyPath } });
  assertOk(noGit);
  assert.match(noGit.stdout, /git was not found/);
  assert.ok(!(await exists(join(cwd, 'app', '.git'))));

  const env = withIdentity();
  const outer = join(cwd, 'monorepo');
  await mkdir(outer);
  git(['init'], outer, env);
  const nested = runCli(['packages-app', '--no-install'], { cwd: outer, env });
  assertOk(nested);
  assert.match(nested.stdout, /inside an existing git repository/);
  assert.ok(!(await exists(join(outer, 'packages-app', '.git'))));

  assertOk(runCli(['skipped', '--no-install', '--no-git'], { cwd, env }));
  assert.ok(!(await exists(join(cwd, 'skipped', '.git'))));
});

for (const [language, flag] of [['ts', '--ts'], ['js', '--js']] as const) {
  test(`${language}: --static exports with gio export and declares its fonts in CSS`, async () => {
    const cwd = await newCaseDir();
    const result = runCli(['site', flag, '--static', '--no-install', '--no-git'], { cwd });
    assertOk(result);
    const siteDir = join(cwd, 'site');
    const { scripts } = await packageJson(siteDir);
    assert.match(scripts['build'] ?? '', language === 'ts' ? /^tsc --noEmit && .*gio\.js export$/ : /^node .*gio\.js export$/);
    assert.equal(scripts['start'], undefined, 'a static site ships no production server');
    assert.match(result.stdout, /npm run build {6}# → out\//);

    // The export never applies [[fonts]]: the CSS carries them instead.
    const toml = await readFile(join(siteDir, 'gio.toml'), 'utf8');
    assert.doesNotMatch(toml, /\[\[fonts\]\]\n/);
    const css = await readFile(join(siteDir, 'app', 'globals.css'), 'utf8');
    const template = await readFile(join(cliDir, 'templates', 'default', 'gio.toml'), 'utf8');
    for (const font of parseFontEntries(template)) {
      const file = font.url.replace(/^\/public\//, '');
      assert.ok(css.includes(`src: url('../public/${file}') format('woff2');`), `${file} missing:\n${css.slice(0, 600)}`);
      assert.ok(await exists(join(siteDir, 'public', file)));
    }
    assert.match(await readFile(join(siteDir, 'AGENTS.md'), 'utf8'), /This is a static site/);
  });
}
