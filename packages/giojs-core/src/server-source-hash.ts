/**
 * giojs-core/src/server-source-hash.ts
 *
 * Content hash of the server side of an app: every module the worker can
 * render with. The client build hash (build-manifest.ts clientBuildHash)
 * only sees what reaches the browser - each hydration entry imports the
 * default export of a page and its non-root layouts, and esbuild drops the
 * rest - so the root layout, `metadata`/`revalidate` exports,
 * getServerSideProps, route handlers, middleware.ts, gio.config.ts and the
 * server libraries they import never reach it. The Rust server derives the
 * deployment ID (and with it the cache epoch) from both hashes, so a
 * restart after a server-only change no longer serves pages persisted by
 * the old code.
 *
 * Found with an esbuild metafile pass over every code file under app/ plus
 * gio.config and middleware at the project root (nothing is written): its
 * inputs are those files and their transitive project-local imports,
 * including assets they import. Their contents are hashed along with the
 * project's tsconfig/jsconfig and the nearest lockfile, which pins the
 * versions of the packages left external (react, @gio.js/*, ...).
 *
 * If that pass fails (an import esbuild cannot follow), every source file
 * of the project is hashed instead, with a warning: a few extra cache
 * invalidations are better than serving pages of the previous code.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Metafile } from 'esbuild';
import { projectTsconfig } from './client-build.ts';
import { logger } from './logger.ts';

/** Modules the worker loads: entries of the metafile pass. */
const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/;
/** What the fallback walk hashes: code, data and stylesheets. */
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|json|css|scss|sass|less|md|mdx|svg|html)$/;
/** Lockfiles pinning the external packages, nearest directory first. */
const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb'];
/** Root-level modules the worker loads besides app/ (config-loader, middleware-loader). */
const ROOT_MODULES = ['gio.config.ts', 'gio.config.js', 'middleware.ts', 'middleware.js'];
/**
 * Imports that are not code: loaded empty (their bytes are hashed from
 * disk) so the pass never fails on an asset a server module imports.
 */
const ASSET_EXTENSIONS = [
  '.css', '.scss', '.sass', '.less', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif',
  '.ico', '.bmp', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.txt', '.md', '.mdx', '.html',
  '.wasm', '.node', '.mp4', '.webm', '.mp3', '.wav', '.pdf',
];

export interface ServerSourceHashOptions {
  projectRoot: string;
  appDir: string;
}

/** Files under `dir` (recursively) matching `pattern`, skipping node_modules and dot entries. */
async function walk(dir: string, pattern: RegExp, skip: ReadonlySet<string> = new Set()): Promise<string[]> {
  const found: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skip.has(path)) continue;
      found.push(...(await walk(path, pattern, skip)));
    } else if (entry.isFile() && pattern.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

/** The lockfiles of the nearest directory at or above `projectRoot` that has one. */
function nearestLockfiles(projectRoot: string): string[] {
  let dir = resolve(projectRoot);
  for (;;) {
    const present = LOCKFILES.map(name => join(dir, name)).filter(path => existsSync(path));
    if (present.length > 0) return present;
    const parent = dirname(dir);
    if (parent === dir) return [];
    dir = parent;
  }
}

/** Project-local inputs of `metafile`, as absolute paths (virtual modules dropped). */
export function metafileSourcePaths(metafile: Metafile, workingDir: string): string[] {
  return Object.keys(metafile.inputs)
    .filter(input => !/^[a-z-]+:/i.test(input) || /^[a-z]:[\\/]/i.test(input))
    .filter(input => !input.split(/[\\/]/).includes('node_modules'))
    .map(input => resolve(workingDir, input));
}

/** The modules the worker loads and what they import, found by esbuild. */
async function serverModuleGraph(options: ServerSourceHashOptions): Promise<string[]> {
  const entries = (await walk(options.appDir, CODE_FILE)).sort();
  for (const name of ROOT_MODULES) {
    const path = join(options.projectRoot, name);
    if (existsSync(path)) entries.push(path);
  }
  if (entries.length === 0) return [];
  const { build } = await import('esbuild');
  const tsconfig = projectTsconfig(options.projectRoot);
  const result = await build({
    entryPoints: entries,
    absWorkingDir: resolve(options.projectRoot),
    outdir: join(options.projectRoot, '.gio', 'server-source-hash'),
    bundle: true,
    write: false,
    metafile: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    jsx: 'automatic',
    // Dependencies are pinned by the lockfile; bundling them is wasted work.
    packages: 'external',
    loader: Object.fromEntries(ASSET_EXTENSIONS.map(ext => [ext, 'empty' as const])),
    ...(tsconfig !== undefined ? { tsconfig } : {}),
    logLevel: 'silent',
  });
  return metafileSourcePaths(result.metafile, resolve(options.projectRoot));
}

/** Every source file of the project: the fallback when the module graph is unknown. */
async function projectSourceFiles(options: ServerSourceHashOptions): Promise<string[]> {
  const root = resolve(options.projectRoot);
  // public/ is served as is by the server; it never shapes rendered HTML.
  const files = await walk(root, SOURCE_FILE, new Set([join(root, 'public')]));
  const appDir = resolve(options.appDir);
  if (appDir !== root && !appDir.startsWith(root + sep)) {
    files.push(...(await walk(appDir, SOURCE_FILE)));
  }
  return files;
}

/** sha256 over `files` (path relative to `root`, then content), in a stable order. */
export async function hashFiles(root: string, files: readonly string[]): Promise<string> {
  const hash = createHash('sha256');
  const unique = [...new Set(files.map(file => resolve(file)))];
  const keyed = unique
    .map(file => ({ file, key: relative(root, file).split(sep).join('/') }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const { file, key } of keyed) {
    let content: Buffer;
    try {
      content = await readFile(file);
    } catch {
      // Gone between listing and reading: hashed as absent.
      content = Buffer.alloc(0);
    }
    const digest = createHash('sha256').update(content).digest('hex');
    hash.update(`${key}\0${digest}\n`);
  }
  return hash.digest('hex');
}

/**
 * Content hash of the app's server-side sources (see the module comment).
 * Stable across restarts of the same code; changes with any app file,
 * any project-local module one imports, the tsconfig, or the lockfile.
 */
export async function serverSourceHash(options: ServerSourceHashOptions): Promise<string> {
  const root = resolve(options.projectRoot);
  let sources: string[];
  let method: string;
  try {
    sources = await serverModuleGraph(options);
    method = 'module-graph';
  } catch (graphError: unknown) {
    logger.warn('server module graph unavailable - hashing every project source file instead', {
      // esbuild's message lists every error on its own line.
      error: (graphError instanceof Error ? graphError.message : String(graphError))
        .replace(/\s*\n\s*/g, ' ')
        .slice(0, 500),
    });
    sources = await projectSourceFiles(options);
    method = 'project-files';
  }
  const tsconfig = projectTsconfig(options.projectRoot);
  const extras = [...(tsconfig !== undefined ? [tsconfig] : []), ...nearestLockfiles(root)];
  const hash = await hashFiles(root, [...sources, ...extras]);
  logger.info('server sources hashed', { files: sources.length, method });
  return hash;
}
