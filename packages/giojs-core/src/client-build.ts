/**
 * giojs-core/src/client-build.ts
 *
 * Builds the per-route client bundles that hydrate the #__gio boundary.
 * For each discovered route a small entry module is generated that imports
 * the page component plus its static-prefix non-root layouts and registers
 * them with the shared client runtime. esbuild bundles all entries in one
 * pass (ESM + code splitting, content-hashed names) into
 * `.gio/build/static/chunks/`, which Rust serves at `/_next/static/chunks/`
 * with immutable caching.
 *
 * Server-only code is kept out of the bundles structurally, never by
 * rewriting source text: each generated entry imports ONLY the default export
 * of a page/layout, and every non-bare import made by a project file is
 * marked side-effect free. esbuild's tree-shaking then drops
 * `getServerSideProps` / `getStaticPaths` in every export form (declarations,
 * `export { x as getServerSideProps }`, `export ... from`, `export *`)
 * together with whatever only they imported - project helpers and npm
 * packages alike. Bare `import 'x'` statements keep their side effects. Node
 * builtin imports that survive are stubbed so a stray server import can never
 * fail the build.
 *
 * The `server-only` guard is the loud backstop: if `@gio.js/core/server-only`
 * (or the bare `server-only` specifier) or any `*.server.*` file is still
 * live in a route's client graph after tree-shaking, that route's bundle is
 * rejected with the importing file chain. `GIO_PUBLIC_*` variables present at
 * build time are inlined; every other `process.env.X` reads as undefined.
 *
 * A route whose entry fails to build is logged and served without hydration -
 * client build errors must not take down SSR. In dev the error is also handed
 * to the error overlay (client-build-errors.ts).
 */
import { build, type Loader, type Metafile, type OutputFile, type Plugin } from 'esbuild';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RouteModule, LayoutEntry } from './router.ts';
import { logger } from './logger.ts';
import { clearClientBuildErrors, recordClientBuildError } from './client-build-errors.ts';

export { clientBuildErrorFor } from './client-build-errors.ts';

/** Public URL prefix the Rust server maps to `.gio/build/static/chunks`. */
const PUBLIC_CHUNK_PATH = '/_next/static/chunks';

export interface ClientBuildOptions {
  routes: Map<string, RouteModule>;
  layouts: Map<string, LayoutEntry>;
  /** Project root (parent of app/); `.gio/` lives here. */
  projectRoot: string;
  dev: boolean;
  /** Extra module resolution dirs (tests use this to reach react). */
  nodePaths?: string[];
}

/** Route pattern → public entry script URL (e.g. "/_next/static/chunks/route-index-ABC.js"). */
export type ClientManifest = Map<string, string>;

interface GeneratedEntry {
  name: string;
  file: string;
  pattern: string;
}

function slugForPattern(pattern: string): string {
  if (pattern === '/') return 'index';
  return pattern.slice(1).replace(/[^a-zA-Z0-9_-]+/g, '_');
}

/** Forward-slashed absolute path, safe inside a generated import statement. */
function importPath(p: string): string {
  return JSON.stringify(resolve(p).split(sep).join('/'));
}

/**
 * Non-root layouts that apply to every path this pattern can match. Layouts
 * with dynamic segments in their prefix are excluded - the server's runtime
 * prefix match never applies them to concrete paths, and the client must
 * wrap exactly what the server wrapped.
 */
function clientLayoutsFor(pattern: string, layouts: Map<string, LayoutEntry>): LayoutEntry[] {
  return [...layouts.values()]
    .filter(l => l.urlPrefix !== '/')
    .filter(l => !l.urlPrefix.includes(':') && !l.urlPrefix.includes('*'))
    .filter(l => pattern === l.urlPrefix || pattern.startsWith(l.urlPrefix + '/'))
    .sort((a, b) => a.urlPrefix.length - b.urlPrefix.length);
}

function generateEntrySource(
  pattern: string,
  route: RouteModule,
  layouts: LayoutEntry[],
  runtimePath: string,
): string {
  const layoutImports = layouts
    .map((l, i) => `import Layout${i} from ${importPath(l.filePath)};`)
    .join('\n');
  // Wrap innermost-first so the outermost layout is the outer element,
  // mirroring ssr.ts.
  const wraps = layouts
    .map((_, i) => layouts.length - 1 - i)
    .map(idx => `  element = React.createElement(Layout${idx}, { children: element, path });`)
    .join('\n');
  return `import React from 'react';
import { registerRoute } from ${importPath(runtimePath)};
import Page from ${importPath(route.filePath)};
${layoutImports}

registerRoute(${JSON.stringify(pattern)}, (props, path) => {
  let element = React.createElement(Page, props);
${wraps}
  return element;
});
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

/** Specifiers that mark a module as server-only (ours, and the npm package's). */
const SERVER_ONLY_SPECIFIER = /^(?:@gio\.js\/core\/server-only|server-only)$/;
const SERVER_ONLY_NAMESPACE = 'gio-server-only';
/** `*.server.ts` / `.tsx` / `.js` / `.jsx` (+ module variants) never ship to the browser. */
const SERVER_FILE_PATTERN = /\.server\.(?:[cm]?[jt]s|[jt]sx)$/;

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

/**
 * esbuild defines inlining every `GIO_PUBLIC_*` variable in `env`,
 * JSON-encoded. Keys esbuild cannot express as a member chain (dashes etc.)
 * are skipped instead of failing the whole build.
 */
export function publicEnvDefines(env: NodeJS.ProcessEnv): Record<string, string> {
  const defines: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || !/^GIO_PUBLIC_[A-Za-z0-9_]+$/.test(key)) continue;
    defines[`process.env.${key}`] = JSON.stringify(value);
  }
  return defines;
}

/**
 * Client bundle defines: the build-time `GIO_PUBLIC_*` values, and an empty
 * object for everything else under `process.env`, so a non-public read is
 * `undefined` in the browser - never a secret, and never a `process is not
 * defined` crash. The more specific defines win over the catch-all.
 */
export function clientEnvDefines(env: NodeJS.ProcessEnv, dev: boolean): Record<string, string> {
  return {
    'process.env': '{}',
    'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production'),
    'process.env.GIO_EXPORT': '"0"',
    ...publicEnvDefines(env),
  };
}

function gioServerCodePlugin(projectRoot: string): Plugin {
  const root = resolve(projectRoot);
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

      // Any non-bare import a project file makes is side-effect free: once
      // the server exports it served are shaken out, the import (a project
      // helper or an npm package) drops with them - including through
      // `export ... from` and `export *` chains and path aliases.
      const bareImportsByFile = new Map<string, Promise<Set<string>>>();
      const bareImportsOf = (file: string): Promise<Set<string>> => {
        let pending = bareImportsByFile.get(file);
        if (pending === undefined) {
          pending = readFile(file, 'utf8').then(bareImportSpecifiers, () => new Set<string>());
          bareImportsByFile.set(file, pending);
        }
        return pending;
      };
      pluginBuild.onResolve({ filter: /.*/ }, async args => {
        if (args.pluginData === 'gio-resolving') return null;
        if (args.kind === 'dynamic-import' || args.namespace !== 'file') return null;
        if (args.importer === '' || args.importer.includes('node_modules')) return null;
        if (!resolve(args.importer).startsWith(root)) return null;
        if ((await bareImportsOf(args.importer)).has(args.path)) return null;
        const resolved = await pluginBuild.resolve(args.path, {
          importer: args.importer,
          resolveDir: args.resolveDir,
          kind: args.kind,
          pluginData: 'gio-resolving',
        });
        if (resolved.errors.length > 0 || resolved.external) return null;
        return { path: resolved.path, namespace: resolved.namespace, sideEffects: false };
      });

      // *.server.* files get a side effect so they never contribute zero
      // bytes (a pure re-export barrel would) and slip past the metafile scan.
      pluginBuild.onLoad({ filter: SERVER_FILE_PATTERN }, async args => {
        if (args.path.includes('node_modules')) return null;
        return {
          contents: `${await readFile(args.path, 'utf8')}\n;globalThis.__gioServerModule = true;\n`,
          loader: loaderForFile(args.path),
          resolveDir: dirname(args.path),
        };
      });
    },
  };
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

/**
 * Import chain (metafile input paths) from `entryInput` to a server-only
 * module that survived tree-shaking, or null when none did - an import used
 * only by shaken-out code (getServerSideProps) never counts. Any live
 * server-only module yields a chain: in a single-route build everything
 * live belongs to that route, and in a combined build (liveness is the
 * union across routes) callers rebuild each route alone before blaming it.
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

function serverOnlyMessage(pattern: string, chain: string[]): string {
  return (
    `client bundle for route "${pattern}" imports server-only code: ${describeChain(chain)}. ` +
    'The page still server-renders but will NOT hydrate (no client JS) until this import is ' +
    'removed from client code - keep server-only modules behind getServerSideProps or route.ts.'
  );
}

interface EsbuildConfig {
  entryPoints: Record<string, string>;
  outDir: string;
  projectRoot: string;
  dev: boolean;
  defines: Record<string, string>;
  plugin: Plugin;
  nodePaths: string[] | undefined;
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
    loader: { '.css': 'empty' },
    metafile: true,
    write: false,
    logLevel: 'silent',
    plugins: [config.plugin],
    ...(config.nodePaths !== undefined ? { nodePaths: config.nodePaths } : {}),
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
  const outDir = join(projectRoot, '.gio', 'build', 'static', 'chunks');
  const entriesDir = join(projectRoot, '.gio', 'build', 'entries');
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
        clientLayoutsFor(pattern, options.layouts),
        runtimePath,
      );
      await writeFile(file, source, 'utf8');
      entries.push({ name, file, pattern });
    }

    const plugin = gioServerCodePlugin(projectRoot);
    const defines = clientEnvDefines(process.env, options.dev);
    const bundle = (selected: GeneratedEntry[]): Promise<BuiltBundles> =>
      runEsbuild({
        entryPoints: Object.fromEntries(selected.map(e => [e.name, e.file])),
        outDir,
        projectRoot,
        dev: options.dev,
        defines,
        plugin,
        nodePaths: options.nodePaths,
      });
    const serverOnlyChain = (built: BuiltBundles, entry: GeneratedEntry): string[] | null => {
      const input = built.entryInputs.get(resolve(entry.file));
      return input === undefined ? null : findServerOnlyChain(built.metafile, input);
    };

    let combined: BuiltBundles | null = null;
    try {
      const built = await bundle(entries);
      // Liveness in a combined build is the union across routes, so a
      // server-only hit there may belong to another route: rebuild each
      // route alone to pin it on the right one.
      if (!entries.some(e => serverOnlyChain(built, e) !== null)) combined = built;
    } catch (combinedError) {
      // One broken page must not cost every route its bundle: retry each
      // entry alone and keep the ones that build.
      logger.warn('client build failed - retrying routes individually', {
        error: combinedError instanceof Error ? combinedError.message : String(combinedError),
      });
    }

    const entryFileToUrl = new Map<string, string>();
    if (combined !== null) {
      await writeOutputs(combined.outputFiles);
      for (const [file, url] of combined.entryFileToUrl) entryFileToUrl.set(file, url);
    } else {
      for (const entry of entries) {
        try {
          const single = await bundle([entry]);
          const chain = serverOnlyChain(single, entry);
          if (chain !== null) {
            const message = serverOnlyMessage(entry.pattern, chain);
            recordClientBuildError(entry.pattern, message);
            logger.error(
              'client bundle imports server-only code - route will render without hydration',
              {
                pattern: entry.pattern,
                chain: describeChain(chain),
                error: message,
              },
            );
            continue;
          }
          await writeOutputs(single.outputFiles);
          for (const [file, url] of single.entryFileToUrl) entryFileToUrl.set(file, url);
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
