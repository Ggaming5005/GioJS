import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { VersionHistory } from '../../../../components/ReferenceTable.tsx';
import { ConfigKeyTable } from '../../../../components/ConfigKeyTable.tsx';

export const metadata: Metadata = {
  title: '[env]',
  description: 'Whether the .env files in the project root are loaded at startup.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>[env]</h1>
      <p className="page-subtitle">
        Whether the <code>.env</code> files in the project root are loaded at startup.
      </p>
      <CodeBlock lang="toml" title="gio.toml" code={`[env]
files = false        # the process environment is all there is`} />
      <p>
        By default the server loads <code>.env.{'{mode}'}.local</code>, <code>.env.local</code>,{' '}
        <code>.env.{'{mode}'}</code> and <code>.env</code> before anything else, and variables
        already in the environment win. See <a href="/docs/configuration#env-files">.env files</a>.
      </p>

      <h2 id="reference">Reference</h2>
      <ConfigKeyTable rows={[
        { key: 'files', type: 'boolean', default: 'true', zero: <>No <code>.env*</code> file is read</>, env: 'GIO_ENV_FILES', description: <>Load the <code>.env*</code> files. Turn it off on platforms that inject the environment, so a stray file baked into an image can never add or change a variable.</> },
      ]} />

      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          <code>GIO_ENV_FILES=0</code> (or <code>false</code>) skips the files and{' '}
          <code>GIO_ENV_FILES=1</code> (or <code>true</code>) loads them, whatever{' '}
          <code>gio.toml</code> says. Unset or empty leaves it to the key; any other value stops
          startup (<code>GIO_ENV_FILES=&quot;no&quot; must be 0 (skip them) or 1 (load them)</code>).
        </li>
        <li>
          The files load before <code>gio.toml</code> is fully parsed, so this one key is read on
          its own first. If <code>gio.toml</code> has a syntax error there, or <code>files</code> is
          not a plain boolean, the files load and the full parse right after reports the problem.
        </li>
        <li>
          With loading off, startup logs <code>not loading .env files: [env] files turns them off</code>{' '}
          (or <code>GIO_ENV_FILES</code>), and <code>--check-config</code> reports{' '}
          <code>&quot;envFilesDisabledBy&quot;</code>.
        </li>
        <li>
          The server, <code>gio export</code>, <code>gio build standalone</code>, the testing kit and
          the <code>gio</code> CLI all follow the key and the variable.
        </li>
      </ul>
      <p>No key in this section logs a warning.</p>

      <h2 id="examples">Examples</h2>
      <h3 id="a-container-platform">A container platform</h3>
      <p>Keep <code>.env</code> for local development, and never read it in the container:</p>
      <CodeBlock lang="dockerfile" title="Dockerfile" code={`ENV GIO_ENV_FILES=0`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li><code>files = &quot;no&quot;</code> is a startup error: <code>invalid type: string &quot;no&quot;, expected a boolean</code>.</li>
        <li>The files are read once, at startup; restart after editing them.</li>
      </ul>
      <h3 id="not-configurable">Not configurable</h3>
      <ul>
        <li>
          <strong>The <code>GIO_PUBLIC_</code> prefix.</strong> Only variables named{' '}
          <code>GIO_PUBLIC_*</code> are inlined into client bundles; every other variable stays on
          the server, so a secret can only reach the browser if you name it that way.
        </li>
        <li><code>NODE_ENV</code> in a <code>.env</code> file is ignored with a warning: the mode is decided before the files are read.</li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/guides/environment-variables">Environment Variables</a></li>
        <li><a href="/docs/file-conventions/env-files"><code>.env</code> files</a></li>
        <li><a href="/docs/env-vars">Environment variable reference</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <>Introduced, with <code>GIO_ENV_FILES</code>. The server loads <code>.env</code> files from this release on.</> },
      ]} />
    </>
  );
}
