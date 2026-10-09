import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: '.env files',
  description:
    'Environment variables loaded from .env, .env.local and their per-mode variants in the project root when the server starts.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>.env files</h1>
      <p className="page-subtitle">
        Environment variables loaded from <code>.env</code>, <code>.env.local</code> and their
        per-mode variants in the project root when the server starts.
      </p>
      <CodeBlock lang="env" title=".env.local" code={`DATABASE_URL=postgres://localhost:5432/acme
GIO_SESSION_SECRET=replace-me-with-32-random-bytes
# Only GIO_PUBLIC_* variables reach browser code.
GIO_PUBLIC_SITE_NAME=Acme`} />

      <h2 id="reference">Reference</h2>
      <h3 id="files-and-precedence">Files and precedence</h3>
      <p>
        The files sit in the project root, next to <code>app/</code>. They are read in this
        order, and the <strong>first</strong> one that sets a variable wins:
      </p>
      <table>
        <thead><tr><th>Order</th><th>File</th><th>Typical use</th></tr></thead>
        <tbody>
          <tr><td>1</td><td><code>.env.development.local</code> / <code>.env.production.local</code></td><td>Machine-specific overrides for one mode. Never committed.</td></tr>
          <tr><td>2</td><td><code>.env.local</code></td><td>Local secrets for every mode. Never committed.</td></tr>
          <tr><td>3</td><td><code>.env.development</code> / <code>.env.production</code></td><td>Shared defaults for one mode.</td></tr>
          <tr><td>4</td><td><code>.env</code></td><td>Shared defaults for every mode.</td></tr>
        </tbody>
      </table>
      <ul>
        <li>
          <strong>Real environment variables always win.</strong> A variable already set in
          the environment that starts the server is never overridden by a file.
        </li>
        <li>
          <strong>The mode</strong> is <code>development</code> when{' '}
          <code>NODE_ENV=development</code> (as <code>gio dev</code> sets it) and{' '}
          <code>production</code> otherwise, <code>NODE_ENV=test</code> or unset included. There
          is no <code>.env.test</code>.
        </li>
        <li>
          <strong>When.</strong> Once, at server startup, before <code>gio.toml</code> is read,
          so the files can set <code>GIO_PORT</code> and the other variables that override it.
          The Node worker inherits the result. Editing a file needs a restart, in development
          too: the watcher ignores dotfiles.
        </li>
      </ul>

      <h3 id="syntax">Syntax</h3>
      <CodeBlock lang="env" title=".env" code={`# A comment
PLAIN=value
QUOTED="two words"
export WITH_EXPORT=allowed            # the export prefix is ignored
INLINE=value # a comment after a space
MULTILINE="line 1
line 2"
DERIVED=\${PLAIN}-suffix              # value-suffix
LITERAL='\${PLAIN} is not expanded'  # single quotes keep it as written`} />
      <p>
        <code>{'${VAR}'}</code> expands a variable from the environment, from an earlier line,
        or from a file with higher precedence; an unknown one expands to nothing. The parser
        is dotenvy&apos;s, and the Node tools use a port of it, so a file means the same
        thing everywhere.
      </p>

      <h3 id="errors-and-warnings">Errors and warnings</h3>
      <ul>
        <li>
          A file that cannot be parsed stops startup, naming the file and line but never the
          value: <code>cannot load .env.local: invalid syntax on line 2</code>.
        </li>
        <li>
          <code>NODE_ENV</code> in a file is ignored, with a warning: the mode was already
          decided from the real environment. Set it where the server is started.
        </li>
        <li>
          A candidate that is not a regular file (<code>python -m venv .env</code> makes a
          directory) is skipped.
        </li>
        <li>
          The startup log lists the files it read, never their values:{' '}
          <code>loaded .env files mode=&quot;production&quot; files=.env.local, .env.production, .env</code>.
        </li>
      </ul>

      <h3 id="turning-it-off">Turning it off</h3>
      <table>
        <thead><tr><th>Setting</th><th>Effect</th></tr></thead>
        <tbody>
          <tr><td><a href="/docs/configuration/env"><code>[env] files = false</code></a> in <code>gio.toml</code></td><td>No file is loaded.</td></tr>
          <tr><td><code>GIO_ENV_FILES=0</code> (or <code>false</code>)</td><td>No file is loaded, whatever <code>gio.toml</code> says.</td></tr>
          <tr><td><code>GIO_ENV_FILES=1</code> (or <code>true</code>)</td><td>Files are loaded, whatever <code>gio.toml</code> says.</td></tr>
        </tbody>
      </table>
      <p>
        Any other <code>GIO_ENV_FILES</code> value stops startup. Platforms that inject
        their own environment (containers, PaaS) often turn the files off so a stray{' '}
        <code>.env</code> in the image cannot apply.
      </p>

      <h2 id="examples">Examples</h2>
      <h3 id="read-a-variable-on-the-server">Read a variable on the server</h3>
      <CodeBlock lang="tsx" title="app/status/page.tsx" code={`import React from 'react';
import type { GetServerSideProps, InferPageProps } from '@gio.js/core';

export const getServerSideProps: GetServerSideProps<{ region: string }> = async () => {
  // Server-only: DEPLOY_REGION is never sent to the browser unless returned as a prop.
  return { props: { region: process.env.DEPLOY_REGION ?? 'local' } };
};

export default function Status({ region }: InferPageProps<typeof getServerSideProps>) {
  return <p>Served from {region}</p>;
}`} />

      <h3 id="a-public-variable-in-browser-code">A public variable in browser code</h3>
      <CodeBlock lang="tsx" title="components/Footer.tsx" code={`import React from 'react';

export function Footer() {
  // Inlined into the client bundle when it is built.
  return <footer>{process.env.GIO_PUBLIC_SITE_NAME}</footer>;
}`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          <strong>Only <code>GIO_PUBLIC_*</code> reaches the browser.</strong> Those variables
          are inlined into the client bundles when they are built (at worker start,{' '}
          <code>gio export</code> or <code>gio build standalone</code>, which freeze the
          values). Every other <code>process.env.X</code> is <code>undefined</code> in the
          browser. The prefix is fixed, so a secret cannot leak by a renamed setting. Never put
          a secret in a <code>GIO_PUBLIC_</code> variable.
        </li>
        <li>
          Commit <code>.env</code> and <code>.env.{'{mode}'}</code> only if they hold no
          secrets, and keep the <code>.local</code> files out of git. The{' '}
          <code>create-giojs</code> starter ignores <code>.env*.local</code> and ships a{' '}
          <code>.env.example</code> to copy.
        </li>
        <li>
          <code>gio export</code>, <code>gio build standalone</code>, <code>gio routes</code>,{' '}
          <code>gio typegen</code> and the testing kit load the same files with the same rules
          and switches. <code>giojs-server --check-config</code> loads them too, and reports
          which ones it read.
        </li>
        <li>
          Unlike Next.js, <code>.env.local</code> also applies when <code>NODE_ENV=test</code>.
          Set <code>GIO_ENV_FILES=0</code> in tests that must not see local values.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/guides/environment-variables">Environment Variables</a> - the guide.</li>
        <li><a href="/docs/env-vars">Environment variables reference</a> - every variable GioJS reads.</li>
        <li><a href="/docs/configuration/env"><code>[env]</code></a>, <a href="/docs/configuration#env-files">Configuration: .env files</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <>Introduced: <code>.env</code> files with Next.js precedence for the server, <code>gio export</code>, standalone builds and the CLI; <code>GIO_PUBLIC_*</code> inlining; <code>[env] files</code> and <code>GIO_ENV_FILES</code>.</> },
      ]} />
    </>
  );
}
