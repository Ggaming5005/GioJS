import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'resetTestApp',
  description:
    'Forget the routes renderPage and callRoute discovered, so the next call sees files your test added or removed.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>resetTestApp</h1>
      <p className="page-subtitle">
        Forget the routes <code>renderPage</code> and <code>callRoute</code> discovered, so
        the next call sees files your test added or removed.
      </p>
      <CodeBlock lang="ts" code={`import { resetTestApp } from '@gio.js/core/testing';

await resetTestApp();`} />

      <h2 id="reference">Reference</h2>
      <PropsTable kind="Parameter" rows={[
        {
          name: 'appDir',
          type: 'string',
          default: 'every app',
          description: (
            <>
              The <code>app/</code> directory to forget, resolved like{' '}
              <code>renderPage</code>&apos;s <code>appDir</code> option. Left out, every app
              directory discovered in this process is forgotten.
            </>
          ),
        },
      ]} />
      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          <code>renderPage</code> and <code>callRoute</code> discover an app directory once
          per process - routes, layouts, handlers, special files, <code>gio.config.ts</code>{' '}
          plugins - and reuse it. <code>resetTestApp</code> drops that, and the next call
          discovers again.
        </li>
        <li>
          It runs the dropped apps&apos; plugin <code>onShutdown</code> hooks, and resolves
          once they finished. A directory that was never discovered is ignored.
        </li>
        <li>
          It does not unload modules. A page, layout or helper that was already imported stays
          as it was - <code>vi.resetModules()</code> does not change that - so an edit to it
          shows up only in a new test process. Values already loaded from <code>.env</code>{' '}
          files stay in <code>process.env</code> as well.
        </li>
      </ul>

      <h2 id="examples">Examples</h2>
      <h3 id="a-route-added-by-the-test">A route added by the test</h3>
      <CodeBlock lang="ts" title="tests/generated-routes.test.ts" code={`import { mkdir, rm, writeFile } from 'node:fs/promises';
import { afterAll, expect, it } from 'vitest';
import { callRoute, resetTestApp } from '@gio.js/core/testing';

afterAll(async () => {
  await rm('app/api/generated', { recursive: true, force: true });
  await resetTestApp();
});

it('serves a route.ts written during the test', async () => {
  await mkdir('app/api/generated', { recursive: true });
  await writeFile('app/api/generated/route.ts', 'export const GET = () => ({ generated: true });');
  await resetTestApp();                       // discover again
  const res = await callRoute('/api/generated');
  expect(await res.json()).toEqual({ generated: true });
});`} />
      <h3 id="run-plugin-shutdown-hooks">Run plugin shutdown hooks</h3>
      <CodeBlock lang="ts" code={`import { after } from 'node:test';
import { resetTestApp } from '@gio.js/core/testing';

// Closes the database pool your gio.config.ts plugin opened in onStartup.
after(() => resetTestApp());`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          <strong>Module state outlives it.</strong> Reset module-level state of your own
          (an in-memory store, a counter) in your own <code>beforeEach</code>.
        </li>
        <li>
          <strong>vitest isolates test files</strong> by default, and <code>node --test</code>{' '}
          runs each file in its own process, so a fresh file always starts with a fresh
          discovery.
        </li>
        <li>
          It does not touch servers started with{' '}
          <a href="/docs/functions/create-test-server">createTestServer</a>; restart those
          to pick up file changes.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/testing#module-caching">Testing: Module caching</a></li>
        <li><a href="/docs/functions/render-page">renderPage</a>, <a href="/docs/functions/call-route">callRoute</a></li>
        <li><a href="/docs/functions/define-config">defineConfig</a> - plugin hooks</li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[{ version: 'v0.1.0-beta.8', changes: 'Introduced.' }]} />
    </>
  );
}
