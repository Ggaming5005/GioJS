import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { VersionHistory } from '../../../../components/ReferenceTable.tsx';
import { ConfigKeyTable } from '../../../../components/ConfigKeyTable.tsx';

export const metadata: Metadata = {
  title: '[app]',
  description: 'Informational settings about the app. The server checks the keys but never acts on them.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>[app]</h1>
      <p className="page-subtitle">
        Informational settings about the app. The server checks the keys but never acts on them.
      </p>
      <CodeBlock lang="toml" title="gio.toml" code={`[app]
name = "my-app"
router = "app"`} />

      <h2 id="reference">Reference</h2>
      <ConfigKeyTable rows={[
        { key: 'name', type: 'string', description: <>A name for the app, for people reading the file. Not used by the server.</> },
        { key: 'router', type: '"app"', description: <>The router, documented for clarity: the <code>app/</code> directory router is the only one GioJS has, so <code>&quot;app&quot;</code> is the only value accepted.</> },
      ]} />

      <h3 id="behavior">Behavior</h3>
      <p>
        The section is parsed like every other one - an unknown key or another <code>router</code>{' '}
        value stops startup - and then ignored. Removing it changes nothing.
      </p>

      <h2 id="examples">Examples</h2>
      <h3 id="a-new-apps-gio-toml">A new app&apos;s gio.toml</h3>
      <CodeBlock lang="toml" title="gio.toml" code={`#:schema ./node_modules/@gio.js/server/gio.schema.json

[app]
name = "my-app"`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          <code>router = &quot;pages&quot;</code> is an error:{' '}
          <code>invalid `app.router`: unknown variant `pages`, expected `app`</code>. GioJS has no
          Pages Router; see <a href="/docs/migration">Migrating from Next.js</a>.
        </li>
        <li>Settings for other tools belong in a <code>[x-...]</code> table, not here (see <a href="/docs/configuration#x-tables"><code>[x-*]</code> tables</a>).</li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/configuration">gio.toml overview</a></li>
        <li><a href="/docs/file-conventions/gio-toml"><code>gio.toml</code></a></li>
        <li><a href="/docs/project-structure">Project Structure</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <>Unknown keys are refused, and <code>router</code> only accepts <code>&quot;app&quot;</code>.</> },
        { version: 'v0.1.0-beta.1', changes: <>Introduced with <code>name</code> and <code>router</code>.</> },
      ]} />
    </>
  );
}
