import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const metadata: Metadata = {
  title: 'Contributing',
  description: 'Help build the Rust-powered React framework.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>Contributing</h1>
      <p className="page-subtitle">Help build the Rust-powered React framework.</p>
      <p>GioJS is an open project. The monorepo holds the Rust crates (the server hot path) and the Node packages (the SSR bridge and React components).</p>

      <h2 id="the-repository">The repository</h2>
      <table>
        <thead>
          <tr><th>Path</th><th>What</th></tr>
        </thead>
        <tbody>
          <tr><td><code>crates/giojs-server</code></td><td>The HTTP server: routing, security, the page cache, rules, the IPC client and worker supervision, <code>gio.toml</code> parsing.</td></tr>
          <tr><td><code>crates/giojs-*</code></td><td>Focused crates the server uses: router, cache, image, CSS, fonts, i18n, rate limiter, prefetch budget, assets, plugins.</td></tr>
          <tr><td><code>packages/giojs-core</code></td><td><code>@gio.js/core</code>: the Node worker (SSR, route handlers, actions, the client build) and the server-side API.</td></tr>
          <tr><td><code>packages/giojs-react</code></td><td><code>@gio.js/react</code>: components and hooks that run in the browser.</td></tr>
          <tr><td><code>packages/giojs</code></td><td><code>@gio.js/server</code>: the <code>gio</code> CLI and the <a href="/docs/cli/giojs-server"><code>giojs-server</code></a> launcher.</td></tr>
          <tr><td><code>packages/giojs-cli</code></td><td><a href="/docs/create-giojs"><code>create-giojs</code></a>: the scaffolder, its templates, <code>add</code> and <code>migrate</code>.</td></tr>
          <tr><td><code>tests/integration</code></td><td>End-to-end tests against the real server binary and worker.</td></tr>
          <tr><td><code>docs-site</code></td><td>This site, a GioJS app exported to static HTML.</td></tr>
        </tbody>
      </table>

      <h2 id="setting-up">Setting up</h2>
      <p>You need Node.js 20 or newer, pnpm, and Rust 1.89 or newer (the workspace&apos;s <code>rust-version</code>).</p>
      <CodeBlock lang="bash" code={`git clone https://github.com/Ggaming5005/GioJS
cd GioJS
pnpm install

cargo test --workspace --locked                      # Rust crates
cargo clippy --workspace --locked -- -D warnings
pnpm -r --filter "./packages/*" test                 # Node packages (vitest, node:test)

# The Rust <-> Node integration suite: the real server binary and worker
cargo build -p giojs-server
GIO_SERVER_BIN=target/debug/giojs-server node tests/integration/run.mjs

# Docs site: typecheck, dead links and nav, tests, and the static build
cd docs-site && npm ci && npm run typecheck && npm run check-links && npm test && npm run export`} />
      <p>
        Apps in the workspace - the examples, and apps scaffolded inside the monorepo - resolve{' '}
        <code>@gio.js/react</code> through its build (<code>dist/</code>) and the{' '}
        <code>@gio.js/core</code> types through its declarations (<code>dist/types</code>). Build
        both before running or typechecking such an app. Rebuild after changing their sources
        too: a stale <code>dist/types</code> keeps serving the old types to every package that
        imports <code>@gio.js/core</code> by name.
      </p>
      <CodeBlock lang="bash" code={`pnpm --filter @gio.js/core --filter @gio.js/react run build`} />

      <h2 id="changing-the-configuration">Changing the configuration</h2>
      <p>
        A new <code>gio.toml</code> key goes into the config structs in{' '}
        <code>crates/giojs-server/src/config.rs</code>, and its section into{' '}
        <code>SECTIONS</code> if it is new: unknown keys stop the server, so a key the structs
        do not know cannot be used. Then:
      </p>
      <ul>
        <li>
          regenerate the editor schema that ships with <code>@gio.js/server</code>:
          <CodeBlock lang="bash" code={`GIO_UPDATE_SCHEMA=1 cargo test -p giojs-server json_schema`} />
        </li>
        <li>
          a switch that turns a protection off or loosens a limit adds its warning to{' '}
          <code>protections_off_warnings</code> in <code>config_check.rs</code>, so startup
          and <code>--check-config</code> say the same thing;
        </li>
        <li>
          follow the conventions every section uses: <code>enabled = true</code> for a
          feature, <code>0</code> for unlimited or no timeout;
        </li>
        <li>
          update the full reference on <a href="/docs/configuration">gio.toml</a>, the
          section&apos;s page, and the <code>CHANGELOG.md</code> entry.
        </li>
      </ul>

      <h2 id="writing-docs">Writing docs</h2>
      <p>
        Every docs page lives under <code>docs-site/app/docs/</code> and must be listed in the
        nav file of its area under <code>docs-site/components/nav/</code> - the link checker
        fails on pages nobody can navigate to and on links to pages that do not exist.{' '}
        <code>docs-site/AGENTS.md</code> is the guide to writing a page: the template, the
        components, heading ids and metadata. Every default, status code and header a page
        states comes from the source; facts that could drift get a check in{' '}
        <code>docs-site/scripts/docs-content.test.mjs</code>.
      </p>

      <h2 id="pull-requests">Pull requests</h2>
      <ul>
        <li>CI runs the Rust tests and clippy on Linux and Windows, the MSRV check, <code>cargo-deny</code>, the Node tests and typechecks, the integration suite and the docs site.</li>
        <li>Behavior changes get a test that fails without them, and an entry in <code>CHANGELOG.md</code>; a change in meaning also gets an upgrade note.</li>
        <li>Every published package shares one version, set by <code>packages/giojs</code>: <code>node scripts/sync-versions.mjs</code> stamps it everywhere and <code>--check</code> verifies it in CI.</li>
      </ul>
      <p>
        Report security issues as described in <code>SECURITY.md</code>, not in public issues.
      </p>
    </>
  );
}
