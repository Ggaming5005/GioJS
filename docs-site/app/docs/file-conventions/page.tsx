import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">API Reference</div>
      <h1>File Conventions</h1>
      <p className="page-subtitle">Special files GioJS recognizes inside app/.</p>
      <table>
        <thead><tr><th>File</th><th>Purpose</th></tr></thead>
        <tbody>
          <tr><td><code>page.tsx</code></td><td>Makes a folder a route</td></tr>
          <tr><td><code>layout.tsx</code></td><td>Wraps pages in this folder and below</td></tr>
          <tr><td><code>route.ts</code></td><td>API endpoint (GET/POST/PUT/PATCH/DELETE), SSE, or WebSocket handler</td></tr>
          <tr><td><code>error.tsx</code></td><td>Error UI for its folder and below: the 500 page when a render throws, and a client error boundary once hydrated</td></tr>
          <tr><td><code>not-found.tsx</code></td><td>404 UI for its folder and below, when a page calls <code>notFound()</code>. The one in app/ also answers unmatched URLs and is exported to 404.html</td></tr>
          <tr><td><code>loading.tsx</code></td><td>Suspense fallback for its folder and below - streamed first while the page suspends</td></tr>
        </tbody>
      </table>
      <p>
        <code>error.tsx</code>, <code>not-found.tsx</code> and <code>loading.tsx</code> may sit
        in any folder, including route groups and dynamic folders, and the nearest one at or
        above a page wins. Like layouts they take <code>.tsx</code>, <code>.jsx</code> or{' '}
        <code>.js</code>. Inside a folder they nest the way the Next.js App Router does:
      </p>
      <CodeBlock lang="text" code={`<Layout>                 layout.tsx
  <ErrorBoundary>        error.tsx   - catches everything below, not the layout above it
    <Suspense>           loading.tsx - fallback while anything below suspends
      ...the next folder's layout, or the page`} />
      <p>
        So an <code>error.tsx</code> never handles errors from the layout in its own folder -
        the <code>error.tsx</code> of a parent folder does. See{' '}
        <a href="/docs/error-handling">Error Handling</a> and{' '}
        <a href="/docs/layouts-and-pages">Layouts &amp; Pages</a>.
      </p>
      <h2>Folder conventions</h2>
      <table>
        <thead><tr><th>Folder</th><th>Effect</th></tr></thead>
        <tbody>
          <tr><td><code>[id]</code></td><td>Dynamic segment - matches exactly one URL segment (<code>/posts/:id</code>)</td></tr>
          <tr><td><code>[...slug]</code></td><td>Catch-all - one or more segments; <code>params.slug</code> is <code>&apos;a/b&apos;</code></td></tr>
          <tr><td><code>[[...slug]]</code></td><td>Optional catch-all - zero or more segments, so it also matches the parent URL (<code>params.slug</code> is <code>&apos;&apos;</code>)</td></tr>
          <tr><td><code>(group)</code></td><td>Route group - organizes files and scopes a layout without adding a URL segment</td></tr>
          <tr><td><code>_folder</code></td><td>Private - never routable; for colocated components and helpers</td></tr>
        </tbody>
      </table>
      <p>
        Layouts apply by folder ancestry: a page gets the layout.tsx of every folder from app/
        down to its own, groups and dynamic folders included. Two files resolving to the same
        URLs fail startup with an error naming both. See Layouts &amp; Pages for matching order.
      </p>
      <p>
        Param names may not start with <code>.</code> or contain <code>?</code>, <code>:</code>{' '}
        or <code>*</code>; a folder like <code>[...slug?]</code> or <code>[id?]</code> fails
        startup instead of quietly changing what the route matches.
      </p>
    </>
  );
}
