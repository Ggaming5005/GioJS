import React from 'react';

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
          <tr><td><code>error.tsx</code></td><td>500 page when a render throws (app/ root)</td></tr>
          <tr><td><code>not-found.tsx</code></td><td>404 page - also exported to 404.html for static sites (app/ root)</td></tr>
        </tbody>
      </table>
    </>
  );
}
