/**
 * giojs-core/src/css-build.test.ts
 *
 * The route stylesheet build against a real fixture app: one content-hashed
 * stylesheet per route plus a shared one for the root layout, cascade order
 * (root layout, layouts outer to inner, page), CSS Modules named exactly as
 * the worker's SSR import and the client bundle name them, url() assets, and
 * failure isolation.
 */
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildRouteStylesheets } from './css-build.ts';
import { buildClientBundles } from './client-build.ts';
import { cssModuleClasses, compileCssModuleClasses } from './css-modules.ts';
import { logger } from './logger.ts';
import { segmentStylesheetKey, type StyleManifest } from './style-manifest.ts';
import {
  discoverLayouts,
  discoverRoutes,
  discoverSegmentFiles,
  type LayoutEntry,
  type RouteModule,
  type SegmentFiles,
} from './router.ts';

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));

async function writeProject(prefix: string, files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  for (const [rel, contents] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), contents);
  }
  return root;
}

const component = (name: string, imports: string, body = `'${name}'`): string => `import React from 'react';
${imports}
export default function ${name}({ children }: { children?: React.ReactNode }) {
  return React.createElement('div', null, ${body}, children);
}
`;

const FIXTURE: Record<string, string> = {
  'package.json': '{ "name": "css-fixture", "type": "module" }\n',
  'app/layout.tsx': component(
    'RootLayout',
    `import './globals.css';\nimport Nav from '../components/Nav.tsx';`,
    'React.createElement(Nav)',
  ),
  'app/globals.css': `.global-marker { color: red; background: url(/public/bg.png); }
.with-icon { background-image: url(./icon.svg); }
`,
  'app/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n',
  'components/Nav.tsx': component('Nav', `import styles from './nav.module.css';`, 'styles.nav'),
  'components/nav.module.css': '.nav { color: navy; }\n',
  'app/page.tsx': `import React from 'react';
import { readFileSync } from 'node:fs';
import './globals.css';
import './home.css';
import styles from './home.module.css';
export default function Home() { return React.createElement('h1', { className: styles.title }, 'home'); }
export async function getServerSideProps() { return { props: { x: readFileSync('/etc/hostname', 'utf8') } }; }
`,
  'app/home.css': '.home-first { order: 1; }\n',
  'app/home.module.css': '.title { color: green; }\n.home-last { order: 2; }\n',
  'app/docs/layout.tsx': component('DocsLayout', `import './docs-layout.css';`),
  'app/docs/docs-layout.css': '.docs-layout-marker { order: 1; }\n',
  'app/docs/page.tsx': component('Docs', `import styles from './docs.module.css';`, 'styles.article'),
  'app/docs/docs.module.css': `.article { composes: shared from '../shared.module.css'; color: teal; }
:global(.docs-global) { order: 3; }
`,
  'app/shared.module.css': '.shared { margin: 0; }\n',
  'app/plain/page.tsx': component('Plain', ''),
  'app/not-found.tsx': component('NotFound', `import './not-found.css';`),
  'app/not-found.css': '.not-found-marker { order: 4; }\n',
};

async function discover(root: string): Promise<{
  routes: Map<string, RouteModule>;
  layouts: Map<string, LayoutEntry>;
  segmentFiles: SegmentFiles;
}> {
  const appDir = join(root, 'app');
  const [routes, layouts, segmentFiles] = await Promise.all([
    discoverRoutes(appDir),
    discoverLayouts(appDir),
    discoverSegmentFiles(appDir),
  ]);
  return { routes, layouts, segmentFiles };
}

describe('buildRouteStylesheets', () => {
  let root: string;
  let manifest: StyleManifest;
  let cssDir: string;

  const sheet = async (url: string | undefined): Promise<string> => {
    expect(url).toBeDefined();
    return readFile(join(cssDir, url?.split('/').pop() ?? ''), 'utf8');
  };

  beforeAll(async () => {
    root = await writeProject('gio-css-build-', FIXTURE);
    cssDir = join(root, '.gio', 'build', 'static', 'css');
    manifest = await buildRouteStylesheets({ ...(await discover(root)), projectRoot: root, dev: true });
  }, 60_000);

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('emits a content-hashed root stylesheet followed by one per route', async () => {
    const [rootUrl, homeUrl] = manifest.routes.get('/') ?? [];
    expect(rootUrl).toMatch(/^\/_next\/static\/css\/root-[A-Z0-9]+\.css$/);
    expect(homeUrl).toMatch(/^\/_next\/static\/css\/route-index-[A-Z0-9]+\.css$/);
    expect(manifest.routes.get('/docs')?.[0]).toBe(rootUrl);
    expect(manifest.routes.get('/docs')?.[1]).toMatch(/^\/_next\/static\/css\/route-docs-[A-Z0-9]+\.css$/);
    const files = await readdir(cssDir);
    for (const url of [...manifest.routes.values()].flat()) {
      expect(files).toContain(url.split('/').pop());
    }
  });

  it("collects the server-only root layout's CSS, through the components it renders", async () => {
    const css = await sheet(manifest.routes.get('/')?.[0]);
    expect(css).toContain('.global-marker');
    const nav = await cssModuleClasses(join(root, 'components', 'nav.module.css'));
    expect(css).toContain(`.${nav['nav']}`);
  });

  it('leaves out of route stylesheets what the root stylesheet already holds', async () => {
    const css = await sheet(manifest.routes.get('/')?.[1]);
    expect(css).toContain('.home-first');
    expect(css).not.toContain('.global-marker');
  });

  it('gives a route without CSS of its own only the root stylesheet', () => {
    expect(manifest.routes.get('/plain')).toEqual([manifest.routes.get('/')?.[0]]);
  });

  it('keeps side-effect CSS in import order, layouts before the page', async () => {
    const home = await sheet(manifest.routes.get('/')?.[1]);
    const homeModule = await cssModuleClasses(join(root, 'app', 'home.module.css'));
    expect(home.indexOf('.home-first')).toBeLessThan(home.indexOf(`.${homeModule['home-last']}`));
    const docs = await sheet(manifest.routes.get('/docs')?.[1]);
    const docsModule = await cssModuleClasses(join(root, 'app', 'docs', 'docs.module.css'));
    const article = docsModule['article']?.split(' ').pop() ?? 'missing';
    expect(docs.indexOf('.docs-layout-marker')).toBeLessThan(docs.indexOf(`.${article}`));
  });

  it('names CSS Module classes exactly as the worker-side compile does, composes and :global included', async () => {
    const docs = await sheet(manifest.routes.get('/docs')?.[1]);
    const classes = await compileCssModuleClasses(join(root, 'app', 'docs', 'docs.module.css'));
    const shared = await compileCssModuleClasses(join(root, 'app', 'shared.module.css'));
    expect(classes['article']).toMatch(/^shared_[0-9a-f]{6}_shared docs_[0-9a-f]{6}_article$/);
    expect(classes['article']?.split(' ')[0]).toBe(shared['shared']);
    for (const name of classes['article']?.split(' ') ?? []) expect(docs).toContain(`.${name}`);
    expect(docs).toContain('.docs-global');
    expect(classes['docs-global']).toBeUndefined();
  });

  it('keeps site-absolute url()s and emits relative url() assets next to the stylesheet', async () => {
    const css = await sheet(manifest.routes.get('/')?.[0]);
    expect(css).toContain('url(/public/bg.png)');
    const asset = /url\("?\.\/(icon-[A-Z0-9]+\.svg)"?\)/.exec(css)?.[1];
    expect(asset).toBeDefined();
    expect(await readdir(cssDir)).toContain(asset);
  });

  it('builds not-found pages their own stylesheet after the root one', async () => {
    const sheets = manifest.segmentPages.get(segmentStylesheetKey('notFound', '')) ?? [];
    expect(sheets[0]).toBe(manifest.routes.get('/')?.[0]);
    expect(await sheet(sheets[1])).toContain('.not-found-marker');
  });

  it('ships no JavaScript into the stylesheet directory', async () => {
    expect((await readdir(cssDir)).filter(f => f.endsWith('.js'))).toEqual([]);
  });
});

describe('buildRouteStylesheets in production', () => {
  it('minifies stylesheets but never CSS Module names', async () => {
    const root = await writeProject('gio-css-prod-', FIXTURE);
    try {
      const manifest = await buildRouteStylesheets({ ...(await discover(root)), projectRoot: root, dev: false });
      const url = manifest.routes.get('/')?.[1] ?? '';
      const css = await readFile(join(root, '.gio', 'build', 'static', 'css', url.split('/').pop() ?? ''), 'utf8');
      const classes = await compileCssModuleClasses(join(root, 'app', 'home.module.css'));
      expect(css).toContain(`.${classes['title']}{color:green}`);
      expect(css).not.toContain('\n  ');
      expect((await readdir(join(root, '.gio', 'build', 'static', 'css'))).some(f => f.endsWith('.map'))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});

// The shape of Tailwind v4 CLI output: cascade layers, @property, nesting,
// oklch colors and custom properties.
const TAILWIND_OUTPUT = `/*! tailwindcss v4.1.0 | MIT License | https://tailwindcss.com */
@layer properties;
@layer theme, base, components, utilities;
@layer theme {
  :root, :host { --color-blue-500: oklch(62.3% 0.214 259.815); --spacing: 0.25rem; }
}
@layer base { *, ::after, ::before { box-sizing: border-box; margin: 0; } }
@layer utilities {
  .p-4 { padding: calc(var(--spacing) * 4); }
  .text-blue-500 { color: var(--color-blue-500); }
  .hover\\:underline { &:hover { @media (hover: hover) { text-decoration-line: underline; } } }
}
@property --tw-shadow { syntax: "*"; inherits: false; initial-value: 0 0 #0000; }
`;

describe('Tailwind CLI output imported from the root layout', () => {
  it('ships with its layers, @property rules and escaped class names intact', async () => {
    const root = await writeProject('gio-css-tailwind-', {
      ...FIXTURE,
      'app/layout.tsx': component('RootLayout', `import './tailwind.out.css';`),
      'app/tailwind.out.css': TAILWIND_OUTPUT,
    });
    try {
      const manifest = await buildRouteStylesheets({ ...(await discover(root)), projectRoot: root, dev: false });
      const url = manifest.routes.get('/')?.[0] ?? '';
      const css = await readFile(join(root, '.gio', 'build', 'static', 'css', url.split('/').pop() ?? ''), 'utf8');
      expect(css).toContain('@layer theme,base,components,utilities');
      expect(css).toContain('@property --tw-shadow');
      expect(css).toContain('.hover\\:underline');
      expect(css).toContain('.text-blue-500{color:var(--color-blue-500)}');
      expect(css).toContain('oklch(');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('a stylesheet that fails to build', () => {
  it('costs only its own route its stylesheet', async () => {
    const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const root = await writeProject('gio-css-broken-', {
      ...FIXTURE,
      'app/broken/page.tsx': component('Broken', `import './missing.css';`),
    });
    try {
      const manifest = await buildRouteStylesheets({ ...(await discover(root)), projectRoot: root, dev: true });
      expect(manifest.routes.get('/broken')).toEqual([manifest.routes.get('/')?.[0]]);
      expect(manifest.routes.get('/')?.[1]).toMatch(/route-index-/);
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining('stylesheet failed to build'),
        expect.objectContaining({ pattern: '/broken' }),
      );
    } finally {
      errorLog.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('CSS Modules in the client bundle', () => {
  it('carry the same class names as SSR and render the route stylesheets', async () => {
    const root = await writeProject('gio-css-client-', FIXTURE);
    try {
      const discovered = await discover(root);
      const stylesheets = await buildRouteStylesheets({ ...discovered, projectRoot: root, dev: true });
      const scripts = await buildClientBundles({
        ...discovered,
        projectRoot: root,
        dev: true,
        stylesheets: stylesheets.routes,
        nodePaths: [join(packageDir, 'node_modules')],
      });
      const chunksDir = join(root, '.gio', 'build', 'static', 'chunks');
      const entry = await readFile(join(chunksDir, scripts.get('/docs')?.split('/').pop() ?? ''), 'utf8');
      const classes = await cssModuleClasses(join(root, 'app', 'docs', 'docs.module.css'));
      expect(entry).toContain(JSON.stringify(classes['article']));
      for (const url of stylesheets.routes.get('/docs') ?? []) expect(entry).toContain(url);
      // Plain CSS is never inlined into JavaScript.
      const chunks = (await readdir(chunksDir)).filter(f => f.endsWith('.js'));
      for (const chunk of chunks) {
        expect(await readFile(join(chunksDir, chunk), 'utf8')).not.toContain('docs-layout-marker');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
