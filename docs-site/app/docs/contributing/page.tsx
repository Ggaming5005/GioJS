import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Resources</div>
      <h1>Contributing</h1>
      <p className="page-subtitle">Help build the Rust-powered React framework.</p>
      <p>GioJS is an open project. The monorepo holds the Rust crates (the server hot path) and the Node packages (the SSR bridge and React components).</p>
      <CodeBlock lang="bash" code={`git clone https://github.com/Ggaming5005/GioJS
cd GioJS
pnpm install

cargo test --workspace --locked                      # Rust crates
cargo clippy --workspace --all-targets -- -D warnings
pnpm -r --filter "./packages/*" test                 # Node packages (vitest, node:test)

# The Rust <-> Node integration suite: the real server binary and worker
cargo build -p giojs-server
GIO_SERVER_BIN=target/debug/giojs-server node tests/integration/run.mjs

# Docs site: typecheck and dead-link check
cd docs-site && npm install && npm run typecheck && npm run check-links`} />
      <p>
        Every docs page lives under <code>docs-site/app/docs/</code> and must be listed in{' '}
        <code>docs-site/components/Sidebar.tsx</code> - the link checker fails on pages
        nobody can navigate to and on links to pages that do not exist. Report security
        issues as described in <code>SECURITY.md</code>, not in public issues.
      </p>
      <p>
        Apps in the workspace - the examples, and apps scaffolded inside the monorepo - resolve{' '}
        <code>@gio.js/react</code> through its build (<code>dist/</code>) and the{' '}
        <code>@gio.js/core</code> types through its declarations (<code>dist/types</code>). Build
        both before running or typechecking such an app. Rebuild after changing their sources
        too: a stale <code>dist/types</code> keeps serving the old types to every package that
        imports <code>@gio.js/core</code> by name.
      </p>
      <CodeBlock lang="bash" code={`pnpm --filter @gio.js/core --filter @gio.js/react run build`} />
    </>
  );
}
