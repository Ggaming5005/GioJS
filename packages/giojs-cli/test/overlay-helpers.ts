/**
 * giojs-cli/test/overlay-helpers.ts
 *
 * Shared setup for the feature-overlay tests: scaffolding a template into a
 * temp dir, applying overlays through the built CLI modules (dist/ - the
 * sources import each other by .js specifiers, which node --test's type
 * stripping does not map), and a node_modules laid out the way an install
 * of the published packages looks (see template-typecheck.test.ts).
 */
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const cliDir = join(dirname(fileURLToPath(import.meta.url)), '..');
export const packagesDir = join(cliDir, '..');
export const repoRoot = join(packagesDir, '..');
export const coreDir = join(packagesDir, 'giojs-core');
export const reactDir = join(packagesDir, 'giojs-react');

const dist = (path: string): string => new URL(`../dist/${path}`, import.meta.url).href;

// Typed loosely on purpose: the test imports compiled JS.
export const overlays = (await import(dist('overlays/apply.js'))) as typeof import('../src/overlays/apply.ts');
export const overlayCli = (await import(dist('overlays/cli.js'))) as typeof import('../src/overlays/cli.ts');
export const toml = (await import(dist('overlays/toml.js'))) as typeof import('../src/overlays/toml.ts');
export const pm = (await import(dist('overlays/package-manager.js'))) as typeof import('../src/overlays/package-manager.ts');
export const addModule = (await import(dist('overlays/add.js'))) as typeof import('../src/overlays/add.ts');
export const tailwindFeature = (await import(dist('overlays/features/tailwind.js'))) as typeof import('../src/overlays/features/tailwind.ts');
const { copyTemplate } = (await import(dist('copy-template.js'))) as typeof import('../src/copy-template.ts');

export type Feature = 'tailwind' | 'api' | 'auth' | 'db' | 'docker' | 'ci';
export const ALL_FEATURES: Feature[] = ['tailwind', 'api', 'auth', 'db', 'docker', 'ci'];

export interface Scaffold {
  dir: string;
  language: 'ts' | 'js';
  mode: 'server' | 'static';
}

/** Copy a template the way create-giojs does (published package.json, no monorepo patch). */
export async function scaffold(dir: string, language: 'ts' | 'js' = 'ts', mode: 'server' | 'static' = 'server'): Promise<Scaffold> {
  await copyTemplate(language === 'js' ? 'default-js' : 'default', dir, 'overlay-app');
  if (mode === 'static') {
    const pkgPath = join(dir, 'package.json');
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as { scripts: Record<string, string> };
    pkg.scripts['build'] = 'gio export';
    delete pkg.scripts['start'];
    await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  }
  return { dir, language, mode };
}

export async function applyFeatures(
  project: Scaffold,
  features: Feature[],
  options: { force?: boolean; packageManager?: 'npm' | 'pnpm' | 'yarn' | 'bun' } = {},
): Promise<Awaited<ReturnType<typeof overlays.planOverlays>>> {
  const plan = await overlays.planOverlays(
    project.dir,
    features,
    {
      projectName: 'overlay-app',
      language: project.language,
      mode: project.mode,
      packageManager: pm.packageManager(options.packageManager ?? 'npm'),
    },
    options.force === undefined ? {} : { force: options.force },
  );
  if (plan.conflicts.length === 0 && plan.unsupported.length === 0) await overlays.applyPlan(project.dir, plan);
  return plan;
}

export async function read(dir: string, path: string): Promise<string> {
  return readFile(join(dir, path), 'utf8');
}

export async function readJson<T = Record<string, unknown>>(dir: string, path: string): Promise<T> {
  return JSON.parse(await read(dir, path)) as T;
}

// ── a node_modules like an install of the published packages ─────────────────

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

function buildPackage(packageDir: string, outDir: string): void {
  const config = parseConfig(join(packageDir, 'tsconfig.build.json'), { outDir });
  const program = ts.createProgram(config.fileNames, config.options);
  const result = program.emit();
  const errors = formatDiagnostics([...ts.getPreEmitDiagnostics(program), ...result.diagnostics], packageDir);
  assert.deepEqual(errors, [], `building ${packageDir} failed`);
}

/** What `tsc --noEmit -p <config>` reports for the project. */
export function typecheck(projectDir: string, configName: string, overrides: ts.CompilerOptions = {}): string[] {
  const config = parseConfig(join(projectDir, configName), { ...overrides, noEmit: true });
  const program = ts.createProgram(config.fileNames, config.options);
  return formatDiagnostics(ts.getPreEmitDiagnostics(program), projectDir);
}

async function linkFrom(nodeModules: string, fromPackage: string, name: string): Promise<void> {
  const target = await realpath(join(fromPackage, 'node_modules', name));
  await mkdir(dirname(join(nodeModules, name)), { recursive: true });
  await symlink(target, join(nodeModules, name), 'junction');
}

/**
 * @gio.js/core as its built declarations (or, with `coreSource`, a link to
 * the package itself - what the worker runs), @gio.js/react built, React,
 * the @types packages and drizzle-orm from the workspace.
 */
export async function createNodeModules(nodeModules: string, options: { coreSource?: boolean } = {}): Promise<void> {
  const coreOut = join(nodeModules, '@gio.js', 'core');
  if (options.coreSource === true) {
    await mkdir(dirname(coreOut), { recursive: true });
    await symlink(coreDir, coreOut, 'junction');
  } else {
    buildPackage(coreDir, join(coreOut, 'dist', 'types'));
    await cp(join(coreDir, 'package.json'), join(coreOut, 'package.json'));
  }
  const reactOut = join(nodeModules, '@gio.js', 'react');
  buildPackage(reactDir, join(reactOut, 'dist'));
  await cp(join(reactDir, 'package.json'), join(reactOut, 'package.json'));
  for (const name of ['react', 'react-dom', 'esbuild', '@types/react', '@types/react-dom', '@types/node']) {
    await linkFrom(nodeModules, coreDir, name);
  }
  await linkFrom(nodeModules, cliDir, 'drizzle-orm');
}
