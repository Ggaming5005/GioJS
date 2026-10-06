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
      <h2>Stylesheets in app/</h2>
      <p>Every .css file under app/ is transformed (and minified in production) once at startup and served from memory at its path: app/globals.css answers at /globals.css. app/globals.css is also the source for critical CSS extraction.</p>
      <p>Because these URLs carry no content hash, they are served with <code>Cache-Control: public, max-age=0, must-revalidate</code> and a strong ETag computed from the transformed bytes. Browsers revalidate on each use and get a bodiless 304 while the file is unchanged, and the new stylesheet as soon as a deploy changes it. Content-hashed chunks under /_next/static keep year-long immutable caching. Root-served public/ files revalidate the same way, using Last-Modified.</p>
      <h2>CSS Modules</h2>
      <p>The giojs-css layer hashes class names and minifies output with lightningcss, and can extract critical CSS per route at startup.</p>
    </>
  );
}
