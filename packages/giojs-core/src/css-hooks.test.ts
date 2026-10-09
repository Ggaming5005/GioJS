/**
 * giojs-core/src/css-hooks.test.ts
 *
 * `.css` imports in the worker, where Node cannot load a stylesheet: a real
 * tsx process loads a page through loadTsModule - launched through tsx's CLI
 * (how Rust spawns the worker), and as plain node where tsx comes in through
 * its API alone (docs-site/build.mjs). Global CSS evaluates to an empty
 * module, a CSS Module to the class map css-modules.ts compiles - the names
 * the client bundle and the route stylesheet carry. CommonJS gets the same
 * for global CSS and a clear error for CSS Modules.
 *
 * The hooks must use the hook API tsx registered with: on Node 24.11.1+ tsx
 * uses module.registerHooks(), and a module.register() hook next to it left
 * every app module with an empty namespace - every page answered 500
 * ("Element type is invalid") and middleware.ts "had no default export".
 * vitest's module runner never loads app code through Node's loader, so the
 * loading itself is tested in child processes.
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import Module, { type LoadFnOutput, type LoadHookContext } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { compileCssModuleClasses } from './css-modules.ts';
import { cssHookSource, cssLoadHook, hookApiOf } from './css-hooks.ts';

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const tsxDir = join(packageDir, 'node_modules', 'tsx');
const tsxCli = join(tsxDir, 'dist', 'cli.mjs');
const tsxApi = pathToFileURL(join(tsxDir, 'dist', 'esm', 'api', 'index.mjs')).href;
const loadTs = pathToFileURL(join(packageDir, 'src', 'load-ts.ts')).href;

/**
 * How a child process gets tsx. `cli`: through tsx's CLI, as the server
 * spawns the worker (ipc.rs spawn_node_tsx) - tsx's hooks are preloaded and
 * loadTsModule registers them once more. `api`: plain node, where
 * loadTsModule's registration is the only global one (load-ts.ts itself
 * comes in through tsImport, as docs-site/build.mjs loads the exporter).
 */
type Launch = 'cli' | 'api';
const LAUNCHES: Launch[] = ['cli', 'api'];

/** Top of every runner script: `loadTsModule` as `launch` (argv[2]) gets it. */
const RUNNER_PRELUDE = `const launch = process.argv[2];
const { loadTsModule } = launch === 'api'
  ? await (await import(${JSON.stringify(tsxApi)})).tsImport(${JSON.stringify(loadTs)}, import.meta.url)
  : await import(${JSON.stringify(loadTs)});
`;

/** Loads the page at argv[3] and prints what its default export returns. */
const RUNNER = `import { pathToFileURL } from 'node:url';
${RUNNER_PRELUDE}const mod = await loadTsModule(pathToFileURL(process.argv[3]).href);
console.log(JSON.stringify(mod.default()));
`;

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Run `root`/run.mjs as `launch` (args after it), as the worker would run: no vitest variables. */
function runScript(root: string, launch: Launch, args: string[], tsconfig?: string): Run {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // VITEST switches load-ts.ts to vitest's import conventions.
  for (const name of Object.keys(env)) {
    if (name.startsWith('VITEST')) delete env[name];
  }
  delete env['TSX_TSCONFIG_PATH'];
  // What the server sets on its worker (ipc.rs worker_tsconfig).
  if (tsconfig !== undefined) env['TSX_TSCONFIG_PATH'] = tsconfig;
  const script = join(root, 'run.mjs');
  const argv = launch === 'cli' ? [tsxCli, script, launch, ...args] : [script, launch, ...args];
  const result = spawnSync(process.execPath, argv, { cwd: root, env, encoding: 'utf8', timeout: 30_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runPage(root: string, launch: Launch, page: string): Run {
  return runScript(root, launch, [join(root, page)]);
}

function lastLine(stdout: string): string {
  return stdout.trim().split('\n').at(-1) ?? '';
}

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, contents] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), contents);
  }
}

describe('.css imports in the worker', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'gio-css-hooks-'));
    await writeFiles(root, {
      'package.json': '{ "type": "module" }\n',
      'run.mjs': RUNNER,
      'app/globals.css': '.g { color: red; }\n',
      'app/card.module.css': '.card { color: blue; }\n.title { composes: card; }\n',
      'app/page.tsx': `import './globals.css';
import globals from './globals.css';
import styles from './card.module.css';
export default () => ({ globals, styles });
`,
      'cjs/package.json': '{ "type": "commonjs" }\n',
      'cjs/run.mjs': RUNNER,
      'cjs/app/globals.css': '.g { color: red; }\n',
      'cjs/app/card.module.css': '.card { color: blue; }\n',
      'cjs/app/global-page.ts': `import globals from './globals.css';
export default () => ({ globals });
`,
      'cjs/app/module-page.ts': `import styles from './card.module.css';
export default () => ({ styles });
`,
    });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each(LAUNCHES)(
    '%s: loads global CSS as an empty module and a CSS Module as its compiled class map',
    async launch => {
      const run = runPage(root, launch, 'app/page.tsx');
      expect(run.status, run.stderr).toBe(0);
      const { globals, styles } = JSON.parse(lastLine(run.stdout) || '{}') as {
        globals: unknown;
        styles: Record<string, string>;
      };
      expect(globals).toEqual({});
      expect(styles).toEqual(await compileCssModuleClasses(join(root, 'app', 'card.module.css')));
      expect(styles['title']).toMatch(/^card_[0-9a-f]{6}_card card_[0-9a-f]{6}_title$/);
    },
    40_000,
  );

  // The worker's launch only: loaded through tsx's API alone (tsImport), a
  // CommonJS .ts page fails in tsx itself, on every Node version.
  it('cli: loads global CSS from CommonJS and explains why a CSS Module cannot load there', () => {
    const cjsRoot = join(root, 'cjs');
    const globals = runPage(cjsRoot, 'cli', 'app/global-page.ts');
    expect(globals.status, globals.stderr).toBe(0);
    expect(JSON.parse(lastLine(globals.stdout) || 'null')).toEqual({ globals: {} });
    const modules = runPage(cjsRoot, 'cli', 'app/module-page.ts');
    expect(modules.status).not.toBe(0);
    expect(modules.stderr).toContain('CSS Modules need ES modules');
  }, 40_000);

  it('leaves every other URL to the next hook', async () => {
    const hooks = (await import(
      `data:text/javascript,${encodeURIComponent(cssHookSource('file:///core/css-modules.ts'))}`
    )) as {
      load: (url: string, context: object, next: (url: string) => unknown) => Promise<{ source?: string } | string>;
    };
    const next = (url: string): string => `next:${url}`;
    expect(await hooks.load('file:///app/page.tsx', {}, next)).toBe('next:file:///app/page.tsx');
    expect(await hooks.load('node:fs', {}, next)).toBe('next:node:fs');
    const moduleCss = await hooks.load('file:///app/x.module.css?v=1', {}, next);
    expect(typeof moduleCss === 'object' ? moduleCss.source : '').toContain('cssModuleClasses("file:///app/x.module.css")');
  });
});

/** Loads the app the way the worker does and renders its home page; prints one JSON report. */
const APP_RUNNER = `import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
${RUNNER_PRELUDE}const load = file => loadTsModule(pathToFileURL(join(process.cwd(), file)).href);
const layout = await load('app/layout.tsx');
const page = await load('app/page.tsx');
const middleware = await load('middleware.ts');
const report = {
  exports: { layout: Object.keys(layout), page: Object.keys(page), middleware: Object.keys(middleware) },
  middleware: middleware.default ?? null,
  html: null,
  renderError: null,
};
try {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  report.html = renderToStaticMarkup(createElement(layout.default, null, createElement(page.default)));
} catch (error) {
  report.renderError = error instanceof Error ? error.message : String(error);
}
console.log(JSON.stringify(report));
`;

describe('app modules next to the .css hooks', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'gio-css-hooks-app-'));
    const middlewareModule = pathToFileURL(join(packageDir, 'src', 'middleware.ts')).href;
    await writeFiles(root, {
      'package.json': '{ "type": "module" }\n',
      'tsconfig.json': `${JSON.stringify({
        compilerOptions: { jsx: 'react-jsx', module: 'esnext', moduleResolution: 'bundler', strict: true },
      })}\n`,
      'run.mjs': APP_RUNNER,
      'middleware.ts': `import { defineMiddleware } from ${JSON.stringify(middlewareModule)};
export default defineMiddleware({ redirects: [{ from: '/old', to: '/' }] });
`,
      'app/globals.css': 'body { margin: 0; }\n',
      'app/card.module.css': '.card { color: blue; }\n.title { composes: card; font-weight: 600; }\n',
      'app/layout.tsx': `import type { ReactNode } from 'react';
import './globals.css';
export const metadata = { title: 'Fixture' };
export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
`,
      'app/page.tsx': `import styles from './card.module.css';
export const metadata = { title: 'Home' };
export default function Home() {
  return <main className={styles.card}><h1 className={styles.title}>Hello</h1></main>;
}
`,
    });
    // The app's own React, as a project has it.
    await mkdir(join(root, 'node_modules'));
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    for (const dep of ['react', 'react-dom']) {
      await symlink(join(packageDir, 'node_modules', dep), join(root, 'node_modules', dep), linkType);
    }
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each(LAUNCHES)(
    '%s: layouts, pages and middleware.ts keep their exports and render the client class names',
    async launch => {
      const run = runScript(root, launch, [], join(root, 'tsconfig.json'));
      expect(run.status, run.stderr).toBe(0);
      const report = JSON.parse(lastLine(run.stdout) || '{}') as {
        exports: Record<string, string[]>;
        middleware: unknown;
        html: string | null;
        renderError: string | null;
      };
      expect(report.exports).toEqual({
        layout: ['default', 'metadata'],
        page: ['default', 'metadata'],
        middleware: ['default'],
      });
      expect(report.middleware).toEqual({ redirects: [{ from: '/old', to: '/' }] });
      expect(report.renderError).toBeNull();
      const classes = await compileCssModuleClasses(join(root, 'app', 'card.module.css'));
      expect(classes['title']).toMatch(/^card_[0-9a-f]{6}_card card_[0-9a-f]{6}_title$/);
      expect(report.html).toContain(
        `<main class="${classes['card']}"><h1 class="${classes['title']}">Hello</h1></main>`,
      );
    },
    40_000,
  );
});

describe('the module.registerHooks() load hook', () => {
  const hook = cssLoadHook('file:///core/css-modules.ts');
  const next = (url: string): LoadFnOutput => ({ format: 'next', source: url });
  const imported: LoadHookContext = { conditions: ['node', 'import'], format: undefined, importAttributes: {} };
  const required: LoadHookContext = { conditions: ['require', 'node'], format: undefined, importAttributes: {} };

  it('loads what the module.register() hook loads, and leaves every other URL to the next hook', () => {
    expect(hook('file:///app/page.tsx', imported, next)).toEqual(next('file:///app/page.tsx'));
    expect(hook('node:fs', imported, next)).toEqual(next('node:fs'));
    expect(hook('file:///app/globals.css', imported, next)).toEqual({
      format: 'module',
      shortCircuit: true,
      source: 'export default {};\n',
    });
    const moduleCss = hook('file:///app/x.module.css?v=1', imported, next);
    expect(moduleCss.format).toBe('module');
    expect(String(moduleCss.source)).toBe(
      'import { cssModuleClasses } from "file:///core/css-modules.ts";\n' +
        'export default await cssModuleClasses("file:///app/x.module.css");\n',
    );
  });

  it('answers require() as CommonJS: an empty module for global CSS, the ES modules error for a CSS Module', () => {
    expect(hook('file:///app/globals.css', required, next)).toEqual({
      format: 'commonjs',
      shortCircuit: true,
      source: 'module.exports = {};\n',
    });
    const cssModule = join(tmpdir(), 'card.module.css');
    expect(() => hook(pathToFileURL(cssModule).href, required, next)).toThrow(
      `CSS Module ${cssModule} was required from CommonJS. CSS Modules need ES modules`,
    );
  });
});

describe('hookApiOf', () => {
  const host = Module as unknown as { registerHooks?: (options: object) => unknown };
  let saved: PropertyDescriptor | undefined;

  beforeEach(() => {
    saved = Object.getOwnPropertyDescriptor(Module, 'registerHooks');
  });

  afterEach(() => {
    if (saved === undefined) delete host.registerHooks;
    else Object.defineProperty(Module, 'registerHooks', saved);
  });

  it('names registerHooks() when the registration calls it, and puts it back', () => {
    const registrations: object[] = [];
    const registerHooks = (options: object): object => {
      registrations.push(options);
      return { deregister: () => undefined };
    };
    host.registerHooks = registerHooks;
    expect(hookApiOf(() => host.registerHooks?.({ load: 'tsx' }))).toBe('sync');
    expect(registrations).toEqual([{ load: 'tsx' }]);
    expect(host.registerHooks).toBe(registerHooks);
  });

  it('names register() when it does not - also where Node has no registerHooks', () => {
    let registrations = 0;
    host.registerHooks = () => undefined;
    expect(hookApiOf(() => (registrations += 1))).toBe('async');
    delete host.registerHooks;
    expect(hookApiOf(() => (registrations += 1))).toBe('async');
    expect(registrations).toBe(2);
  });

  it('puts registerHooks back when the registration throws', () => {
    const registerHooks = (): undefined => undefined;
    host.registerHooks = registerHooks;
    expect(() =>
      hookApiOf(() => {
        throw new Error('refused');
      }),
    ).toThrow('refused');
    expect(host.registerHooks).toBe(registerHooks);
  });
});
