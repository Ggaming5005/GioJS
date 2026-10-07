/**
 * Tailwind CSS v4 through its official CLI, the recipe the CSS docs give:
 * app/tailwind.css (input) builds into app/tailwind.out.css, which the root
 * layout imports - GioJS bundles imported CSS itself and never compiles
 * Tailwind directives. `dev` runs the watcher next to the server
 * (scripts/dev.mjs, no extra dependencies); build/start/export build the
 * stylesheet once first, and a project without a build script gets one.
 *
 * The starter's own stylesheet moves into Tailwind's `base` layer
 * (`@import ... layer(base)`): unlayered CSS beats every layered rule, so
 * left as it was, its element resets would override Tailwind's utilities.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FileEdit, Overlay, OverlayContext } from '../types.js';

export const TAILWIND_INPUT = 'app/tailwind.css';
export const TAILWIND_OUTPUT = 'app/tailwind.out.css';
const CLI = `tailwindcss -i ./${TAILWIND_INPUT} -o ./${TAILWIND_OUTPUT}`;
export const CSS_BUILD = `${CLI} --minify`;
const DEV_RUNNER = 'node scripts/dev.mjs';
const LAYOUTS = ['app/layout.tsx', 'app/layout.jsx', 'app/layout.js', 'app/layout.ts'];

const GLOBALS_LINK = /^[ \t]*<link\s+rel="stylesheet"\s+href="\/public\/styles\/globals\.css"\s*\/>[ \t]*\r?\n/m;
const GLOBALS_IMPORT = /^import\s+(['"])(\.{1,2}\/[^'"]*globals\.css)\1;?[ \t]*$/m;
const IMPORT_LINE = /^import\s[^;]*?(?:from\s+)?['"][^'"]+['"];?[ \t]*$/gm;

/** The starter stylesheet the layout loads, as a path relative to app/. */
function starterStylesheet(layout: string): string | null {
  if (GLOBALS_LINK.test(layout)) return '../public/styles/globals.css';
  return GLOBALS_IMPORT.exec(layout)?.[2] ?? null;
}

function readLayout(ctx: OverlayContext): string | null {
  const path = LAYOUTS.map(candidate => join(ctx.dir, candidate)).find(existsSync);
  return path === undefined ? null : readFileSync(path, 'utf8');
}

export function tailwindInput(layout: string | null): string {
  const starter = layout === null ? null : starterStylesheet(layout);
  const lines = [
    '/* Tailwind input: `npm run dev` rebuilds app/tailwind.out.css from it as you',
    '   edit (the root layout imports that output - never this file). */',
    '@import "tailwindcss";',
  ];
  if (starter !== null) {
    lines.push(
      '',
      "/* The starter's styles, in Tailwind's base layer so utility classes override",
      '   them (unlayered CSS would win over every utility). */',
      `@import "${starter}" layer(base);`,
    );
  }
  return lines.join('\n') + '\n';
}

/** Point the root layout at the generated stylesheet. */
export function importTailwindOutput(layout: string): string {
  if (layout.includes('tailwind.out.css')) return layout;
  const statement = "import './tailwind.out.css';";
  if (GLOBALS_IMPORT.test(layout)) return layout.replace(GLOBALS_IMPORT, statement);
  const withoutLink = layout.replace(GLOBALS_LINK, '');
  const imports = [...withoutLink.matchAll(IMPORT_LINE)];
  const last = imports[imports.length - 1];
  if (last === undefined) return `${statement}\n${withoutLink}`;
  const at = last.index + last[0].length;
  return `${withoutLink.slice(0, at)}\n${statement}${withoutLink.slice(at)}`;
}

/** `tailwindcss ... --minify && <script>`, once. */
function withCssBuild(current: string | undefined): string | undefined {
  if (current === undefined || current.includes(CLI)) return current;
  return `${CSS_BUILD} && ${current}`;
}

/**
 * The build script builds the stylesheet even when the project had none (an
 * app from `create-giojs migrate`): the Dockerfile and the CI workflow run
 * `build` before `gio build standalone`, and the output is git-ignored, so
 * nothing else would create it in a clean checkout.
 */
function buildWithCss(current: string | undefined): string | undefined {
  return current === undefined ? CSS_BUILD : withCssBuild(current);
}

const layoutEdit: FileEdit = {
  paths: LAYOUTS,
  apply: content => importTailwindOutput(content),
  manual: `Import the generated stylesheet in your root layout: import './tailwind.out.css';`,
};

export const tailwind: Overlay = {
  name: 'tailwind',
  title: 'Tailwind CSS',
  hint: 'Tailwind v4 via its CLI, rebuilt as you edit',
  modes: ['server', 'static'],
  templateDirs: ['tailwind'],
  generate: ctx => [{ path: TAILWIND_INPUT, content: tailwindInput(readLayout(ctx)), onExisting: 'keep' }],
  devDependencies: {
    '@tailwindcss/cli': '^4.1.0',
    tailwindcss: '^4.1.0',
  },
  scripts: ctx => {
    const dev = ctx.packageJson.scripts?.['dev'];
    return {
      'css:build': CSS_BUILD,
      'css:watch': `${CLI} --watch`,
      // The server command moves to dev:server; dev runs both.
      'dev:server': current => current ?? (dev === DEV_RUNNER ? undefined : dev),
      // Only while moving the server command; a dev script changed after
      // that is the user's.
      dev: current =>
        current === undefined || ctx.packageJson.scripts?.['dev:server'] !== undefined ? current : DEV_RUNNER,
      build: buildWithCss,
      start: withCssBuild,
      export: withCssBuild,
    };
  },
  gitignore: ['# Generated by Tailwind (npm run css:build)', TAILWIND_OUTPUT],
  edits: () => [layoutEdit],
  agents:
    '- Tailwind CSS v4 (CLI): `app/tailwind.css` is the input and `app/tailwind.out.css` the generated,\n' +
    '  git-ignored output the root layout imports (never import the input). The dev script runs the\n' +
    '  watcher next to the server (scripts/dev.mjs); build/start/export build the output first. The\n' +
    "  starter stylesheet is imported into Tailwind's base layer, so utility classes override it.",
  postSteps: ctx => [
    `Use Tailwind classes in any component - \`${ctx.packageManager.run('dev')}\` runs the Tailwind watcher next to the server.`,
    `The starter's own styles now load from ${TAILWIND_INPUT} (in Tailwind's base layer).`,
  ],
};
