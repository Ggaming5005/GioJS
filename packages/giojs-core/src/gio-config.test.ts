/**
 * giojs-core/src/gio-config.test.ts
 *
 * defineConfig / GioConfig typing, and the boot-time validation that makes
 * a malformed gio.config.ts fail loudly instead of being half-ignored.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, validateGioConfig, type GioConfig } from './gio-config.ts';
import { loadGioConfig } from './config-loader.ts';
import * as publicApi from './public.ts';
import type { GioNodePlugin } from './plugin.ts';

const plugin: GioNodePlugin = { name: 'stamp', version: '1.0.0' };

describe('defineConfig', () => {
  it('returns the config unchanged and is part of the public API', () => {
    const config = { plugins: [plugin] };
    expect(defineConfig(config)).toBe(config);
    expect(publicApi.defineConfig).toBe(defineConfig);
  });

  it('types the config', () => {
    // @ts-expect-error - plugins must be an array of plugins
    defineConfig({ plugins: 'stamp' });
    // @ts-expect-error - unknown keys are a type error
    defineConfig({ plugin: [plugin] });
    const typed: GioConfig = defineConfig({});
    expect(typed).toEqual({});
  });
});

describe('validateGioConfig', () => {
  it('accepts a missing export and well-formed plugins', () => {
    expect(validateGioConfig(undefined)).toEqual({});
    expect(validateGioConfig({})).toEqual({});
    const config = { plugins: [plugin] };
    expect(validateGioConfig(config)).toBe(config);
  });

  it('rejects unknown keys, naming the file and the likely key', () => {
    expect(() => validateGioConfig({ plugin: [plugin] }, 'gio.config.ts')).toThrow(
      /^gio\.config\.ts: unknown key "plugin" - did you mean "plugins"\?/,
    );
    expect(() => validateGioConfig({ port: 3000 })).toThrow(
      /unknown key "port" \(gio\.config takes plugins; server settings belong in gio\.toml\)/,
    );
  });

  it('rejects malformed values', () => {
    expect(() => validateGioConfig([plugin])).toThrow(/default export must be an object/);
    expect(() => validateGioConfig('config')).toThrow(/default export must be an object/);
    expect(() => validateGioConfig({ plugins: plugin })).toThrow(/plugins must be an array/);
    expect(() => validateGioConfig({ plugins: [plugin, { version: '1' }] })).toThrow(
      /plugins\[1\] must be a plugin object with a name/,
    );
  });
});

describe('loadGioConfig', () => {
  let projectDir: string | undefined;
  afterEach(async () => {
    if (projectDir !== undefined) await rm(projectDir, { recursive: true, force: true });
    projectDir = undefined;
  });

  async function project(configSource: string | null): Promise<string> {
    projectDir = await mkdtemp(join(tmpdir(), 'gio-config-'));
    await mkdir(join(projectDir, 'app'));
    if (configSource !== null) await writeFile(join(projectDir, 'gio.config.js'), configSource);
    return join(projectDir, 'app');
  }

  it('returns an empty config without a gio.config file', async () => {
    expect(await loadGioConfig(await project(null))).toEqual({});
  });

  it('loads a valid config', async () => {
    const appDir = await project("export default { plugins: [{ name: 'p', version: '1' }] };\n");
    const config = await loadGioConfig(appDir);
    expect(config.plugins?.map(p => p.name)).toEqual(['p']);
  });

  it('fails boot on a typo instead of ignoring it', async () => {
    const appDir = await project("export default { plugin: [{ name: 'p', version: '1' }] };\n");
    await expect(loadGioConfig(appDir)).rejects.toThrow(
      /gio\.config\.js: unknown key "plugin" - did you mean "plugins"\?/,
    );
  });
});
