import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PmTabs } from '../../../../components/PmTabs.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'gio info',
  description:
    'Print the OS, Node.js, package manager, server binary and @gio.js/* versions - the ' +
    'environment details a bug report needs.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>gio info</h1>
      <p className="page-subtitle">
        Print the OS, Node.js, package manager, server binary and <code>@gio.js/*</code>{' '}
        versions - the environment details a bug report needs.
      </p>
      <PmTabs command={`npx gio info`} />
      <CodeBlock lang="bash" code={`gio info [--json]`} />

      <h2 id="reference">Reference</h2>
      <PropsTable kind="Option" rows={[
        { name: '--json', type: 'boolean', default: 'false', description: 'Print the report as JSON.' },
        { name: '-h, --help', type: 'boolean', description: <>Print the help and exit with <code>0</code>.</> },
      ]} />

      <h3 id="output">Output</h3>
      <CodeBlock lang="text" code={`$ npx gio info
  gio              0.1.0-beta.8
  Node.js          22.22.0
  Platform         linux-x64 (glibc), 6.8.0-45-generic
  Package manager  npm 10.9.2
  Server binary    0.1.0-beta.8 (/home/me/shop/node_modules/@gio.js/server-linux-x64/bin/giojs-server)
  @gio.js/server   0.1.0-beta.8
  @gio.js/core     0.1.0-beta.8
  @gio.js/react    0.1.0-beta.8
  create-giojs     not installed
  Project          /home/me/shop
  gio.toml         gio.toml
  NODE_ENV         (unset)`} />
      <table>
        <thead>
          <tr><th>Row</th><th>Where it comes from</th></tr>
        </thead>
        <tbody>
          <tr><td>Platform</td><td>OS and CPU, the C library on Linux (<code>glibc</code> or <code>musl</code>), and the kernel release.</td></tr>
          <tr><td>Package manager</td><td>The one running <code>gio</code> (<code>npm_config_user_agent</code>, with its version), else the one whose lockfile the project has (no version), else <code>npm</code>.</td></tr>
          <tr><td>Server binary</td><td>The binary <code>gio dev</code> would run: its package version, or <code>GIO_SERVER_BIN</code> / <code>repository build</code>, and its path. <code>not found (...)</code> with the reason when there is none.</td></tr>
          <tr><td><code>@gio.js/*</code>, <code>create-giojs</code></td><td>The installed versions, as Node would resolve them from the project.</td></tr>
          <tr><td>gio.toml</td><td>The file the server would read, or <code>none (defaults)</code>.</td></tr>
        </tbody>
      </table>

      <h3 id="json-output">JSON output</h3>
      <CodeBlock lang="json" code={`{
  "gio": "0.1.0-beta.8",
  "node": "22.22.0",
  "platform": "linux-x64 (glibc)",
  "osRelease": "6.8.0-45-generic",
  "packageManager": "npm 10.9.2",
  "serverBinary": {
    "path": "/home/me/shop/node_modules/@gio.js/server-linux-x64/bin/giojs-server",
    "source": "package",
    "package": "@gio.js/server-linux-x64",
    "version": "0.1.0-beta.8"
  },
  "packages": {
    "@gio.js/server": "0.1.0-beta.8",
    "@gio.js/core": "0.1.0-beta.8",
    "@gio.js/react": "0.1.0-beta.8",
    "create-giojs": null
  },
  "projectRoot": "/home/me/shop",
  "gioToml": "gio.toml",
  "nodeEnv": null
}`} />
      <p>
        <code>serverBinary.source</code> is <code>package</code>, <code>env</code>{' '}
        (<code>GIO_SERVER_BIN</code>) or <code>workspace</code> (a cargo build inside the
        GioJS repository). Without a binary it is <code>{'{ "missing": "<reason>", "package": "<name>" }'}</code>.
      </p>

      <h2 id="examples">Examples</h2>
      <h3 id="versions-only">Just the versions</h3>
      <CodeBlock lang="text" code={`$ npx gio --version
gio            0.1.0-beta.8 (@gio.js/server)
server binary  0.1.0-beta.8 (@gio.js/server-linux-x64)
@gio.js/core   0.1.0-beta.8`} />
      <p>
        <code>gio --version</code> (<code>-v</code>) prints the three versions that must
        match; <code>gio info</code> adds the rest.
      </p>

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li><code>gio info</code> checks nothing and always exits with <code>0</code>; use <a href="/docs/cli/doctor"><code>gio doctor</code></a> for checks.</li>
        <li>It reads no secrets and does not start the server or probe the port.</li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/cli/doctor"><code>gio doctor</code></a></li>
        <li><a href="/docs/cli/help"><code>gio help</code></a> and <code>gio --version</code></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[{ version: 'v0.1.0-beta.8', changes: 'Introduced.' }]} />
    </>
  );
}
