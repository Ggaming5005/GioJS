/**
 * giojs-core/src/build-manifest.test.ts
 *
 * In a worker pool only the builder bundles: it records its build for this
 * server run, and a worker told to reuse it loads exactly that - never a
 * manifest from another run or a malformed one. A pool worker never builds
 * under the workers serving from `.gio/build` (it fails its boot instead);
 * a lone worker falls back to building rather than serving pages without
 * their scripts.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildManifestPath,
  loadClientBuild,
  readBuildManifest,
  reuseBuildRequested,
  sharedBuildDirectory,
  writeBuildManifest,
  type ClientBuild,
} from './build-manifest.ts';

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'gio-build-manifest-'));
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

function sampleBuild(): ClientBuild {
  return {
    clientScripts: new Map([
      ['/', '/_next/static/chunks/route-index-AAA.js'],
      ['/posts/:id', '/_next/static/chunks/route-posts__id-BBB.js'],
    ]),
    stylesheets: {
      routes: new Map([['/', ['/_next/static/css/root-CCC.css']]]),
      segmentPages: new Map([['notFound:', ['/_next/static/css/root-CCC.css']]]),
    },
  };
}

describe('reuseBuildRequested', () => {
  it('is on only for GIO_REUSE_BUILD=1', () => {
    expect(reuseBuildRequested({ GIO_REUSE_BUILD: '1' })).toBe(true);
    expect(reuseBuildRequested({ GIO_REUSE_BUILD: '0' })).toBe(false);
    expect(reuseBuildRequested({})).toBe(false);
  });
});

describe('sharedBuildDirectory', () => {
  it('is on only in a pool of more than one worker', () => {
    expect(sharedBuildDirectory({ GIO_WORKER_COUNT: '2' })).toBe(true);
    expect(sharedBuildDirectory({ GIO_WORKER_COUNT: '8' })).toBe(true);
    expect(sharedBuildDirectory({ GIO_WORKER_COUNT: '1' })).toBe(false);
    expect(sharedBuildDirectory({ GIO_WORKER_COUNT: 'auto' })).toBe(false);
    expect(sharedBuildDirectory({})).toBe(false);
  });
});

describe('build manifest', () => {
  it('round-trips the build for the same server run', async () => {
    expect(await writeBuildManifest(projectRoot, sampleBuild(), 'run-1')).toBe(true);
    const read = await readBuildManifest(projectRoot, 'run-1');
    expect(read).toEqual({ build: sampleBuild() });
    // Renamed into place: no temporary file is left behind.
    expect(await readdir(join(projectRoot, '.gio', 'build'))).toEqual(['manifest.json']);
  });

  it('refuses a manifest another server run wrote', async () => {
    await writeBuildManifest(projectRoot, sampleBuild(), 'run-1');
    expect(await readBuildManifest(projectRoot, 'run-2')).toEqual({
      problem: 'the build manifest belongs to another server run',
    });
  });

  it('refuses missing, malformed and versionless manifests', async () => {
    expect('problem' in (await readBuildManifest(projectRoot, 'run-1'))).toBe(true);
    await mkdir(join(projectRoot, '.gio', 'build'), { recursive: true });
    const path = buildManifestPath(projectRoot);
    for (const body of [
      'not json',
      JSON.stringify({ buildId: 'run-1', clientScripts: {}, stylesheets: {} }),
      JSON.stringify({ version: 1, buildId: 'run-1', clientScripts: { '/': 7 }, stylesheets: { routes: {}, segmentPages: {} } }),
      JSON.stringify({ version: 1, buildId: 'run-1', clientScripts: {}, stylesheets: { routes: { '/': 'x.css' }, segmentPages: {} } }),
      'null',
    ]) {
      await writeFile(path, body);
      expect('problem' in (await readBuildManifest(projectRoot, 'run-1')), body).toBe(true);
    }
  });

  it('needs a build id on both sides', async () => {
    expect(await writeBuildManifest(projectRoot, sampleBuild(), undefined)).toBe(false);
    await writeBuildManifest(projectRoot, sampleBuild(), 'run-1');
    expect(await readBuildManifest(projectRoot, undefined)).toEqual({
      problem: 'GIO_BUILD_ID is not set',
    });
  });
});

describe('loadClientBuild', () => {
  function freshBuild(): ClientBuild {
    return {
      clientScripts: new Map([['/', '/_next/static/chunks/route-index-NEW.js']]),
      stylesheets: { routes: new Map(), segmentPages: new Map() },
    };
  }

  /** Make `.gio/build` a file: recording the manifest then fails. */
  async function blockManifestWrites(): Promise<void> {
    await mkdir(join(projectRoot, '.gio'), { recursive: true });
    await writeFile(join(projectRoot, '.gio', 'build'), 'not a directory');
  }

  it.each([false, true])('builds and records the build when it is the builder (shared: %s)', async shared => {
    const build = vi.fn(async () => sampleBuild());
    const loaded = await loadClientBuild({ projectRoot, reuse: false, shared, buildId: 'run-1', build });
    expect(build).toHaveBeenCalledTimes(1);
    expect(loaded).toEqual(sampleBuild());
    const recorded = JSON.parse(await readFile(buildManifestPath(projectRoot), 'utf8'));
    expect(recorded.buildId).toBe('run-1');
  });

  it('loads the recorded build instead of building when told to reuse it', async () => {
    await writeBuildManifest(projectRoot, sampleBuild(), 'run-1');
    const build = vi.fn(async (): Promise<ClientBuild> => {
      throw new Error('a reusing worker must not build');
    });
    const loaded = await loadClientBuild({ projectRoot, reuse: true, shared: true, buildId: 'run-1', build });
    expect(build).not.toHaveBeenCalled();
    expect(loaded).toEqual(sampleBuild());
  });

  it('a pool worker fails its boot instead of rebuilding under the workers serving', async () => {
    // What the serving workers' pages link: a build would empty its directory.
    const chunk = join(projectRoot, '.gio', 'build', 'static', 'chunks', 'route-index-AAA.js');
    await mkdir(join(chunk, '..'), { recursive: true });
    await writeFile(chunk, 'hydrate()');
    const build = vi.fn(async () => {
      await rm(join(projectRoot, '.gio', 'build', 'static'), { recursive: true, force: true });
      return freshBuild();
    });
    // A manifest another run wrote, then none at all.
    await writeBuildManifest(projectRoot, sampleBuild(), 'old-run');
    await expect(
      loadClientBuild({ projectRoot, reuse: true, shared: true, buildId: 'run-2', build }),
    ).rejects.toThrow(/client build manifest unusable \(.*another server run\) - a pool worker never rebuilds/);
    await rm(buildManifestPath(projectRoot));
    await expect(
      loadClientBuild({ projectRoot, reuse: true, shared: true, buildId: 'run-2', build }),
    ).rejects.toThrow(/client build manifest unusable/);
    expect(build).not.toHaveBeenCalled();
    expect((await stat(chunk)).isFile()).toBe(true);
  });

  it('a lone worker builds after all when the recorded build is unusable', async () => {
    await writeBuildManifest(projectRoot, sampleBuild(), 'old-run');
    const build = vi.fn(async () => freshBuild());
    const loaded = await loadClientBuild({ projectRoot, reuse: true, shared: false, buildId: 'run-2', build });
    expect(build).toHaveBeenCalledTimes(1);
    expect(loaded).toEqual(freshBuild());
    expect(await readBuildManifest(projectRoot, 'run-2')).toEqual({ build: freshBuild() });
  });

  it('the builder of a pool fails its boot when it cannot record its build', async () => {
    await blockManifestWrites();
    const build = vi.fn(async () => sampleBuild());
    await expect(
      loadClientBuild({ projectRoot, reuse: false, shared: true, buildId: 'run-1', build }),
    ).rejects.toThrow(/client build manifest not written \(.+\) - the other workers of the pool/);
    await rm(join(projectRoot, '.gio'), { recursive: true });
    await expect(
      loadClientBuild({ projectRoot, reuse: false, shared: true, buildId: undefined, build }),
    ).rejects.toThrow(/GIO_BUILD_ID is not set/);
  });

  it('a lone builder serves its build even when it cannot record it', async () => {
    await blockManifestWrites();
    const build = vi.fn(async () => sampleBuild());
    const loaded = await loadClientBuild({ projectRoot, reuse: false, shared: false, buildId: 'run-1', build });
    expect(loaded).toEqual(sampleBuild());
    const unstarted = await loadClientBuild({ projectRoot, reuse: false, shared: false, buildId: undefined, build });
    expect(unstarted).toEqual(sampleBuild());
  });
});
