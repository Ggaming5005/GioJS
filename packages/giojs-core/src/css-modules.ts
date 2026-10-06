/**
 * giojs-core/src/css-modules.ts
 *
 * CSS Modules (`*.module.css`) with ONE naming scheme for every consumer:
 * the worker's SSR import (css-hooks.ts), the client bundle, the route
 * stylesheets (css-build.ts) and the standalone worker bundle. A class name
 * that differs between the server HTML and the hydrating bundle is a
 * hydration mismatch, so names must not depend on which build compiled them.
 *
 * esbuild's `local-css` loader names a local `.root` in `card.module.css`
 * `card_root` - but appends a counter when two files in the same build share
 * that name (`card_root2`, by build order), and minified builds shorten
 * names to `a`, `b`, ... Neither survives across builds. So every module is
 * resolved to a virtual path whose base name carries a hash of the file's
 * location (`card-3fa9c1.module.css`): esbuild then names `.root`
 * `card_3fa9c1_root`, distinct files never collide, and the name is the same
 * in every build. Builds that compile modules this way never set
 * `minifyIdentifiers` (whitespace/syntax minification is fine).
 *
 * The hash covers the file's path relative to its package root (the nearest
 * directory with a package.json), so names are stable across machines and
 * checkouts - and with them the content-hashed stylesheet URLs.
 *
 * Semantics are esbuild's: class names, ids and `@keyframes` are local,
 * `:global(.x)` / `:global .x` stay global, `composes: a b` and
 * `composes: a from './other.module.css'` add the composed names to the
 * exported value. Imports take the default export (`import styles from`).
 */
import { build, type Plugin } from 'esbuild';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

/** `*.module.css` - the only stylesheets with local names. */
export const CSS_MODULE_FILE = /\.module\.css$/;

/** Namespace of the virtual module paths (see the file comment). */
export const CSS_MODULE_NAMESPACE = 'gio-css-module';

/**
 * pluginData marking a nested `build.resolve()` from one of the CSS plugins:
 * every CSS plugin passes it on and skips such calls, so two plugins never
 * keep re-resolving each other's lookups.
 */
export const CSS_RESOLVING = 'gio-css-resolving';

/** Local name → generated class names (space-separated when composed). */
export type CssModuleClasses = Record<string, string>;

const packageRoots = new Map<string, string | null>();

/** Nearest ancestor of `dir` holding a package.json, or null. */
function packageRootOf(dir: string): string | null {
  const cached = packageRoots.get(dir);
  if (cached !== undefined) return cached;
  const parent = dirname(dir);
  const root = existsSync(join(dir, 'package.json')) ? dir : parent === dir ? null : packageRootOf(parent);
  packageRoots.set(dir, root);
  return root;
}

/**
 * The virtual path a module file compiles under: same directory, base name
 * `<stem>-<hash>.module.css`. esbuild derives the local-name prefix from it.
 */
export function cssModuleVirtualPath(realPath: string): string {
  const root = packageRootOf(dirname(realPath));
  const location = (root === null ? realPath : relative(root, realPath)).split(sep).join('/');
  const hash = createHash('sha256').update(location).digest('hex').slice(0, 6);
  const stem = basename(realPath).replace(CSS_MODULE_FILE, '');
  return join(dirname(realPath), `${stem}-${hash}.module.css`);
}

/**
 * Resolves every `*.module.css` import - from JS, and `composes ... from`
 * between modules - to its virtual path, loaded with the `local-css` loader
 * from the real file. Shared by every build that compiles CSS Modules.
 */
export function cssModulePlugin(
  /** Filled with virtual path → real path for every module resolved. */
  realPaths?: Map<string, string>,
): Plugin {
  return {
    name: 'gio-css-modules',
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: CSS_MODULE_FILE }, async args => {
        if (args.pluginData === CSS_RESOLVING) return null;
        const resolved = await pluginBuild.resolve(args.path, {
          importer: args.importer,
          resolveDir: args.resolveDir,
          kind: args.kind,
          pluginData: CSS_RESOLVING,
        });
        if (resolved.errors.length > 0 || resolved.external || resolved.namespace !== 'file') {
          return null;
        }
        const virtualPath = cssModuleVirtualPath(resolved.path);
        realPaths?.set(virtualPath, resolved.path);
        return {
          path: virtualPath,
          namespace: CSS_MODULE_NAMESPACE,
          pluginData: resolved.path,
        };
      });
      pluginBuild.onLoad({ filter: /.*/, namespace: CSS_MODULE_NAMESPACE }, async args => {
        const realPath = args.pluginData as string;
        return {
          contents: await readFile(realPath, 'utf8'),
          loader: 'local-css',
          resolveDir: dirname(realPath),
          watchFiles: [realPath],
        };
      });
    },
  };
}

/**
 * Compile one module file on its own and return its class map. Throws with
 * esbuild's message on invalid CSS or an unresolvable `composes ... from`.
 */
export async function compileCssModuleClasses(realPath: string): Promise<CssModuleClasses> {
  const result = await build({
    stdin: {
      contents: `import classes from ${JSON.stringify(realPath.split(sep).join('/'))};\nexport default classes;`,
      resolveDir: dirname(realPath),
      loader: 'js',
    },
    bundle: true,
    write: false,
    // Required for the CSS output; nothing is written.
    outdir: join(dirname(realPath), '.gio-css-module-out'),
    format: 'iife',
    globalName: '__gioCssModule',
    platform: 'neutral',
    logLevel: 'silent',
    plugins: [cssModulePlugin()],
  });
  const js = result.outputFiles.find(file => file.path.endsWith('.js'));
  if (js === undefined) return {};
  // esbuild's output is an object literal of string values (composed names
  // are folded into the strings); evaluating it in an empty context is the
  // simplest exact reading of it.
  const value: unknown = runInNewContext(`${js.text};__gioCssModule`, Object.create(null), {
    timeout: 1000,
  });
  const exported =
    typeof value === 'object' && value !== null ? (value as { default?: unknown }).default : undefined;
  const classes: CssModuleClasses = {};
  if (typeof exported === 'object' && exported !== null) {
    for (const [local, generated] of Object.entries(exported)) {
      if (typeof generated === 'string') classes[local] = generated;
    }
  }
  return classes;
}

const compiled = new Map<string, Promise<CssModuleClasses>>();

/**
 * Class map for a module file (path or file: URL), compiled once per
 * process: the worker restarts on every source change in dev, and each
 * client build makes its own compiler (createCssModuleCompiler).
 */
export function cssModuleClasses(file: string): Promise<CssModuleClasses> {
  const realPath = file.startsWith('file:') ? fileURLToPath(file) : file;
  let pending = compiled.get(realPath);
  if (pending === undefined) {
    pending = compileCssModuleClasses(realPath);
    compiled.set(realPath, pending);
    // A failure is not cached: the next import retries (and reports) it.
    pending.catch(() => compiled.delete(realPath));
  }
  return pending;
}

/** A per-build memo of compileCssModuleClasses - a build sees one version of each file. */
export function createCssModuleCompiler(): (realPath: string) => Promise<CssModuleClasses> {
  const memo = new Map<string, Promise<CssModuleClasses>>();
  return realPath => {
    let pending = memo.get(realPath);
    if (pending === undefined) {
      pending = compileCssModuleClasses(realPath);
      memo.set(realPath, pending);
    }
    return pending;
  };
}

/** JS module source exporting `classes` as its default export. */
export function cssModuleSource(classes: CssModuleClasses): string {
  return `export default ${JSON.stringify(classes)};\n`;
}

/**
 * For JS bundles (client hydration, standalone worker): a `*.module.css`
 * import becomes its class map, every other `.css` import an empty module.
 * The stylesheets themselves come from the route CSS build (css-build.ts).
 */
export function cssImportsAsClassMapsPlugin(): Plugin {
  const compile = createCssModuleCompiler();
  return {
    name: 'gio-css-class-maps',
    setup(pluginBuild) {
      pluginBuild.onLoad({ filter: CSS_MODULE_FILE }, async args =>
        args.namespace === 'file'
          ? { contents: cssModuleSource(await compile(args.path)), loader: 'js', watchFiles: [args.path] }
          : null,
      );
      pluginBuild.onLoad({ filter: /\.css$/ }, args =>
        args.namespace === 'file' ? { contents: '', loader: 'empty' } : null,
      );
    },
  };
}
