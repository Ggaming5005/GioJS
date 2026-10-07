import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PmTabs } from '../../../../components/PmTabs.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'gio typegen',
  description:
    'Write .gio/routes.d.ts and .gio/css-modules.d.ts - the typed routes and CSS import ' +
    'types - without starting the server.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>gio typegen</h1>
      <p className="page-subtitle">
        Write <code>.gio/routes.d.ts</code> and <code>.gio/css-modules.d.ts</code> - the
        typed routes and CSS import types - without starting the server.
      </p>
      <PmTabs command={`npx gio typegen`} />

      <h2 id="reference">Reference</h2>
      <PropsTable kind="Option" rows={[
        {
          name: '-h, --help',
          type: 'boolean',
          description: <>Print the help and exit with <code>0</code>. <code>gio typegen</code> takes no other option.</>,
        },
      ]} />

      <h3 id="behavior">Behavior</h3>
      <p>
        <code>gio typegen</code> discovers the routes like{' '}
        <a href="/docs/cli/routes"><code>gio routes</code></a> (the <code>.env</code> files
        load first and every <code>route.ts</code> is imported) and writes two files under{' '}
        <code>.gio/</code> in the project root:
      </p>
      <ul>
        <li>
          <code>.gio/routes.d.ts</code> fills the global <code>GioJS.RegisteredRoutes</code>{' '}
          interface with one entry per page and <code>route.ts</code> pattern. That is what
          types <code>href(&apos;/posts/:id&apos;, {'{ id }'})</code>, <code>useParams()</code>,{' '}
          <code>PageProps&lt;&apos;/posts/:id&apos;&gt;</code> and{' '}
          <code>GsspContext</code>.
        </li>
        <li>
          <code>.gio/css-modules.d.ts</code> types <code>*.module.css</code> imports as class
          maps and allows plain <code>*.css</code> imports. <code>routes.d.ts</code>{' '}
          references it.
        </li>
      </ul>
      <p>A file is rewritten only when its content changes, so the command is cheap to repeat:</p>
      <CodeBlock lang="text" code={`$ npx gio typegen
gio typegen: wrote /home/me/my-app/.gio/routes.d.ts (5 routes)
$ npx gio typegen
gio typegen: /home/me/my-app/.gio/routes.d.ts is up to date (5 routes)`} />
      <CodeBlock lang="ts" title=".gio/routes.d.ts" code={`/// <reference path="./css-modules.d.ts" />
declare global {
  namespace GioJS {
    interface RegisteredRoutes {
      '/': Record<string, never>;
      '/about': Record<string, never>;
      '/api/notes': Record<string, never>;
      '/docs/*slug?': { slug?: string };
      '/posts/:id': { id: string };
    }
  }
}
export {};`} />
      <p>
        A catch-all param is one string with <code>/</code> separators (<code>&quot;a/b&quot;</code>),
        the shape <code>getServerSideProps</code> receives; an optional catch-all is an
        optional field.
      </p>

      <h2 id="examples">Examples</h2>
      <h3 id="typecheck-in-ci">Typecheck in CI</h3>
      <CodeBlock lang="bash" code={`npx gio typegen && npx tsc --noEmit`} />
      <p>
        The server writes these files at every start, but a CI job that only typechecks never
        starts it. Without the files, <code>href()</code> and <code>PageProps</code> fall back
        to untyped routes and CSS Module imports do not typecheck.
      </p>

      <h3 id="include-the-file-in-tsconfig">Include the file in tsconfig.json</h3>
      <CodeBlock lang="json" title="tsconfig.json" code={`{
  "include": ["app", "components", ".gio/routes.d.ts"]
}`} />
      <p>
        TypeScript&apos;s wildcards skip dot-folders, so <code>.gio/routes.d.ts</code> must be
        listed by name. The starters do this;{' '}
        <a href="/docs/cli/doctor"><code>gio doctor</code></a> warns when it is missing.
      </p>

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          A <code>route.ts</code> that fails to import in CI (it needs a secret CI does not
          set) is still typed, so CI and a developer machine get the same declarations.
        </li>
        <li>
          WebSocket-only <code>route.ts</code> files and metadata routes are not in{' '}
          <code>RegisteredRoutes</code>; they are not <code>href()</code> targets.
        </li>
        <li>
          Exit code <code>1</code> when there is no <code>app/</code> directory, so a CI step
          run from the wrong directory fails instead of writing <code>.gio/</code> elsewhere;
          also on a route conflict or a missing <code>@gio.js/core</code>.
        </li>
        <li>Add <code>.gio/</code> to <code>.gitignore</code>; the starters do.</li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/cli/routes"><code>gio routes</code></a></li>
        <li><a href="/docs/linking-and-navigating">Linking &amp; Navigating</a></li>
        <li><a href="/docs/css">CSS &amp; Styling</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        {
          version: 'v0.1.0-beta.8',
          changes: <>Introduced. The declarations fill the global <code>GioJS.RegisteredRoutes</code> (they used to augment <code>@gio.js/react</code>&apos;s <code>GioRegisteredRoutes</code>), and <code>css-modules.d.ts</code> is written next to them.</>,
        },
      ]} />
    </>
  );
}
