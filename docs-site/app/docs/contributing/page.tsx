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
cargo test          # Rust crates
npm test            # Node packages`} />
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
