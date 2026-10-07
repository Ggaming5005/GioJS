/**
 * giojs-core/src/typed-routes.test.ts
 *
 * generateRouteTypes must emit a declaration-merging .d.ts covering static,
 * :param, *catchall, and optional *catchall? patterns; writeRouteTypes must create .gio/routes.d.ts
 * and skip rewrites when the content is unchanged (tsc watch churn). The
 * generated files also type CSS imports, so the default template's tsconfig
 * typechecks `import styles from './x.module.css'`.
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import { CSS_MODULE_TYPES, generateRouteTypes, writeRouteTypes } from './typed-routes.ts';
import { discoverRoutes } from './router.ts';

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureRoot = join(packageDir, '.typed-routes-test-fixture');

describe('generateRouteTypes', () => {
  it('fills the global GioJS.RegisteredRoutes registry from a module file', () => {
    const output = generateRouteTypes(['/']);
    expect(output).toContain('declare global {');
    expect(output).toContain('namespace GioJS {');
    expect(output).toContain('interface RegisteredRoutes {');
    // No module augmentation: the file must not depend on which @gio.js/*
    // packages the project can resolve.
    expect(output).not.toContain('declare module');
    expect(output).toContain('export {};');
  });

  it('maps the root and other static routes to Record<string, never>', () => {
    const output = generateRouteTypes(['/', '/about']);
    expect(output).toContain("'/': Record<string, never>;");
    expect(output).toContain("'/about': Record<string, never>;");
  });

  it('maps :param segments to string fields', () => {
    const output = generateRouteTypes(['/posts/:id', '/users/:userId/posts/:postId']);
    expect(output).toContain("'/posts/:id': { id: string };");
    expect(output).toContain(
      "'/users/:userId/posts/:postId': { userId: string; postId: string };",
    );
  });

  it('maps *catchall segments to string fields', () => {
    const output = generateRouteTypes(['/docs/*slug']);
    expect(output).toContain("'/docs/*slug': { slug: string };");
  });

  it('maps optional *catchall? segments to optional string fields', () => {
    const output = generateRouteTypes(['/shop/*path?', '/u/:id/*rest?']);
    expect(output).toContain("'/shop/*path?': { path?: string };");
    expect(output).toContain("'/u/:id/*rest?': { id: string; rest?: string };");
  });

  it('types the patterns discovery produces: groups stripped, catch-alls typed', async () => {
    const appDir = join(fixtureRoot, 'discovered', 'app');
    const page = 'export default function P() { return null; }';
    for (const dir of ['(marketing)/about', 'docs/[...slug]', '(shop)/shop/[[...path]]', '_lib']) {
      await mkdir(join(appDir, dir), { recursive: true });
      await writeFile(join(appDir, dir, 'page.tsx'), page);
    }
    const routes = await discoverRoutes(appDir);
    const output = generateRouteTypes([...routes.keys()]);
    expect(output).toContain("'/about': Record<string, never>;");
    expect(output).toContain("'/docs/*slug': { slug: string };");
    expect(output).toContain("'/shop/*path?': { path?: string };");
    expect(output).not.toContain('(marketing)');
    expect(output).not.toContain('_lib');
  });

  it('deduplicates and sorts patterns for deterministic output', () => {
    const first = generateRouteTypes(['/b', '/a', '/a']);
    const second = generateRouteTypes(['/a', '/b']);
    expect(first).toBe(second);
  });

  it('quotes param names that are not valid identifiers', () => {
    const output = generateRouteTypes(['/x/:post-id']);
    expect(output).toContain("'/x/:post-id': { 'post-id': string };");
  });
});

describe('writeRouteTypes', () => {
  afterAll(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it('creates .gio/routes.d.ts under the project root', async () => {
    const projectRoot = join(fixtureRoot, 'create');
    await mkdir(projectRoot, { recursive: true });

    const wrote = await writeRouteTypes(projectRoot, ['/', '/posts/:id']);
    expect(wrote).toBe(true);

    const content = await readFile(join(projectRoot, '.gio', 'routes.d.ts'), 'utf8');
    expect(content).toBe(generateRouteTypes(['/', '/posts/:id']));
  });

  it('writes the CSS import types routes.d.ts references next to it', async () => {
    const projectRoot = join(fixtureRoot, 'css-types-file');
    await mkdir(projectRoot, { recursive: true });

    await writeRouteTypes(projectRoot, ['/']);
    const routes = await readFile(join(projectRoot, '.gio', 'routes.d.ts'), 'utf8');
    expect(routes).toContain('/// <reference path="./css-modules.d.ts" />');
    // A triple-slash directive only counts before the first statement.
    expect(routes.indexOf('/// <reference')).toBeLessThan(routes.indexOf('declare global'));
    expect(await readFile(join(projectRoot, '.gio', 'css-modules.d.ts'), 'utf8')).toBe(CSS_MODULE_TYPES);
  });

  it('skips the write when content is unchanged', async () => {
    const projectRoot = join(fixtureRoot, 'unchanged');
    await mkdir(projectRoot, { recursive: true });
    const typesPath = join(projectRoot, '.gio', 'routes.d.ts');

    await writeRouteTypes(projectRoot, ['/docs/*slug']);
    const before = await stat(typesPath);

    const wrote = await writeRouteTypes(projectRoot, ['/docs/*slug']);
    const after = await stat(typesPath);
    expect(wrote).toBe(false);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('rewrites when the pattern set changes', async () => {
    const projectRoot = join(fixtureRoot, 'changed');
    await mkdir(projectRoot, { recursive: true });

    await writeRouteTypes(projectRoot, ['/']);
    const wrote = await writeRouteTypes(projectRoot, ['/', '/posts/:id']);
    expect(wrote).toBe(true);

    const content = await readFile(join(projectRoot, '.gio', 'routes.d.ts'), 'utf8');
    expect(content).toContain("'/posts/:id': { id: string };");
  });

  it('overwrites a stale hand-edited file', async () => {
    const projectRoot = join(fixtureRoot, 'stale');
    const gioDir = join(projectRoot, '.gio');
    await mkdir(gioDir, { recursive: true });
    await writeFile(join(gioDir, 'routes.d.ts'), 'stale content', 'utf8');

    const wrote = await writeRouteTypes(projectRoot, ['/']);
    expect(wrote).toBe(true);

    const content = await readFile(join(gioDir, 'routes.d.ts'), 'utf8');
    expect(content).toContain("'/': Record<string, never>;");
  });
});

describe('CSS import types', () => {
  const templateTsconfig = join(packageDir, '..', 'giojs-cli', 'templates', 'default', 'tsconfig.json');

  /** Messages tsc reports for the project, as `tsc --noEmit` would. */
  function typecheck(projectRoot: string): string[] {
    const config = ts.getParsedCommandLineOfConfigFile(join(projectRoot, 'tsconfig.json'), {}, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: diagnostic => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
      },
    });
    if (config === undefined) throw new Error('tsconfig.json did not parse');
    const program = ts.createProgram(config.fileNames, config.options);
    return ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  }

  it("let the default template's tsconfig typecheck CSS Module and global CSS imports", async () => {
    // Outside the repo, so no node_modules/@types leak into the program.
    const projectRoot = await mkdtemp(join(tmpdir(), 'gio-css-types-'));
    try {
      await mkdir(join(projectRoot, 'app'), { recursive: true });
      await writeFile(join(projectRoot, 'tsconfig.json'), await readFile(templateTsconfig, 'utf8'));
      await writeFile(join(projectRoot, 'app', 'card.module.css'), '.card { color: red; }\n');
      await writeFile(join(projectRoot, 'app', 'globals.css'), 'body { margin: 0; }\n');
      await writeFile(
        join(projectRoot, 'app', 'page.ts'),
        `import styles from './card.module.css';
import './globals.css';
export const card: string | undefined = styles.card;
export const link: string | undefined = styles['nav-link'];
// @ts-expect-error class names are strings, never numbers
export const wrong: number = styles.card;
`,
      );
      expect(typecheck(projectRoot)).toContain(
        "Cannot find module './card.module.css' or its corresponding type declarations.",
      );

      await writeRouteTypes(projectRoot, ['/']);
      expect(typecheck(projectRoot)).toEqual([]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
