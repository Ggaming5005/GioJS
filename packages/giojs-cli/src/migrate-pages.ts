/**
 * packages/giojs-cli/src/migrate-pages.ts
 *
 * pages/ router → app/ router file mapping, and the root layout generated
 * from pages/_app + pages/_document. GioJS uses the app/ conventions
 * (page/layout/route/not-found/error/loading, [param], [...slug],
 * [[...slug]], (group), _private), so an app/ project keeps its structure.
 */
import ts from 'typescript';
import { TODO_MARKER, forEachDescendant, parseSource, stringValue } from './migrate-edits.js';
import type { FileRole } from './migrate-transforms.js';

export type PagesMapping =
  | { kind: 'move'; to: string; role: FileRole }
  | { kind: 'special'; name: '_app' | '_document' | '_error' }
  | { kind: 'skip'; reason: string };

const PAGE_EXTENSIONS = new Set(['.tsx', '.ts', '.jsx', '.js']);

function splitExt(path: string): [string, string] {
  const match = /^(.*?)(\.[^./]+)$/.exec(path);
  return match === null ? [path, ''] : [match[1] as string, match[2] as string];
}

/** GioJS pages and layouts are .tsx/.jsx/.js; route handlers .ts/.js. */
function componentExt(ext: string): string {
  return ext === '.ts' ? '.tsx' : ext;
}

function handlerExt(ext: string): string {
  return ext === '.tsx' ? '.ts' : ext === '.jsx' ? '.js' : ext;
}

/**
 * Where a file under pages/ goes. `rel` is pages/-relative with '/'
 * separators; `appDir` the app directory prefix ('app').
 */
export function mapPagesFile(rel: string, appDir = 'app'): PagesMapping {
  const [stem, ext] = splitExt(rel);
  if (!PAGE_EXTENSIONS.has(ext)) {
    return { kind: 'skip', reason: ext === '.mdx' || ext === '.md' ? 'MDX/Markdown pages are not supported by GioJS - convert them to a page.tsx' : 'not a page module' };
  }
  if (stem.endsWith('.d') || /\.(test|spec|stories)$/.test(stem)) return { kind: 'skip', reason: 'not a page module' };
  const segments = stem.split('/');
  if (segments[0] === 'api') {
    const rest = segments.slice(1);
    if (rest[rest.length - 1] === 'index') rest.pop();
    return { kind: 'move', to: [appDir, 'api', ...rest, `route${handlerExt(ext)}`].join('/'), role: 'pages-api' };
  }
  if (segments.length === 1) {
    const name = segments[0] as string;
    if (name === '_app' || name === '_document' || name === '_error') return { kind: 'special', name };
    if (name === '404') return { kind: 'move', to: `${appDir}/not-found${componentExt(ext)}`, role: 'app-page' };
    if (name === '500') return { kind: 'move', to: `${appDir}/error${componentExt(ext)}`, role: 'app-page' };
  }
  if (segments.some(s => s.startsWith('_'))) {
    return { kind: 'skip', reason: 'a "_" folder or file is private in GioJS (never routed) - rename it to keep this page' };
  }
  if (segments[segments.length - 1] === 'index') segments.pop();
  return { kind: 'move', to: [appDir, ...segments, `page${componentExt(ext)}`].join('/'), role: 'pages-page' };
}

export interface RootLayoutInput {
  app?: { path: string; source: string };
  document?: { path: string; source: string };
  /** href → note for the global stylesheets _app imported. */
  stylesheets: string[];
  /** Stylesheets _app imported that could not be linked (no public URL). */
  unlinkedStylesheets: string[];
  typescript: boolean;
}

/**
 * app/layout.* replacing _app and _document: the <html> shell with the
 * document's <Html>/<Head>/<body> parts carried over where they are plain
 * markup, stylesheet links for _app's global CSS, and the original files
 * kept below as a comment for porting providers by hand.
 */
export function buildRootLayout(input: RootLayoutInput): string {
  const todos: string[] = [];
  let htmlAttrs = ' lang="en"';
  let bodyAttrs = '';
  const headLines: string[] = [];

  if (input.document !== undefined) {
    const sf = parseSource(input.document.path, input.document.source);
    forEachDescendant(sf, n => {
      if (!ts.isJsxElement(n) && !ts.isJsxSelfClosingElement(n)) return;
      const opening = ts.isJsxElement(n) ? n.openingElement : n;
      const tag = opening.tagName.getText(sf);
      const attrs = opening.attributes.properties.map(a => a.getText(sf));
      if (tag === 'Html' && attrs.length > 0) htmlAttrs = ' ' + attrs.join(' ');
      if (tag === 'body' && attrs.length > 0) bodyAttrs = ' ' + attrs.join(' ');
      if (tag === 'Head' && ts.isJsxElement(n)) {
        for (const child of n.children) {
          if (ts.isJsxText(child) && child.containsOnlyTriviaWhiteSpaces) continue;
          const text = child.getText(sf);
          const plain = (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) &&
            /^<[a-z]/.test(text) && !/\{(?!\s*["'`\d])/.test(text);
          if (plain) headLines.push(text.replace(/\s*\n\s*/g, ' '));
          else todos.push(`port this from ${input.document?.path} <Head> by hand: ${text.replace(/\s+/g, ' ').slice(0, 100)}`);
        }
      }
    });
    if (/\bgetInitialProps\b/.test(input.document.source)) {
      todos.push(`${input.document.path} customized getInitialProps (styled-components/emotion SSR?): collect those styles in the root layout instead`);
    }
  }

  if (input.app !== undefined) {
    const sf = parseSource(input.app.path, input.app.source);
    const wrappers = new Set<string>();
    forEachDescendant(sf, n => {
      if (!ts.isJsxOpeningElement(n) && !ts.isJsxSelfClosingElement(n)) return;
      const tag = n.tagName.getText(sf);
      if (/^[A-Z]/.test(tag) && tag !== 'Component' && !tag.endsWith('.Component')) wrappers.add(tag);
    });
    if (wrappers.size > 0) {
      todos.push(
        `${input.app.path} wrapped every page in ${[...wrappers].map(w => `<${w}>`).join(', ')}: the root layout is server-only HTML in GioJS (never hydrated), so providers and interactive wrappers go in a nested layout (e.g. app/(site)/layout.tsx around the pages) or in the pages themselves`,
      );
    }
  }
  for (const css of input.unlinkedStylesheets) {
    todos.push(`link the global stylesheet ${css} from <head> (move it under app/ - app/x.css is served at /x.css - or public/)`);
  }

  const headIndent = '        ';
  const head = [
    '<meta charSet="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    ...headLines,
    ...input.stylesheets.map(href => `<link rel="stylesheet" href=${JSON.stringify(href)} />`),
  ].map(l => headIndent + l);

  const props = input.typescript ? '{ children }: { children: React.ReactNode }' : '{ children }';
  const ret = input.typescript ? ': React.JSX.Element' : '';
  const lines = [
    "import React from 'react';",
    '',
    ...todos.map(t => `// ${TODO_MARKER} ${t}`),
    `export default function RootLayout(${props})${ret} {`,
    '  return (',
    `    <html${htmlAttrs}>`,
    '      <head>',
    ...head,
    '      </head>',
    `      <body${bodyAttrs}>{children}</body>`,
    '    </html>',
    '  );',
    '}',
  ];
  for (const original of [input.app, input.document]) {
    if (original === undefined) continue;
    lines.push(
      '',
      `/* Original ${original.path}, kept by create-giojs migrate for reference - delete once ported:`,
      '',
      original.source.replace(/\*\//g, '*\\/').trimEnd(),
      '*/',
    );
  }
  return lines.join('\n') + '\n';
}

/** Side-effect stylesheet imports (`import '../styles/globals.css'`) of a module. */
export function stylesheetImports(path: string, source: string): string[] {
  const sf = parseSource(path, source);
  const out: string[] = [];
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause !== undefined) continue;
    const spec = stringValue(statement.moduleSpecifier);
    if (spec !== undefined && /\.css$/i.test(spec)) out.push(spec);
  }
  return out;
}
