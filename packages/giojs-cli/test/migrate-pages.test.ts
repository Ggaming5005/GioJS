/**
 * giojs-cli/test/migrate-pages.test.ts
 *
 * pages/ → app/ path mapping and the root layout generated from
 * pages/_app + pages/_document.
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRootLayout, mapPagesFile, stylesheetImports } from '../dist/migrate-pages.js';

test('pages files map to app/ conventions', () => {
  const table: Array<[string, unknown]> = [
    ['index.tsx', { kind: 'move', to: 'app/page.tsx', role: 'pages-page' }],
    ['about.tsx', { kind: 'move', to: 'app/about/page.tsx', role: 'pages-page' }],
    ['blog/index.jsx', { kind: 'move', to: 'app/blog/page.jsx', role: 'pages-page' }],
    ['[id].tsx', { kind: 'move', to: 'app/[id]/page.tsx', role: 'pages-page' }],
    ['posts/[id]/edit.js', { kind: 'move', to: 'app/posts/[id]/edit/page.js', role: 'pages-page' }],
    ['[...slug].tsx', { kind: 'move', to: 'app/[...slug]/page.tsx', role: 'pages-page' }],
    ['docs/[[...slug]].tsx', { kind: 'move', to: 'app/docs/[[...slug]]/page.tsx', role: 'pages-page' }],
    // GioJS pages must be .tsx/.jsx/.js.
    ['plain.ts', { kind: 'move', to: 'app/plain/page.tsx', role: 'pages-page' }],
    ['404.tsx', { kind: 'move', to: 'app/not-found.tsx', role: 'app-page' }],
    ['500.jsx', { kind: 'move', to: 'app/error.jsx', role: 'app-page' }],
    ['api/hello.ts', { kind: 'move', to: 'app/api/hello/route.ts', role: 'pages-api' }],
    ['api/index.js', { kind: 'move', to: 'app/api/route.js', role: 'pages-api' }],
    ['api/users/[id].ts', { kind: 'move', to: 'app/api/users/[id]/route.ts', role: 'pages-api' }],
    // Route handlers must be .ts/.js.
    ['api/legacy.tsx', { kind: 'move', to: 'app/api/legacy/route.ts', role: 'pages-api' }],
    ['_app.tsx', { kind: 'special', name: '_app' }],
    ['_document.js', { kind: 'special', name: '_document' }],
    ['_error.tsx', { kind: 'special', name: '_error' }],
  ];
  for (const [rel, expected] of table) assert.deepEqual(mapPagesFile(rel), expected, rel);
});

test('pages files GioJS cannot route are skipped with a reason', () => {
  assert.equal(mapPagesFile('styles.module.css').kind, 'skip');
  assert.match((mapPagesFile('blog/post.mdx') as { reason: string }).reason, /MDX/);
  assert.match((mapPagesFile('_drafts/x.tsx') as { reason: string }).reason, /private in GioJS/);
  assert.equal(mapPagesFile('types.d.ts').kind, 'skip');
  assert.equal(mapPagesFile('index.test.tsx').kind, 'skip');
});

test('buildRootLayout carries over the document shell and links global CSS', () => {
  const layout = buildRootLayout({
    app: {
      path: 'pages/_app.tsx',
      source: "import '../styles/globals.css';\nexport default function App({ Component, pageProps }) {\n  return <Store><Component {...pageProps} /></Store>;\n}\n",
    },
    document: {
      path: 'pages/_document.tsx',
      source: [
        "import { Html, Head, Main, NextScript } from 'next/document';",
        'export default function Document() {',
        '  return (',
        '    <Html lang="fr" dir="ltr">',
        '      <Head>',
        '        <link rel="preconnect" href="https://fonts.gstatic.com" />',
        '        <meta name="theme-color" content={theme} />',
        '      </Head>',
        '      <body className="dark"><Main /><NextScript /></body>',
        '    </Html>',
        '  );',
        '}',
      ].join('\n'),
    },
    stylesheets: ['/styles/globals.css'],
    unlinkedStylesheets: ['bootstrap/dist/css/bootstrap.css'],
    typescript: true,
  });
  assert.match(layout, /^import React from 'react';\n/);
  assert.match(layout, /export default function RootLayout\(\{ children \}: \{ children: React\.ReactNode \}\): React\.JSX\.Element \{/);
  assert.match(layout, /<html lang="fr" dir="ltr">/);
  assert.match(layout, /<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com" \/>\n/);
  assert.match(layout, /<link rel="stylesheet" href="\/styles\/globals\.css" \/>/);
  assert.match(layout, /<body className="dark">\{children\}<\/body>/);
  // The dynamic <meta> needs the document's variables: TODO, not copied.
  assert.doesNotMatch(layout, /<meta name="theme-color" content=\{theme\} \/>\n\s*<link/);
  assert.match(layout, /TODO\(gio-migrate\): port this from pages\/_document\.tsx <Head> by hand: <meta name="theme-color"/);
  assert.match(layout, /TODO\(gio-migrate\): pages\/_app\.tsx wrapped every page in <Store>/);
  assert.match(layout, /TODO\(gio-migrate\): link the global stylesheet bootstrap\/dist\/css\/bootstrap\.css/);
  // Originals are kept below as comments, with */ escaped so the comment can't end early.
  assert.match(layout, /\/\* Original pages\/_app\.tsx, kept by create-giojs migrate/);
  assert.match(layout, /\/\* Original pages\/_document\.tsx/);
});

test('buildRootLayout for JavaScript has no type annotations', () => {
  const layout = buildRootLayout({ stylesheets: [], unlinkedStylesheets: [], typescript: false });
  assert.match(layout, /export default function RootLayout\(\{ children \}\) \{/);
  assert.match(layout, /<html lang="en">/);
});

test('original sources containing */ cannot terminate the reference comment', () => {
  const layout = buildRootLayout({
    app: { path: 'pages/_app.js', source: '/* a */\nexport default function App() { return null; }\n' },
    stylesheets: [],
    unlinkedStylesheets: [],
    typescript: false,
  });
  assert.match(layout, /\/\* a \*\\\//);
  assert.equal(layout.trimEnd().endsWith('*/'), true);
});

test('stylesheetImports lists side-effect CSS imports only', () => {
  const source = "import '../styles/a.css';\nimport styles from './b.module.css';\nimport 'normalize.css';\nimport './c';\n";
  assert.deepEqual(stylesheetImports('pages/_app.tsx', source), ['../styles/a.css', 'normalize.css']);
});
