/**
 * giojs-core/src/client-build.ts
 *
 * Builds the per-route client bundles that hydrate the #__gio boundary.
 * For each discovered route a small entry module is generated that imports
 * the page component plus the non-root layouts, error.* and loading.* files
 * of its ancestor folders and registers them with the shared client runtime.
 * esbuild bundles all entries in one pass (ESM + code splitting,
 * content-hashed names) into `.gio/build/static/chunks/`, which Rust serves
 * at `/_next/static/chunks/` with immutable caching.
 *
 * Server-only code is kept out of the bundles structurally, never by
 * rewriting source text: each generated entry imports ONLY the default export
 * of each app file, and the project's own modules - plus every module a
 * project file imports by binding (`import { x } from`, `export ... from`,
 * `import()`) - are marked side-effect free. esbuild's tree-shaking then
 * drops `getServerSideProps` / `getStaticPaths` in every export form
 * (declarations, `export { x as getServerSideProps }`, `export ... from`,
 * `export *`) together with whatever only they imported - project helpers
 * and npm packages alike. A module some project file imports bare
 * (`import 'x'`) keeps its side effects. The verdict is a function of the
 * module alone, decided from a scan of the project's imports before any
 * import is resolved, so the same code always builds the same chunks
 * (gioServerCodePlugin). Node builtin imports that survive are stubbed so a
 * stray server import can never fail the build.
 *
 * The `server-only` guard is the loud backstop: if `@gio.js/core/server-only`
 * (or the bare `server-only` specifier) or any `*.server.*` file is still
 * live in a route's client graph after tree-shaking - including through an
 * error.* or loading.* file - that route's bundle is rejected with the
 * importing file chain. `GIO_PUBLIC_*` variables present at build time are
 * inlined; every other `process.env.X` reads as undefined.
 *
 * CSS never ships in these bundles: a CSS Module import evaluates to its
 * class map (css-modules.ts - the names SSR renders) and any other `.css`
 * import to nothing. The stylesheets come from css-build.ts, and each entry
 * renders its route's links exactly as ssr.ts does (withStylesheets).
 *
 * A route whose entry fails to build is logged and served without hydration -
 * client build errors must not take down SSR, nor cost the other routes their
 * shared chunks. In dev the error is also handed to the error overlay
 * (client-build-errors.ts).
 */
import {
  build,
  transform,
  type Loader,
  type ImportKind,
  type Metafile,
  type OutputFile,
  type Plugin,
  type ResolveResult,
} from 'esbuild';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  emptySegmentFiles,
  segmentChainForDir,
  type RouteModule,
  type LayoutEntry,
  type SegmentChainLevel,
  type SegmentFiles,
} from './router.ts';
import { logger } from './logger.ts';
import { clearClientBuildErrors, recordClientBuildError } from './client-build-errors.ts';
import { cssImportsAsClassMapsPlugin } from './css-modules.ts';

export { clientBuildErrorFor } from './client-build-errors.ts';

/** Public URL prefix the Rust server maps to `.gio/build/static/chunks`. */
const PUBLIC_CHUNK_PATH = '/_next/static/chunks';

export interface ClientBuildOptions {
  routes: Map<string, RouteModule>;
  layouts: Map<string, LayoutEntry>;
  /** Per-folder error.* and loading.* (not-found.* is server-only) - see segment-tree.ts. */
  segmentFiles?: SegmentFiles;
  /** Project root (parent of app/); `.gio/` lives here. */
  projectRoot: string;
  dev: boolean;
  /** Extra module resolution dirs (tests use this to reach react). */
  nodePaths?: string[];
  /**
   * Static export: chunks go straight into `<outDir>/_next/static/chunks`
   * (the URLs pages reference), and the bundles see GIO_EXPORT=1 like the
   * export render did. Generated entries live under `.gio/export/`, so an
   * export never wipes a running server's build.
   */
  staticExportDir?: string;
  /**
   * Route pattern → its stylesheet URLs (css-build.ts). Each entry renders
   * them as React stylesheet resources ahead of the page tree, exactly as
   * ssr.ts does inside #__gio: hydration matches, and on client navigation
   * React loads a route's new stylesheets before revealing it.
   */
  stylesheets?: Map<string, string[]>;
}

/** Route pattern → public entry script URL (e.g. "/_next/static/chunks/route-index-ABC.js"). */
export type ClientManifest = Map<string, string>;

interface GeneratedEntry {
  name: string;
  file: string;
  pattern: string;
}

export function slugForPattern(pattern: string): string {
  if (pattern === '/') return 'index';
  return pattern.slice(1).replace(/[^a-zA-Z0-9_-]+/g, '_');
}

/** Forward-slashed absolute path, safe inside a generated import statement. */
function importPath(p: string): string {
  return JSON.stringify(resolve(p).split(sep).join('/'));
}

/**
 * The project's tsconfig.json (or jsconfig.json), handed to every esbuild
 * build: esbuild only auto-discovers it for files it resolves itself, and the
 * plugins here resolve and load most project files - so without it,
 * jsxImportSource, experimentalDecorators and friends would apply in SSR
 * (tsx) but silently not in the bundles.
 */
export function projectTsconfig(projectRoot: string): string | undefined {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const candidate = join(projectRoot, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Entry module for one route. `chain` is segmentChainForDir() of the route's
 * folder - the chain ssr.ts renders inside the #__gio boundary (the root
 * layout stays server-only HTML) - and both sides build the tree with
 * buildSegmentTree(), so the client wraps exactly what the server wrapped
 * or hydration mismatches. The route's stylesheets go in front of it with
 * withStylesheets(), as on the server.
 */
function generateEntrySource(
  pattern: string,
  route: RouteModule,
  chain: SegmentChainLevel[],
  runtimePath: string,
  stylesheets: readonly string[],
): string {
  const imports: string[] = [];
  const levels = chain.map((level, i) => {
    const binding = (name: string, file: { filePath: string } | undefined): string => {
      if (file === undefined) return 'null';
      imports.push(`import ${name}${i} from ${importPath(file.filePath)};`);
      return `${name}${i}`;
    };
    const layout = binding('Layout', level.layout);
    const error = binding('SegmentError', level.error);
    const loading = binding('Loading', level.loading);
    const params = level.params.length > 0 ? `, params: ${JSON.stringify(level.params)}` : '';
    return `  { layout: ${layout}, error: ${error}, loading: ${loading}${params} },`;
  });
  return `import React from 'react';
import { registerRoute, buildSegmentTree } from ${importPath(runtimePath)};
import { withStylesheets } from ${importPath(join(dirname(runtimePath), 'segment-tree.ts'))};
import Page from ${importPath(route.filePath)};
${imports.join('\n')}

const levels = [
${levels.join('\n')}
];
const stylesheets = ${JSON.stringify(stylesheets)};

registerRoute(${JSON.stringify(pattern)}, (props, path) =>
  withStylesheets(buildSegmentTree(React.createElement(Page, props), path, levels), stylesheets),
);
`;
}

function loaderForFile(path: string): Loader {
  const ext = extname(path);
  if (ext === '.tsx') return 'tsx';
  if (ext === '.ts' || ext === '.mts' || ext === '.cts') return 'ts';
  if (ext === '.jsx') return 'jsx';
  return 'js';
}

const NODE_BUILTIN_FILTER =
  /^(node:|fs$|path$|crypto$|os$|child_process$|net$|tls$|http$|https$|stream$|zlib$|worker_threads$|dns$|dgram$|cluster$|readline$|v8$|vm$|perf_hooks$|async_hooks$|inspector$)/;

/**
 * Specifiers that mark a module as server-only (ours, and the npm
 * package's). The testing kit counts as one: it would drag the whole server
 * runtime into the bundle, so the build names it instead of failing on
 * whatever Node builtin it trips over first.
 */
const SERVER_ONLY_SPECIFIER = /^(?:@gio\.js\/core\/(?:server-only|testing)|server-only)$/;
const SERVER_ONLY_NAMESPACE = 'gio-server-only';
/** `*.server.ts` / `.tsx` / `.js` / `.jsx` (+ module variants) never ship to the browser. */
const SERVER_FILE_PATTERN = /\.server\.(?:[cm]?[jt]s|[jt]sx)$/;
/**
 * Loose scans of a TypeScript module's source: one that names a server-only
 * specifier, and one that may declare an enum. False positives (the text in
 * a comment or string) only cost a needless compile in loadServerModule().
 */
const NAMES_SERVER_ONLY = /(['"])(?:@gio\.js\/core\/(?:server-only|testing)|server-only)\1/;
const MAY_DECLARE_ENUM = /\benum\s/;
const TS_FILE_PATTERN = /\.(?:[cm]?ts|tsx)$/;

/**
 * Bare side-effect imports (`import 'x'`) in `source`. A loose scan is safe:
 * a false positive (the text inside a comment or string) only keeps a
 * module's side effects, which is esbuild's default anyway.
 */
export function bareImportSpecifiers(source: string): Set<string> {
  const specifiers = new Set<string>();
  for (const match of source.matchAll(/(?<![\w$.])import\s*(['"])([^'"\r\n]+)\1/g)) {
    specifiers.add(match[2] as string);
  }
  return specifiers;
}

/** One import of a module that binds something from it (or loads it lazily). */
export interface BoundImport {
  specifier: string;
  kind: 'import-statement' | 'dynamic-import' | 'require-call';
}

/**
 * The binding imports in `source`: `import ... from`, `export ... from`,
 * `import()` and `require()` of a literal specifier. Loose like
 * bareImportSpecifiers(): a false positive (the text inside a comment or
 * string) only marks a module the project names side-effect free - the
 * verdict a real import of it gets anyway.
 */
export function boundImportSpecifiers(source: string): BoundImport[] {
  const found: BoundImport[] = [];
  const pattern =
    /(?<![\w$.])(?:from\s*(['"])([^'"\r\n]+)\1|import\s*\(\s*(['"])([^'"\r\n]+)\3\s*[,)]|require\s*\(\s*(['"])([^'"\r\n]+)\5\s*\))/g;
  for (const match of source.matchAll(pattern)) {
    if (match[2] !== undefined) found.push({ specifier: match[2], kind: 'import-statement' });
    else if (match[4] !== undefined) found.push({ specifier: match[4], kind: 'dynamic-import' });
    else if (match[6] !== undefined) found.push({ specifier: match[6], kind: 'require-call' });
  }
  return found;
}

/**
 * The `GIO_PUBLIC_*` variables in `env`. Keys esbuild cannot express as a
 * member chain (dashes etc.) are skipped instead of failing the whole build.
 */
export function publicEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && /^GIO_PUBLIC_[A-Za-z0-9_]+$/.test(key)) vars[key] = value;
  }
  return vars;
}

/** esbuild defines inlining every `GIO_PUBLIC_*` variable in `env`, JSON-encoded. */
export function publicEnvDefines(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(publicEnv(env)).map(([key, value]) => [
      `process.env.${key}`,
      JSON.stringify(value),
    ]),
  );
}

/**
 * Client bundle defines: the build-time `GIO_PUBLIC_*` values, inlined at
 * each `process.env.GIO_PUBLIC_X` read. `process.env` itself becomes an
 * object holding only those values (plus NODE_ENV and GIO_EXPORT), so
 * destructuring and `process.env[name]` see the same values the server
 * rendered with, and a non-public read is `undefined` in the browser - never
 * a secret, and never a `process is not defined` crash. The more specific
 * defines win over the object.
 */
export function clientEnvDefines(
  env: NodeJS.ProcessEnv,
  dev: boolean,
  staticExport = false,
): Record<string, string> {
  const visible = {
    NODE_ENV: dev ? 'development' : 'production',
    GIO_EXPORT: staticExport ? '1' : '0',
    ...publicEnv(env),
  };
  return {
    'process.env': JSON.stringify(visible),
    'process.env.NODE_ENV': JSON.stringify(visible.NODE_ENV),
    'process.env.GIO_EXPORT': JSON.stringify(visible.GIO_EXPORT),
    ...publicEnvDefines(env),
  };
}

/**
 * The import() targets of one bundle run (runEsbuild). esbuild makes every
 * dynamically imported module a chunk of its own before it shakes out the
 * code that imported it, so an `await import('../lib/db')` inside
 * getServerSideProps would still ship db as a public chunk - and, being
 * live, a `*.server.*` one would reject the route. A project file's import()
 * therefore stays external (a marker path no chunk is made for) until a pass
 * finds it in the output, i.e. in code that survived tree-shaking; only
 * those targets are bundled, on the next pass.
 */
interface DynamicImports {
  /** Resolved paths whose import() survived tree-shaking: bundled. */
  readonly live: Set<string>;
}

/** External marker for a project file's import() not known to be live yet. */
const DYNAMIC_IMPORT_MARKER = 'gio-dynamic-import:';

/** Project modules a live import() loads that this pass left external. */
function unbundledDynamicImports(metafile: Metafile): string[] {
  const found = new Set<string>();
  for (const output of Object.values(metafile.outputs)) {
    for (const imported of output.imports) {
      if (imported.external === true && imported.path.startsWith(DYNAMIC_IMPORT_MARKER)) {
        found.add(imported.path.slice(DYNAMIC_IMPORT_MARKER.length));
      }
    }
  }
  return [...found];
}

/** Marks gioServerCodePlugin's own nested resolutions, which its onResolve passes through. */
const GIO_RESOLVING = 'gio-resolving';
/** Modules the side-effect scan reads for imports (declaration files import nothing that ships). */
const SCANNED_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const DECLARATION_FILE = /\.d\.[cm]?ts$/;
/** Top-level project folders that hold no app source: static files and export output. */
const NON_SOURCE_TOP_DIRS = new Set(['public', 'out']);

/** Whether `path` is strictly inside `root`. */
function isInside(root: string, path: string): boolean {
  const rel = relative(root, resolve(path));
  return rel !== '' && !isAbsolute(rel) && rel.split(/[\\/]/)[0] !== '..';
}

/**
 * Whether `path` is one of the project's own source files: inside `root`
 * and not under node_modules, a dot folder (`.gio`, `.git`, ...), a
 * top-level `public/` or `out/`, or one of `excludedDirs`.
 */
export function isProjectSource(
  root: string,
  path: string,
  excludedDirs: readonly string[] = [],
): boolean {
  if (!isInside(root, path)) return false;
  if (excludedDirs.some(dir => path === dir || isInside(dir, path))) return false;
  const segments = relative(root, resolve(path)).split(/[\\/]/);
  if (segments.length > 1 && NON_SOURCE_TOP_DIRS.has(segments[0] as string)) return false;
  return segments.every(segment => segment !== 'node_modules' && !segment.startsWith('.'));
}

/** The project's source modules (isProjectSource) the side-effect scan reads. */
async function projectSourceModules(
  root: string,
  excludedDirs: readonly string[],
): Promise<string[]> {
  const found: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        // A folder is walked when a file directly inside it would count.
        if (isProjectSource(root, join(path, 'x'), excludedDirs)) await visit(path);
      } else if (
        entry.isFile() &&
        SCANNED_FILE.test(entry.name) &&
        !DECLARATION_FILE.test(entry.name) &&
        isProjectSource(root, path, excludedDirs)
      ) {
        found.push(path);
      }
    }
  };
  await visit(root);
  return found;
}

/** The imports one scanned module makes. */
interface ScannedModule {
  file: string;
  bare: string[];
  bound: BoundImport[];
}

/** What the project's modules import, resolved: targetKey()s. */
interface ProjectImportTargets {
  /** Modules some project file imports for their side effects (`import 'x'`). */
  sideEffect: Set<string>;
  /** Modules some project file binds from, or loads with import() / require(). */
  bound: Set<string>;
  /** False when a resolution threw (not merely failed to resolve): worth retrying. */
  complete: boolean;
}

/** A resolved module's identity: esbuild keys modules by namespace and path. */
function targetKey(resolved: { namespace: string; path: string }): string {
  return `${resolved.namespace}:${resolved.path}`;
}

/**
 * Read the imports of every project source module plus `extraFiles` (the
 * generated entries). Order-free: only set membership is used.
 */
async function scanProjectImports(
  root: string,
  extraFiles: readonly string[],
  excludedDirs: readonly string[],
): Promise<ScannedModule[]> {
  const files = [...(await projectSourceModules(root, excludedDirs)), ...extraFiles];
  return Promise.all(
    files.map(async file => {
      const source = await readFile(file, 'utf8').catch(() => '');
      return { file, bare: [...bareImportSpecifiers(source)], bound: boundImportSpecifiers(source) };
    }),
  );
}

type ResolveFrom = (
  specifier: string,
  importer: string,
  resolveDir: string,
  kind: ImportKind,
) => Promise<ResolveResult>;

/**
 * Resolve the scanned imports, as esbuild resolves them from those files.
 * A binding import whose path already names a project source is not
 * resolved: such a module is side-effect free without being listed. That
 * shortcut (like any miss here) can only leave a module with esbuild's
 * default; it never makes the verdict depend on the import.
 */
async function resolveImportTargets(
  scanned: Promise<ScannedModule[]>,
  resolveFrom: ResolveFrom,
  isSource: (path: string) => boolean,
): Promise<ProjectImportTargets> {
  const targets: ProjectImportTargets = { sideEffect: new Set(), bound: new Set(), complete: true };
  // One resolution per (directory, specifier, kind): the result depends on
  // nothing else (the tsconfig is the build's).
  const resolutions = new Map<string, Promise<string | null>>();
  const add = async (
    into: Set<string>,
    file: string,
    specifier: string,
    kind: ImportKind,
  ): Promise<void> => {
    const resolveDir = dirname(file);
    const memo = `${resolveDir}\0${kind}\0${specifier}`;
    let pending = resolutions.get(memo);
    if (pending === undefined) {
      // (A resolver that throws, even synchronously, lands in the rejection.)
      pending = Promise.resolve()
        .then(() => resolveFrom(specifier, file, resolveDir, kind))
        .then(
          // Unresolvable: no module to decide for.
          resolved =>
            resolved.errors.length === 0 && !resolved.external ? targetKey(resolved) : null,
          () => {
            targets.complete = false;
            return null;
          },
        );
      resolutions.set(memo, pending);
    }
    const key = await pending;
    if (key !== null) into.add(key);
  };
  const namesSource = (file: string, specifier: string): boolean =>
    (specifier.startsWith('.') || isAbsolute(specifier)) &&
    isSource(resolve(dirname(file), specifier));
  await Promise.all(
    (await scanned).flatMap(({ file, bare, bound }) => [
      ...bare.map(specifier => add(targets.sideEffect, file, specifier, 'import-statement')),
      ...bound
        .filter(({ specifier }) => !namesSource(file, specifier))
        .map(({ specifier, kind }) => add(targets.bound, file, specifier, kind)),
    ]),
  );
  return targets;
}

interface ServerCodePluginOptions {
  projectRoot: string;
  dynamicImports: DynamicImports;
  /** Generated entry modules: their imports count as the project's. */
  entryFiles: readonly string[];
  /** Folders inside the project that hold no source (a static export's output). */
  excludedDirs: readonly string[];
}

export function gioServerCodePlugin(options: ServerCodePluginOptions): Plugin {
  const root = resolve(options.projectRoot);
  const { dynamicImports } = options;
  const excludedDirs = options.excludedDirs.map(dir => resolve(dir));
  const isSource = (path: string): boolean => isProjectSource(root, path, excludedDirs);
  // Found once, during the first build that needs them, for every pass and
  // every build of one buildClientBundles(): they all decide alike. That
  // build cannot end first - the onResolve that started it awaits it.
  let targets: Promise<ProjectImportTargets> | undefined;
  return {
    name: 'gio-server-code',
    setup(pluginBuild) {
      // Node builtins become empty stubs: never executed client-side, and a
      // stray server import must not fail the whole client build.
      pluginBuild.onResolve({ filter: NODE_BUILTIN_FILTER }, args => ({
        path: args.path,
        namespace: 'gio-node-stub',
      }));
      // CJS shape so any named import (`import { readFileSync } from 'fs'`)
      // passes build-time export checks and resolves to undefined at runtime.
      pluginBuild.onLoad({ filter: /.*/, namespace: 'gio-node-stub' }, () => ({
        contents: 'module.exports = {};',
        loader: 'js',
      }));

      // server-only becomes a side-effectful marker module: it survives
      // tree-shaking exactly when its importer is live client code, which is
      // what findServerOnlyChain() looks for in the metafile. A bundle that
      // contains it is never written.
      pluginBuild.onResolve({ filter: SERVER_ONLY_SPECIFIER }, args => ({
        path: args.path,
        namespace: SERVER_ONLY_NAMESPACE,
      }));
      pluginBuild.onLoad({ filter: /.*/, namespace: SERVER_ONLY_NAMESPACE }, () => ({
        contents: 'throw new Error("server-only module bundled for the browser");',
        loader: 'js',
      }));

      // Which modules are side-effect free, i.e. drop when nothing they
      // export is used (sideEffectFree): once the server exports that used
      // them are shaken out, a project helper or an npm package drops with
      // them - including through `export ... from` and `export *` chains
      // and path aliases. esbuild keeps the flag of whichever resolution of
      // a module finishes first, so the verdict depends only on the module,
      // never on the import that reached it: anything else would make the
      // output - and the deployment ID - vary from build to build.
      const resolveFrom: ResolveFrom = (specifier, importer, resolveDir, kind) =>
        pluginBuild.resolve(specifier, {
          importer,
          resolveDir,
          kind,
          namespace: 'file',
          pluginData: GIO_RESOLVING,
        });
      const importTargets = (): Promise<ProjectImportTargets> => {
        if (targets === undefined) {
          const found = resolveImportTargets(
            scanProjectImports(root, options.entryFiles, excludedDirs),
            resolveFrom,
            isSource,
          );
          targets = found;
          // A resolver failure (not a missing module) is retried by the next build.
          void found.then(result => {
            if (!result.complete && targets === found) targets = undefined;
          });
        }
        return targets;
      };
      const sideEffectFree = async (resolved: ResolveResult): Promise<boolean> => {
        const { sideEffect, bound } = await importTargets();
        const key = targetKey(resolved);
        if (sideEffect.has(key)) return false;
        return bound.has(key) || (resolved.namespace === 'file' && isSource(resolved.path));
      };

      pluginBuild.onResolve({ filter: /.*/ }, async args => {
        if (args.pluginData === GIO_RESOLVING) return null;
        // Generated entries (importer '') and virtual modules import nothing
        // the verdict could apply to.
        if (args.namespace !== 'file' || args.importer === '') return null;
        const resolved = await resolveFrom(args.path, args.importer, args.resolveDir, args.kind);
        if (resolved.errors.length > 0 || resolved.external) return null;
        // A project file's import() is bundled only once a pass saw it
        // survive (DynamicImports).
        if (
          args.kind === 'dynamic-import' &&
          resolved.namespace === 'file' &&
          !dynamicImports.live.has(resolved.path) &&
          isInside(root, args.importer) &&
          !args.importer.includes('node_modules')
        ) {
          return { path: `${DYNAMIC_IMPORT_MARKER}${resolved.path}`, external: true };
        }
        // null: esbuild resolves it again itself, to the same module, and
        // keeps its default (package.json `sideEffects`, else side effects).
        return (await sideEffectFree(resolved))
          ? { path: resolved.path, namespace: resolved.namespace, sideEffects: false }
          : null;
      });

      pluginBuild.onLoad({ filter: /\.(?:[cm]?[jt]s|[jt]sx)$/ }, args =>
        args.namespace === 'file' && !args.path.includes('node_modules')
          ? loadServerModule(args.path)
          : null,
      );
    },
  };
}

/**
 * Load a project module the server-only guard must see through, or null to
 * let esbuild load it normally.
 *
 * - A server-only TypeScript module (`*.server.*`, or one naming the
 *   server-only marker) that declares an enum is compiled to plain JS first.
 *   esbuild inlines enum members across modules, so a client read of
 *   `Secret.Key` would ship the value while the module - and its marker -
 *   was tree-shaken away unseen. Compiled, the enum is an ordinary object:
 *   reading it keeps the module live, and the guard rejects the route. The
 *   compiled code itself never ships (the module is either shaken out or
 *   its route rejected), so only what stays live matters.
 * - `*.server.*` files also get a side effect, so they never contribute zero
 *   bytes (a pure re-export barrel would) and slip past the metafile scan.
 */
async function loadServerModule(
  path: string,
): Promise<{ contents: string; loader: Loader; resolveDir: string } | null> {
  const serverFile = SERVER_FILE_PATTERN.test(path);
  const typescript = TS_FILE_PATTERN.test(path);
  if (!serverFile && !typescript) return null;
  const source = await readFile(path, 'utf8');
  const compile =
    typescript && MAY_DECLARE_ENUM.test(source) && (serverFile || NAMES_SERVER_ONLY.test(source));
  if (!serverFile && !compile) return null;
  const loader = loaderForFile(path);
  let contents = compile ? await compileEnums(source, loader, path) : source;
  if (serverFile) contents += '\n;globalThis.__gioServerModule = true;\n';
  return { contents, loader, resolveDir: dirname(path) };
}

/** `source` with TypeScript compiled away (enums become objects); best-effort. */
async function compileEnums(source: string, loader: Loader, path: string): Promise<string> {
  try {
    const result = await transform(source, {
      loader,
      jsx: 'preserve',
      sourcefile: path,
      // Accept parameter decorators too (TypeORM/Nest-style modules).
      tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
    });
    return result.code;
  } catch (compileError) {
    // The bundler reports real syntax errors on the original source.
    logger.debug('server-only module not precompiled', {
      file: path,
      error: compileError instanceof Error ? compileError.message : String(compileError),
    });
    return source;
  }
}

function isServerOnlyInput(input: string): boolean {
  if (input.startsWith(`${SERVER_ONLY_NAMESPACE}:`)) return true;
  // The *.server.* convention is the app's; a dependency's file name is not.
  return SERVER_FILE_PATTERN.test(input) && !input.includes('node_modules');
}

/** Inputs that contributed code to any output, i.e. survived tree-shaking. */
function liveInputs(metafile: Metafile): Set<string> {
  const live = new Set<string>();
  for (const output of Object.values(metafile.outputs)) {
    for (const [input, meta] of Object.entries(output.inputs)) {
      if (meta.bytesInOutput > 0) live.add(input);
    }
  }
  return live;
}

/** Shortest import path from `from` to an input `isTarget` accepts, walking only `canVisit`. */
function shortestImportPath(
  metafile: Metafile,
  from: string,
  isTarget: (input: string) => boolean,
  canVisit: (input: string) => boolean,
): string[] | null {
  const parent = new Map<string, string | null>([[from, null]]);
  const queue = [from];
  for (let input = queue.shift(); input !== undefined; input = queue.shift()) {
    if (isTarget(input)) {
      const chain: string[] = [];
      for (let at: string | null = input; at !== null; at = parent.get(at) ?? null) chain.unshift(at);
      return chain;
    }
    for (const imported of metafile.inputs[input]?.imports ?? []) {
      if (imported.external === true || parent.has(imported.path) || !canVisit(imported.path)) continue;
      parent.set(imported.path, input);
      queue.push(imported.path);
    }
  }
  return null;
}

/** Whether any server-only module survived tree-shaking in this build. */
function hasLiveServerOnly(metafile: Metafile): boolean {
  return [...liveInputs(metafile)].some(isServerOnlyInput);
}

/**
 * Whether `entryInput` has any import path to a server-only module that
 * survived tree-shaking. In a combined build liveness is the union across
 * routes, so this over-approximates (the module may be live only for
 * another route): it picks the suspects to rebuild alone, never a verdict.
 */
function mayReachServerOnly(metafile: Metafile, entryInput: string): boolean {
  const live = liveInputs(metafile);
  const isOffender = (input: string): boolean => live.has(input) && isServerOnlyInput(input);
  return shortestImportPath(metafile, entryInput, isOffender, () => true) !== null;
}

/**
 * Import chain (metafile input paths) from `entryInput` to a server-only
 * module that survived tree-shaking, or null when none did - an import used
 * only by shaken-out code (getServerSideProps) never counts. For a
 * single-route build only: any live server-only module yields a chain,
 * since everything live belongs to that route.
 */
export function findServerOnlyChain(metafile: Metafile, entryInput: string): string[] | null {
  const live = liveInputs(metafile);
  const offenders = [...live].filter(isServerOnlyInput);
  if (offenders.length === 0) return null;
  const isOffender = (input: string): boolean => live.has(input) && isServerOnlyInput(input);
  // Prefer a path through code that shipped; re-export-only barrels ship no
  // bytes, so fall back to any import path, then to the bare offender.
  return (
    shortestImportPath(metafile, entryInput, isOffender, input => live.has(input)) ??
    shortestImportPath(metafile, entryInput, isOffender, () => true) ?? [
      entryInput,
      offenders[0] as string,
    ]
  );
}

/** Human-readable chain: generated entry dropped, marker namespace stripped. */
function describeChain(chain: string[]): string {
  return chain
    .slice(1)
    .map(input =>
      input.startsWith(`${SERVER_ONLY_NAMESPACE}:`)
        ? input.slice(SERVER_ONLY_NAMESPACE.length + 1)
        : input,
    )
    .join(' -> ');
}

/** error.* and loading.* files - client code for every page below their folder. */
const SEGMENT_CLIENT_FILE = /(^|[\\/])(error|loading)\.(tsx|jsx|js)$/;

function serverOnlyMessage(pattern: string, chain: string[]): string {
  // chain[0] is the generated entry; chain[1] the app file that imported it.
  const importer = chain[1];
  const segmentHint =
    importer !== undefined && SEGMENT_CLIENT_FILE.test(importer)
      ? ` ${importer} is a client error/loading boundary for every page below its folder, ` +
        'so it must be browser-safe like a page component.'
      : '';
  return (
    `client bundle for route "${pattern}" imports server-only code: ${describeChain(chain)}.` +
    `${segmentHint} The page still server-renders but will NOT hydrate (no client JS) until ` +
    'this import is removed from client code - keep server-only modules behind ' +
    'getServerSideProps or route.ts.'
  );
}

interface EsbuildConfig {
  entryPoints: Record<string, string>;
  outDir: string;
  projectRoot: string;
  dev: boolean;
  defines: Record<string, string>;
  plugins: Plugin[];
  /** The live import() targets the server-code plugin bundles, per run. */
  dynamicImports: DynamicImports;
  nodePaths: string[] | undefined;
  tsconfig: string | undefined;
}

interface BuiltBundles {
  /** Generated entry file (absolute) → public output URL. */
  entryFileToUrl: Map<string, string>;
  /** Generated entry file (absolute) → its metafile input key. */
  entryInputs: Map<string, string>;
  metafile: Metafile;
  outputFiles: OutputFile[];
}

/**
 * Bundle without writing: output is only written once the server-only scan
 * passes, so a rejected bundle never becomes a servable chunk.
 */
async function runEsbuild(config: EsbuildConfig): Promise<BuiltBundles> {
  // Each pass bundles the import() targets the previous one found live -
  // which may import() more. Without any, the first pass is the build.
  config.dynamicImports.live.clear();
  for (let pass = 1; ; pass++) {
    const built = await runEsbuildPass(config);
    const unbundled = unbundledDynamicImports(built.metafile);
    if (unbundled.length === 0) return built;
    if (pass >= MAX_DYNAMIC_IMPORT_PASSES) {
      throw new Error(`dynamic import() chain too deep to bundle: ${unbundled.join(', ')}`);
    }
    for (const path of unbundled) config.dynamicImports.live.add(path);
  }
}

/** Bounds runEsbuild's passes: each one goes a level deeper into nested import()s. */
const MAX_DYNAMIC_IMPORT_PASSES = 16;

async function runEsbuildPass(config: EsbuildConfig): Promise<BuiltBundles> {
  const result = await build({
    entryPoints: config.entryPoints,
    bundle: true,
    format: 'esm',
    splitting: true,
    outdir: config.outDir,
    // Metafile keys become project-relative: they are the chain printed in
    // server-only errors.
    absWorkingDir: config.projectRoot,
    entryNames: '[name]-[hash]',
    chunkNames: 'shared-[hash]',
    minify: !config.dev,
    sourcemap: config.dev ? 'linked' : false,
    jsx: 'automatic',
    platform: 'browser',
    define: config.defines,
    // Stylesheets ship from the CSS build (css-build.ts); here a CSS
    // Module import is its class map and any other .css import is empty.
    loader: { '.css': 'empty' },
    metafile: true,
    write: false,
    logLevel: 'silent',
    plugins: config.plugins,
    ...(config.nodePaths !== undefined ? { nodePaths: config.nodePaths } : {}),
    ...(config.tsconfig !== undefined ? { tsconfig: config.tsconfig } : {}),
  });

  // Map each generated entry file back to its public output URL.
  const entryFileToUrl = new Map<string, string>();
  const entryInputs = new Map<string, string>();
  for (const [outFile, meta] of Object.entries(result.metafile.outputs)) {
    if (meta.entryPoint === undefined) continue;
    const entryFile = resolve(config.projectRoot, meta.entryPoint);
    entryFileToUrl.set(entryFile, `${PUBLIC_CHUNK_PATH}/${basename(outFile)}`);
    entryInputs.set(entryFile, meta.entryPoint);
  }
  return {
    entryFileToUrl,
    entryInputs,
    metafile: result.metafile,
    outputFiles: result.outputFiles,
  };
}

async function writeOutputs(files: OutputFile[]): Promise<void> {
  for (const file of files) {
    await mkdir(dirname(file.path), { recursive: true });
    await writeFile(file.path, file.contents);
  }
}

/**
 * Build all route bundles. Returns the pattern → script URL manifest; routes
 * that fail to build (or pull server-only code into the browser) are omitted
 * - they render server-only. Never throws.
 */
export async function buildClientBundles(options: ClientBuildOptions): Promise<ClientManifest> {
  const manifest: ClientManifest = new Map();
  clearClientBuildErrors();
  if (options.routes.size === 0) return manifest;

  const started = Date.now();
  const projectRoot = resolve(options.projectRoot);
  const exportDir = options.staticExportDir;
  const outDir =
    exportDir !== undefined
      ? join(resolve(exportDir), ...PUBLIC_CHUNK_PATH.split('/').filter(Boolean))
      : join(projectRoot, '.gio', 'build', 'static', 'chunks');
  const entriesDir =
    exportDir !== undefined
      ? join(projectRoot, '.gio', 'export', 'entries')
      : join(projectRoot, '.gio', 'build', 'entries');
  const runtimePath = fileURLToPath(new URL('./client-runtime.ts', import.meta.url));

  try {
    await rm(outDir, { recursive: true, force: true });
    await rm(entriesDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
    await mkdir(entriesDir, { recursive: true });

    const entries: GeneratedEntry[] = [];
    const usedNames = new Set<string>();
    for (const [pattern, route] of options.routes) {
      let name = `route-${slugForPattern(pattern)}`;
      while (usedNames.has(name)) name += '_';
      usedNames.add(name);
      const file = join(entriesDir, `${name}.tsx`);
      const source = generateEntrySource(
        pattern,
        route,
        segmentChainForDir(
          route.dir,
          options.layouts,
          options.segmentFiles ?? emptySegmentFiles(),
        ),
        runtimePath,
        options.stylesheets?.get(pattern) ?? [],
      );
      await writeFile(file, source, 'utf8');
      entries.push({ name, file, pattern });
    }

    // One class-map plugin for every pass: each module compiles once.
    const dynamicImports: DynamicImports = { live: new Set() };
    const plugins = [
      gioServerCodePlugin({
        projectRoot,
        dynamicImports,
        entryFiles: entries.map(entry => entry.file),
        excludedDirs: exportDir !== undefined ? [exportDir] : [],
      }),
      cssImportsAsClassMapsPlugin(),
    ];
    const tsconfig = projectTsconfig(projectRoot);
    const defines = clientEnvDefines(process.env, options.dev, exportDir !== undefined);
    const bundle = (selected: GeneratedEntry[]): Promise<BuiltBundles> =>
      runEsbuild({
        entryPoints: Object.fromEntries(selected.map(e => [e.name, e.file])),
        outDir,
        projectRoot,
        dev: options.dev,
        defines,
        plugins,
        dynamicImports,
        nodePaths: options.nodePaths,
        tsconfig,
      });
    const entryInput = (built: BuiltBundles, entry: GeneratedEntry): string | undefined =>
      built.entryInputs.get(resolve(entry.file));

    /**
     * Build `entry` alone and judge it: null - recorded for the overlay and
     * logged - when it fails to build or still has live server-only code.
     */
    const buildAlone = async (entry: GeneratedEntry): Promise<BuiltBundles | null> => {
      try {
        const single = await bundle([entry]);
        const input = entryInput(single, entry);
        const chain = input === undefined ? null : findServerOnlyChain(single.metafile, input);
        if (chain === null) return single;
        const message = serverOnlyMessage(entry.pattern, chain);
        recordClientBuildError(entry.pattern, message);
        logger.error(
          'client bundle imports server-only code - route will render without hydration',
          { pattern: entry.pattern, chain: describeChain(chain), error: message },
        );
      } catch (entryError) {
        const message = entryError instanceof Error ? entryError.message : String(entryError);
        recordClientBuildError(
          entry.pattern,
          `client bundle for route "${entry.pattern}" failed to build: ${message}`,
        );
        logger.error('client bundle failed - route will render without hydration', {
          pattern: entry.pattern,
          error: message,
        });
      }
      return null;
    };

    /** A build of `selected` that ships no server-only code, or null. */
    const buildTogether = async (selected: GeneratedEntry[]): Promise<BuiltBundles | null> => {
      try {
        const built = await bundle(selected);
        return hasLiveServerOnly(built.metafile) ? null : built;
      } catch {
        return null;
      }
    };

    // Routes build in one pass so shared code (react, the client runtime)
    // lands in shared chunks - soft navigation must never load a second
    // copy. A route that cannot ship (a build error, or server-only code
    // still live after tree-shaking) must not cost the others that: the
    // suspects are rebuilt alone to confirm, then the rest rebuilt together.
    let combined: BuiltBundles | null = null;
    let suspects = entries;
    try {
      const built = await bundle(entries);
      if (!hasLiveServerOnly(built.metafile)) {
        combined = built;
      } else {
        // Liveness is the union across routes: only an entry that can
        // reach a live server-only module is a suspect (if none can be
        // pinned, every route is checked).
        const reaching = entries.filter(entry => {
          const input = entryInput(built, entry);
          return input !== undefined && mayReachServerOnly(built.metafile, input);
        });
        if (reaching.length > 0) suspects = reaching;
      }
    } catch (combinedError) {
      logger.warn('client build failed - isolating the failing routes', {
        error: combinedError instanceof Error ? combinedError.message : String(combinedError),
      });
    }

    let shipped = entries;
    if (combined === null) {
      const rejected = new Set<GeneratedEntry>();
      for (const entry of suspects) {
        if ((await buildAlone(entry)) === null) rejected.add(entry);
      }
      shipped = entries.filter(entry => !rejected.has(entry));
      if (shipped.length > 0) combined = await buildTogether(shipped);
    }

    const entryFileToUrl = new Map<string, string>();
    const ship = async (built: BuiltBundles): Promise<void> => {
      await writeOutputs(built.outputFiles);
      for (const [file, url] of built.entryFileToUrl) entryFileToUrl.set(file, url);
    };
    if (combined !== null) {
      await ship(combined);
    } else {
      // Last resort (the remaining routes build alone but not together):
      // per-route bundles, each with its own copy of shared code.
      for (const entry of shipped) {
        const single = await buildAlone(entry);
        if (single !== null) await ship(single);
      }
    }

    for (const entry of entries) {
      const url = entryFileToUrl.get(resolve(entry.file));
      if (url !== undefined) manifest.set(entry.pattern, url);
    }
    logger.info('client bundles built', {
      routes: manifest.size,
      durationMs: Date.now() - started,
    });
  } catch (buildError) {
    logger.error('client build failed - pages will render without hydration', {
      error: buildError instanceof Error ? buildError.message : String(buildError),
    });
  }
  return manifest;
}
