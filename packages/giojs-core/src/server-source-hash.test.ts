/**
 * giojs-core/src/server-source-hash.test.ts
 *
 * The server-side half of the deployment ID: it must change with any code
 * the worker renders with - the root layout, a `metadata` export, a server
 * library outside app/, an asset or a tsconfig-aliased import - and stay
 * the same for a restart of the same code and for files nothing imports.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { metafileSourcePaths, serverSourceHash } from './server-source-hash.ts';

let projectRoot: string;

async function put(relativePath: string, content: string): Promise<void> {
  const path = join(projectRoot, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

function hash(): Promise<string> {
  return serverSourceHash({ projectRoot, appDir: join(projectRoot, 'app') });
}

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'gio-source-hash-'));
  await put(
    'app/layout.tsx',
    "import React from 'react';\nexport default function Root({ children }) {\n" +
      '  return <html><head><meta content="LAYOUT_V1" /></head><body>{children}</body></html>;\n}\n',
  );
  await put(
    'app/page.tsx',
    "import React from 'react';\nimport { greeting } from '../lib/greeting.ts';\nimport logo from './logo.svg';\n" +
      "import { db } from '@/server/db';\n" +
      "export const metadata = { title: 'TITLE_V1' };\nexport const revalidate = 300;\n" +
      'export default function Page() {\n  return <p>{greeting} {String(logo)} {db}</p>;\n}\n',
  );
  await put('app/logo.svg', '<svg>v1</svg>');
  await put('lib/greeting.ts', "export const greeting = 'hello';\n");
  await put('src/server/db.ts', "export const db = 'db-v1';\n");
  await put(
    'tsconfig.json',
    JSON.stringify({ compilerOptions: { jsx: 'react-jsx', baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
  );
  await put('gio.config.ts', 'export default {};\n');
  await put('README.md', '# app\n');
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

describe('serverSourceHash', () => {
  it('is stable for the same code', async () => {
    const first = await hash();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await hash()).toBe(first);
  });

  it('changes with the root layout alone', async () => {
    const before = await hash();
    await put(
      'app/layout.tsx',
      "import React from 'react';\nexport default function Root({ children }) {\n" +
        '  return <html><head><meta content="LAYOUT_V2" /></head><body>{children}</body></html>;\n}\n',
    );
    expect(await hash()).not.toBe(before);
  });

  it("changes with a page's metadata or revalidate export alone", async () => {
    const before = await hash();
    await put(
      'app/page.tsx',
      "import React from 'react';\nimport { greeting } from '../lib/greeting.ts';\nimport logo from './logo.svg';\n" +
        "import { db } from '@/server/db';\n" +
        "export const metadata = { title: 'TITLE_V2' };\nexport const revalidate = false;\n" +
        'export default function Page() {\n  return <p>{greeting} {String(logo)} {db}</p>;\n}\n',
    );
    expect(await hash()).not.toBe(before);
  });

  it('follows imports outside app/, through tsconfig paths and into assets', async () => {
    let previous = await hash();
    for (const [file, content] of [
      ['lib/greeting.ts', "export const greeting = 'bonjour';\n"],
      ['src/server/db.ts', "export const db = 'db-v2';\n"],
      ['app/logo.svg', '<svg>v2</svg>'],
    ] as const) {
      await put(file, content);
      const next = await hash();
      expect(next, file).not.toBe(previous);
      previous = next;
    }
  });

  it('covers gio.config, middleware, route handlers and the lockfile', async () => {
    let previous = await hash();
    for (const [file, content] of [
      ['gio.config.ts', 'export default { plugins: [] };\n'],
      ['middleware.ts', 'export default { headers: [] };\n'],
      ['app/api/route.ts', 'export function GET() { return { ok: true }; }\n'],
      ['pnpm-lock.yaml', "lockfileVersion: '9.0'\n"],
    ] as const) {
      await put(file, content);
      const next = await hash();
      expect(next, file).not.toBe(previous);
      previous = next;
    }
  });

  it('ignores files the server never loads', async () => {
    const before = await hash();
    await put('README.md', '# app, documented\n');
    await put('lib/unused.ts', "export const unused = 'x';\n");
    await put('public/robots.txt', 'User-agent: *\n');
    expect(await hash()).toBe(before);
  });

  it('falls back to hashing every project source when the module graph is unavailable', async () => {
    await put(
      'app/broken/page.tsx',
      "import React from 'react';\nimport { missing } from '../../lib/does-not-exist.ts';\n" +
        'export default function Broken() {\n  return <p>{missing}</p>;\n}\n',
    );
    const before = await hash();
    expect(await hash()).toBe(before);
    await put('lib/greeting.ts', "export const greeting = 'hola';\n");
    expect(await hash()).not.toBe(before);
  });
});

describe('metafileSourcePaths', () => {
  it('keeps project files and drops virtual modules and node_modules', () => {
    const paths = metafileSourcePaths(
      {
        inputs: {
          'app/page.tsx': { bytes: 1, imports: [] },
          '../shared/x.ts': { bytes: 1, imports: [] },
          'node_modules/react/index.js': { bytes: 1, imports: [] },
          'virtual:entry': { bytes: 1, imports: [] },
        },
        outputs: {},
      },
      '/project',
    );
    expect(paths.map(p => p.split('\\').join('/'))).toEqual(
      expect.arrayContaining([expect.stringMatching(/\/project\/app\/page\.tsx$/), expect.stringMatching(/\/shared\/x\.ts$/)]),
    );
    expect(paths).toHaveLength(2);
  });
});
