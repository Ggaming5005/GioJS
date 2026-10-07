import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'gio help',
  description:
    'Print the gio command list or one command\'s options; gio --version prints the CLI, ' +
    'server binary and @gio.js/core versions.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>gio help</h1>
      <p className="page-subtitle">
        Print the <code>gio</code> command list or one command&apos;s options;{' '}
        <code>gio --version</code> prints the CLI, server binary and{' '}
        <code>@gio.js/core</code> versions.
      </p>
      <CodeBlock lang="bash" code={`gio help [command]
gio --help                # -h
gio <command> --help      # same as gio help <command>
gio --version             # -v`} />

      <h2 id="reference">Reference</h2>
      <PropsTable kind="Parameter" rows={[
        {
          name: '[command]',
          type: 'string',
          description: <>A command name (<code>dev</code>, <code>cache</code>, ...). Without it, the command list. An unknown name is a usage error.</>,
        },
      ]} />

      <h3 id="behavior">Behavior</h3>
      <CodeBlock lang="text" code={`$ gio --help
Usage: gio <command> [options]

Commands:
  dev      Start the development server (file watcher, error overlay)
  start    Start the production server
  build    Explain deploys; \`gio build standalone\` packages a deploy directory
  export   Render the app to static HTML in out/
  routes   List the app's routes (pages, route handlers, WebSockets, metadata)
  typegen  Write .gio/routes.d.ts (typed routes) without starting the server
  doctor   Check the environment and project for problems
  info     Print versions and environment details for bug reports
  cache    Explain how the cache served a URL (\`gio cache explain <url>\`)
  bench    Load-test a running server
  migrate  Migrate a Next.js app to GioJS (runs create-giojs migrate)
  add      Add a feature to this app (runs create-giojs add)
  help     Show help for a command

Options:
  -h, --help       show help (also: gio help <command>, gio <command> --help)
  -v, --version    show the CLI, server binary and @gio.js/core versions

Exit codes:
  0  success
  1  the command failed (server exited with an error, doctor found errors,
     no server binary, route conflict, ...)
  2  usage error (unknown command or option, missing argument)

Docs: https://giojs.com/docs/cli`} />
      <ul>
        <li>
          <code>gio help</code> and <code>gio --help</code> print to stdout and exit with{' '}
          <code>0</code>. <code>gio</code> with no command prints the same text to stderr,
          adds <code>To start the server: gio dev (development) or gio start (production).</code>,
          and exits with <code>2</code>.
        </li>
        <li>
          <code>gio help &lt;command&gt;</code> prints the command&apos;s usage, summary and
          options. For <code>migrate</code>, <code>add</code> and{' '}
          <code>build standalone</code>, the command&apos;s own <code>--help</code> has the full
          option list (the first two come from <code>create-giojs</code>).
        </li>
        <li>
          <code>gio --version</code> prints three lines and exits with <code>0</code>, even
          when no binary is installed (<code>not installed (...)</code>).
        </li>
      </ul>
      <CodeBlock lang="text" code={`$ gio --version
gio            0.1.0-beta.8 (@gio.js/server)
server binary  0.1.0-beta.8 (@gio.js/server-darwin-arm64)
@gio.js/core   0.1.0-beta.8`} />

      <h3 id="exit-codes">Exit codes</h3>
      <table>
        <thead>
          <tr><th>Code</th><th>Meaning</th></tr>
        </thead>
        <tbody>
          <tr><td><code>0</code></td><td>Success.</td></tr>
          <tr><td><code>1</code></td><td>The command failed: the server exited with an error (its own code is passed through), <code>gio doctor</code> found an error, no server binary, a route conflict, an unreachable server.</td></tr>
          <tr><td><code>2</code></td><td>Usage error: unknown command or option, a missing or malformed argument.</td></tr>
        </tbody>
      </table>
      <p>
        Three commands run their own parser and use <code>1</code> for a usage error too:{' '}
        <code>gio build standalone</code>, <code>gio bench</code> and{' '}
        <code>gio migrate</code>.
      </p>

      <h2 id="examples">Examples</h2>
      <h3 id="a-mistyped-command">A mistyped command</h3>
      <CodeBlock lang="text" code={`$ gio strat
gio: unknown command "strat" - did you mean \`gio start\`?
Run \`gio --help\` for usage.`} />
      <p>
        Close misspellings and unambiguous prefixes (<code>gio doc</code>) get a suggestion.
        Words people type out of habit get a pointer:
      </p>
      <table>
        <thead>
          <tr><th>You type</th><th>Suggested</th></tr>
        </thead>
        <tbody>
          <tr><td><code>gio serve</code>, <code>gio run</code></td><td><code>gio start</code></td></tr>
          <tr><td><code>gio create</code>, <code>gio new</code>, <code>gio init</code></td><td><code>npm create giojs@latest</code></td></tr>
          <tr><td><code>gio version</code></td><td><code>gio --version</code></td></tr>
          <tr><td><code>gio lint</code></td><td>your linter directly (GioJS has no lint command)</td></tr>
        </tbody>
      </table>

      <h3 id="one-commands-options">One command&apos;s options</h3>
      <CodeBlock lang="text" code={`$ gio help cache
Usage: gio cache explain <url-or-path> [--base <url>]

Explain how the cache served a URL (\`gio cache explain <url>\`).

Requests the URL from the running server and decodes its X-Gio-Cache
header: hit, stale (revalidating), miss; stored, bypass, static or ppr.
...`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          Every command parses its options strictly: an unknown option is an error with a
          suggestion, never ignored, and a bare <code>gio</code> never starts a server.
        </li>
        <li>
          Help text loads nothing else, so <code>gio --help</code> answers instantly even in a
          broken install.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/cli">CLI overview</a></li>
        <li><a href="/docs/cli/info"><code>gio info</code></a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <>Introduced: <code>gio help</code>, <code>--help</code> on every command, <code>--version</code>, did-you-mean errors and exit code <code>2</code> for usage errors. A bare <code>gio</code> prints the help instead of starting the server.</> },
      ]} />
    </>
  );
}
