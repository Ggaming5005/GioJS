/**
 * giojs-core/src/standalone-gen.test.ts
 *
 * Entry generation for `gio build standalone`: import statements, registry
 * literal shape, and syntactic validity of the emitted module.
 */
import { describe, it, expect } from 'vitest';
import { transform } from 'esbuild';
import { resolve } from 'node:path';
import { generateStandaloneEntry, type StandaloneEntrySpec } from './standalone-gen.ts';

const CORE_ENTRY = resolve('/proj/core/src/standalone-entry.ts');

function fullSpec(): StandaloneEntrySpec {
  return {
    entryModulePath: CORE_ENTRY,
    routes: [
      { pattern: '/', filePath: resolve('/proj/app/page.tsx') },
      { pattern: '/posts/:id', filePath: resolve('/proj/app/posts/[id]/page.tsx') },
    ],
    layouts: [{ prefix: '/', filePath: resolve('/proj/app/layout.tsx') }],
    routeFiles: [{ pattern: '/api/notes', filePath: resolve('/proj/app/api/notes/route.ts') }],
    notFoundPath: resolve('/proj/app/not-found.tsx'),
    errorPath: resolve('/proj/app/error.tsx'),
    configPath: resolve('/proj/gio.config.ts'),
    middlewarePath: resolve('/proj/middleware.ts'),
    clientScripts: { '/': '/_next/static/chunks/route-index-ABC.js' },
  };
}

describe('generateStandaloneEntry', () => {
  it('emits one namespace import and one registry entry per route', () => {
    const source = generateStandaloneEntry(fullSpec());
    expect(source).toContain('import { runStandaloneServer } from ');
    expect(source).toContain('import * as gioPage0 from ');
    expect(source).toContain('import * as gioPage1 from ');
    expect(source).toContain('pattern: "/", ');
    expect(source).toContain('pattern: "/posts/:id", ');
    expect(source).toContain('module: gioPage0');
    expect(source).toContain('module: gioPage1');
  });

  it('uses forward-slashed absolute specifiers in every import', () => {
    const source = generateStandaloneEntry(fullSpec());
    for (const line of source.split('\n').filter(l => l.startsWith('import '))) {
      expect(line).not.toContain('\\');
      expect(line).toMatch(/from "(\/|[A-Za-z]:\/)/);
    }
  });

  it('wires layouts, route files, special pages, config, and middleware', () => {
    const source = generateStandaloneEntry(fullSpec());
    expect(source).toContain('prefix: "/", ');
    expect(source).toContain('module: gioLayout0');
    expect(source).toContain('pattern: "/api/notes", ');
    expect(source).toContain('module: gioRoute0');
    expect(source).toContain('specialPages: { notFound: gioNotFound, error: gioError }');
    expect(source).toContain('config: gioConfig.default,');
    expect(source).toContain('middleware: gioMiddleware.default,');
    expect(source).toContain('"/_next/static/chunks/route-index-ABC.js"');
  });

  it('omits optional sections that were not discovered', () => {
    const source = generateStandaloneEntry({
      entryModulePath: CORE_ENTRY,
      routes: [{ pattern: '/', filePath: resolve('/proj/app/page.tsx') }],
      layouts: [],
      routeFiles: [],
      clientScripts: {},
    });
    expect(source).not.toContain('specialPages');
    expect(source).not.toContain('gioConfig');
    expect(source).not.toContain('gioMiddleware');
    expect(source).not.toContain('gioNotFound');
    expect(source).toContain('clientScripts: {}');
  });

  it('emits a syntactically valid ES module', async () => {
    const source = generateStandaloneEntry(fullSpec());
    const result = await transform(source, { loader: 'js', format: 'esm' });
    expect(result.code).toContain('runStandaloneServer');
  });
});
