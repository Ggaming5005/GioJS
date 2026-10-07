/**
 * giojs-cli/test/template-typecheck.test.ts
 *
 * A fresh scaffold must typecheck - beta.7 shipped one whose `tsc --noEmit`
 * failed. Each template is scaffolded into a temp dir next to a
 * node_modules laid out the way npm installs the published packages:
 * @gio.js/core as package.json + its built declarations (dist/types),
 * @gio.js/react as package.json + its built dist/, React and the @types
 * packages from the workspace. So this also proves the published types
 * work without the .ts sources (which app tsconfigs cannot compile).
 *
 * The TS template is checked before the first server start (no
 * .gio/routes.d.ts: params come from the patterns themselves) and with the
 * routes.d.ts the worker generates, where an unregistered pattern must
 * fail. The JS template's JSDoc types are checked with checkJs.
 *   npm test
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { copyTemplate } from '../src/copy-template.ts';
import { writeRouteTypes } from '../../giojs-core/src/typed-routes.ts';

const packagesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const coreDir = join(packagesDir, 'giojs-core');
const reactDir = join(packagesDir, 'giojs-react');

/** The routes the server discovers in the templates' app/ folders. */
const TEMPLATE_ROUTES = ['/', '/about', '/posts/:id'];

let workDir = '';
let nodeModules = '';

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[], base: string): string[] {
  return diagnostics.map(diagnostic => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    if (diagnostic.file === undefined || diagnostic.start === undefined) return message;
    const { line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    return `${relative(base, diagnostic.file.fileName)}:${line + 1}: ${message}`;
  });
}

function parseConfig(configPath: string, overrides: ts.CompilerOptions): ts.ParsedCommandLine {
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, overrides, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: diagnostic => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    },
  });
  if (parsed === undefined) throw new Error(`${configPath} did not parse`);
  return parsed;
}

/** Run a package's tsconfig.build.json, emitting into `outDir`. */
function buildPackage(packageDir: string, outDir: string): void {
  const config = parseConfig(join(packageDir, 'tsconfig.build.json'), { outDir });
  const program = ts.createProgram(config.fileNames, config.options);
  const result = program.emit();
  const errors = formatDiagnostics([...ts.getPreEmitDiagnostics(program), ...result.diagnostics], packageDir);
  assert.deepEqual(errors, [], `building ${packageDir} failed`);
}

/** What `tsc --noEmit -p <config>` reports for the project. */
function typecheck(projectDir: string, configName: string, overrides: ts.CompilerOptions = {}): string[] {
  const config = parseConfig(join(projectDir, configName), { ...overrides, noEmit: true });
  const program = ts.createProgram(config.fileNames, config.options);
  return formatDiagnostics(ts.getPreEmitDiagnostics(program), projectDir);
}

/** Link a package the workspace installed (pnpm layout) into `nodeModules`. */
async function linkInstalled(name: string): Promise<void> {
  const target = await realpath(join(coreDir, 'node_modules', name));
  await mkdir(dirname(join(nodeModules, name)), { recursive: true });
  await symlink(target, join(nodeModules, name), 'junction');
}

async function scaffold(template: string): Promise<string> {
  const projectDir = join(workDir, template);
  await copyTemplate(template, projectDir, 'typecheck-app');
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
    await linkInstalled(name);
  }
});

after(async () => {
  if (workDir !== '') await rm(workDir, { recursive: true, force: true });
});

test('default (TS) template typechecks before the first server start', async () => {
  const projectDir = await scaffold('default');
  assert.deepEqual(typecheck(projectDir, 'tsconfig.json'), []);
});

test('default (TS) template typechecks against its generated routes, which reject unknown patterns', async () => {
  const projectDir = join(workDir, 'default');
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

test('default-js template typechecks its JSDoc types with checkJs', async () => {
  const projectDir = await scaffold('default-js');
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
