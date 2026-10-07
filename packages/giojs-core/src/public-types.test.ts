/**
 * giojs-core/src/public-types.test.ts
 *
 * Type-level tests of the @gio.js/core app types. The fixtures under
 * test-fixtures/types are typechecked as app code would be - `@gio.js/core`
 * by package name, strict settings - and must produce no diagnostics: their
 * `@ts-expect-error` lines are the negative cases (an unused one is itself
 * an error). `registered/` runs with a .gio/routes.d.ts written by the real
 * generator, `unregistered/` without one.
 *
 * Also guards the public surface: every interface or class that an export
 * of public.ts names in its signature must be exported too, so app code can
 * annotate what the API hands it.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { writeRouteTypes } from './typed-routes.ts';

const srcDir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(srcDir, '..', 'test-fixtures', 'types');
const publicEntry = join(srcDir, 'public.ts');

/** What the fixtures' app routes would generate. */
const APP_PATTERNS = [
  '/',
  '/about',
  '/posts/:id',
  '/users/:userId/posts/:postId',
  '/docs/*slug',
  '/shop/*path?',
  '/api/posts/:id',
];

const compilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
  strict: true,
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true,
  noEmit: true,
  // The sources, not a possibly stale dist/types build: the package's own
  // types under test. (Only resolving through src/ needs the .ts imports.)
  allowImportingTsExtensions: true,
  paths: { '@gio.js/core': [publicEntry] },
  types: ['node', 'react'],
  // vitest's own declarations (expectTypeOf) do not pass
  // exactOptionalPropertyTypes; the generated routes.d.ts is checked
  // without this in typed-routes.test.ts.
  skipLibCheck: true,
};

async function fixtureFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  return entries.filter(name => /\.tsx?$/.test(name)).map(name => join(dir, name));
}

function diagnostics(rootNames: string[]): string[] {
  const program = ts.createProgram(rootNames, compilerOptions);
  return ts.getPreEmitDiagnostics(program).map(diagnostic => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    if (diagnostic.file === undefined || diagnostic.start === undefined) return message;
    const { line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    return `${relative(fixturesDir, diagnostic.file.fileName)}:${line + 1}: ${message}`;
  });
}

describe('@gio.js/core app types', () => {
  it('type params from the generated .gio/routes.d.ts and check every convention', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'gio-public-types-'));
    try {
      await writeRouteTypes(projectRoot, APP_PATTERNS);
      const files = await fixtureFiles(join(fixturesDir, 'registered'));
      expect(diagnostics([...files, join(projectRoot, '.gio', 'routes.d.ts')])).toEqual([]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it('parse params from the pattern when no routes are registered', async () => {
    const files = await fixtureFiles(join(fixturesDir, 'unregistered'));
    expect(diagnostics(files)).toEqual([]);
  }, 60_000);
});

// ── public surface ────────────────────────────────────────────────────────────

/** Declaration parts that make up a public signature (never bodies). */
function signatureParts(node: ts.Node): ts.Node[] {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)) {
    return [...(node.typeParameters ?? []), ...node.parameters, ...(node.type !== undefined ? [node.type] : [])];
  }
  if (ts.isClassDeclaration(node)) {
    const isPublic = (member: ts.ClassElement): boolean =>
      !(ts.getCombinedModifierFlags(member) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) &&
      !(member.name !== undefined && ts.isPrivateIdentifier(member.name));
    return [
      ...(node.heritageClauses ?? []),
      ...node.members.filter(isPublic).flatMap(member =>
        ts.isPropertyDeclaration(member) ? (member.type !== undefined ? [member.type] : []) : signatureParts(member),
      ),
    ];
  }
  return [node];
}

function isGlobalAugmentation(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
    if (ts.isModuleDeclaration(current) && current.flags & ts.NodeFlags.GlobalAugmentation) return true;
  }
  return false;
}

function unexportedReferences(): string[] {
  const program = ts.createProgram([publicEntry], compilerOptions);
  const checker = program.getTypeChecker();
  const resolve = (symbol: ts.Symbol): ts.Symbol =>
    symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const moduleSymbol = checker.getSymbolAtLocation(program.getSourceFile(publicEntry)!);
  const exports = checker.getExportsOfModule(moduleSymbol!);
  const exported = new Set(exports.map(resolve));

  const missing = new Set<string>();
  for (const exportSymbol of exports) {
    const visit = (node: ts.Node): void => {
      const name = ts.isTypeReferenceNode(node)
        ? node.typeName
        : ts.isExpressionWithTypeArguments(node)
          ? node.expression
          : undefined;
      const referenced = name !== undefined ? checker.getSymbolAtLocation(name) : undefined;
      if (referenced !== undefined) {
        const target = resolve(referenced);
        const declaredInCore = (target.declarations ?? []).some(decl =>
          decl.getSourceFile().fileName.startsWith(srcDir),
        );
        // `declare global` types (GioJS.*) need no import to be named.
        const isGlobal = (target.declarations ?? []).some(isGlobalAugmentation);
        if (
          target.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.Class) &&
          declaredInCore &&
          !isGlobal &&
          !exported.has(target)
        ) {
          missing.add(`${exportSymbol.name} → ${target.name}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    for (const declaration of resolve(exportSymbol).declarations ?? []) {
      for (const part of signatureParts(declaration)) visit(part);
    }
  }
  return [...missing].sort();
}

describe('public.ts', () => {
  it('exports every interface and class its exports name in their signatures', () => {
    expect(unexportedReferences()).toEqual([]);
  }, 60_000);
});
