/**
 * giojs-cli/test/template-typecheck.test.ts
 *
 * A fresh scaffold must typecheck - beta.7 shipped one whose `tsc --noEmit`
 * failed. Each template is scaffolded by the CLI into a temp dir next to a
 * node_modules laid out the way npm installs the published packages:
 * @gio.js/core as package.json + its built declarations (dist/types),
 * @gio.js/react as package.json + its built dist/, React and the @types
 * packages from the workspace. So this also proves the published types
 * work without the .ts sources (which app tsconfigs cannot compile).
 *
 * The TS template is checked before the first server start (no
 * .gio/routes.d.ts: params come from the patterns themselves) and with the
 * routes.d.ts the worker generates, where an unregistered pattern must
 * fail; the static-site variant too. The JS template's JSDoc types are
 * checked with checkJs.
 *   npm test
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { writeRouteTypes } from '../../giojs-core/src/typed-routes.ts';
import { scaffoldApp } from './helpers.ts';
import { buildPackage, coreDir, formatDiagnostics, linkInstalled, packagesDir, parseConfig, reactDir } from './workspace.ts';

/** The routes the server discovers in the templates' app/ folders. */
const TEMPLATE_ROUTES = ['/', '/about', '/posts/:id'];

let workDir = '';
let nodeModules = '';

/** What `tsc --noEmit -p <config>` reports for the project. */
function typecheck(projectDir: string, configName: string, overrides: ts.CompilerOptions = {}): string[] {
  const config = parseConfig(join(projectDir, configName), { ...overrides, noEmit: true });
  const program = ts.createProgram(config.fileNames, config.options);
  return formatDiagnostics(ts.getPreEmitDiagnostics(program), projectDir);
}

/** Scaffolds with the real CLI, as `npm create giojs` would. */
async function scaffold(name: string, flags: string[]): Promise<string> {
  const projectDir = scaffoldApp(workDir, name, flags);
  await symlink(nodeModules, join(projectDir, 'node_modules'), 'junction');
  return projectDir;
}

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'gio-template-typecheck-'));
  nodeModules = join(workDir, 'node_modules');

  const coreOut = join(nodeModules, '@gio.js', 'core');
  buildPackage(coreDir, join(coreOut, 'dist', 'types'));
  await cp(join(coreDir, 'package.json'), join(coreOut, 'package.json'));

  const reactOut = join(nodeModules, '@gio.js', 'react');
  buildPackage(reactDir, join(reactOut, 'dist'));
  await cp(join(reactDir, 'package.json'), join(reactOut, 'package.json'));

  // esbuild: named by core's declarations (client build error types).
  for (const name of ['react', 'react-dom', 'esbuild', '@types/react', '@types/react-dom', '@types/node']) {
    await linkInstalled(nodeModules, name);
  }
});

after(async () => {
  if (workDir !== '') await rm(workDir, { recursive: true, force: true });
});

test('default (TS) template typechecks before the first server start', async () => {
  const projectDir = await scaffold('ts-server', ['--ts', '--server']);
  assert.deepEqual(typecheck(projectDir, 'tsconfig.json'), []);
});

test('default (TS) template typechecks against its generated routes, which reject unknown patterns', async () => {
  const projectDir = join(workDir, 'ts-server');
  await writeRouteTypes(projectDir, TEMPLATE_ROUTES);
  await writeFile(
    join(projectDir, 'app', 'route-check.ts'),
    `import type { GetServerSideProps, PageProps } from '@gio.js/core';
import { href } from '@gio.js/react';

export const ok: GetServerSideProps<{ id: string }, '/posts/:id'> = async (ctx) => ({
  props: { id: ctx.params.id },
});
export const link: string = href('/posts/:id', { id: '1' });
// @ts-expect-error - not a route of this app
export type Typo = PageProps<'/post/:id'>;
// @ts-expect-error - '/posts/:id' has no 'slug' param
export const wrong = (props: PageProps<'/posts/:id'>): string => props.params.slug;
`,
  );
  assert.deepEqual(typecheck(projectDir, 'tsconfig.json'), []);
});

test('the TS static-site scaffold typechecks', async () => {
  const projectDir = await scaffold('ts-static', ['--ts', '--static']);
  assert.deepEqual(typecheck(projectDir, 'tsconfig.json'), []);
});

test('default-js template typechecks its JSDoc types with checkJs', async () => {
  const projectDir = await scaffold('js-server', ['--js', '--server']);
  // maxNodeModuleJsDepth 0: the symlinked workspace packages would otherwise
  // have their plain .js files checked too, which an npm install never does.
  assert.deepEqual(typecheck(projectDir, 'jsconfig.json', { checkJs: true, maxNodeModuleJsDepth: 0 }), []);
});

test('both templates depend on @gio.js/core directly', async () => {
  // App code imports its types; under pnpm (strict node_modules) only direct
  // dependencies resolve.
  for (const template of ['default', 'default-js']) {
    const pkg = JSON.parse(
      await readFile(join(packagesDir, 'giojs-cli', 'templates', template, 'package.json'), 'utf8'),
    ) as { dependencies: Record<string, string> };
    assert.equal(pkg.dependencies['@gio.js/core'], pkg.dependencies['@gio.js/react'], template);
  }
});
