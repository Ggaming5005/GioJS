/**
 * giojs-core/src/standalone-gen.test.ts
 *
 * Entry generation for `gio build standalone`: import statements, registry
 * literal shape, and syntactic validity of the emitted module - and the
 * worker.js patch that keeps a module's import error for every importer.
 */
import { describe, it, expect } from 'vitest';
import { build, transform } from 'esbuild';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateStandaloneEntry, withStickyModuleErrors, type StandaloneEntrySpec } from './standalone-gen.ts';

const CORE_ENTRY = resolve('/proj/core/src/standalone-entry.ts');

function fullSpec(): StandaloneEntrySpec {
  return {
    entryModulePath: CORE_ENTRY,
    routes: [
      { pattern: '/', dir: '', filePath: resolve('/proj/app/page.tsx') },
      { pattern: '/posts/:id', dir: 'posts/[id]', filePath: resolve('/proj/app/posts/[id]/page.tsx') },
    ],
    layouts: [{ dir: '', filePath: resolve('/proj/app/layout.tsx') }],
    routeFiles: [{ pattern: '/api/notes', filePath: resolve('/proj/app/api/notes/route.ts') }],
    segmentFiles: [
      { kind: 'not-found', dir: 'posts/[id]', filePath: resolve('/proj/app/posts/[id]/not-found.tsx') },
      { kind: 'loading', dir: '(shop)', filePath: resolve('/proj/app/(shop)/loading.tsx') },
    ],
    metadataRoutes: [
      { kind: 'sitemap', filePath: resolve('/proj/app/sitemap.ts') },
      { kind: 'robots', filePath: resolve('/proj/app/robots.ts') },
    ],
    notFoundPath: resolve('/proj/app/not-found.tsx'),
    errorPath: resolve('/proj/app/error.tsx'),
    configPath: resolve('/proj/gio.config.ts'),
    middlewarePath: resolve('/proj/middleware.ts'),
    clientScripts: { '/': '/_next/static/chunks/route-index-ABC.js' },
    stylesheets: {
      routes: { '/': ['/_next/static/css/root-AAA.css', '/_next/static/css/route-index-BBB.css'] },
      segmentPages: { 'notFound:': ['/_next/static/css/root-AAA.css'] },
    },
  };
}

describe('generateStandaloneEntry', () => {
  it('emits one registry entry with a lazy loader per route', () => {
    const source = generateStandaloneEntry(fullSpec());
    expect(source).toContain('import { runStandaloneServer } from ');
    expect(source).toMatch(/pattern: "\/", [^\n]*load: \(\) => import\("[^"]*\/app\/page\.tsx"\)/);
    expect(source).toMatch(/pattern: "\/posts\/:id", [^\n]*load: \(\) => import\("[^"]*\/posts\/\[id\]\/page\.tsx"\)/);
  });

  it('imports per-route modules lazily, and only gio.config and middleware statically', () => {
    const source = generateStandaloneEntry(fullSpec());
    const statics = source.split('\n').filter(l => l.startsWith('import '));
    expect(statics).toHaveLength(3);
    expect(statics.join('\n')).toMatch(/runStandaloneServer[\s\S]*gioConfig[\s\S]*gioMiddleware/);
    // 2 pages, 1 layout, 1 route file, 2 segment files, 2 metadata routes, 2 special pages.
    expect(source.match(/\(\) => import\(/g)).toHaveLength(10);
  });

  it('uses forward-slashed absolute specifiers in every import', () => {
    const source = generateStandaloneEntry(fullSpec());
    const specifiers = [...source.matchAll(/(?:from |import\()("[^"]*")/g)].map(m => m[1] ?? '');
    expect(specifiers).toHaveLength(13);
    for (const specifier of specifiers) {
      expect(specifier).not.toContain('\\');
      expect(specifier).toMatch(/^"(\/|[A-Za-z]:\/)/);
    }
  });

  it('wires layouts, route files, special pages, config, and middleware', () => {
    const source = generateStandaloneEntry(fullSpec());
    expect(source).toContain('dir: "", filePath: ');
    expect(source).toContain('dir: "posts/[id]", ');
    expect(source).toMatch(/dir: "", filePath: [^\n]*load: \(\) => import\("[^"]*\/app\/layout\.tsx"\)/);
    expect(source).toMatch(/pattern: "\/api\/notes", [^\n]*load: \(\) => import\("[^"]*\/api\/notes\/route\.ts"\)/);
    expect(source).toMatch(
      /specialPages: \{ notFound: \(\) => import\("[^"]*\/app\/not-found\.tsx"\), error: \(\) => import\("[^"]*\/app\/error\.tsx"\) \}/,
    );
    expect(source).toContain('config: gioConfig.default,');
    expect(source).toContain('middleware: gioMiddleware.default,');
    expect(source).toContain('"/_next/static/chunks/route-index-ABC.js"');
  });

  it('wires per-folder not-found, error and loading files with their kind and folder', () => {
    const source = generateStandaloneEntry(fullSpec());
    expect(source).toMatch(/\{ kind: "not-found", dir: "posts\/\[id\]", [^\n]*load: \(\) => import\("[^"]*\/not-found\.tsx"\) \}/);
    expect(source).toMatch(/\{ kind: "loading", dir: "\(shop\)", [^\n]*load: \(\) => import\("[^"]*\/loading\.tsx"\) \}/);
  });

  it('wires app/sitemap, app/robots and app/manifest modules with their kind', () => {
    const source = generateStandaloneEntry(fullSpec());
    expect(source).toMatch(/\{ kind: "sitemap", filePath: [^\n]*load: \(\) => import\("[^"]*\/sitemap\.ts"\) \}/);
    expect(source).toMatch(/\{ kind: "robots", filePath: [^\n]*load: \(\) => import\("[^"]*\/robots\.ts"\) \}/);
  });

  it('omits optional sections that were not discovered', () => {
    const source = generateStandaloneEntry({
      entryModulePath: CORE_ENTRY,
      routes: [{ pattern: '/', dir: '', filePath: resolve('/proj/app/page.tsx') }],
      layouts: [],
      routeFiles: [],
      clientScripts: {},
    });
    expect(source).not.toContain('specialPages');
    expect(source).not.toContain('segmentFiles');
    expect(source).not.toContain('metadataRoutes');
    expect(source).not.toContain('gioConfig');
    expect(source).not.toContain('gioMiddleware');
    expect(source).not.toContain('not-found');
    expect(source).not.toContain('stylesheets');
    expect(source).toContain('clientScripts: {}');
  });

  it('embeds the prebuilt stylesheet manifest in the registry', () => {
    const source = generateStandaloneEntry(fullSpec());
    // Evaluate the registry literal the way the bundle would see it.
    const literal = /^ {2}stylesheets: ([\s\S]*?),\n\}\);/m.exec(source)?.[1];
    expect(literal).toBeDefined();
    expect(JSON.parse(literal ?? '')).toEqual(fullSpec().stylesheets);
  });

  it('emits a syntactically valid ES module', async () => {
    const source = generateStandaloneEntry(fullSpec());
    const result = await transform(source, { loader: 'js', format: 'esm' });
    expect(result.code).toContain('runStandaloneServer');
  });
});

describe('withStickyModuleErrors', () => {
  /**
   * Bundle an entry that imports two modules sharing a lib that throws while
   * it is evaluated - lazily, the way `gio build standalone` bundles
   * worker.js - and report what each import() settled with.
   */
  async function importInTurn(patch: boolean): Promise<string[]> {
    const dir = await mkdtemp(join(tmpdir(), 'gio-sticky-'));
    try {
      await writeFile(join(dir, 'broken.ts'), "throw new Error('LIB_IMPORT_ERROR');\nexport const value = 1;\n");
      for (const name of ['first', 'second']) {
        await writeFile(join(dir, `${name}.ts`), "import { value } from './broken.ts';\nexport const read = () => value.toFixed();\n");
      }
      await writeFile(
        join(dir, 'entry.mjs'),
        'export const results = [];\n' +
          "for (const load of [() => import('./first.ts'), () => import('./second.ts'), () => import('./first.ts')]) {\n" +
          '  try { results.push(`ok ${(await load()).read()}`); } catch (error) { results.push(`threw ${error.message}`); }\n' +
          '}\n',
      );
      const outfile = join(dir, 'worker.mjs');
      await build({
        entryPoints: [join(dir, 'entry.mjs')],
        outfile,
        bundle: true,
        platform: 'node',
        format: 'esm',
        logLevel: 'silent',
      });
      const patched = withStickyModuleErrors(await readFile(outfile, 'utf8'));
      expect(patched).not.toBeNull();
      if (patch) await writeFile(outfile, patched ?? '');
      const mod = (await import(pathToFileURL(outfile).href)) as { results: string[] };
      return mod.results;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("fails every importer of a module that threw, like Node's ESM loader", async () => {
    expect(await importInTurn(true)).toEqual([
      'threw LIB_IMPORT_ERROR',
      'threw LIB_IMPORT_ERROR',
      'threw LIB_IMPORT_ERROR',
    ]);
  });

  it("is needed: unpatched, later importers get the module's undefined bindings", async () => {
    const results = await importInTurn(false);
    expect(results[0]).toBe('threw LIB_IMPORT_ERROR');
    expect(results[1]).toMatch(/^threw Cannot read properties of undefined/);
  });

  it('leaves a bundle without lazy modules alone, and refuses a helper it does not know', () => {
    expect(withStickyModuleErrors('console.log(1);\n')).toBe('console.log(1);\n');
    expect(withStickyModuleErrors('var __esm = (fn) => fn;\n')).toBeNull();
  });
});
