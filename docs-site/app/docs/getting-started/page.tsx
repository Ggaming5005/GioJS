import React from 'react';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function GettingStartedPage(): React.JSX.Element {
  return (
    <>
      <h1>Getting Started</h1>
      <p className="page-subtitle">
        GioJS is a Rust-powered React framework. The Rust binary handles HTTP, routing,
        caching, and compression. Node handles React SSR.
      </p>

      <h2>Prerequisites</h2>
      <ul>
        <li>Node.js 20 or later</li>
      </ul>

      <h2>Create a new app</h2>
      <CodeBlock lang="bash" code={`npm create giojs@latest my-app\ncd my-app\nnpm install`} />
      <p>
        GioJS ships a platform-specific binary via optional npm dependencies
        (the same model as esbuild). The right binary is selected automatically at install time.
      </p>

      <h2>Start the dev server</h2>
      <CodeBlock lang="bash" code={`npm run dev`} />

      <h2>Build for production</h2>
      <CodeBlock lang="bash" code={`npm run build\nNODE_ENV=production PORT=3000 npm start`} />

      <h2>gio.toml — project configuration</h2>
      <p>
        Create <code>gio.toml</code> in your project root. All fields are optional — GioJS
        has sensible defaults for everything.
      </p>
      <CodeBlock lang="toml" code={`[app]
name = "my-app"
router = "app"         # "app" (default) or "pages"

[server]
host = "0.0.0.0"
port = 3000

[cache]
memory_mb = 128        # in-process LRU cache size`} />

      <h2>Health check</h2>
      <p>
        The <code>/_gio/health</code> endpoint is always available and returns JSON.
        Use it for readiness probes and uptime monitors.
      </p>
      <CodeBlock lang="bash" code={`curl http://localhost:3000/_gio/health\n# {"status":"ok","http2":false,"tls":false}`} />

      <div className="callout">
        <strong>Migrating from Next.js?</strong> Run <code>npx gio-migrate</code> to
        automatically convert imports. See the <a href="/docs/migration">Migration Guide</a>.
      </div>
    </>
  );
}
