import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../components/CodeBlock.tsx';
import { PropsTable, VersionHistory } from '../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'gio.config.ts',
  description:
    'The optional JavaScript config file: Node plugins that run around every request the ' +
    'render worker handles. Everything declarative belongs in gio.toml.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>gio.config.ts</h1>
      <p className="page-subtitle">
        The optional JavaScript config file: Node plugins that run around every request the
        render worker handles. Everything declarative belongs in <code>gio.toml</code>.
      </p>
      <CodeBlock lang="ts" title="gio.config.ts" code={`import { defineConfig } from '@gio.js/core';
import { internalOnly, renderTiming } from './lib/plugins';

export default defineConfig({
  plugins: [internalOnly, renderTiming],
});`} />

      <h2 id="reference">Reference</h2>
      <p>
        The file is <code>gio.config.ts</code> or <code>gio.config.js</code> (checked in that
        order) in the project root, next to <code>gio.toml</code> - the parent of{' '}
        <code>app/</code> (or of <code>GIO_APP_DIR</code>). Its default export is a{' '}
        <code>GioConfig</code>; <code>defineConfig</code> returns its argument unchanged and
        only adds the type.
      </p>
      <h3 id="keys">Keys</h3>
      <PropsTable kind="Key" rows={[
        {
          name: 'plugins',
          type: 'GioNodePlugin[]',
          default: '[]',
          description: <>Node plugins, run in array order around every request the worker handles. See <a href="#gionodeplugin"><code>GioNodePlugin</code></a>.</>,
        },
      ]} />
      <p>
        That is the only key. Server settings - limits, headers, redirects, guards, caching -
        are <a href="/docs/configuration"><code>gio.toml</code></a> keys, and declarative
        rules can also live in <a href="/docs/middleware"><code>middleware.ts</code></a>.
      </p>

      <h3 id="gionodeplugin">GioNodePlugin</h3>
      <CodeBlock lang="ts" code={`import type { GioNodePlugin, IPCRequest, IPCResponse } from '@gio.js/core';

interface GioNodePlugin {
  name: string;
  version: string;
  onRequest?: (req: IPCRequest) => Promise<IPCRequest | IPCResponse>;
  onResponse?: (req: IPCRequest, res: IPCResponse) => Promise<IPCResponse>;
  onStartup?: () => Promise<void>;
  onShutdown?: () => Promise<void>;
}`} />
      <PropsTable kind="Field" rows={[
        { name: 'name', type: 'string', required: true, description: 'Names the plugin in error logs and in the 500 body when a hook throws.' },
        { name: 'version', type: 'string', required: true, description: 'Your plugin\'s version (required by the type, informational).' },
        {
          name: 'onRequest',
          type: 'function',
          description: <>Runs before routing. Return the request (changed or not) to continue, or a response to answer at once - later plugins and the page are skipped.</>,
        },
        {
          name: 'onResponse',
          type: 'function',
          description: 'Runs on the finished response; return it, changed or not.',
        },
        { name: 'onStartup', type: 'function', description: 'Runs when a worker process starts, before it serves.' },
        { name: 'onShutdown', type: 'function', description: 'Runs when a worker process stops, plugins in reverse order.' },
      ]} />
      <p>
        <code>IPCRequest</code> carries <code>method</code>, <code>path</code>,{' '}
        <code>query</code>, lowercased <code>headers</code>, <code>body</code>,{' '}
        <code>locale</code>, and when known <code>ip</code>, <code>scheme</code>,{' '}
        <code>host</code> and <code>requestId</code>. <code>IPCResponse</code> carries{' '}
        <code>status</code>, <code>headers</code>, <code>body</code>,{' '}
        <code>cacheable</code>, <code>cacheMaxAge</code> and <code>setCookies</code>.
      </p>

      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          <strong>Loading.</strong> Each worker imports the file at boot through{' '}
          <code>tsx</code>, so it can import TypeScript from your project. A missing file
          means no plugins.
        </li>
        <li>
          <strong>Validation.</strong> The export is checked at boot: anything but an object,
          an unknown key, a <code>plugins</code> that is not an array, or a plugin without a
          string <code>name</code> stops the worker with an error naming the file:{' '}
          <code>gio.config.ts: unknown key &quot;plugin&quot; - did you mean &quot;plugins&quot;? (gio.config takes plugins; server settings belong in gio.toml)</code>.
        </li>
        <li>
          <strong>Which requests.</strong> Every request the Node worker handles: page renders
          (background revalidations included), page actions, route handlers and metadata
          routes. Requests Rust answers alone never reach a plugin: cache hits,{' '}
          <code>public/</code> files and chunks, <code>/_gio/image</code>, and requests that a
          guard, redirect or rate limit from <code>gio.toml</code> / <code>middleware.ts</code>{' '}
          already answered. WebSocket messages do not go through plugins.
        </li>
        <li>
          <strong>Errors.</strong> An <code>onRequest</code> that throws answers{' '}
          <code>500</code> with <code>Internal Server Error (plugin: &lt;name&gt;)</code>. An{' '}
          <code>onResponse</code> that throws is logged and skipped: the response goes on as
          it was. Neither crashes the worker.
        </li>
        <li>
          <strong>Streaming.</strong> An <code>onResponse</code> hook must see the whole body,
          so while any plugin has one, page renders do not stream (partial prerendering
          included) and route handlers stream only event streams. Streamed route-handler
          responses skip <code>onResponse</code>.
        </li>
        <li>
          <strong>Caching.</strong> What <code>onResponse</code> returns is what Rust caches,
          so a cache hit replays it without running the hook again. An{' '}
          <code>onRequest</code> that reads credentials (cookies, <code>authorization</code>,
          the client address) and then rewrites the path, query or locale makes that render
          per-visitor: it is not cached. A page that reads a header a plugin changed is not
          cached either.
        </li>
        <li>
          <strong>Workers.</strong> With <code>[server] workers</code> above 1, every worker
          loads the plugins and runs <code>onStartup</code> - and again when a worker is
          respawned. <code>GIO_WORKER_INDEX</code> is <code>&quot;0&quot;</code> in one worker
          per server.
        </li>
      </ul>

      <h2 id="examples">Examples</h2>
      <h3 id="answer-from-onrequest">Refuse a path from onRequest</h3>
      <CodeBlock lang="ts" title="lib/plugins.ts" code={`import type { GioNodePlugin } from '@gio.js/core';

/** Answers /internal/* with 403 unless the request carries the ops key. */
export const internalOnly: GioNodePlugin = {
  name: 'internal-only',
  version: '1.0.0',
  async onRequest(req) {
    if (!req.path.startsWith('/internal/')) return req;
    if (req.headers['x-ops-key'] === process.env.OPS_KEY) return req;
    return {
      id: req.id,
      status: 403,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: 'Forbidden',
      cacheable: false,
      cacheMaxAge: 0,
    };
  },
};`} />
      <p>
        A response from <code>onRequest</code> must echo <code>req.id</code>; keep{' '}
        <code>cacheable: false</code> for an answer that depends on the request. For a plain
        cookie or role check, a <code>[[guards]]</code> rule in <code>gio.toml</code> runs in
        Rust before Node and needs no plugin.
      </p>

      <h3 id="add-a-header-in-onresponse">Add a header in onResponse</h3>
      <CodeBlock lang="ts" title="lib/plugins.ts" code={`import type { GioNodePlugin } from '@gio.js/core';

export const renderTiming: GioNodePlugin = {
  name: 'render-timing',
  version: '1.0.0',
  async onRequest(req) {
    req.headers['x-render-start'] = String(Date.now());
    return req;
  },
  async onResponse(req, res) {
    const start = Number(req.headers['x-render-start']);
    return { ...res, headers: { ...res.headers, 'server-timing': \`render;dur=\${Date.now() - start}\` } };
  },
};`} />
      <CodeBlock lang="text" code={`$ curl -sI http://localhost:3000/about | grep -i server-timing
server-timing: render;dur=51`} />

      <h3 id="strip-cookies">Strip cookies from a response</h3>
      <CodeBlock lang="ts" title="lib/plugins.ts" code={`import type { GioNodePlugin } from '@gio.js/core';

export const noCookiesOnPublic: GioNodePlugin = {
  name: 'no-cookies-on-public',
  version: '1.0.0',
  async onResponse(req, res) {
    return req.path.startsWith('/public-api/') ? { ...res, setCookies: [] } : res;
  },
};`} />
      <p>
        Cookies a page or route handler sets arrive in <code>res.setCookies</code>, one entry
        per <code>Set-Cookie</code>, never in <code>res.headers[&apos;set-cookie&apos;]</code>.
        Append to the array to add one.
      </p>

      <h3 id="run-a-job-once-per-server">Run a startup job once per server</h3>
      <CodeBlock lang="ts" title="lib/plugins.ts" code={`import type { GioNodePlugin } from '@gio.js/core';
import { primeSearchIndex } from './search';

export const warmup: GioNodePlugin = {
  name: 'warmup',
  version: '1.0.0',
  async onStartup() {
    if (process.env.GIO_WORKER_INDEX !== '0') return;
    await primeSearchIndex(); // keep it idempotent: worker 0 can be respawned
  },
};`} />

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          <code>giojs-server --check-config</code> and <code>gio doctor</code> do not load{' '}
          <code>gio.config.ts</code>. A validation error shows when the worker boots: the
          worker exits with the message above in the log, and the server exits once it gives
          up waiting for a worker.
        </li>
        <li>
          In <code>gio dev</code>, editing <code>gio.config.ts</code> or a module it imports
          restarts the worker. <code>gio build standalone</code> bundles it into{' '}
          <code>worker.js</code>, and the testing kit (<code>renderPage</code>,{' '}
          <code>callRoute</code>) runs your plugins too.
        </li>
        <li>
          Prefer <code>gio.toml</code> or <code>middleware.ts</code> rules for redirects,
          rewrites, headers and guards: they run in Rust for every request, cache hits
          included, and cost no Node time.
        </li>
        <li>
          There is no Rust plugin API in <code>gio.config.ts</code>; it configures the Node
          worker only.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/functions/define-config"><code>defineConfig</code></a></li>
        <li><a href="/docs/file-conventions/gio-config">File conventions: gio.config.ts</a></li>
        <li><a href="/docs/configuration">gio.toml</a> and <a href="/docs/middleware">Middleware</a></li>
        <li><a href="/docs/configuration#render-workers">Render workers</a></li>
        <li><a href="/docs/caching-layers">Caching Layers</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        {
          version: 'v0.1.0-beta.8',
          changes: <>Validated at boot (unknown keys and plugins without a <code>name</code> are errors). <code>defineConfig</code> and <code>type GioConfig</code> exported from <code>@gio.js/core</code>. <code>onStartup</code> / <code>onShutdown</code> run in every worker of a pool. Cookies reach <code>onResponse</code> in <code>res.setCookies</code>. Renders an <code>onRequest</code> plugin personalized are no longer cached.</>,
        },
        { version: 'v0.1.0-beta.1', changes: <>Introduced: <code>plugins</code> with <code>onRequest</code> / <code>onResponse</code> / <code>onStartup</code> / <code>onShutdown</code>; <code>gio.config.js</code> is read when there is no <code>gio.config.ts</code>.</> },
      ]} />
    </>
  );
}
