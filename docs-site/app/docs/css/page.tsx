import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Building Your App</div>
      <h1>CSS & Styling</h1>
      <p className="page-subtitle">Global stylesheets, CSS modules, and critical CSS extraction.</p>
      <p>Link a global stylesheet from your root layout. Files under public/ are served directly by Rust.</p>
      <CodeBlock lang="tsx" code={`<link rel="stylesheet" href="/public/styles/globals.css" />`} />
      <h2>CSS Modules</h2>
      <p>The giojs-css layer hashes class names and minifies output with lightningcss, and can extract critical CSS per route at startup.</p>
    </>
  );
}
