/**
 * A GitHub Actions workflow for the generated app: install with the
 * project's package manager (from its lockfile), typecheck (TypeScript
 * projects), run the tests when there is a test script, then build what
 * gets deployed - the `gio build standalone` folder for a server app, the
 * `gio export` site for a static one - and keep it as a workflow artifact.
 */
import type { PackageManager } from '../package-manager.js';
import type { Overlay, OverlayContext } from '../types.js';

/** Steps that put the package manager on the runner, before setup-node. */
function managerSetup(pm: PackageManager): string[] {
  if (pm.name === 'pnpm') return ['      - uses: pnpm/action-setup@v4', '        with:', '          version: 10'];
  if (pm.name === 'bun') return ['      - uses: oven-sh/setup-bun@v2'];
  return [];
}

function testCommand(pm: PackageManager, hasTestScript: boolean): string | null {
  // npm and pnpm skip a missing script themselves, so a test script added
  // later runs without editing the workflow.
  if (pm.name === 'npm') return 'npm test --if-present';
  if (pm.name === 'pnpm') return 'pnpm run --if-present test';
  return hasTestScript ? pm.run('test') : null;
}

function step(name: string, run: string): string[] {
  return [`      - name: ${name}`, `        run: ${run}`];
}

export function ciWorkflow(ctx: OverlayContext): string {
  const pm = ctx.packageManager;
  const scripts = ctx.packageJson.scripts ?? {};
  const cache = pm.name === 'bun' ? [] : ['          cache: ' + pm.name];
  const test = testCommand(pm, scripts['test'] !== undefined);
  const deploy =
    ctx.mode === 'server'
      ? [
          ...(scripts['build'] !== undefined ? step('Build', pm.run('build')) : []),
          ...step('Build standalone', pm.exec('gio build standalone')),
          '      - uses: actions/upload-artifact@v4',
          '        with:',
          '          name: standalone',
          '          path: standalone/',
          // .gio/manifest.json is part of the deploy folder.
          '          include-hidden-files: true',
          '          retention-days: 7',
        ]
      : [
          ...step('Export the static site', pm.run('build')),
          '      - uses: actions/upload-artifact@v4',
          '        with:',
          '          name: site',
          '          path: out/',
          '          retention-days: 7',
        ];

  const lines = [
    `# CI for ${ctx.projectName}: install, typecheck, test, build.`,
    'name: CI',
    '',
    'on:',
    '  push:',
    '    branches: [main]',
    '  pull_request:',
    '',
    'permissions:',
    '  contents: read',
    '',
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    ...managerSetup(pm),
    '      - uses: actions/setup-node@v4',
    '        with:',
    '          node-version: 22',
    ...cache,
    ...step('Install', pm.ci),
    ...(ctx.language === 'ts' ? step('Typecheck', pm.exec('tsc --noEmit')) : []),
    ...(test !== null ? step('Test', test) : []),
    ...deploy,
  ];
  return lines.join('\n') + '\n';
}

export const ci: Overlay = {
  name: 'ci',
  title: 'GitHub Actions CI',
  hint: 'install, typecheck, test and build on every push',
  modes: ['server', 'static'],
  agents: '- CI: `.github/workflows/ci.yml` installs, typechecks, tests and builds on every push.',
  generate: ctx => [{ path: '.github/workflows/ci.yml', content: ciWorkflow(ctx) }],
  postSteps: ctx => [
    `Commit your lockfile (${ctx.packageManager.lockfile}): CI installs from it.`,
  ],
};
