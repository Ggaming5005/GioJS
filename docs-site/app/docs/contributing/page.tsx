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
    </>
  );
}
