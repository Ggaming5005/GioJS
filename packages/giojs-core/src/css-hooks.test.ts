/**
 * giojs-core/src/css-hooks.test.ts
 *
 * `.css` imports in the worker, where Node cannot load a stylesheet: a real
 * tsx process (how Rust spawns the worker) loads a page through
 * loadTsModule. Global CSS evaluates to an empty module, a CSS Module to the
 * class map css-modules.ts compiles - the names the client bundle and the
 * route stylesheet carry. CommonJS gets the same for global CSS and a clear
 * error for CSS Modules.
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileCssModuleClasses } from './css-modules.ts';
import { cssHookSource } from './css-hooks.ts';

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const tsxCli = join(packageDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const loadTs = join(packageDir, 'src', 'load-ts.ts');

const RUNNER = `import { pathToFileURL } from 'node:url';
import { loadTsModule } from ${JSON.stringify(loadTs)};
const mod = await loadTsModule(pathToFileURL(process.argv[2]).href);
console.log(JSON.stringify(mod.default()));
`;

function runPage(root: string, page: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [tsxCli, join(root, 'run.mts'), join(root, page)], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
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
      'run.mts': RUNNER,
      'app/globals.css': '.g { color: red; }\n',
      'app/card.module.css': '.card { color: blue; }\n.title { composes: card; }\n',
      'app/page.tsx': `import './globals.css';
import globals from './globals.css';
import styles from './card.module.css';
export default () => ({ globals, styles });
`,
      'cjs/package.json': '{ "type": "commonjs" }\n',
      'cjs/run.mts': RUNNER,
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

  it('loads global CSS as an empty module and a CSS Module as its compiled class map', async () => {
    const run = runPage(root, 'app/page.tsx');
    expect(run.status, run.stderr).toBe(0);
    const { globals, styles } = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '{}') as {
      globals: unknown;
      styles: Record<string, string>;
    };
    expect(globals).toEqual({});
    expect(styles).toEqual(await compileCssModuleClasses(join(root, 'app', 'card.module.css')));
    expect(styles['title']).toMatch(/^card_[0-9a-f]{6}_card card_[0-9a-f]{6}_title$/);
  }, 40_000);

  it('loads global CSS from CommonJS and explains why a CSS Module cannot load there', () => {
    const cjsRoot = join(root, 'cjs');
    const globals = runPage(cjsRoot, 'app/global-page.ts');
    expect(globals.status, globals.stderr).toBe(0);
    expect(JSON.parse(globals.stdout.trim().split('\n').at(-1) ?? 'null')).toEqual({ globals: {} });
    const modules = runPage(cjsRoot, 'app/module-page.ts');
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
