/**
 * giojs-cli/test/create.test.ts
 *
 * The steps create-giojs prints after scaffolding. Inside the GioJS
 * monorepo the app file-refs the workspace's @gio.js/core and
 * @gio.js/react, which resolve through their builds - without core's
 * dist/types, tsc reads core's .ts sources and the app's `tsc --noEmit`
 * fails with TS5097 - so the steps start by building them. A published
 * create-giojs (no monorepo around it) prints no such step.
 *   npm test   (runs tsc first: the CLI runs from dist/)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliDir, runCli } from './helpers.ts';

const BUILD_STEP = 'pnpm --filter @gio.js/core --filter @gio.js/react run build';

/** Runs `create-giojs <name> --yes --no-install --no-git` in `cwd`; returns its stdout. */
function scaffold(cliEntry: string, cwd: string, name = 'app', flags: string[] = []): string {
  const result = runCli([name, '--yes', '--no-install', '--no-git', ...flags], { cwd, entry: cliEntry });
  assert.equal(result.status, 0, `create-giojs failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

async function dependencies(appDir: string): Promise<Record<string, string>> {
  const pkg = JSON.parse(await readFile(join(appDir, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  return pkg.dependencies;
}

test('a monorepo scaffold builds the workspace packages it links before the first run', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'gio-create-'));
  try {
    const stdout = scaffold(join(cliDir, 'dist', 'index.js'), cwd);
    const deps = await dependencies(join(cwd, 'app'));
    assert.equal(deps['@gio.js/core'], 'file:../../packages/giojs-core');
    assert.equal(deps['@gio.js/react'], 'file:../../packages/giojs-react');

    const steps = stdout.slice(stdout.indexOf('Done!'));
    const build = steps.indexOf(BUILD_STEP);
    assert.ok(build !== -1, `the steps do not build the linked packages:\n${steps}`);
    assert.ok(build < steps.indexOf('npm run dev'), `the build comes after the first run:\n${steps}`);
    assert.match(steps, /again after changing them/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('create-giojs installed in a GioJS app (gio.toml four levels up) scaffolds in published mode', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'gio-create-'));
  try {
    // `gio add` / `gio migrate` install create-giojs as a devDependency; npx
    // and `npm create giojs` then run that copy from inside the app.
    const host = join(workDir, 'hostproj');
    await mkdir(host);
    await writeFile(join(host, 'gio.toml'), '[app]\nname = "hostproj"\n');
    const installed = join(host, 'node_modules', 'create-giojs');
    await mkdir(installed, { recursive: true });
    await cp(join(cliDir, 'dist'), join(installed, 'dist'), { recursive: true });
    await cp(join(cliDir, 'templates'), join(installed, 'templates'), { recursive: true });
    await cp(join(cliDir, 'package.json'), join(installed, 'package.json'));

    const stdout = scaffold(join(installed, 'dist', 'index.js'), host, 'other-app');
    const pkg = JSON.parse(await readFile(join(host, 'other-app', 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    assert.match(pkg.dependencies['@gio.js/core'] ?? '', /^\^/);
    assert.ok(pkg.dependencies['@gio.js/server'] !== undefined, 'the server bin is kept');
    assert.doesNotMatch(JSON.stringify(pkg.scripts), /cargo|\.\.\/\.\.\//);
    assert.doesNotMatch(stdout, /pnpm --filter/);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test('a published create-giojs prints no workspace build step', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'gio-create-'));
  try {
    // The published layout, with no gio.toml anywhere above it.
    const installed = join(workDir, 'node_modules', 'npx', 'create-giojs');
    await mkdir(installed, { recursive: true });
    await cp(join(cliDir, 'dist'), join(installed, 'dist'), { recursive: true });
    await cp(join(cliDir, 'templates'), join(installed, 'templates'), { recursive: true });
    await cp(join(cliDir, 'package.json'), join(installed, 'package.json'));

    const stdout = scaffold(join(installed, 'dist', 'index.js'), workDir);
    const deps = await dependencies(join(workDir, 'app'));
    assert.match(deps['@gio.js/core'] ?? '', /^\^/);
    assert.doesNotMatch(stdout, /pnpm --filter/);

    // A published static site exports through the @gio.js/server bin.
    scaffold(join(installed, 'dist', 'index.js'), workDir, 'site', ['--static']);
    const site = JSON.parse(await readFile(join(workDir, 'site', 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    assert.equal(site.scripts['build'], 'tsc --noEmit && gio export');
    assert.equal(site.scripts['dev'], 'cross-env NODE_ENV=development giojs-server');
    assert.equal(site.scripts['start'], undefined);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
