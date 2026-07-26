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
 * Server-only code is kept out of the bundles two ways: `getServerSideProps`
 * / `getStaticPaths` exports are demoted to unused locals before bundling so
 * they tree-shake away, and relative project imports are marked side-effect
 * free so the demoted code's imports (db clients, fs helpers) drop with it.
 * Node builtin imports that survive are stubbed so a stray server import can
 * never fail the build. A route whose entry fails to build is logged and
 * served without hydration — client build errors must not take down SSR.
 */
import { build, type Plugin, type Loader } from 'esbuild';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RouteModule, LayoutEntry } from './router.ts';
import { logger } from './logger.ts';

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
 * with dynamic segments in their prefix are excluded — the server's runtime
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

/** Demote server-only exports to unused locals so they tree-shake away. */
export function demoteServerExports(source: string): string {
  return source.replace(
    /export\s+((?:async\s+)?function\s+(?:getServerSideProps|getStaticPaths)\b)/g,
    '$1',
  ).replace(
    /export\s+(const|let|var)(\s+(?:getServerSideProps|getStaticPaths)\b)/g,
    '$1$2',
  );
}

function loaderForFile(path: string): Loader {
  const ext = extname(path);
  if (ext === '.tsx') return 'tsx';
  if (ext === '.ts') return 'ts';
  if (ext === '.jsx') return 'jsx';
  return 'js';
}

const NODE_BUILTIN_FILTER =
  /^(node:|fs$|path$|crypto$|os$|child_process$|net$|tls$|http$|https$|stream$|zlib$|worker_threads$|dns$|dgram$|cluster$|readline$|v8$|vm$|perf_hooks$|async_hooks$|inspector$)/;

function gioServerCodePlugin(projectRoot: string, pageFiles: Set<string>): Plugin {
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

      // Relative project imports are side-effect free: when the demoted
      // getServerSideProps is shaken out, its imports drop with it.
      pluginBuild.onResolve({ filter: /^\.\.?\// }, async args => {
        if (args.pluginData === 'gio-resolving') return null;
        if (args.importer === '' || args.importer.includes('node_modules')) return null;
        if (!resolve(args.importer).startsWith(root)) return null;
        const resolved = await pluginBuild.resolve(args.path, {
          importer: args.importer,
          resolveDir: args.resolveDir,
          kind: args.kind,
          pluginData: 'gio-resolving',
        });
        if (resolved.errors.length > 0 || resolved.external) return null;
        return { path: resolved.path, sideEffects: false };
      });

      // Page modules: strip server-only exports before bundling.
      pluginBuild.onLoad({ filter: /page\.(tsx|ts|jsx|js)$/ }, async args => {
        if (!pageFiles.has(resolve(args.path))) return null;
        const source = await readFile(args.path, 'utf8');
        return {
          contents: demoteServerExports(source),
          loader: loaderForFile(args.path),
          resolveDir: dirname(args.path),
        };
      });
    },
  };
}

interface EsbuildConfig {
  entryPoints: Record<string, string>;
  outDir: string;
  dev: boolean;
  plugin: Plugin;
  nodePaths: string[] | undefined;
}

async function runEsbuild(config: EsbuildConfig): Promise<Map<string, string>> {
  const result = await build({
    entryPoints: config.entryPoints,
    bundle: true,
    format: 'esm',
    splitting: true,
    outdir: config.outDir,
    entryNames: '[name]-[hash]',
    chunkNames: 'shared-[hash]',
    minify: !config.dev,
    sourcemap: config.dev ? 'linked' : false,
    jsx: 'automatic',
    platform: 'browser',
    define: {
      'process.env.NODE_ENV': JSON.stringify(config.dev ? 'development' : 'production'),
      'process.env.GIO_EXPORT': '"0"',
    },
    loader: { '.css': 'empty' },
    metafile: true,
    logLevel: 'silent',
    plugins: [config.plugin],
    ...(config.nodePaths !== undefined ? { nodePaths: config.nodePaths } : {}),
  });

  // Map each generated entry file back to its public output URL.
  const entryFileToUrl = new Map<string, string>();
  for (const [outFile, meta] of Object.entries(result.metafile.outputs)) {
    if (meta.entryPoint === undefined) continue;
    entryFileToUrl.set(resolve(meta.entryPoint), `${PUBLIC_CHUNK_PATH}/${basename(outFile)}`);
  }
  return entryFileToUrl;
}

/**
 * Build all route bundles. Returns the pattern → script URL manifest; routes
 * that fail to build are omitted (they render server-only). Never throws.
 */
export async function buildClientBundles(options: ClientBuildOptions): Promise<ClientManifest> {
  const manifest: ClientManifest = new Map();
  if (options.routes.size === 0) return manifest;

  const started = Date.now();
  const outDir = join(options.projectRoot, '.gio', 'build', 'static', 'chunks');
  const entriesDir = join(options.projectRoot, '.gio', 'build', 'entries');
  const runtimePath = fileURLToPath(new URL('./client-runtime.ts', import.meta.url));

  try {
    await rm(outDir, { recursive: true, force: true });
    await rm(entriesDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
    await mkdir(entriesDir, { recursive: true });

    const pageFiles = new Set([...options.routes.values()].map(r => resolve(r.filePath)));
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

    const plugin = gioServerCodePlugin(options.projectRoot, pageFiles);
    const entryPoints = Object.fromEntries(entries.map(e => [e.name, e.file]));

    let entryFileToUrl: Map<string, string>;
    try {
      entryFileToUrl = await runEsbuild({
        entryPoints,
        outDir,
        dev: options.dev,
        plugin,
        nodePaths: options.nodePaths,
      });
    } catch (combinedError) {
      // One broken page must not cost every route its bundle: retry each
      // entry alone and keep the ones that build.
      logger.warn('client build failed — retrying routes individually', {
        error: combinedError instanceof Error ? combinedError.message : String(combinedError),
      });
      entryFileToUrl = new Map();
      for (const entry of entries) {
        try {
          const single = await runEsbuild({
            entryPoints: { [entry.name]: entry.file },
            outDir,
            dev: options.dev,
            plugin,
            nodePaths: options.nodePaths,
          });
          for (const [file, url] of single) entryFileToUrl.set(file, url);
        } catch (entryError) {
          logger.error('client bundle failed — route will render without hydration', {
            pattern: entry.pattern,
            error: entryError instanceof Error ? entryError.message : String(entryError),
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
    logger.error('client build failed — pages will render without hydration', {
      error: buildError instanceof Error ? buildError.message : String(buildError),
    });
  }
  return manifest;
}
