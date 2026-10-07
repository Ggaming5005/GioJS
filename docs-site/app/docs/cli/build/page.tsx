import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'gio build',
  description:
    'Explains that a normal GioJS deploy has no build step; gio build standalone packages ' +
    'a self-contained deploy directory.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>gio build</h1>
      <p className="page-subtitle">
        Explains that a normal GioJS deploy has no build step;{' '}
        <code>gio build standalone</code> packages a self-contained deploy directory.
      </p>
      <CodeBlock lang="bash" code={`gio build
gio build standalone [--out <dir>] [--target <platform>]`} />

      <h2 id="reference">Reference</h2>
      <PropsTable kind="Parameter" rows={[
        {
          name: 'standalone',
          type: 'subcommand',
          description: <>Package the app into one directory that runs anywhere Node is installed. See <a href="/docs/cli/build-standalone"><code>gio build standalone</code></a> for its options.</>,
        },
        {
          name: '-h, --help',
          type: 'boolean',
          description: <>Print the help and exit with <code>0</code>.</>,
        },
      ]} />
      <h3 id="behavior">Behavior</h3>
      <p>Without a subcommand, <code>gio build</code> prints this and exits with <code>0</code>:</p>
      <CodeBlock lang="text" code={`GioJS has no build step for normal deploys: \`gio start\` starts the server,
renders on demand, and caches in Rust. To package a self-contained
deploy directory (one folder, runs anywhere Node is installed), use:

  gio build standalone [--out <dir>] [--target <platform>]`} />
      <p>
        Any other argument is a usage error (exit code <code>2</code>), with a suggestion for
        a near miss:
      </p>
      <CodeBlock lang="text" code={`$ gio build stndalone
gio: unknown build target "stndalone" - did you mean \`gio build standalone\`?
Run \`gio build --help\` for usage.`} />

      <h2 id="examples">Examples</h2>
      <h3 id="a-build-script-for-a-server-app">A build script for a server app</h3>
      <p>
        A server app has nothing to compile ahead of time, so the starter&apos;s{' '}
        <code>build</code> script only typechecks:
      </p>
      <CodeBlock lang="json" title="package.json" code={`{
  "scripts": {
    "build": "tsc --noEmit",
    "start": "cross-env NODE_ENV=production giojs-server"
  }
}`} />
      <h3 id="a-build-script-for-a-static-site">A build script for a static site</h3>
      <p>
        A site created with <code>--static</code> builds with{' '}
        <a href="/docs/cli/export"><code>gio export</code></a>:
      </p>
      <CodeBlock lang="json" title="package.json" code={`{
  "scripts": {
    "build": "tsc --noEmit && gio export"
  }
}`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          Unlike frameworks with a <code>next build</code>-style step, GioJS bundles the
          client code when the server starts (into <code>.gio/build</code>) and renders pages
          on demand. A deploy is <code>npm ci</code> followed by{' '}
          <a href="/docs/cli/start"><code>gio start</code></a>.
        </li>
        <li>
          Use <a href="/docs/cli/build-standalone"><code>gio build standalone</code></a> when
          the target machine should not run <code>npm install</code>, and{' '}
          <a href="/docs/cli/export"><code>gio export</code></a> for a static host.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/cli/build-standalone"><code>gio build standalone</code></a></li>
        <li><a href="/docs/cli/export"><code>gio export</code></a></li>
        <li><a href="/docs/guides/deploying">Deploying</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <>A mistyped subcommand is a usage error with a suggestion; <code>gio build --help</code>.</> },
        { version: 'v0.1.0-beta.7', changes: <>Introduced: prints an explanation; <code>gio build standalone</code>.</> },
      ]} />
    </>
  );
}
