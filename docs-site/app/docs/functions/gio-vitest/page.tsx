import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'gioVitest',
  description:
    'The vitest plugin that makes CSS Module imports evaluate to the class names the GioJS server renders.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>gioVitest</h1>
      <p className="page-subtitle">
        The vitest plugin that makes CSS Module imports evaluate to the class names the GioJS
        server renders.
      </p>
      <CodeBlock lang="ts" title="vitest.config.ts" code={`import { defineConfig } from 'vitest/config';
import { gioVitest } from '@gio.js/core/vitest';

export default defineConfig({
  plugins: [gioVitest()],
});`} />

      <h2 id="reference">Reference</h2>
      <p>
        <code>gioVitest()</code> takes no options and returns a vite plugin (
        <code>GioVitestPlugin</code>, assignable to vite&apos;s <code>Plugin</code>) named{' '}
        <code>gio:css-modules</code>.
      </p>
      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          vitest compiles <code>*.module.css</code> its own way, with class names such as{' '}
          <code>_card_80010d</code> that the GioJS server never sends. With the plugin, an
          import such as <code>import styles from &apos;./card.module.css&apos;</code>{' '}
          evaluates to the class map GioJS compiles - the names server rendering, the
          hydration bundle and the route stylesheet all use.
        </li>
        <li>
          It applies to imports in your pages and components (as{' '}
          <a href="/docs/functions/render-page">renderPage</a> renders them) and in your test
          files alike.
        </li>
        <li>
          Only plain <code>.module.css</code> imports are handled. An import with a query (
          <code>?inline</code>, <code>?raw</code>) is left to vite, and plain{' '}
          <code>.css</code> imports need nothing - vitest already loads them as empty
          modules.
        </li>
        <li>In watch mode, editing the stylesheet re-runs the tests that import it.</li>
      </ul>

      <h2 id="examples">Examples</h2>
      <h3 id="assert-on-a-class-name">Assert on a class name</h3>
      <CodeBlock lang="ts" title="tests/card.test.ts" code={`import { expect, it } from 'vitest';
import { renderPage } from '@gio.js/core/testing';
import styles from '../app/card/card.module.css';

it('renders the card with its CSS Module class', async () => {
  const page = await renderPage('/card');
  expect(page.html).toContain(\`class="\${styles.card}"\`);
});`} />
      <p>
        <code>styles.card</code> is the server&apos;s name for the class (for example{' '}
        <code>card_e15fc2_card</code>), so the assertion holds without hard-coding it.
      </p>
      <h3 id="with-the-scaffold-alias">With the scaffold&apos;s <code>@/</code> alias</h3>
      <p>
        vitest does not read tsconfig <code>paths</code>. Mirror the starter&apos;s{' '}
        <code>@/*</code> alias next to the plugin:
      </p>
      <CodeBlock lang="ts" title="vitest.config.ts" code={`import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { gioVitest } from '@gio.js/core/vitest';

export default defineConfig({
  plugins: [gioVitest()],
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  test: { include: ['tests/**/*.test.ts'] },
});`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          <strong>node:test needs no plugin.</strong> Under <code>node --import tsx --test</code>,
          the test kit registers GioJS&apos;s own CSS hooks, and CSS Modules already render the
          server&apos;s names.
        </li>
        <li>
          <strong>Plain JavaScript on purpose.</strong> vite loads a config&apos;s npm imports
          with Node&apos;s own loader, which refuses TypeScript inside{' '}
          <code>node_modules</code>, so <code>@gio.js/core/vitest</code> ships as{' '}
          <code>.js</code> with type declarations.
        </li>
        <li>
          <code>@gio.js/core</code> does not depend on vite or vitest; install vitest in your
          app.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/testing#vitest">Testing: vitest setup</a></li>
        <li><a href="/docs/css">CSS &amp; Styling</a> - CSS Modules</li>
        <li><a href="/docs/functions/render-page">renderPage</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[{ version: 'v0.1.0-beta.8', changes: 'Introduced.' }]} />
    </>
  );
}
