/**
 * giojs-core/src/load-ts.test.ts
 *
 * loadTsModule takes file: URLs, which percent-encode `[id]` folders and
 * spaces. vitest's module runner does not decode them, so app modules in
 * such folders must still load when app code is tested under vitest.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadTsModule } from './load-ts.ts';

describe('loadTsModule', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'gio load ts-'));
    await mkdir(join(root, 'posts', '[id]'), { recursive: true });
    await writeFile(join(root, 'posts', '[id]', 'page.ts'), `export const marker: string = 'DYNAMIC_SEGMENT';\n`);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('loads a module whose file URL percent-encodes brackets and spaces', async () => {
    const url = pathToFileURL(join(root, 'posts', '[id]', 'page.ts')).href;
    expect(url).toContain('%5Bid%5D');
    expect(url).toContain('%20');
    const mod = await loadTsModule<{ marker: string }>(url);
    expect(mod.marker).toBe('DYNAMIC_SEGMENT');
  });
});
