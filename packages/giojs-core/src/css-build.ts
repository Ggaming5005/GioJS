/**
 * giojs-core/src/css-build.ts
 *
 * Builds the stylesheets each route links. Every `.css` import reachable
 * from a route's module graph - side-effect `import './x.css'` and CSS
 * Modules alike, from the page, its layouts and error/loading files, the
 * components they use, and the server-only root layout - is bundled with
 * esbuild into content-hashed files under `.gio/build/static/css/`, which
 * Rust serves at `/_next/static/css/` with immutable caching. ssr.ts links
 * them as React stylesheet resources inside the hydrated tree, so they hoist
 * into <head> and client navigation waits for them before revealing a route.
 *
 * This is its own build, separate from the hydration bundles: the root
 * layout never ships to the browser but its CSS must, and a route whose
 * client bundle is rejected (server-only code) still renders - styled.
 * Each entry imports its files bare, so every module counts as live and its
 * CSS is collected in import order; npm JavaScript is never bundled (CSS an
 * npm package ships is imported explicitly: `import 'pkg/styles.css'`).
 *
 * Output per page: the root layout's stylesheet (shared by every page, so
 * it is downloaded once) followed by the route's own, which leaves out
 * anything the root stylesheet already holds - cascade order is root
 * layout, then layouts outer to inner, then the page. not-found.* and
 * error.* pages get the same treatment. CSS Modules compile with the shared
 * naming scheme (css-modules.ts); production output is minified, but local
 * names never are.
 *
 * A failing build is logged and costs only the entries that fail: their
 * pages render without their own stylesheet. Never throws.
 */
import { build, type Loader, type Metafile, type OutputFile, type Plugin } from 'esbuild';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import {
  emptySegmentFiles,
  layoutsForDir,
  segmentChainForDir,
  type LayoutEntry,
  type RouteModule,
  type SegmentFiles,
} from './router.ts';
import {
  CSS_MODULE_FILE,
  CSS_MODULE_NAMESPACE,
  CSS_RESOLVING,
  cssModulePlugin,
} from './css-modules.ts';
import { projectTsconfig, slugForPattern } from './client-build.ts';
import { emptyStyleManifest, segmentStylesheetKey, type StyleManifest } from './style-manifest.ts';
import { logger } from './logger.ts';

/** Public URL prefix the Rust server maps to `.gio/build/static/css`. */
export const PUBLIC_CSS_PATH = '/_next/static/css';

export interface CssBuildOptions {
  routes: Map<string, RouteModule>;
  layouts: Map<string, LayoutEntry>;
  segmentFiles?: SegmentFiles;
  /** Project root (parent of app/); `.gio/` lives here. */
  projectRoot: string;
  dev: boolean;
  /** Static export: stylesheets go to `<outDir>/_next/static/css`, entries under `.gio/export/`. */
  staticExportDir?: string;
}

/** Files CSS may reference with url() - emitted next to the stylesheet, content-hashed. */
const ASSET_LOADERS: Record<string, Loader> = Object.fromEntries(
  ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.ico', '.bmp', '.cur',
    '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp4', '.webm']
    .map(ext => [ext, 'file' as const]),
);

/** Extensions esbuild loads itself (or via ASSET_LOADERS); anything else imported from JS is irrelevant here. */
const KNOWN_EXTENSION = new RegExp(
  `\\.(?:[cm]?[jt]sx?|json|css|${Object.keys(ASSET_LOADERS).map(ext => ext.slice(1)).join('|')})$`,
  'i',
);

const EXCLUDED_NAMESPACE = 'gio-css-excluded';

/** A path segment named node_modules. */
function inNodeModules(path: string): boolean {
  return path.split(/[\\/]/).includes('node_modules');
}

/** A package name with no subpath: `pkg`, `@scope/pkg`. */
const BARE_PACKAGE = /^(?:@[^/]+\/)?[^/.@][^/]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The `style` condition of a package's "." export, if it has one. */
function exportedStyle(exportsField: unknown): string | undefined {
  if (!isRecord(exportsField)) return undefined;
  const isSubpathMap = Object.keys(exportsField).some(key => key.startsWith('.'));
  const root = isSubpathMap ? exportsField['.'] : exportsField;
  return isRecord(root) && typeof root['style'] === 'string' ? root['style'] : undefined;
}

/**
 * The stylesheet a package names for CSS consumers - the `style` condition
 * of its "." export, else its `style` field, as postcss-import and Vite read
 * them - looked up from `resolveDir` the way Node finds packages. esbuild
 * resolves `@import "pkg"` through `main` and `exports` only, so a package
 * whose entry is JavaScript (or that has no `main`) needs this.
 */
function packageStylesheet(specifier: string, resolveDir: string): string | undefined {
  if (!BARE_PACKAGE.test(specifier)) return undefined;
  for (let dir = resolveDir; ; dir = dirname(dir)) {
    const packageDir = join(dir, 'node_modules', specifier);
    const manifestPath = join(packageDir, 'package.json');
    if (existsSync(manifestPath)) {
      let pkg: unknown;
      try {
        pkg = JSON.parse(readFileSync(manifestPath, 'utf8'));
      } catch {
        return undefined;
      }
      if (!isRecord(pkg)) return undefined;
      const style = exportedStyle(pkg['exports']) ?? (typeof pkg['style'] === 'string' ? pkg['style'] : undefined);
      if (style === undefined || CSS_MODULE_FILE.test(style)) return undefined;
      const stylesheet = join(packageDir, style);
      // Real path, as esbuild reports inputs (pnpm links node_modules/pkg).
      return existsSync(stylesheet) ? realpathSync(stylesheet) : undefined;
    }
    if (dirname(dir) === dir) return undefined;
  }
}

/**
 * Keeps the CSS build to CSS: npm JavaScript (and anything that does not
 * resolve - SSR reports that) stays external, site-absolute url()s
 * (`/public/bg.png`) stay as written, unknown file types load empty, and
 * stylesheets in `excluded` (already in the root stylesheet) load empty.
 * Every @import is bundled, `@import "pkg"` included (packageStylesheet).
 */
function cssGraphPlugin(excluded: ReadonlySet<string>): Plugin {
  return {
    name: 'gio-css-graph',
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /.*/ }, async args => {
        if (args.pluginData === CSS_RESOLVING || args.kind === 'entry-point') return null;
        if (args.kind === 'url-token' || args.kind === 'import-rule') {
          if (args.path.startsWith('/') && !args.path.startsWith('//')) {
            return { path: args.path, external: true };
          }
        }
        // `composes ... from` needs the real class names, never an empty stand-in.
        if (args.kind === 'composes-from') return null;
        // Whatever an @import names is CSS, extension or not: `@import "pkg"`
        // is bundled like any stylesheet, never left as an external @import
        // the server 404s.
        const isCss =
          args.kind === 'import-rule' || (args.kind !== 'url-token' && /\.css(?:$|\?)/.test(args.path));
        const resolved = await pluginBuild.resolve(args.path, {
          importer: args.importer,
          resolveDir: args.resolveDir,
          kind: args.kind,
          pluginData: CSS_RESOLVING,
        });
        const unresolved = resolved.errors.length > 0;
        if (
          args.kind === 'import-rule' &&
          (unresolved || (!resolved.external && resolved.namespace === 'file' && !/\.css$/i.test(resolved.path)))
        ) {
          // `@import "pkg"` that esbuild could not resolve, or resolved to JavaScript.
          const stylesheet = packageStylesheet(args.path, args.resolveDir);
          if (stylesheet !== undefined) {
            return excluded.has(stylesheet)
              ? { path: stylesheet, namespace: EXCLUDED_NAMESPACE }
              : { path: stylesheet };
          }
        }
        if (unresolved) {
          // A CSS import that does not resolve is a real error (SSR fails on
          // it too); a missing url() target only costs that asset.
          return isCss ? null : { path: args.path, external: true };
        }
        if (args.kind === 'url-token') return null;
        if (resolved.external || resolved.namespace !== 'file') return null;
        if (isCss) {
          if (excluded.has(resolved.path)) return { path: resolved.path, namespace: EXCLUDED_NAMESPACE };
          // CSS Modules resolve to their virtual path (cssModulePlugin).
          return CSS_MODULE_FILE.test(resolved.path) ? null : { path: resolved.path };
        }
        return inNodeModules(resolved.path) ? { path: args.path, external: true } : { path: resolved.path };
      });
      pluginBuild.onLoad({ filter: /.*/, namespace: EXCLUDED_NAMESPACE }, args => ({
        contents: '',
        loader: CSS_MODULE_FILE.test(args.path) ? 'local-css' : 'css',
      }));
      pluginBuild.onLoad({ filter: /.*/ }, args =>
        args.namespace === 'file' && !KNOWN_EXTENSION.test(args.path)
          ? { contents: '', loader: 'empty' }
          : null,
      );
    },
  };
}

interface CssEntry {
  name: string;
  file: string;
  /** Where the URLs go: a route pattern or a segmentStylesheetKey. */
  key: { kind: 'route' | 'segment' | 'root'; id: string };
}

interface CssBuildResult {
  /** Entry file (absolute) → public stylesheet URL; entries without CSS are absent. */
  urls: Map<string, string>;
  /** Real paths of every stylesheet that went into the outputs. */
  inputs: Set<string>;
  outputFiles: OutputFile[];
}

/** Forward-slashed absolute path, safe inside a generated import statement. */
function importPath(p: string): string {
  return JSON.stringify(resolve(p).split(sep).join('/'));
}

function entrySource(files: readonly string[]): string {
  return `${files.map(file => `import ${importPath(file)};`).join('\n')}\n`;
}

/** Real path of a metafile input key (project-relative, or a CSS Module's virtual path). */
function inputRealPath(key: string, projectRoot: string, modules: Map<string, string>): string {
  const namespaced = `${CSS_MODULE_NAMESPACE}:`;
  if (key.startsWith(namespaced)) {
    const virtualPath = key.slice(namespaced.length);
    return modules.get(virtualPath) ?? virtualPath;
  }
  return resolve(projectRoot, key);
}

async function runCssBuild(
  entries: readonly CssEntry[],
  excluded: ReadonlySet<string>,
  outDir: string,
  options: CssBuildOptions,
): Promise<CssBuildResult> {
  const projectRoot = resolve(options.projectRoot);
  const modules = new Map<string, string>();
  const tsconfig = projectTsconfig(projectRoot);
  const result = await build({
    entryPoints: Object.fromEntries(entries.map(e => [e.name, e.file])),
    bundle: true,
    format: 'esm',
    platform: 'node',
    outdir: outDir,
    absWorkingDir: projectRoot,
    entryNames: '[name]-[hash]',
    assetNames: '[name]-[hash]',
    // Never minifyIdentifiers: it would rename CSS Module classes away from
    // the names SSR and the client bundle use.
    minifyWhitespace: !options.dev,
    minifySyntax: !options.dev,
    // Every import of every module counts: a component's CSS Module import
    // must not be dropped because the root layout's JS is unused here.
    treeShaking: false,
    sourcemap: options.dev ? 'linked' : false,
    jsx: 'automatic',
    loader: ASSET_LOADERS,
    metafile: true,
    write: false,
    logLevel: 'silent',
    plugins: [cssGraphPlugin(excluded), cssModulePlugin(modules)],
    ...(tsconfig !== undefined ? { tsconfig } : {}),
  });
  return collectOutputs(result.metafile, result.outputFiles, projectRoot, modules);
}

function collectOutputs(
  metafile: Metafile,
  outputFiles: OutputFile[],
  projectRoot: string,
  modules: Map<string, string>,
): CssBuildResult {
  const urls = new Map<string, string>();
  const inputs = new Set<string>();
  for (const meta of Object.values(metafile.outputs)) {
    if (meta.entryPoint === undefined || meta.cssBundle === undefined) continue;
    const css = metafile.outputs[meta.cssBundle];
    // An entry whose graph holds only excluded (empty) stylesheets.
    if (css === undefined || css.bytes === 0) continue;
    urls.set(resolve(projectRoot, meta.entryPoint), `${PUBLIC_CSS_PATH}/${basename(meta.cssBundle)}`);
    for (const input of Object.keys(css.inputs)) {
      inputs.add(inputRealPath(input, projectRoot, modules));
    }
  }
  // The JavaScript is a by-product; stylesheets, their maps and the assets
  // they reference are what ships.
  const shipped = outputFiles.filter(file => !/\.js(?:\.map)?$/.test(file.path));
  return { urls, inputs, outputFiles: shipped };
}

async function writeOutputs(files: OutputFile[]): Promise<void> {
  for (const file of files) {
    await mkdir(dirname(file.path), { recursive: true });
    await writeFile(file.path, file.contents);
  }
}

/**
 * Build every route's stylesheets. Returns the manifest ssr.ts links from;
 * pages whose CSS fails to build get what did build. Never throws.
 */
export async function buildRouteStylesheets(options: CssBuildOptions): Promise<StyleManifest> {
  const manifest = emptyStyleManifest();
  const started = Date.now();
  const projectRoot = resolve(options.projectRoot);
  const exportDir = options.staticExportDir;
  const outDir =
    exportDir !== undefined
      ? join(resolve(exportDir), ...PUBLIC_CSS_PATH.split('/').filter(Boolean))
      : join(projectRoot, '.gio', 'build', 'static', 'css');
  const entriesDir =
    exportDir !== undefined
      ? join(projectRoot, '.gio', 'export', 'css-entries')
      : join(projectRoot, '.gio', 'build', 'css-entries');
  const segmentFiles = options.segmentFiles ?? emptySegmentFiles();

  try {
    await rm(outDir, { recursive: true, force: true });
    await rm(entriesDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
    await mkdir(entriesDir, { recursive: true });

    const usedNames = new Set<string>();
    const makeEntry = async (
      base: string,
      key: CssEntry['key'],
      files: string[],
    ): Promise<CssEntry> => {
      let name = base;
      while (usedNames.has(name)) name += '_';
      usedNames.add(name);
      const file = join(entriesDir, `${name}.js`);
      await writeFile(file, entrySource(files), 'utf8');
      return { name, file, key };
    };

    // Root layout first: its stylesheet is shared, and route stylesheets
    // leave out whatever it already holds.
    const rootLayout = options.layouts.get('');
    let rootUrl: string | undefined;
    let rootInputs = new Set<string>();
    if (rootLayout !== undefined) {
      const rootEntry = await makeEntry('root', { kind: 'root', id: '' }, [rootLayout.filePath]);
      try {
        const built = await runCssBuild([rootEntry], new Set(), outDir, options);
        await writeOutputs(built.outputFiles);
        rootUrl = built.urls.get(resolve(rootEntry.file));
        rootInputs = built.inputs;
      } catch (rootError) {
        logger.error('root layout stylesheet failed to build - pages render without it', {
          error: rootError instanceof Error ? rootError.message : String(rootError),
        });
      }
    }

    const entries: CssEntry[] = [];
    for (const [pattern, route] of options.routes) {
      const files = segmentChainForDir(route.dir, options.layouts, segmentFiles).flatMap(level =>
        [level.layout, level.loading, level.error].flatMap(f => (f !== undefined ? [f.filePath] : [])),
      );
      files.push(route.filePath);
      entries.push(
        await makeEntry(`route-${slugForPattern(pattern)}`, { kind: 'route', id: pattern }, files),
      );
    }
    for (const kind of ['notFound', 'error'] as const) {
      for (const page of segmentFiles[kind].values()) {
        const files = layoutsForDir(page.dir, options.layouts)
          .filter(layout => layout.dir !== '')
          .map(layout => layout.filePath);
        files.push(page.filePath);
        const slug = page.dir === '' ? 'root' : slugForPattern(`/${page.dir}`);
        entries.push(
          await makeEntry(
            `${page.kind}-${slug}`,
            { kind: 'segment', id: segmentStylesheetKey(kind, page.dir) },
            files,
          ),
        );
      }
    }

    // One pass for everything; if it fails, each entry alone so one broken
    // import costs only its own pages their stylesheet.
    const urls = new Map<string, string>();
    try {
      const built = await runCssBuild(entries, rootInputs, outDir, options);
      await writeOutputs(built.outputFiles);
      for (const [file, url] of built.urls) urls.set(file, url);
    } catch {
      for (const entry of entries) {
        try {
          const built = await runCssBuild([entry], rootInputs, outDir, options);
          await writeOutputs(built.outputFiles);
          for (const [file, url] of built.urls) urls.set(file, url);
        } catch (entryError) {
          logger.error('stylesheet failed to build - page renders without its own CSS', {
            [entry.key.kind === 'route' ? 'pattern' : 'page']: entry.key.id,
            error: entryError instanceof Error ? entryError.message : String(entryError),
          });
        }
      }
    }

    for (const entry of entries) {
      const own = urls.get(resolve(entry.file));
      const sheets = [rootUrl, own].filter((url): url is string => url !== undefined);
      if (entry.key.kind === 'route') manifest.routes.set(entry.key.id, sheets);
      else manifest.segmentPages.set(entry.key.id, sheets);
    }
    logger.info('route stylesheets built', {
      stylesheets: urls.size + (rootUrl !== undefined ? 1 : 0),
      durationMs: Date.now() - started,
    });
  } catch (buildError) {
    logger.error('stylesheet build failed - pages render without imported CSS', {
      error: buildError instanceof Error ? buildError.message : String(buildError),
    });
  }
  return manifest;
}
