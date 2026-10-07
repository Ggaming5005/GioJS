/**
 * giojs-core/src/testing.test.ts
 *
 * The `@gio.js/core/testing` kit against test-fixtures/testing-app: pages
 * with getServerSideProps, cookies, redirects, notFound() and error files,
 * route handlers with JSON/form/binary bodies, multiple cookies and SSE, and
 * the real server via createTestServer when a giojs-server binary exists.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { defineConfig } from 'vitest/config';
import {
  TEST_ENTRY_SCRIPT,
  callRoute,
  createTestServer,
  renderPage,
  resetTestApp,
  type TestServer,
} from '@gio.js/core/testing';
import { buildClientBundles, clientBuildErrorFor } from './client-build.ts';
import { buildRouteStylesheets } from './css-build.ts';
import { compileCssModuleClasses } from './css-modules.ts';
import { logger } from './logger.ts';
import { discoverLayouts, discoverRoutes, discoverSegmentFiles } from './router.ts';
import { segmentStylesheetKey } from './style-manifest.ts';
import { gioVitest } from './vitest-plugin.js';

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(packageDir));
const fixtureRoot = join(packageDir, 'test-fixtures', 'testing-app');
const appDir = join(fixtureRoot, 'app');

/** Write a throwaway project (react linked in, like an installed app); returns its root. */
async function writeProject(prefix: string, files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  for (const [path, source] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), source);
  }
  await mkdir(join(root, 'node_modules'));
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  for (const dep of ['react', 'react-dom']) {
    await symlink(join(packageDir, 'node_modules', dep), join(root, 'node_modules', dep), linkType);
  }
  return root;
}

/** What buildRouteStylesheets needs, discovered like main.ts discovers it. */
async function discoverForCss(appDir: string): Promise<{
  routes: Awaited<ReturnType<typeof discoverRoutes>>;
  layouts: Awaited<ReturnType<typeof discoverLayouts>>;
  segmentFiles: Awaited<ReturnType<typeof discoverSegmentFiles>>;
}> {
  const [routes, layouts, segmentFiles] = await Promise.all([
    discoverRoutes(appDir),
    discoverLayouts(appDir),
    discoverSegmentFiles(appDir),
  ]);
  return { routes, layouts, segmentFiles };
}

let quiet: ReturnType<typeof vi.spyOn>[] = [];
beforeAll(() => {
  // Failure paths (boom, handler errors) log by design.
  quiet = [
    vi.spyOn(logger, 'error').mockImplementation(() => undefined),
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined),
  ];
});
afterAll(async () => {
  for (const spy of quiet) spy.mockRestore();
  await resetTestApp();
});

describe('renderPage', () => {
  it('renders a page inside its layouts, with the hydration props', async () => {
    const page = await renderPage('/', { appDir });
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.html).toContain('<html lang="en">');
    expect(page.html).toContain('TESTING_KIT_HOME');
    // Rendered like a served page: envelope + bootstrap module.
    expect(page.html).toContain(TEST_ENTRY_SCRIPT);
    expect(page.props).toEqual({ params: {}, searchParams: {} });
    expect(page.cacheable).toBe(false);
    expect(page.redirect).toBeUndefined();
    expect(page.error).toBeUndefined();
  });

  it('runs getServerSideProps with the query, cookies and plugins, and returns its cookies', async () => {
    const page = await renderPage('/greet?name=ada&x=1', {
      appDir,
      cookies: { theme: 'dark' },
      query: { x: '2' },
    });
    expect(page.status).toBe(200);
    expect(page.props).toEqual({ name: 'ada', theme: 'dark', plugin: 'on' });
    expect(page.html).toContain('HELLO_<!-- -->ada');
    expect(page.setCookies).toEqual(['visited=1; Path=/', 'last=greet; Path=/; HttpOnly']);
    expect(page.headers['x-greeting']).toBe('hello');
    expect(page.headers['set-cookie']).toBeUndefined();
  });

  it('merges cookies given as a header and as an object', async () => {
    const page = await renderPage('/greet', {
      appDir,
      headers: { Cookie: 'other=1' },
      cookies: { theme: 'sepia' },
    });
    expect(page.props?.['theme']).toBe('sepia');
  });

  it('reports cacheability the way the page cache decides it', async () => {
    const cached = await renderPage('/cached', { appDir });
    expect(cached.cacheable).toBe(true);
    expect(cached.cacheMaxAge).toBe(60);
    expect(cached.props).toEqual({ generated: 'static' });
    // export const tags plus the gSSP render's own, as Rust would store them.
    expect(cached.cacheTags).toEqual(['catalog', 'generated:static']);

    // revalidate, but the render read a cookie: personal, never shared.
    const personal = await renderPage('/personal', { appDir, cookies: { user: 'ada' } });
    expect(personal.props).toEqual({ user: 'ada' });
    expect(personal.cacheable).toBe(false);
    expect(personal.cacheMaxAge).toBe(0);
    expect(personal.cacheTags).toEqual([]);

    // gSSP response headers make a page uncacheable too.
    expect((await renderPage('/greet', { appDir })).cacheable).toBe(false);
  });

  it('answers a getServerSideProps redirect with its status, location and cookies', async () => {
    const page = await renderPage('/old', { appDir });
    expect(page.status).toBe(301);
    expect(page.redirect).toEqual({ destination: '/greet?name=moved', permanent: true });
    expect(page.headers['location']).toBe('/greet?name=moved');
    expect(page.setCookies).toEqual(['moved=1; Path=/']);
    expect(page.props).toBeNull();
    expect(page.html).toBe('');
  });

  it('resolves notFound() and { notFound: true } to the nearest not-found file', async () => {
    const ok = await renderPage('/posts/7', { appDir });
    expect(ok.props).toEqual({ id: '7', title: 'Post 7' });

    for (const path of ['/posts/missing', '/posts/gone']) {
      const page = await renderPage(path, { appDir });
      expect(page.status).toBe(404);
      expect(page.html).toContain('TESTING_KIT_POST_404');
      expect(page.html).toContain('<html lang="en">');
      expect(page.props).toBeNull();
      expect(page.cacheable).toBe(false);
    }

    const unmatched = await renderPage('/no/such/page', { appDir });
    expect(unmatched.status).toBe(404);
    expect(unmatched.html).toContain('TESTING_KIT_404');
  });

  it('answers a failed render with the error file and a digest, never the message', async () => {
    const page = await renderPage('/boom', { appDir });
    expect(page.status).toBe(500);
    expect(page.html).toMatch(/TESTING_KIT_ERROR <!-- -->[0-9a-f]{12}/);
    expect(page.html).not.toContain('TESTING_KIT_SECRET_FAILURE');
    expect(page.props).toBeNull();
  });

  it('answers HEAD without a body', async () => {
    const page = await renderPage('/greet', { appDir, method: 'HEAD' });
    expect(page.status).toBe(200);
    expect(page.html).toBe('');
    expect(page.setCookies).toHaveLength(2);
  });

  it('rejects what a page request cannot be', async () => {
    await expect(
      renderPage('/', { appDir, method: 'POST' as 'GET' }),
    ).rejects.toThrow(/use callRoute/);
    await expect(renderPage('greet', { appDir })).rejects.toThrow(/absolute path/);
    await expect(
      renderPage('/greet', { appDir, cookies: { theme: 'dark; admin=1' } }),
    ).rejects.toThrow(/must not contain/);
    await expect(
      renderPage('/greet', { appDir, cookies: { 'bad name': 'x' } }),
    ).rejects.toThrow(/invalid cookie name/);
    await expect(renderPage('/api/events', { appDir })).rejects.toThrow(/event stream/);
  });

  it('forwards the path the way the server does, never parsing it as a URL', async () => {
    // To the server `//greet` is a path (the router skips empty segments),
    // never a URL with the host "greet".
    expect((await renderPage('//greet?name=x', { appDir })).props).toMatchObject({ name: 'x' });
    // Escapes of unreserved characters are decoded, as path_hygiene.rs does.
    expect((await renderPage('/posts/%37', { appDir })).props).toEqual({ id: '7', title: 'Post 7' });
    // Encoded like a client sends it; a fragment never leaves the client.
    expect((await renderPage('/posts/a b', { appDir })).props).toMatchObject({ id: 'a%20b' });
    expect((await renderPage('/posts/%c3%a9#top', { appDir })).props).toMatchObject({ id: '%C3%A9' });
    // What the server answers 400 for never reaches a page.
    for (const path of ['/%2e%2e/', '/posts/../greet', '/posts/./7', '/posts/%2E', '/100%', '/posts/%zz']) {
      await expect(renderPage(path, { appDir }), path).rejects.toThrow(/answers 400/);
    }
  });

  it('loads the project\'s .env files, before gio.config.ts and the app modules', async () => {
    // gio.config.ts reads its stamp from .env as it is imported.
    expect((await renderPage('/greet', { appDir })).props).toMatchObject({ plugin: 'on' });
    const runtime = await callRoute('/api/runtime', { appDir });
    expect(await runtime.json()).toMatchObject({ dotenv: 'from-dotenv' });
  });

  it('defaults the app directory to GIO_APP_DIR', async () => {
    const previous = process.env.GIO_APP_DIR;
    process.env.GIO_APP_DIR = appDir;
    try {
      expect((await renderPage('/')).html).toContain('TESTING_KIT_HOME');
    } finally {
      if (previous === undefined) delete process.env.GIO_APP_DIR;
      else process.env.GIO_APP_DIR = previous;
    }
  });
});

describe('renderPage without error or not-found files', () => {
  let root: string;

  beforeAll(async () => {
    root = await writeProject('gio-testing-bare-', {
      'app/page.tsx': `import React from 'react';
export default function Home() { return React.createElement('p', null, 'BARE_HOME'); }
`,
      'app/boom/page.tsx': `import React from 'react';
export async function getServerSideProps() { throw new Error('BARE_SECRET'); }
export default function Boom() { return React.createElement('p', null, 'never'); }
`,
    });
  });

  afterAll(async () => {
    await resetTestApp(join(root, 'app'));
    await rm(root, { recursive: true, force: true });
  });

  it('answers with the server\'s built-in pages', async () => {
    const appDir = join(root, 'app');
    // No root layout: the document shell comes from the renderer.
    const home = await renderPage('/', { appDir });
    expect(home.html).toMatch(/^<!DOCTYPE html><html>/);
    expect(home.html).toContain('BARE_HOME');

    const missing = await renderPage('/nope', { appDir });
    expect(missing.status).toBe(404);
    expect(missing.html).toContain('Page not found');

    const boom = await renderPage('/boom', { appDir });
    expect(boom.status).toBe(500);
    expect(boom.error?.message).toBe('Internal Server Error');
    expect(boom.error?.digest).toMatch(/^[0-9a-f]{12}$/);
    expect(boom.html).toContain(`Error reference: <code>${boom.error?.digest}</code>`);
    expect(boom.html).not.toContain('BARE_SECRET');
  });

  it('caches discovery per app until resetTestApp', async () => {
    const appDir = join(root, 'app');
    expect((await renderPage('/late', { appDir })).status).toBe(404);
    await mkdir(join(appDir, 'late'));
    await writeFile(
      join(appDir, 'late', 'page.tsx'),
      `import React from 'react';
export default function Late() { return React.createElement('p', null, 'LATE_PAGE'); }
`,
    );
    // Discovered once: the new page is not seen yet.
    expect((await renderPage('/late', { appDir })).status).toBe(404);
    await resetTestApp(appDir);
    const late = await renderPage('/late', { appDir });
    expect(late.status).toBe(200);
    expect(late.html).toContain('LATE_PAGE');
  });
});

describe('callRoute and app metadata routes', () => {
  let root: string;

  beforeAll(async () => {
    root = await writeProject('gio-testing-metadata-', {
      'app/page.tsx': `import React from 'react';
export const metadata = { title: 'KIT_HOME_TITLE' };
export default function Home() { return React.createElement('p', null, 'KIT_HOME'); }
`,
      'app/robots.ts': `export default { rules: { userAgent: '*', disallow: '/private' } };
`,
      'app/sitemap.ts': `export default () => [{ url: 'https://kit.example/' }];
`,
    });
  });

  afterAll(async () => {
    await resetTestApp(join(root, 'app'));
    await rm(root, { recursive: true, force: true });
  });

  it('serves app/robots.ts and app/sitemap.ts like the server, and page metadata', async () => {
    const appDir = join(root, 'app');
    const robots = await callRoute('/robots.txt', { appDir });
    expect(robots.status).toBe(200);
    expect(robots.headers['content-type']).toMatch(/^text\/plain/);
    expect(await robots.text()).toContain('Disallow: /private');
    const sitemap = await callRoute('/sitemap.xml', { appDir });
    expect(sitemap.status).toBe(200);
    expect(sitemap.headers['content-type']).toMatch(/^application\/xml/);
    expect(await sitemap.text()).toContain('<loc>https://kit.example/</loc>');
    expect((await renderPage('/', { appDir })).html).toContain('<title>KIT_HOME_TITLE</title>');
  });
});

describe('renderPage and CSS', () => {
  let root: string;

  beforeAll(async () => {
    root = await writeProject('gio-testing-css-', {
      'app/layout.tsx': `import React from 'react';
import './root.css';
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return React.createElement('html', null, React.createElement('body', null, children));
}
`,
      'app/root.css': '.kit-root-marker { color: red; }\n',
      'app/page.tsx': `import React from 'react';
import './home.css';
import styles from './card.module.css';
export default function Home() { return React.createElement('p', { className: styles.card }, 'KIT_STYLED'); }
`,
      'app/home.css': '.kit-home-marker { order: 1; }\n',
      'app/card.module.css': '.card { color: teal; }\n',
      'app/plain/page.tsx': `import React from 'react';
export default function Plain() { return React.createElement('p', null, 'KIT_PLAIN'); }
`,
      'app/not-found.tsx': `import React from 'react';
import './not-found.css';
export default function NotFound() { return React.createElement('p', null, 'KIT_MISSING'); }
`,
      'app/not-found.css': '.kit-missing-marker { order: 2; }\n',
    });
  });

  afterAll(async () => {
    await resetTestApp(join(root, 'app'));
    await rm(root, { recursive: true, force: true });
  });

  const links = (html: string): string[] =>
    [...html.matchAll(/<link rel="stylesheet" href="([^"]+)" data-precedence="[^"]+"\/>/g)].map(m => m[1] as string);

  it("links the stylesheets the worker links, and renders the server's CSS Module class names", async () => {
    const appDir = join(root, 'app');
    const home = await renderPage('/', { appDir });
    const plain = await renderPage('/plain', { appDir });
    const missing = await renderPage('/nope', { appDir });
    // Nothing written: .gio/ belongs to whatever server runs next to the tests.
    expect(existsSync(join(root, '.gio'))).toBe(false);

    // What the worker builds at boot, in the same mode (production here).
    const served = await buildRouteStylesheets({
      ...(await discoverForCss(appDir)),
      projectRoot: root,
      dev: false,
    });
    const homeSheets = served.routes.get('/') ?? [];
    expect(homeSheets).toHaveLength(2);
    expect(links(home.html)).toEqual(homeSheets);
    expect(links(plain.html)).toEqual(served.routes.get('/plain'));
    expect(links(plain.html)).toEqual([homeSheets[0]]);
    expect(missing.status).toBe(404);
    expect(missing.html).toContain('KIT_MISSING');
    expect(links(missing.html)).toEqual(served.segmentPages.get(segmentStylesheetKey('notFound', '')));
    expect(links(missing.html)).toHaveLength(2);

    // The css-modules.ts name, not vitest's own (`_card_<hash>`): the
    // package's vitest.config.ts runs the @gio.js/core/vitest plugin.
    const classes = await compileCssModuleClasses(join(appDir, 'card.module.css'));
    expect(classes['card']).toMatch(/^card_[0-9a-f]{6}_card$/);
    expect(home.html).toContain(`<p class="${classes['card']}">KIT_STYLED</p>`);
    const homeCss = await readFile(
      join(root, '.gio', 'build', 'static', 'css', homeSheets[1]?.split('/').pop() ?? ''),
      'utf8',
    );
    expect(homeCss).toContain(`.${classes['card']}{color:teal}`);
  }, 60_000);
});

describe('the @gio.js/core/vitest plugin', () => {
  let root: string;

  beforeAll(async () => {
    root = await writeProject('gio-testing-vitest-', {
      'package.json': '{ "name": "kit-vitest-app", "private": true, "type": "module" }\n',
      // The setup the testing docs give: an npm import of the plugin, which
      // Node loads itself (vite externalizes a config's dependencies).
      'vitest.config.mjs': `import { gioVitest } from '@gio.js/core/vitest';
export default { plugins: [gioVitest()], test: { include: ['tests/*.test.ts'] } };
`,
      'tests/css.test.ts': `import { writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { renderPage } from '@gio.js/core/testing';
import styles from '../app/card.module.css';
it('renders', async () => {
  const page = await renderPage('/');
  expect(page.status).toBe(200);
  writeFileSync(new URL('../result.json', import.meta.url), JSON.stringify({ html: page.html, direct: styles }));
});
`,
      'app/page.tsx': `import React from 'react';
import './home.css';
import styles from './card.module.css';
export default function Home() { return React.createElement('p', { className: styles.card }, 'KIT_STYLED'); }
`,
      'app/home.css': '.kit-home-marker { order: 1; }\n',
      'app/card.module.css': '.card { color: teal; }\n.title { composes: card; font-weight: bold; }\n',
    });
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    await mkdir(join(root, 'node_modules', '@gio.js'));
    await symlink(packageDir, join(root, 'node_modules', '@gio.js', 'core'), linkType);
    await symlink(join(packageDir, 'node_modules', 'vitest'), join(root, 'node_modules', 'vitest'), linkType);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("gives a project's own vitest run the server's CSS Module class names", async () => {
    // A vitest run of the project's own, with its config - not this suite's.
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const name of Object.keys(env)) {
      if (name.startsWith('VITEST')) delete env[name];
    }
    const vitestCli = join(packageDir, 'node_modules', 'vitest', 'vitest.mjs');
    const run = await new Promise<{ code: number | null; output: string }>(resolveRun => {
      const child = spawn(process.execPath, [vitestCli, 'run'], { cwd: root, env });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
      child.on('close', code => resolveRun({ code, output }));
    });
    expect(run.code, run.output).toBe(0);

    const result = JSON.parse(await readFile(join(root, 'result.json'), 'utf8')) as {
      html: string;
      direct: Record<string, string>;
    };
    const classes = await compileCssModuleClasses(join(root, 'app', 'card.module.css'));
    expect(classes['card']).toMatch(/^card_[0-9a-f]{6}_card$/);
    // A test's own import and the rendered page alike, composes included.
    expect(result.direct).toEqual(classes);
    expect(result.html).toContain(`<p class="${classes['card']}">KIT_STYLED</p>`);
    expect(result.html).toMatch(/<link rel="stylesheet" href="\/_next\/static\/css\/route-index-[A-Z0-9]+\.css"/);
  }, 120_000);

  it('types as a vite plugin', () => {
    // Also a compile-time check: the declared types fit vite's PluginOption.
    expect(defineConfig({ plugins: [gioVitest()] }).plugins).toHaveLength(1);
  });
});

describe('callRoute and page actions', () => {
  let root: string;

  beforeAll(async () => {
    root = await writeProject('gio-testing-action-', {
      'app/contact/page.tsx': `import React from 'react';
import { redirect } from '${pathToFileURL(join(packageDir, 'src', 'action.ts')).href}';
export async function action(req) {
  const email = String((await req.formData()).get('email') ?? '');
  if (!email.includes('@')) return { status: 422, data: { error: 'ACTION_BAD_EMAIL' } };
  return redirect('/contact/thanks');
}
export default function Contact({ actionData }) {
  return React.createElement('p', null, actionData?.error ?? 'CONTACT_FORM');
}
`,
    });
  });

  afterAll(async () => {
    await resetTestApp(join(root, 'app'));
    await rm(root, { recursive: true, force: true });
  });

  it('posts a form to a page action: redirect, or a 422 re-render', async () => {
    const appDir = join(root, 'app');
    const sent = await callRoute('/contact', { appDir, method: 'POST', body: new URLSearchParams({ email: 'a@b.c' }) });
    expect(sent.status).toBe(303);
    expect(sent.headers['location']).toBe('/contact/thanks');

    const invalid = await callRoute('/contact', { appDir, method: 'POST', body: new URLSearchParams({ email: 'x' }) });
    expect(invalid.status).toBe(422);
    expect(await invalid.text()).toContain('ACTION_BAD_EMAIL');
  });
});

describe('callRoute and sessions', () => {
  let root: string;

  beforeAll(async () => {
    // What a project scaffolded with --auth has: a module-scope storage,
    // which throws in production (NODE_ENV=test) without a secret.
    root = await writeProject('gio-testing-session-', {
      'lib/session.server.ts': `import { createSessionStorage } from '${pathToFileURL(join(packageDir, 'src', 'session.ts')).href}';
export const sessions = createSessionStorage();
`,
      'app/api/login/route.ts': `import { sessions } from '../../../lib/session.server.ts';
export async function POST(req) {
  const session = sessions.getSession(req);
  session.set('email', (await req.json()).email);
  return new Response(null, { status: 204, headers: { 'set-cookie': sessions.commitSession(session) } });
}
`,
    });
  });

  afterAll(async () => {
    await resetTestApp(join(root, 'app'));
    await rm(root, { recursive: true, force: true });
  });

  it('logs in under NODE_ENV=test with no GIO_SESSION_SECRET set: the kit provides one', async () => {
    expect(process.env.NODE_ENV).toBe('test');
    const res = await callRoute('/api/login', {
      appDir: join(root, 'app'),
      method: 'POST',
      body: { email: 'ada@example.com' },
    });
    expect(res.status).toBe(204);
    expect(res.setCookies.join('\n')).toMatch(/^gio_session=/);
    expect(Buffer.byteLength(process.env.GIO_SESSION_SECRET ?? '')).toBeGreaterThanOrEqual(32);
  });
});

describe('callRoute and a route.ts that throws while it is imported', () => {
  let root: string;
  const errors: unknown[][] = [];

  beforeAll(async () => {
    root = await writeProject('gio-testing-broken-route-', {
      'lib/env.server.ts': `if (process.env.TK_REQUIRED_VAR === undefined) throw new Error('TK_REQUIRED_VAR is not set');
export const required = process.env.TK_REQUIRED_VAR;
`,
      'app/api/broken/route.ts': `import { required } from '../../../lib/env.server.ts';
export function POST() { return { required }; }
`,
      // A sibling page must not take the URL over (GET would render it).
      'app/api/broken/page.tsx': `import React from 'react';
export default function Sibling() { return React.createElement('p', null, 'SIBLING_PAGE'); }
`,
      'app/api/fine/route.ts': `export function GET() { return { fine: true }; }
`,
    });
  });

  afterAll(async () => {
    await resetTestApp(join(root, 'app'));
    await rm(root, { recursive: true, force: true });
  });

  it('answers 500 with a digest for every method, never 404, and logs the file and the error', async () => {
    const appDir = join(root, 'app');
    const errorSpy = vi.mocked(logger.error);
    errorSpy.mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    try {
      // OPTIONS too: a 405 would list methods the module may never export.
      for (const method of ['POST', 'GET', 'HEAD', 'DELETE', 'OPTIONS']) {
        const res = await callRoute('/api/broken', { appDir, method });
        expect(res.status, method).toBe(500);
        expect(res.headers['allow'], method).toBeUndefined();
        if (method === 'HEAD') continue;
        const body = await res.json<{ error: string; digest: string }>();
        expect(body.error).toBe('Internal Server Error');
        expect(body.digest).toMatch(/^[0-9a-f]{12}$/);
        expect(JSON.stringify(body)).not.toContain('TK_REQUIRED_VAR');
      }
      expect((await callRoute('/api/fine', { appDir })).status).toBe(200);
    } finally {
      errorSpy.mockImplementation(() => undefined);
    }
    const file = join(root, 'app', 'api', 'broken', 'route.ts');
    // Once at discovery, then per request under the response's digest.
    expect(errors[0]?.[0]).toMatch(/route file failed to load/);
    expect(errors[0]?.[1]).toMatchObject({ urlPattern: '/api/broken', filePath: file, error: 'TK_REQUIRED_VAR is not set' });
    expect(errors[1]?.[0]).toBe('route file failed to load');
    expect(errors[1]?.[1]).toMatchObject({
      path: '/api/broken',
      method: 'POST',
      digest: expect.stringMatching(/^[0-9a-f]{12}$/),
      filePath: file,
      error: 'TK_REQUIRED_VAR is not set',
    });
  });

  it('shows the file and the import error in development', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      const res = await callRoute('/api/broken', { appDir: join(root, 'app'), method: 'POST' });
      expect(res.status).toBe(500);
      const body = await res.json<{ error: string }>();
      expect(body.error).toBe(
        `route file ${join(root, 'app', 'api', 'broken', 'route.ts')} failed to load: TK_REQUIRED_VAR is not set`,
      );
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});

describe('renderPage and .env files', () => {
  const names = ['TK_ENV_FILE', 'TK_ENV_PRESET', 'TK_ENV_LOCAL', 'TK_ENV_DEV', 'TK_ENV_BROKEN'];
  const page = `import React from 'react';
export async function getServerSideProps() {
  const env = (name: string) => process.env[name] ?? null;
  return {
    props: { file: env('TK_ENV_FILE'), preset: env('TK_ENV_PRESET'), local: env('TK_ENV_LOCAL'), dev: env('TK_ENV_DEV') },
  };
}
export default function Home() { return React.createElement('p', null, 'ENV_HOME'); }
`;
  const roots: string[] = [];

  afterAll(async () => {
    for (const name of names) delete process.env[name];
    for (const root of roots) {
      await resetTestApp(join(root, 'app'));
      await rm(root, { recursive: true, force: true });
    }
  });

  it('loads them by the server\'s rules: precedence, mode, never over a variable already set', async () => {
    const root = await writeProject('gio-testing-env-', {
      '.env': 'TK_ENV_FILE=from-env\nTK_ENV_PRESET=from-file\nTK_ENV_LOCAL=from-env\n',
      '.env.local': 'TK_ENV_LOCAL=from-local\n',
      // Mode development only when NODE_ENV=development (vitest sets "test").
      '.env.development': 'TK_ENV_DEV=loaded\n',
      'app/page.tsx': page,
    });
    roots.push(root);
    expect(process.env.NODE_ENV).not.toBe('development');
    process.env.TK_ENV_PRESET = 'from-test';
    const home = await renderPage('/', { appDir: join(root, 'app') });
    expect(home.props).toEqual({ file: 'from-env', preset: 'from-test', local: 'from-local', dev: null });
  });

  it('fails like the server\'s startup on a file it cannot parse', async () => {
    const root = await writeProject('gio-testing-badenv-', {
      '.env': 'TK_ENV_BROKEN=1\nnot valid\n',
      'app/page.tsx': page,
    });
    roots.push(root);
    await expect(renderPage('/', { appDir: join(root, 'app') })).rejects.toThrow(
      'cannot load .env: invalid syntax on line 2',
    );
    expect(process.env.TK_ENV_BROKEN).toBeUndefined();
  });
});

describe('callRoute', () => {
  it('sends an object as JSON and reads the JSON answer', async () => {
    const res = await callRoute('/api/echo?from=path', {
      appDir,
      method: 'post',
      body: { title: 'hello', tags: ['a'] },
      query: { page: '2' },
      cookies: { session: 'abc' },
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(await res.json()).toEqual({
      method: 'POST',
      body: { title: 'hello', tags: ['a'] },
      query: { from: 'path', page: '2' },
      cookies: { session: 'abc' },
      contentType: 'application/json',
    });
    expect(res.stream).toBeNull();
  });

  it('keeps an explicit content-type, and answers 415 for a non-JSON body', async () => {
    const patched = await callRoute('/api/echo', {
      appDir,
      method: 'POST',
      headers: { 'Content-Type': 'application/merge-patch+json' },
      body: { title: null },
    });
    expect(await patched.json()).toMatchObject({ contentType: 'application/merge-patch+json' });

    const text = await callRoute('/api/echo', { appDir, method: 'POST', body: '{"a":1}' });
    expect(text.status).toBe(415);
  });

  it('returns every Set-Cookie value intact', async () => {
    const res = await callRoute('/api/session', { appDir, method: 'POST', body: { user: 'ada' } });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, user: 'ada' });
    expect(res.setCookies).toEqual([
      'session=user-ada; Path=/; HttpOnly; SameSite=Lax',
      // The Expires date carries a comma: never joined or split.
      'theme=dark; Expires=Wed, 21 Oct 2037 00:00:00 GMT; Path=/; SameSite=Lax',
    ]);
    expect(res.headers['set-cookie']).toBeUndefined();

    const out = await callRoute('/api/session', { appDir, method: 'DELETE' });
    expect(out.status).toBe(204);
    expect(await out.text()).toBe('');
  });

  it('reads text responses, form bodies and binary bodies', async () => {
    const text = await callRoute('/api/text?q=x', { appDir });
    expect(text.status).toBe(202);
    expect(text.headers['x-handler']).toBe('text');
    expect(text.headers['content-type']).toBe('text/plain;charset=UTF-8');
    expect(await text.text()).toBe('plain x');

    const form = await callRoute('/api/text', {
      appDir,
      method: 'POST',
      body: new URLSearchParams({ name: 'Ada Lovelace', role: 'admin' }),
    });
    expect(await form.json()).toEqual({
      contentType: 'application/x-www-form-urlencoded;charset=UTF-8',
      fields: { name: 'Ada Lovelace', role: 'admin' },
    });

    const binary = await callRoute('/api/binary', {
      appDir,
      method: 'PUT',
      body: new Uint8Array([0xff, 0x00, 0x41]),
    });
    expect(binary.headers['x-was-base64']).toBe('true');
    expect([...(await binary.bytes())]).toEqual([0x41, 0x00, 0xff]);

    const utf8 = await callRoute('/api/binary', { appDir, method: 'PUT', body: new TextEncoder().encode('ab') });
    expect(utf8.headers['x-was-base64']).toBe('false');
    expect(await utf8.text()).toBe('ba');
  });

  it('answers unknown methods, notFound() and handler failures like the server', async () => {
    const put = await callRoute('/api/echo', { appDir, method: 'PUT' });
    expect(put.status).toBe(405);
    expect(put.headers['allow']).toBe('GET, POST, HEAD');

    const missing = await callRoute('/api/missing', { appDir });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'Not Found' });

    const failed = await callRoute('/api/missing', { appDir, method: 'POST' });
    expect(failed.status).toBe(500);
    const body = await failed.json<{ error: string; digest: string }>();
    expect(body.error).toBe('Internal Server Error');
    expect(body.digest).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(body)).not.toContain('TESTING_KIT_HANDLER_FAILURE');
  });

  it('renders pages for GET and refuses other methods on them', async () => {
    const page = await callRoute('/posts/3', { appDir });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('POST_<!-- -->Post 3');
    expect((await callRoute('/posts/3', { appDir, method: 'POST' })).status).toBe(405);
  });

  it('exposes an event stream framed like the server sends it', async () => {
    const res = await callRoute('/api/events?count=2', { appDir });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.stream).not.toBeNull();
    expect(await res.text()).toBe(
      'id: 1\nevent: tick\ndata: {"n":1}\n\n' + 'id: 2\nevent: tick\ndata: {"n":2}\n\n',
    );
  });

  it('runs the stream cleanup when the reader goes away', async () => {
    const counter = (): number =>
      Number((globalThis as Record<string, unknown>)['__testingKitSseCleanups'] ?? 0);
    const before = counter();
    const res = await callRoute('/api/events?count=1&open', { appDir });
    const reader = res.stream!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('data: {"n":1}');
    expect(counter()).toBe(before);
    await reader.cancel();
    expect(counter()).toBe(before + 1);
  });
});

describe('server-only', () => {
  let root: string;

  beforeAll(async () => {
    root = await writeProject('gio-testing-client-', {
      'app/leak/page.tsx': `import React from 'react';
import { renderPage } from '@gio.js/core/testing';
export default function Leak() {
  return React.createElement('button', { onClick: () => void renderPage('/') }, 'LEAK');
}
`,
    });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('keeps the testing kit out of client bundles', async () => {
    const appDir = join(root, 'app');
    const manifest = await buildClientBundles({
      routes: await discoverRoutes(appDir),
      layouts: await discoverLayouts(appDir),
      projectRoot: root,
      dev: true,
      nodePaths: [join(packageDir, 'node_modules')],
    });
    expect(manifest.get('/leak')).toBeUndefined();
    expect(clientBuildErrorFor('/leak')).toContain('app/leak/page.tsx -> @gio.js/core/testing');
  }, 60_000);
});

/** A giojs-server binary to run against, if this checkout has one. */
function serverBinary(): string | undefined {
  if (process.env.GIO_SERVER_BIN) return process.env.GIO_SERVER_BIN;
  const exe = process.platform === 'win32' ? '.exe' : '';
  for (const profile of ['debug', 'release']) {
    const candidate = join(repoRoot, 'target', profile, `giojs-server${exe}`);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Linux: live processes running from `dir` (the worker's cwd is the project root). */
function processesIn(dir: string): number[] {
  if (process.platform !== 'linux') return [];
  const found: number[] = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      if (readlinkSync(`/proc/${name}/cwd`) === dir) found.push(Number(name));
    } catch {
      // Gone, or not ours.
    }
  }
  return found;
}

/** Enables POST /_gio/revalidate on the test server (>= 32 bytes). */
const REVALIDATE_TOKEN = 'testing-kit-revalidate-token-0123456789';

describe('createTestServer', () => {
  it('explains a missing binary', async () => {
    await expect(
      createTestServer({ appDir, binary: join(tmpdir(), 'no-such-giojs-server') }),
    ).rejects.toThrow(/binary not found at .*no-such-giojs-server/);
  });

  const binary = serverBinary();
  describe.skipIf(binary === undefined)('against the real server', () => {
    let server: TestServer;

    beforeAll(async () => {
      server = await createTestServer({
        appDir,
        binary: binary!,
        env: { RUST_LOG: 'info', GIO_REVALIDATE_TOKEN: REVALIDATE_TOKEN },
      });
    }, 90_000);

    afterAll(async () => {
      await server?.close();
    });

    it('serves pages and route handlers on 127.0.0.1', async () => {
      expect(server.url).toBe(`http://127.0.0.1:${server.port}`);
      const page = await fetch(`${server.url}/greet?name=srv`, { headers: { cookie: 'theme=dark' } });
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('HELLO_<!-- -->srv');
      expect(html).toContain('plugin=<!-- -->on');
      expect(page.headers.getSetCookie()).toEqual(['visited=1; Path=/', 'last=greet; Path=/; HttpOnly']);

      const api = await fetch(`${server.url}/api/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user: 'srv' }),
      });
      expect(api.status).toBe(201);
      expect(api.headers.getSetCookie()).toHaveLength(2);
      expect(server.logs()).toContain('GioJS listening on 127.0.0.1:');
    });

    it('runs the worker as a production process, not a vitest one', async () => {
      // In-process, the handler runs inside this vitest worker.
      expect(await (await callRoute('/api/runtime', { appDir })).json()).toMatchObject({
        vitest: 'true',
        dotenv: 'from-dotenv',
        sessionSecret: true,
      });
      const res = await fetch(`${server.url}/api/runtime`);
      expect(await res.json()).toEqual({
        vitest: null,
        nodeEnv: 'production',
        dotenv: 'from-dotenv',
        sessionSecret: false,
      });
    });

    it('uses a private cache, so the project cache is never touched', async () => {
      const first = await fetch(`${server.url}/cached`);
      expect(first.headers.get('x-gio-cache')).toMatch(/^miss/);
      await first.text();
      const second = await fetch(`${server.url}/cached`);
      expect(second.headers.get('x-gio-cache')).toMatch(/^hit/);
      await second.text();
      expect(existsSync(join(fixtureRoot, '.gio', 'cache'))).toBe(false);
    });

    it('purges a page by the tags renderPage reports', async () => {
      const { cacheTags } = await renderPage('/cached', { appDir });
      expect(cacheTags).toContain('generated:static');
      const warm = await fetch(`${server.url}/cached`);
      expect(warm.headers.get('x-gio-cache')).toMatch(/^hit/);
      await warm.text();
      const purge = await fetch(`${server.url}/_gio/revalidate`, {
        method: 'POST',
        headers: { authorization: `Bearer ${REVALIDATE_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ tags: ['generated:static'] }),
      });
      expect(await purge.json()).toEqual({ ok: true, purged: 1 });
      const fresh = await fetch(`${server.url}/cached`);
      expect(fresh.headers.get('x-gio-cache')).toBe('miss; stored');
      await fresh.text();
    });

    it('takes down the server and its worker on close', async () => {
      expect(processesIn(fixtureRoot).length).toBeGreaterThan(0);
      await server.close();
      await server.close();
      await expect(fetch(`${server.url}/_gio/health`)).rejects.toThrow();
      expect(processesIn(fixtureRoot)).toEqual([]);
    }, 30_000);
  });

  describe.skipIf(binary === undefined)('and .env files', () => {
    let root: string;

    beforeAll(async () => {
      root = await writeProject('gio-testing-server-env-', {
        '.env': 'TK_SERVER_SET_BY_TEST=from-file\n',
        '.env.production': 'TK_SERVER_MODE=production\n',
        '.env.development': 'TK_SERVER_MODE=development\n',
        'app/page.tsx': `import React from 'react';
export default function Home() { return React.createElement('p', null, 'SERVER_ENV_HOME'); }
`,
        'app/api/env/route.ts': `export function GET() {
  return { mode: process.env.TK_SERVER_MODE ?? null, setByTest: process.env.TK_SERVER_SET_BY_TEST ?? null };
}
`,
      });
    });

    afterAll(async () => {
      delete process.env.TK_SERVER_MODE;
      delete process.env.TK_SERVER_SET_BY_TEST;
      await resetTestApp(join(root, 'app'));
      await rm(root, { recursive: true, force: true });
    });

    it('leaves the files to the server: what renderPage loaded never overrides its own mode', async () => {
      const appDir = join(root, 'app');
      expect(await (await callRoute('/api/env', { appDir })).json()).toEqual({
        mode: 'production',
        setByTest: 'from-file',
      });
      // A value the test sets itself is handed down like any variable.
      process.env.TK_SERVER_SET_BY_TEST = 'from-test';
      const dev = await createTestServer({ appDir, binary: binary!, env: { NODE_ENV: 'development' } });
      try {
        const res = await fetch(`${dev.url}/api/env`);
        expect(await res.json()).toEqual({ mode: 'development', setByTest: 'from-test' });
      } finally {
        await dev.close();
      }
    }, 90_000);
  });

  describe.skipIf(binary === undefined)('without close()', () => {
    // test-fixtures/testing-orphans.ts, in a node process of its own, starts
    // a server for a throwaway project and never closes it.
    const script = join(packageDir, 'test-fixtures', 'testing-orphans.ts');
    let root: string;
    let child: ChildProcess | undefined;

    beforeAll(async () => {
      root = realpathSync(
        await writeProject('gio-testing-orphans-', {
          'app/page.tsx': `import React from 'react';
export default function Home() { return React.createElement('p', null, 'ORPHANS_HOME'); }
`,
        }),
      );
    });

    afterEach(() => {
      child?.kill('SIGKILL');
      child = undefined;
      // Whatever a failed test left behind.
      for (const pid of processesIn(root)) process.kill(pid, 'SIGKILL');
    });

    afterAll(async () => {
      await rm(root, { recursive: true, force: true });
    });

    /** Start the script; resolves with the port it printed and each line it prints. */
    function run(mode: 'forget' | 'hang' | 'thread'): { port: Promise<number>; line: (text: string) => Promise<void> } {
      const env: NodeJS.ProcessEnv = { ...process.env, GIO_SERVER_BIN: binary };
      for (const name of Object.keys(env)) {
        if (name.startsWith('VITEST')) delete env[name];
      }
      // `--import tsx` resolves from the cwd: this package has tsx installed.
      const started = spawn(process.execPath, ['--import', 'tsx', script, mode, join(root, 'app')], {
        cwd: packageDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child = started;
      let output = '';
      const waiters: Array<() => void> = [];
      const onOutput = (chunk: Buffer): void => {
        output += chunk.toString('utf8');
        for (const wake of waiters.splice(0)) wake();
      };
      let closed = false;
      started.stdout.on('data', onOutput);
      started.stderr.on('data', onOutput);
      started.once('close', () => {
        closed = true;
        for (const wake of waiters.splice(0)) wake();
      });
      const line = (text: string): Promise<void> =>
        new Promise((resolveLine, reject) => {
          const check = (): void => {
            if (output.split('\n').some(l => l.startsWith(text))) resolveLine();
            else if (closed) reject(new Error(`script ended before "${text}":\n${output}`));
            else waiters.push(check);
          };
          check();
        });
      const port = line('port ').then(() => Number(/^port (\d+)$/m.exec(output)?.[1]));
      return { port, line };
    }

    /** The exit code, or 'still running' once `ms` passed. */
    function exitWithin(ms: number): Promise<number | string | null> {
      const started = child!;
      if (started.exitCode !== null) return Promise.resolve(started.exitCode);
      return new Promise(resolveExit => {
        const timer = setTimeout(() => resolveExit('still running'), ms);
        started.once('exit', (code, signal) => {
          clearTimeout(timer);
          resolveExit(code ?? signal);
        });
      });
    }

    /** Nothing of the server for `root` is left: no process, no listener. */
    async function expectNothingLeft(port: number): Promise<void> {
      const answers = (): Promise<boolean> =>
        fetch(`http://127.0.0.1:${port}/_gio/health`).then(
          async res => {
            await res.body?.cancel();
            return true;
          },
          () => false,
        );
      // The watchdog acts within milliseconds; SIGKILL lands asynchronously.
      const deadline = Date.now() + 5_000;
      while ((processesIn(root).length > 0 || (await answers())) && Date.now() < deadline) {
        await new Promise(resolveTick => setTimeout(resolveTick, 50));
      }
      expect(processesIn(root)).toEqual([]);
      expect(await answers()).toBe(false);
    }

    it('a test process that forgets close() still exits, and takes its server along', async () => {
      const { port } = run('forget');
      const listening = await port;
      // An open server used to hold the process (and node:test runs) open forever.
      expect(await exitWithin(30_000)).toBe(0);
      await expectNothingLeft(listening);
    }, 90_000);

    it('a test process killed outright, with no hook run, leaves no server behind', async () => {
      const { port } = run('hang');
      const listening = await port;
      expect((await fetch(`http://127.0.0.1:${listening}/_gio/health`)).status).toBe(200);
      if (process.platform === 'linux') expect(processesIn(root).length).toBeGreaterThan(1);
      child!.kill('SIGKILL');
      expect(await exitWithin(10_000)).toBe('SIGKILL');
      await expectNothingLeft(listening);
    }, 90_000);

    it('a worker thread torn down without hooks (vitest pool: threads) leaves no server behind', async () => {
      const { port, line } = run('thread');
      const listening = await port;
      await line('terminated');
      await expectNothingLeft(listening);
      // The test process itself lives on: the thread's end was enough.
      expect(child!.exitCode).toBeNull();
    }, 90_000);
  });
});
