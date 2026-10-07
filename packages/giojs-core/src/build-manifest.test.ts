/**
 * giojs-core/src/build-manifest.test.ts
 *
 * In a worker pool only the builder bundles: it records its build for this
 * server run, and a worker told to reuse it loads exactly that - never a
 * manifest from another run or a malformed one, falling back to building
 * rather than serving pages without their scripts.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildManifestPath,
  loadClientBuild,
  readBuildManifest,
  reuseBuildRequested,
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
  it('builds and records the build when it is the builder', async () => {
    const build = vi.fn(async () => sampleBuild());
    const loaded = await loadClientBuild({ projectRoot, reuse: false, buildId: 'run-1', build });
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
    const loaded = await loadClientBuild({ projectRoot, reuse: true, buildId: 'run-1', build });
    expect(build).not.toHaveBeenCalled();
    expect(loaded).toEqual(sampleBuild());
  });

  it('builds after all when the recorded build is unusable', async () => {
    await writeBuildManifest(projectRoot, sampleBuild(), 'old-run');
    const fresh: ClientBuild = {
      clientScripts: new Map([['/', '/_next/static/chunks/route-index-NEW.js']]),
      stylesheets: { routes: new Map(), segmentPages: new Map() },
    };
    const build = vi.fn(async () => fresh);
    const loaded = await loadClientBuild({ projectRoot, reuse: true, buildId: 'run-2', build });
    expect(build).toHaveBeenCalledTimes(1);
    expect(loaded).toEqual(fresh);
    expect(await readBuildManifest(projectRoot, 'run-2')).toEqual({ build: fresh });
  });
});
