/**
 * giojs-core/src/typed-routes.test.ts
 *
 * generateRouteTypes must emit a declaration-merging .d.ts covering static,
 * :param, and *catchall patterns; writeRouteTypes must create .gio/routes.d.ts
 * and skip rewrites when the content is unchanged (tsc watch churn).
 */
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { generateRouteTypes, writeRouteTypes } from './typed-routes.ts';

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureRoot = join(packageDir, '.typed-routes-test-fixture');

describe('generateRouteTypes', () => {
  it('augments @gio.js/react as a module file', () => {
    const output = generateRouteTypes(['/']);
    expect(output).toContain("declare module '@gio.js/react' {");
    expect(output).toContain('interface GioRegisteredRoutes {');
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
