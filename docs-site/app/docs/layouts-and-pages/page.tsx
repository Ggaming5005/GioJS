import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Building Your App</div>
      <h1>Layouts & Pages</h1>
      <p className="page-subtitle">Build routes with page files and share UI with nested layouts.</p>
      <h2>Pages</h2>
      <p>A page is the default export of a page.tsx file. It renders the UI for a route.</p>
      <CodeBlock lang="tsx" code={`export default function Page() {
  return <h1>Hello, world</h1>;
}`} />
      <h2>Layouts</h2>
      <p>A layout.tsx wraps the pages in its folder and all nested folders. The root app/layout.tsx must render <code>&lt;html&gt;</code> and <code>&lt;body&gt;</code>.</p>
      <CodeBlock lang="tsx" code={`export default function Layout({ children }) {
  return (
    <html lang="en">
      <body>
        <Navbar />
        <main>{children}</main>
      </body>
    </html>
  );
}`} />
      <h2>Dynamic routes</h2>
      <p>Wrap a folder name in brackets to capture a URL segment. [id] becomes ctx.params.id; [...slug] is a catch-all.</p>
    </>
  );
}
