import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function ApiPage(): React.JSX.Element {
  return (
    <>
      <h1>API Reference</h1>
      <p className="page-subtitle">
        GioJS exposes HTTP endpoints for health checks, image optimization, and
        deployment coordination. The IPC protocol between Rust and Node is documented here.
      </p>

      <h2>Built-in HTTP endpoints</h2>

      <h3>GET /_gio/health</h3>
      <p>Returns server status. Always available, even during startup.</p>
      <CodeBlock lang="json" code={`{
  "status": "ok",
  "deploymentId": "abc12345",
  "nodeReady": true,
  "cacheSize": "12MB",
  "uptime": 3600
}`} />
      <table>
        <thead><tr><th>Field</th><th>Type</th><th>Description</th></tr></thead>
        <tbody>
          <tr><td><code>status</code></td><td>string</td><td>"ok" or "degraded"</td></tr>
          <tr><td><code>deploymentId</code></td><td>string</td><td>Hash of the current build manifest</td></tr>
          <tr><td><code>nodeReady</code></td><td>boolean</td><td>IPC handshake with Node worker complete</td></tr>
          <tr><td><code>cacheSize</code></td><td>string</td><td>Current in-memory cache size</td></tr>
          <tr><td><code>uptime</code></td><td>number</td><td>Server uptime in seconds</td></tr>
        </tbody>
      </table>

      <h3>GET /_gio/image</h3>
      <p>Image optimization endpoint. Used internally by <code>{'<GioImage>'}</code>.</p>
      <CodeBlock lang="bash" code={`GET /_gio/image?url=/images/hero.jpg&w=800&q=80&f=webp`} />
      <table>
        <thead><tr><th>Parameter</th><th>Description</th></tr></thead>
        <tbody>
          <tr><td><code>url</code></td><td>Image path (local) or URL (must match remotePatterns)</td></tr>
          <tr><td><code>w</code></td><td>Target width in pixels</td></tr>
          <tr><td><code>q</code></td><td>Quality 1–100 (default: 80)</td></tr>
          <tr><td><code>f</code></td><td>Output format: webp, avif, jpeg, png (default: webp)</td></tr>
        </tbody>
      </table>

      <h2>IPC protocol (Rust ↔ Node)</h2>
      <p>
        The Rust server communicates with the Node worker over a Unix socket
        (<code>/tmp/giojs.sock</code>) or Windows named pipe (<code>{'\\\\.\\\pipe\\giojs'}</code>).
        Messages are length-prefixed JSON frames.
      </p>

      <h3>Frame format</h3>
      <CodeBlock lang="text" code={`[4-byte big-endian uint32: payload length][JSON bytes]`} />

      <h3>Request (Rust → Node)</h3>
      <CodeBlock lang="json" code={`{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "method": "GET",
  "path": "/posts/42",
  "params": { "id": "42" },
  "query": {},
  "headers": { "accept": "text/html" },
  "body": null,
  "deploymentId": "abc12345"
}`} />

      <h3>Response (Node → Rust)</h3>
      <CodeBlock lang="json" code={`{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "status": 200,
  "headers": { "content-type": "text/html; charset=utf-8" },
  "body": "<!DOCTYPE html>...",
  "cacheable": true,
  "cacheMaxAge": 31536000
}`} />

      <h3>Handshake</h3>
      <p>
        On startup, Node sends a <code>{'{"type":"ready","version":"0.1.0"}'}</code> frame.
        Rust responds with <code>{'{"type":"ack"}'}</code>. Requests are processed only after
        the ACK.
      </p>

      <h2>Page module API</h2>
      <p>Every page in <code>app/</code> can export:</p>
      <CodeBlock lang="typescript" code={`// Required: default export is the React component
export default function Page(props: PageProps): React.JSX.Element { ... }

// Optional: server-side data fetching
export async function getServerSideProps(ctx: {
  params: Record<string, string>;
  query: Record<string, string>;
}): Promise<Record<string, unknown> | { redirect: { destination: string; permanent: boolean } }> { ... }

// Optional: cache control
export const revalidate = false;    // cache forever
export const revalidate = 60;       // revalidate after 60 seconds
// (omit to not cache)`} />
    </>
  );
}
