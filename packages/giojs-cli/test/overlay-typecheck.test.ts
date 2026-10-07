/**
 * giojs-cli/test/overlay-typecheck.test.ts
 *
 * A scaffold with every feature overlay applied must still typecheck, the
 * way template-typecheck.test.ts checks the bare templates: against a
 * node_modules laid out like an install of the published packages (core's
 * built declarations, react's dist), plus drizzle-orm from the workspace.
 * The TS template runs `tsc --noEmit` as is (before the first server start,
 * no generated .gio types); the JS template's JSDoc is checked with checkJs.
 *   npm test
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALL_FEATURES, applyFeatures, createNodeModules, scaffold, typecheck } from './overlay-helpers.ts';

let workDir = '';
let nodeModules = '';

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'gio-overlay-typecheck-'));
  nodeModules = join(workDir, 'node_modules');
  await createNodeModules(nodeModules);
});

after(async () => {
  if (workDir !== '') await rm(workDir, { recursive: true, force: true });
});

test('default (TS) template typechecks with every feature applied', async () => {
  const project = await scaffold(join(workDir, 'ts'), 'ts');
  const plan = await applyFeatures(project, ALL_FEATURES);
  assert.deepEqual(plan.manual, []);
  await symlink(nodeModules, join(project.dir, 'node_modules'), 'junction');
  assert.deepEqual(typecheck(project.dir, 'tsconfig.json'), []);
});

test('the TS overlays typecheck in a project whose @/* alias points at src/ (create-next-app --src-dir)', async () => {
  const project = await scaffold(join(workDir, 'src-dir'), 'ts');
  // The layout's own @/components imports keep resolving under src/.
  await mkdir(join(project.dir, 'src'));
  await rename(join(project.dir, 'components'), join(project.dir, 'src', 'components'));
  const tsconfigPath = join(project.dir, 'tsconfig.json');
  const tsconfig = JSON.parse(await readFile(tsconfigPath, 'utf8')) as {
    compilerOptions: { paths: Record<string, string[]> };
    include: string[];
  };
  tsconfig.compilerOptions.paths = { '@/*': ['./src/*'] };
  tsconfig.include = ['app', 'src', 'lib'];
  await writeFile(tsconfigPath, JSON.stringify(tsconfig, null, 2));
  await applyFeatures(project, ['api', 'auth', 'db']);
  await symlink(nodeModules, join(project.dir, 'node_modules'), 'junction');
  assert.deepEqual(typecheck(project.dir, 'tsconfig.json'), []);
});

test('default-js template typechecks its JSDoc with every feature applied', async () => {
  const project = await scaffold(join(workDir, 'js'), 'js');
  await applyFeatures(project, ALL_FEATURES);
  await symlink(nodeModules, join(project.dir, 'node_modules'), 'junction');
  // include: the overlays' lib/ files too, not only what app/ imports.
  // skipLibCheck: drizzle-orm's declarations need it (the TS overlay sets it).
  const errors = typecheck(project.dir, 'jsconfig.json', {
    checkJs: true,
    maxNodeModuleJsDepth: 0,
    skipLibCheck: true,
  });
  assert.deepEqual(errors, []);
});
