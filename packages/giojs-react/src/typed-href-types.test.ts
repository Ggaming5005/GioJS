/**
 * packages/giojs-react/src/typed-href-types.test.ts
 *
 * Type-level tests of href() and useParams() with an empty route registry -
 * a project before its first server start (or `gio typegen`) writes
 * .gio/routes.d.ts. typed-href.test.ts registers routes for the whole
 * package program, so this runs the fixtures under test-fixtures/types as
 * a program of their own, `@gio.js/react` by package name and strict
 * settings. They must produce no diagnostics: their `@ts-expect-error`
 * lines are the negative cases (an unused one is itself an error).
 */
import { readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const srcDir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(srcDir, '..', 'test-fixtures', 'types');

const compilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
  strict: true,
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true,
  noEmit: true,
  // The sources, not a possibly stale dist build.
  paths: { '@gio.js/react': [join(srcDir, 'index.ts')] },
  types: ['node', 'react'],
  // vitest's own declarations (expectTypeOf) do not pass
  // exactOptionalPropertyTypes.
  skipLibCheck: true,
};

function diagnostics(rootNames: string[]): string[] {
  const program = ts.createProgram(rootNames, compilerOptions);
  return ts.getPreEmitDiagnostics(program).map(diagnostic => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    if (diagnostic.file === undefined || diagnostic.start === undefined) return message;
    const { line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    return `${relative(fixturesDir, diagnostic.file.fileName)}:${line + 1}: ${message}`;
  });
}

describe('href() and useParams() types without .gio/routes.d.ts', () => {
  it('read params from the pattern itself', async () => {
    const dir = join(fixturesDir, 'unregistered');
    const files = (await readdir(dir)).filter(name => /\.tsx?$/.test(name)).map(name => join(dir, name));
    expect(files.length).toBeGreaterThan(0);
    expect(diagnostics(files)).toEqual([]);
  }, 60_000);
});
