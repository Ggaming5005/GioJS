/**
 * giojs-core/src/build-manifest.ts
 *
 * The client build, shared across a worker pool. With `[server] workers`
 * above 1 the Rust server lets only its first worker (the builder) bundle
 * into `.gio/build`; the builder records what it built - each route's
 * hydration entry and stylesheets - in `.gio/build/manifest.json`, and every
 * other worker, started once the builder is READY with GIO_REUSE_BUILD=1,
 * loads that instead of bundling. N workers never race on the same files,
 * and in production a respawned worker comes back without a rebuild. Nor
 * does a pool worker fall back to building when the manifest is unusable:
 * it fails its boot instead (loadClientBuild).
 *
 * The manifest names the server process that wrote it (GIO_BUILD_ID, set
 * by Rust per process): a file a previous run left behind never passes for
 * this run's build. Kept free of esbuild: reusing workers never load it.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ClientManifest } from './client-build.ts';
import { logger } from './logger.ts';
import {
  styleManifestFromJson,
  styleManifestToJson,
  type StyleManifest,
  type StyleManifestJson,
} from './style-manifest.ts';

/** Set to '1' by Rust on a worker that must reuse the builder's build. */
export const REUSE_BUILD_ENV = 'GIO_REUSE_BUILD';
/** Per-server-process build identity (giojs-server/src/ipc.rs BUILD_ID_ENV). */
export const BUILD_ID_ENV = 'GIO_BUILD_ID';
/** The pool size (giojs-server/src/ipc.rs WORKER_COUNT_ENV). */
export const WORKER_COUNT_ENV = 'GIO_WORKER_COUNT';

const MANIFEST_VERSION = 1;

/** What one client build produced. */
export interface ClientBuild {
  clientScripts: ClientManifest;
  stylesheets: StyleManifest;
}

interface BuildManifestJson {
  version: number;
  buildId: string;
  clientScripts: Record<string, string>;
  stylesheets: StyleManifestJson;
}

export function buildManifestPath(projectRoot: string): string {
  return join(projectRoot, '.gio', 'build', 'manifest.json');
}

/** True when this worker was told to load the builder's build. */
export function reuseBuildRequested(env: NodeJS.ProcessEnv): boolean {
  return env[REUSE_BUILD_ENV] === '1';
}

/**
 * True when this worker belongs to a pool of more than one: while it boots,
 * the other workers serve pages that link the chunks and stylesheets in
 * `.gio/build`, so it must never bundle into that directory (a build
 * empties it first).
 */
export function sharedBuildDirectory(env: NodeJS.ProcessEnv): boolean {
  const workers = Number(env[WORKER_COUNT_ENV]);
  return Number.isInteger(workers) && workers > 1;
}

/**
 * Record `build` for the workers that reuse it. Written to a temporary file
 * and renamed into place, so a reader never sees half a manifest. No-op
 * without a build id (a worker not started by the Rust server).
 */
export async function writeBuildManifest(
  projectRoot: string,
  build: ClientBuild,
  buildId: string | undefined,
): Promise<boolean> {
  if (buildId === undefined || buildId === '') return false;
  const path = buildManifestPath(projectRoot);
  const manifest: BuildManifestJson = {
    version: MANIFEST_VERSION,
    buildId,
    clientScripts: Object.fromEntries(build.clientScripts),
    stylesheets: styleManifestToJson(build.stylesheets),
  };
  await mkdir(join(projectRoot, '.gio', 'build'), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(manifest), 'utf8');
  await rename(temporary, path);
  return true;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(entry => typeof entry === 'string')
  );
}

function isUrlListRecord(value: unknown): value is Record<string, string[]> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(
      entry => Array.isArray(entry) && entry.every(url => typeof url === 'string'),
    )
  );
}

/**
 * The build the builder recorded for `buildId`, or why it cannot be used:
 * missing, unreadable, malformed, or written by another server process.
 */
export async function readBuildManifest(
  projectRoot: string,
  buildId: string | undefined,
): Promise<{ build: ClientBuild } | { problem: string }> {
  if (buildId === undefined || buildId === '') {
    return { problem: `${BUILD_ID_ENV} is not set` };
  }
  let raw: string;
  try {
    raw = await readFile(buildManifestPath(projectRoot), 'utf8');
  } catch (readError: unknown) {
    return { problem: readError instanceof Error ? readError.message : String(readError) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { problem: 'the build manifest is not valid JSON' };
  }
  const manifest = parsed as Partial<BuildManifestJson> | null;
  if (typeof manifest !== 'object' || manifest === null || manifest.version !== MANIFEST_VERSION) {
    return { problem: 'unknown build manifest version' };
  }
  if (manifest.buildId !== buildId) {
    return { problem: 'the build manifest belongs to another server run' };
  }
  const styles = manifest.stylesheets;
  if (
    !isStringRecord(manifest.clientScripts) ||
    typeof styles !== 'object' ||
    styles === null ||
    !isUrlListRecord(styles.routes) ||
    !isUrlListRecord(styles.segmentPages)
  ) {
    return { problem: 'the build manifest is malformed' };
  }
  return {
    build: {
      clientScripts: new Map(Object.entries(manifest.clientScripts)),
      stylesheets: styleManifestFromJson(styles),
    },
  };
}

export interface LoadClientBuildOptions {
  projectRoot: string;
  /** Load the builder's manifest (reuseBuildRequested). */
  reuse: boolean;
  /** Other workers serve from `.gio/build` (sharedBuildDirectory). */
  shared: boolean;
  /** This server process's build id (BUILD_ID_ENV). */
  buildId: string | undefined;
  /** Run the stylesheet and hydration builds; never throws. */
  build: () => Promise<ClientBuild>;
}

/**
 * This worker's client build: the builder's manifest when it was told to
 * reuse it, otherwise a fresh build - recorded for the workers that reuse
 * it.
 *
 * In a pool (`shared`) nobody may build while other workers serve: a build
 * empties the chunk and stylesheet directories their pages link. So a
 * reusing worker whose manifest is unusable fails its boot - the server
 * retries it with backoff while the others keep serving - and so does a
 * builder that cannot record its build for the workers that will need it.
 * A lone worker (a production respawn) has nobody to disturb: it builds
 * after all, with a warning, rather than serve pages without their scripts.
 */
export async function loadClientBuild(options: LoadClientBuildOptions): Promise<ClientBuild> {
  if (options.reuse) {
    const reused = await readBuildManifest(options.projectRoot, options.buildId);
    if ('build' in reused) {
      logger.info('client build reused', { routes: reused.build.clientScripts.size });
      return reused.build;
    }
    if (options.shared) {
      throw new Error(
        `client build manifest unusable (${reused.problem}) - a pool worker never rebuilds ` +
          '.gio/build under the workers serving from it; the server retries this worker',
      );
    }
    logger.warn('client build manifest unusable - building in this worker', {
      problem: reused.problem,
    });
  }
  const build = await options.build();
  let recorded: boolean;
  try {
    recorded = await writeBuildManifest(options.projectRoot, build, options.buildId);
  } catch (manifestError: unknown) {
    const message = manifestError instanceof Error ? manifestError.message : String(manifestError);
    if (options.shared) {
      throw new Error(
        `client build manifest not written (${message}) - the other workers of the pool ` +
          'load the build from it',
      );
    }
    // A lone worker's respawn falls back to building without it.
    logger.warn('client build manifest not written', { error: message });
    return build;
  }
  if (!recorded && options.shared) {
    throw new Error(
      `client build manifest not written (${BUILD_ID_ENV} is not set) - the other workers ` +
        'of the pool load the build from it',
    );
  }
  return build;
}
