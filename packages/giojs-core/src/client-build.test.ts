/**
 * giojs-core/src/client-build.test.ts
 *
 * Integration tests for the client bundle pipeline: builds a real fixture app
 * with esbuild and asserts the manifest, hashed output, hydration wiring, and
 * - critically - that getServerSideProps and its server-only imports (secrets,
 * node builtins, npm SDKs) never reach the client bundle in any export form,
 * that the server-only guard rejects bundles that would ship server code, and
 * that only GIO_PUBLIC_* variables are inlined.
 */
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  bareImportSpecifiers,
  buildClientBundles,
  clientBuildErrorFor,
  clientEnvDefines,
  type ClientManifest,
} from './client-build.ts';
import { logger } from './logger.ts';
import { discoverLayouts, discoverRoutes } from './router.ts';
import type { RouteModule, LayoutEntry, PageModule, LayoutModule } from './router.ts';

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));

const PAGE_SOURCE = `
import React from 'react';
import { readSecret, SECRET_MARKER } from '../lib/secret.ts';

interface PageProps { title?: string }

export default function Page({ title }: PageProps) {
  return React.createElement('h1', null, title ?? 'untitled');
}

export async function getServerSideProps() {
  return { props: { title: readSecret() + SECRET_MARKER } };
}
`;

const SECRET_SOURCE = `
import { readFileSync } from 'node:fs';

export const SECRET_MARKER = 'GIO_TEST_SECRET_DO_NOT_BUNDLE';

export function readSecret(): string {
  return readFileSync('/etc/gio-secret', 'utf8');
}
`;

function routeFor(pattern: string, filePath: string, dir = pattern.slice(1)): RouteModule {
  return {
    filePath,
    urlPattern: pattern,
    dir,
    load: (): Promise<PageModule> => Promise.reject(new Error('not loaded in build test')),
  };
}

function layoutFor(dir: string, filePath: string): LayoutEntry {
  return {
    filePath,
    dir,
    load: (): Promise<LayoutModule> => Promise.reject(new Error('not loaded in build test')),
  };
}

describe('buildClientBundles', () => {
  let projectRoot: string;
  let manifest: ClientManifest;
  let chunksDir: string;

  beforeAll(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'gio-client-build-'));
    chunksDir = join(projectRoot, '.gio', 'build', 'static', 'chunks');
    await mkdir(join(projectRoot, 'app', 'docs'), { recursive: true });
    await mkdir(join(projectRoot, 'lib'), { recursive: true });
    await writeFile(join(projectRoot, 'app', 'page.tsx'), PAGE_SOURCE);
    await writeFile(
      join(projectRoot, 'app', 'docs', 'page.tsx'),
      `import React from 'react';
export default function Docs() { return React.createElement('p', null, 'docs'); }
`,
    );
    await writeFile(
      join(projectRoot, 'app', 'docs', 'layout.tsx'),
      `import React from 'react';
export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return React.createElement('section', null, children);
}
`,
    );
    await writeFile(join(projectRoot, 'lib', 'secret.ts'), SECRET_SOURCE);

    const routes = new Map<string, RouteModule>([
      ['/', routeFor('/', join(projectRoot, 'app', 'page.tsx'))],
      ['/docs', routeFor('/docs', join(projectRoot, 'app', 'docs', 'page.tsx'))],
    ]);
    const layouts = new Map<string, LayoutEntry>([
      ['docs', layoutFor('docs', join(projectRoot, 'app', 'docs', 'layout.tsx'))],
    ]);

    manifest = await buildClientBundles({
      routes,
      layouts,
      projectRoot,
      dev: true,
      // The fixture lives outside any node_modules tree; resolve react and
      // react-dom from this package's own installation.
      nodePaths: [join(packageDir, 'node_modules')],
    });
  }, 60_000);

  afterAll(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('produces a hashed entry script per route', async () => {
    expect(manifest.get('/')).toMatch(/^\/_next\/static\/chunks\/route-index-[A-Z0-9]+\.js$/);
    expect(manifest.get('/docs')).toMatch(/^\/_next\/static\/chunks\/route-docs-[A-Z0-9]+\.js$/);
    const files = await readdir(chunksDir);
    for (const url of manifest.values()) {
      expect(files).toContain(url.split('/').pop());
    }
  });

  it('registers the route with the shared hydration runtime', async () => {
    const entryFile = join(chunksDir, manifest.get('/')?.split('/').pop() ?? '');
    const contents = await readFile(entryFile, 'utf8');
    expect(contents).toContain('registerRoute');
    expect(contents).toContain('"/"');
  });

  it('splits react into a shared chunk used by both entries', async () => {
    const files = await readdir(chunksDir);
    expect(files.some(f => f.startsWith('shared-'))).toBe(true);
  });

  it('strips getServerSideProps, its secret constants, and node builtins from the bundle', async () => {
    const files = await readdir(chunksDir);
    for (const file of files.filter(f => f.endsWith('.js'))) {
      const contents = await readFile(join(chunksDir, file), 'utf8');
      expect(contents, `${file} must not contain the gSSP secret`).not.toContain(
        'GIO_TEST_SECRET_DO_NOT_BUNDLE',
      );
      expect(contents, `${file} must not contain fs usage`).not.toContain('/etc/gio-secret');
    }
  });

  it('omits routes that fail to build instead of failing the whole build', async () => {
    const brokenRoot = await mkdtemp(join(tmpdir(), 'gio-client-broken-'));
    try {
      await mkdir(join(brokenRoot, 'app', 'bad'), { recursive: true });
      await writeFile(
        join(brokenRoot, 'app', 'page.tsx'),
        `import React from 'react';
export default function Ok() { return React.createElement('p', null, 'ok'); }
`,
      );
      await writeFile(
        join(brokenRoot, 'app', 'bad', 'page.tsx'),
        `import { missing } from './does-not-exist.ts';
export default missing;
`,
      );
      const routes = new Map<string, RouteModule>([
        ['/', routeFor('/', join(brokenRoot, 'app', 'page.tsx'))],
        ['/bad', routeFor('/bad', join(brokenRoot, 'app', 'bad', 'page.tsx'))],
      ]);
      const result = await buildClientBundles({
        routes,
        layouts: new Map(),
        projectRoot: brokenRoot,
        dev: true,
        nodePaths: [join(packageDir, 'node_modules')],
      });
      expect(result.get('/')).toBeDefined();
      expect(result.get('/bad')).toBeUndefined();
      expect(clientBuildErrorFor('/bad')).toMatch(/does-not-exist/);
      expect(clientBuildErrorFor('/')).toBeUndefined();
    } finally {
      await rm(brokenRoot, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('buildClientBundles layout association', () => {
  let projectRoot: string;
  let entrySources: Map<string, string>;

  beforeAll(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'gio-client-layouts-'));
    const appDir = join(projectRoot, 'app');
    const component = (name: string, tag: string): string => `import React from 'react';
export default function ${name}({ children }: { children?: React.ReactNode }) {
  return React.createElement('${tag}', null, children);
}
`;
    const files: Record<string, string> = {
      'layout.tsx': component('Root', 'body'),
      'posts/[id]/layout.tsx': component('PostLayout', 'article'),
      'posts/[id]/page.tsx': component('Post', 'p'),
      '(shop)/layout.tsx': component('ShopLayout', 'section'),
      '(shop)/cart/page.tsx': component('Cart', 'p'),
      '(marketing)/layout.tsx': component('MarketingLayout', 'aside'),
      '(marketing)/about/page.tsx': component('About', 'p'),
    };
    for (const [rel, source] of Object.entries(files)) {
      await mkdir(dirname(join(appDir, rel)), { recursive: true });
      await writeFile(join(appDir, rel), source);
    }

    const [routes, layouts] = await Promise.all([discoverRoutes(appDir), discoverLayouts(appDir)]);
    const manifest = await buildClientBundles({
      routes,
      layouts,
      projectRoot,
      dev: true,
      nodePaths: [join(packageDir, 'node_modules')],
    });
    expect([...manifest.keys()].sort()).toEqual(['/about', '/cart', '/posts/:id']);

    // The generated entry sources show exactly which layouts each route wraps.
    entrySources = new Map();
    const entriesDir = join(projectRoot, '.gio', 'build', 'entries');
    for (const file of await readdir(entriesDir)) {
      const source = await readFile(join(entriesDir, file), 'utf8');
      const pattern = /registerRoute\(("[^"]*")/.exec(source)?.[1];
      if (pattern !== undefined) entrySources.set(JSON.parse(pattern) as string, source);
    }
  }, 60_000);

  afterAll(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('includes a layout inside a dynamic [id] folder in that route bundle', () => {
    const source = entrySources.get('/posts/:id') ?? '';
    expect(source).toContain('posts/[id]/layout.tsx');
  });

  it("includes a (group) layout only in that group's route bundles", () => {
    expect(entrySources.get('/cart')).toContain('(shop)/layout.tsx');
    expect(entrySources.get('/cart')).not.toContain('(marketing)/layout.tsx');
    expect(entrySources.get('/about')).toContain('(marketing)/layout.tsx');
    expect(entrySources.get('/about')).not.toContain('(shop)/layout.tsx');
  });

  it('keeps the root layout out of every bundle (it stays server-only HTML)', () => {
    for (const source of entrySources.values()) {
      expect(source).not.toContain('/app/layout.tsx');
    }
  });
});

/** Write `files` (project-relative path → source) under a fresh temp root. */
async function writeProject(prefix: string, files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  for (const [path, source] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), source);
  }
  return root;
}

/** Build every `app/<name>/page.tsx` in `root` as route `/<name>`. */
async function buildPages(root: string, names: string[]): Promise<ClientManifest> {
  const routes = new Map<string, RouteModule>(
    names.map(name => [`/${name}`, routeFor(`/${name}`, join(root, 'app', name, 'page.tsx'))]),
  );
  return buildClientBundles({
    routes,
    layouts: new Map(),
    projectRoot: root,
    dev: true,
    nodePaths: [join(packageDir, 'node_modules')],
  });
}

async function allChunks(root: string): Promise<string> {
  const chunksDir = join(root, '.gio', 'build', 'static', 'chunks');
  const files = (await readdir(chunksDir)).filter(f => f.endsWith('.js'));
  const contents = await Promise.all(files.map(f => readFile(join(chunksDir, f), 'utf8')));
  return contents.join('\n');
}

/** A page rendering `marker`, with `rest` spliced in after the react import. */
function page(marker: string, rest: string): string {
  return `import React from 'react';
${rest}
export default function Page() {
  return React.createElement('p', null, ${JSON.stringify(marker)});
}
`;
}

describe('server code stripping', () => {
  let root: string;
  let manifest: ClientManifest;
  let chunks: string;

  const FORMS: Record<string, string> = {
    declaration: page('FORM_DECLARATION', `import { readSecret } from '../../lib/secret.ts';
export async function getServerSideProps() { return { props: { s: readSecret() } }; }`),
    'const-arrow': page('FORM_CONST', `import { readSecret } from '../../lib/secret.ts';
export const getServerSideProps = async () => ({ props: { s: readSecret() } });
export const getStaticPaths = () => ({ paths: [{ params: { s: readSecret() } }] });`),
    'local-list': page('FORM_LOCAL_LIST', `import { readSecret } from '../../lib/secret.ts';
async function getServerSideProps() { return { props: { s: readSecret() } }; }
export { getServerSideProps };`),
    renamed: page('FORM_RENAMED', `import { readSecret } from '../../lib/secret.ts';
async function loader() { return { props: { s: readSecret() } }; }
export { loader as getServerSideProps };`),
    'reexport-from': page('FORM_REEXPORT_FROM', `export { getServerSideProps } from '../../lib/data.ts';`),
    'export-star': page('FORM_EXPORT_STAR', `export * from '../../lib/data.ts';`),
    // Export look-alikes in comments and strings must survive untouched.
    lookalike: `import React from 'react';
// export async function getServerSideProps() { return LOOKALIKE_COMMENT; }
const text = "export const getServerSideProps = 'LOOKALIKE_STRING_KEPT';";
export default function Page() {
  return React.createElement('p', null, text);
}
`,
    // A helper guarded by server-only, used only by gSSP.
    'guarded-helper': page('FORM_GUARDED_HELPER', `import { query } from '../../lib/db.ts';
export async function getServerSideProps() { return { props: { rows: query() } }; }`),
    // An npm SDK used only by gSSP, next to a bare side-effect import.
    'npm-sdk': page('FORM_NPM_SDK', `import '../../lib/polyfill.ts';
import { Sdk } from 'gio-test-server-sdk';
export async function getServerSideProps() { return { props: { sdk: String(new Sdk()) } }; }`),
  };

  beforeAll(async () => {
    const files: Record<string, string> = {
      'lib/secret.ts': SECRET_SOURCE,
      'lib/data.ts': `import { readSecret, SECRET_MARKER } from './secret.ts';
export async function getServerSideProps() { return { props: { s: readSecret() + SECRET_MARKER } }; }
`,
      'lib/db.ts': `import '@gio.js/core/server-only';
import { readSecret } from './secret.ts';
export const DB_MARKER = 'GIO_TEST_DB_DO_NOT_BUNDLE';
export function query(): string { return readSecret() + DB_MARKER; }
`,
      'lib/polyfill.ts': `(globalThis as Record<string, unknown>).__gioPolyfill = 'POLYFILL_SIDE_EFFECT_KEPT';\n`,
      'node_modules/gio-test-server-sdk/package.json': JSON.stringify({
        name: 'gio-test-server-sdk',
        version: '1.0.0',
        type: 'module',
        main: 'index.js',
      }),
      'node_modules/gio-test-server-sdk/index.js': `console.log('GIO_TEST_SDK_SIDE_EFFECT');
export class Sdk { toString() { return 'GIO_TEST_SDK_CLASS'; } }
`,
    };
    for (const [name, source] of Object.entries(FORMS)) {
      files[`app/${name}/page.tsx`] = source;
    }
    root = await writeProject('gio-client-strip-', files);
    manifest = await buildPages(root, Object.keys(FORMS));
    chunks = await allChunks(root);
  }, 60_000);

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('builds a hydration bundle for every export form', () => {
    for (const name of Object.keys(FORMS)) {
      expect(manifest.get(`/${name}`), `/${name} must hydrate`).toBeDefined();
    }
    for (const marker of ['FORM_DECLARATION', 'FORM_RENAMED', 'FORM_EXPORT_STAR', 'FORM_NPM_SDK']) {
      expect(chunks).toContain(marker);
    }
  });

  it('drops server exports and their imports in every export form', () => {
    expect(chunks).not.toContain('GIO_TEST_SECRET_DO_NOT_BUNDLE');
    expect(chunks).not.toContain('/etc/gio-secret');
    expect(chunks).not.toContain('readSecret');
    expect(chunks).not.toContain('getStaticPaths');
  });

  it('drops a server-only helper module that only gSSP uses', () => {
    expect(chunks).not.toContain('GIO_TEST_DB_DO_NOT_BUNDLE');
    expect(chunks).not.toContain('server-only module bundled for the browser');
    expect(clientBuildErrorFor('/guarded-helper')).toBeUndefined();
  });

  it('drops npm packages that only gSSP uses but keeps bare side-effect imports', () => {
    expect(chunks).not.toContain('GIO_TEST_SDK_SIDE_EFFECT');
    expect(chunks).not.toContain('GIO_TEST_SDK_CLASS');
    expect(chunks).toContain('POLYFILL_SIDE_EFFECT_KEPT');
  });

  it('never rewrites export look-alikes inside strings', () => {
    expect(chunks).toContain("export const getServerSideProps = 'LOOKALIKE_STRING_KEPT';");
  });
});

describe('server-only guard', () => {
  let root: string;
  let manifest: ClientManifest;
  let errorLog: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    errorLog = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    root = await writeProject('gio-client-server-only-', {
      'lib/db.ts': `import '@gio.js/core/server-only';
export const DB_MARKER = 'GIO_TEST_DB_DO_NOT_BUNDLE';
export function query(): string { return DB_MARKER; }
`,
      'lib/keys.server.ts': `export const API_KEY = 'GIO_TEST_SERVER_FILE_DO_NOT_BUNDLE';\n`,
      // esbuild inlines enum members across modules; the guard must still
      // see the server-only module that declared them.
      'lib/enums.ts': `import '@gio.js/core/server-only';
export enum Secret { Key = 'GIO_TEST_ENUM_DO_NOT_BUNDLE' }
`,
      'lib/flags.server.ts': `export const enum Flag { A = 'GIO_TEST_CONST_ENUM_DO_NOT_BUNDLE' }\n`,
      // Server-only code with an enum next to parameter decorators
      // (TypeORM/Nest style): precompiling it must not break the build.
      'lib/entity.server.ts': `export enum Role { Admin = 'GIO_TEST_ENTITY_ENUM_DO_NOT_BUNDLE' }
function Inject(): ParameterDecorator { return () => undefined; }
export class Repo { constructor(@Inject() readonly role: Role) {} }
`,
      'app/enum/page.tsx': `import React from 'react';
import { Secret } from '../../lib/enums.ts';
export default function Page() { return React.createElement('p', null, Secret.Key); }
`,
      'app/constenum/page.tsx': `import React from 'react';
import { Flag } from '../../lib/flags.server.ts';
export default function Page() { return React.createElement('p', null, Flag.A); }
`,
      'app/enumok/page.tsx': page('ENUM_OK_PAGE', `import { Secret } from '../../lib/enums.ts';
import { Flag } from '../../lib/flags.server.ts';
import { Repo, Role } from '../../lib/entity.server.ts';
export async function getServerSideProps() {
  return { props: { s: Secret.Key + Flag.A + String(new Repo(Role.Admin).role) } };
}`),
      'components/Rows.tsx': `import React from 'react';
import { query } from '../lib/db.ts';
export function Rows() { return React.createElement('ul', null, query()); }
`,
      // A re-export-only barrel ships zero bytes but must not hide the chain.
      'components/index.ts': `export * from './Rows.tsx';\n`,
      'app/barrel/page.tsx': `import React from 'react';
import { Rows } from '../../components/index.ts';
export default function Page() { return React.createElement(Rows); }
`,
      // The client graph reaches server-only through a component.
      'app/leaky/page.tsx': `import React from 'react';
import { Rows } from '../../components/Rows.tsx';
export default function Page() { return React.createElement(Rows); }
`,
      // The bare npm specifier is recognized too.
      'app/bare/page.tsx': page('BARE', `import 'server-only';`),
      // *.server.* files are server-only by name.
      'app/named/page.tsx': `import React from 'react';
import { API_KEY } from '../../lib/keys.server.ts';
export default function Page() { return React.createElement('p', null, API_KEY); }
`,
      // Server-only code used only by gSSP is fine.
      'app/ok/page.tsx': page('OK_PAGE', `import { query } from '../../lib/db.ts';
import { API_KEY } from '../../lib/keys.server.ts';
export async function getServerSideProps() { return { props: { q: query() + API_KEY } }; }`),
    });
    manifest = await buildPages(root, [
      'leaky',
      'barrel',
      'bare',
      'named',
      'ok',
      'enum',
      'constenum',
      'enumok',
    ]);
  }, 60_000);

  afterAll(async () => {
    errorLog.mockRestore();
    await rm(root, { recursive: true, force: true });
  });

  it('rejects routes whose client graph imports server-only code', () => {
    expect(manifest.get('/leaky')).toBeUndefined();
    expect(manifest.get('/barrel')).toBeUndefined();
    expect(manifest.get('/bare')).toBeUndefined();
    expect(manifest.get('/named')).toBeUndefined();
  });

  it('keeps routes that use server-only code only from getServerSideProps', () => {
    expect(manifest.get('/ok')).toBeDefined();
    expect(clientBuildErrorFor('/ok')).toBeUndefined();
    expect(clientBuildErrorFor('/enumok')).toBeUndefined();
    expect(manifest.get('/enumok')).toBeDefined();
  });

  it('rejects client reads of enums declared in server-only modules', () => {
    expect(manifest.get('/enum')).toBeUndefined();
    expect(clientBuildErrorFor('/enum')).toContain(
      'app/enum/page.tsx -> lib/enums.ts -> @gio.js/core/server-only',
    );
    expect(manifest.get('/constenum')).toBeUndefined();
    expect(clientBuildErrorFor('/constenum')).toContain(
      'app/constenum/page.tsx -> lib/flags.server.ts',
    );
  });

  it('names the importing file chain and says the page will not hydrate', () => {
    expect(clientBuildErrorFor('/leaky')).toContain(
      'app/leaky/page.tsx -> components/Rows.tsx -> lib/db.ts -> @gio.js/core/server-only',
    );
    expect(clientBuildErrorFor('/leaky')).toMatch(/still server-renders but will NOT hydrate/);
    expect(clientBuildErrorFor('/barrel')).toContain(
      'app/barrel/page.tsx -> components/index.ts -> components/Rows.tsx -> lib/db.ts',
    );
    expect(clientBuildErrorFor('/bare')).toContain('app/bare/page.tsx -> server-only');
    expect(clientBuildErrorFor('/named')).toContain('app/named/page.tsx -> lib/keys.server.ts');
  });

  it('logs each rejection as an error', () => {
    const logged = errorLog.mock.calls.filter(call => /server-only code/.test(String(call[0])));
    expect(logged.map(call => (call[1] as { pattern: string }).pattern).sort()).toEqual([
      '/bare',
      '/barrel',
      '/constenum',
      '/enum',
      '/leaky',
      '/named',
    ]);
  });

  it('never writes a rejected bundle to the public chunks directory', async () => {
    const chunks = await allChunks(root);
    expect(chunks).toContain('OK_PAGE');
    expect(chunks).toContain('ENUM_OK_PAGE');
    expect(chunks).not.toContain('GIO_TEST_DB_DO_NOT_BUNDLE');
    expect(chunks).not.toContain('GIO_TEST_SERVER_FILE_DO_NOT_BUNDLE');
    expect(chunks).not.toContain('GIO_TEST_ENUM_DO_NOT_BUNDLE');
    expect(chunks).not.toContain('GIO_TEST_CONST_ENUM_DO_NOT_BUNDLE');
    expect(chunks).not.toContain('GIO_TEST_ENTITY_ENUM_DO_NOT_BUNDLE');
    expect(chunks).not.toContain('server-only module bundled for the browser');
  });
});

describe('a route that cannot ship', () => {
  const CLEAN_PAGES = {
    'app/one/page.tsx': page('ROUTE_ONE', ''),
    'app/two/page.tsx': page('ROUTE_TWO', ''),
  };
  let errorLog: ReturnType<typeof vi.spyOn>;
  let warnLog: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    errorLog = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    warnLog = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterAll(() => {
    errorLog.mockRestore();
    warnLog.mockRestore();
  });

  /** The clean routes still hydrate from small entries over one shared chunk. */
  async function expectSharedChunks(root: string, manifest: ClientManifest): Promise<void> {
    const chunksDir = join(root, '.gio', 'build', 'static', 'chunks');
    const files = await readdir(chunksDir);
    expect(files.some(f => f.startsWith('shared-') && f.endsWith('.js'))).toBe(true);
    for (const pattern of ['/one', '/two']) {
      const url = manifest.get(pattern);
      expect(url, `${pattern} must hydrate`).toBeDefined();
      const entry = await readFile(join(chunksDir, url?.split('/').pop() ?? ''), 'utf8');
      // Isolated per-route bundles each carry their own React (~190KB).
      expect(entry).toMatch(/from "\.\/shared-[A-Z0-9]+\.js"/);
      expect(entry.length).toBeLessThan(20_000);
    }
  }

  it('keeps shared chunks for the other routes when it imports server-only code', async () => {
    const root = await writeProject('gio-client-reject-shared-', {
      ...CLEAN_PAGES,
      'lib/keys.server.ts': `export const API_KEY = 'GIO_TEST_SERVER_FILE_DO_NOT_BUNDLE';\n`,
      'app/leak/page.tsx': `import React from 'react';
import { API_KEY } from '../../lib/keys.server.ts';
export default function Page() { return React.createElement('p', null, API_KEY); }
`,
    });
    try {
      const manifest = await buildPages(root, ['one', 'two', 'leak']);
      expect(manifest.get('/leak')).toBeUndefined();
      expect(clientBuildErrorFor('/leak')).toMatch(/imports server-only code/);
      await expectSharedChunks(root, manifest);
      expect(await allChunks(root)).not.toContain('GIO_TEST_SERVER_FILE_DO_NOT_BUNDLE');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('keeps shared chunks for the other routes when it fails to build', async () => {
    const root = await writeProject('gio-client-broken-shared-', {
      ...CLEAN_PAGES,
      'app/bad/page.tsx': `import { missing } from './does-not-exist.ts';
export default missing;
`,
    });
    try {
      const manifest = await buildPages(root, ['one', 'two', 'bad']);
      expect(manifest.get('/bad')).toBeUndefined();
      expect(clientBuildErrorFor('/bad')).toMatch(/does-not-exist/);
      await expectSharedChunks(root, manifest);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('client env inlining', () => {
  let root: string;
  let manifest: ClientManifest;
  const saved = { ...process.env };

  beforeAll(async () => {
    process.env['GIO_PUBLIC_TEST_GREETING'] = 'hello "public" world';
    process.env['GIO_PUBLIC_TEST_DESTRUCTURED'] = 'GIO_TEST_DESTRUCTURED_VALUE';
    process.env['GIO_TEST_PRIVATE_TOKEN'] = 'GIO_TEST_PRIVATE_VALUE_DO_NOT_BUNDLE';
    root = await writeProject('gio-client-env-', {
      'app/env/page.tsx': `import React from 'react';
export default function Page() {
  const secret = process.env.GIO_TEST_PRIVATE_TOKEN;
  const { GIO_PUBLIC_TEST_DESTRUCTURED, GIO_TEST_PRIVATE_TOKEN } = process.env;
  return React.createElement('p', null, process.env.GIO_PUBLIC_TEST_GREETING, String(secret === undefined),
    GIO_PUBLIC_TEST_DESTRUCTURED, GIO_TEST_PRIVATE_TOKEN);
}
`,
    });
    manifest = await buildPages(root, ['env']);
  }, 60_000);

  afterAll(async () => {
    process.env = saved;
    await rm(root, { recursive: true, force: true });
  });

  it('inlines GIO_PUBLIC_* values and never non-public ones', async () => {
    expect(manifest.get('/env')).toBeDefined();
    const chunks = await allChunks(root);
    expect(chunks).toContain('hello "public" world');
    // Destructured reads see the public values too (the server rendered them).
    expect(chunks).toContain('GIO_TEST_DESTRUCTURED_VALUE');
    expect(chunks).not.toContain('GIO_TEST_PRIVATE_VALUE_DO_NOT_BUNDLE');
    // Non-public reads resolve against an empty object, not a global
    // `process` that would throw in the browser.
    expect(chunks).not.toContain('process.env.GIO_TEST_PRIVATE_TOKEN');
  });
});

describe('buildClientBundles for a static export', () => {
  let projectRoot: string;

  beforeAll(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'gio-client-export-'));
    await mkdir(join(projectRoot, 'app'), { recursive: true });
    await mkdir(join(projectRoot, 'lib'), { recursive: true });
    await writeFile(join(projectRoot, 'app', 'page.tsx'), PAGE_SOURCE);
    await writeFile(join(projectRoot, 'lib', 'secret.ts'), SECRET_SOURCE);
    // A running server's build must survive an export from the same project.
    await mkdir(join(projectRoot, '.gio', 'build', 'static', 'chunks'), { recursive: true });
    await writeFile(join(projectRoot, '.gio', 'build', 'static', 'chunks', 'route-live-X.js'), '');
  });

  afterAll(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('writes the chunks under <out>/_next/static/chunks, at the URLs it reports', async () => {
    const outDir = join(projectRoot, 'out');
    const manifest = await buildClientBundles({
      routes: new Map([['/', routeFor('/', join(projectRoot, 'app', 'page.tsx'))]]),
      layouts: new Map(),
      projectRoot,
      dev: false,
      staticExportDir: outDir,
      nodePaths: [join(packageDir, 'node_modules')],
    });
    const url = manifest.get('/');
    expect(url).toMatch(/^\/_next\/static\/chunks\/route-index-[A-Z0-9]+\.js$/);
    const files = await readdir(join(outDir, '_next', 'static', 'chunks'));
    expect(files).toContain(url?.split('/').pop());
    expect(files.some(f => f.endsWith('.map'))).toBe(false);
    expect(await readdir(join(projectRoot, '.gio', 'build', 'static', 'chunks'))).toEqual(['route-live-X.js']);
  }, 60_000);
});

describe('clientEnvDefines', () => {
  it('defines only well-formed GIO_PUBLIC_* keys, JSON-encoded', () => {
    const defines = clientEnvDefines(
      {
        GIO_PUBLIC_API_URL: 'https://api.example.com',
        'GIO_PUBLIC_BAD-KEY': 'x',
        DATABASE_URL: 'postgres://secret',
      },
      false,
    );
    expect(defines['process.env.GIO_PUBLIC_API_URL']).toBe('"https://api.example.com"');
    expect(defines['process.env.NODE_ENV']).toBe('"production"');
    expect(JSON.parse(defines['process.env'] ?? '')).toEqual({
      NODE_ENV: 'production',
      GIO_EXPORT: '0',
      GIO_PUBLIC_API_URL: 'https://api.example.com',
    });
    expect(Object.keys(defines).some(k => k.includes('BAD-KEY'))).toBe(false);
    expect(JSON.stringify(defines)).not.toContain('BAD-KEY');
    expect(JSON.stringify(defines)).not.toContain('postgres://secret');
  });

  it('marks dev builds as development', () => {
    expect(clientEnvDefines({}, true)['process.env.NODE_ENV']).toBe('"development"');
  });

  it('static export bundles see GIO_EXPORT=1, as the export render did', () => {
    const defines = clientEnvDefines({}, false, true);
    expect(defines['process.env.GIO_EXPORT']).toBe('"1"');
    expect(JSON.parse(defines['process.env'] ?? '')).toMatchObject({ GIO_EXPORT: '1' });
  });

  it('gives destructuring and dynamic reads the public values, and only those', async () => {
    const result = await build({
      stdin: {
        contents: `const { GIO_PUBLIC_A, DATABASE_URL } = process.env;
const name = 'GIO_PUBLIC_A';
export const probe = [GIO_PUBLIC_A, process.env[name], process.env.GIO_PUBLIC_A, DATABASE_URL,
  process.env.DATABASE_URL, process.env.NODE_ENV];
`,
        loader: 'js',
      },
      bundle: true,
      write: false,
      format: 'iife',
      globalName: 'gioEnvProbe',
      platform: 'browser',
      define: clientEnvDefines(
        { GIO_PUBLIC_A: 'public-a', DATABASE_URL: 'postgres://secret' },
        false,
      ),
    });
    const code = result.outputFiles[0]?.text ?? '';
    expect(code).not.toContain('postgres://secret');
    const { probe } = new Function(`${code}; return gioEnvProbe;`)() as { probe: unknown[] };
    expect(probe).toEqual(['public-a', 'public-a', 'public-a', undefined, undefined, 'production']);
  });
});

describe('bareImportSpecifiers', () => {
  it('finds side-effect imports but not binding or dynamic imports', () => {
    const source = `import './styles.css';
import"polyfill";
import React from 'react';
import { a } from './a';
import * as b from './b';
export * from './c';
const lazy = import('./lazy');
`;
    expect([...bareImportSpecifiers(source)].sort()).toEqual(['./styles.css', 'polyfill']);
  });
});
