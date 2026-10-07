import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'gio.config.ts',
  description:
    'The optional project-root file for what only JavaScript can express: Node plugins that run around every request the worker handles.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>gio.config.ts</h1>
      <p className="page-subtitle">
        The optional project-root file for what only JavaScript can express: Node plugins
        that run around every request the worker handles.
      </p>
      <CodeBlock lang="ts" title="gio.config.ts" code={`import { defineConfig } from '@gio.js/core';
import { requestTimer } from './lib/request-timer';

export default defineConfig({
  plugins: [requestTimer],
});`} />

      <h2 id="reference">Reference</h2>
      <h3 id="file-name-and-location">File name and location</h3>
      <p>
        <code>gio.config.ts</code> or <code>gio.config.js</code> (<code>.ts</code> first) in
        the project root, next to <code>app/</code>. Without one, GioJS runs with no plugins.
      </p>
      <p>
        Its default export is a <code>GioConfig</code>; <code>plugins</code> is currently its
        only key. Every key, the plugin interface and its hooks are documented on{' '}
        <a href="/docs/gio-config">gio.config.ts reference</a>.
      </p>

      <h3 id="gio-config-or-gio-toml">gio.config.ts or gio.toml?</h3>
      <table>
        <thead><tr><th>Setting</th><th>File</th></tr></thead>
        <tbody>
          <tr><td>Node plugins (<code>onRequest</code>, <code>onResponse</code>, <code>onStartup</code>, <code>onShutdown</code>)</td><td><code>gio.config.ts</code></td></tr>
          <tr><td>Server, cache, security, images, fonts, rate limits, rules and every other setting</td><td><a href="/docs/file-conventions/gio-toml"><code>gio.toml</code></a></td></tr>
          <tr><td>Redirects, rewrites, headers and guards computed in code</td><td><a href="/docs/file-conventions/middleware"><code>middleware.ts</code></a></td></tr>
        </tbody>
      </table>

      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          <strong>Loaded by the Node worker</strong> when it starts, by every worker of a pool,
          and again whenever a worker restarts. In development, saving the file restarts the
          worker.
        </li>
        <li>
          <strong>Strict.</strong> The default export is checked when the worker starts. A
          mistake makes the worker exit with one of these errors in the log, and the server
          does not start (it reports that it could not connect to the worker):
        </li>
      </ul>
      <CodeBlock lang="text" code={`gio.config.ts: unknown key "plugin" - did you mean "plugins"? (gio.config takes plugins; server settings belong in gio.toml)
gio.config.ts: plugins must be an array of plugins
gio.config.ts: plugins[0] must be a plugin object with a name
gio.config.ts: the default export must be an object - export default defineConfig({ ... })`} />
      <ul>
        <li>
          <strong>Server-only.</strong> The file never reaches a browser bundle, so plugins may
          use secrets and Node APIs.
        </li>
      </ul>

      <h2 id="examples">Examples</h2>
      <h3 id="a-plugin-that-times-renders">A plugin that times renders</h3>
      <CodeBlock lang="ts" title="lib/request-timer.ts" code={`import type { GioNodePlugin } from '@gio.js/core';

const started = new Map<string, number>();

export const requestTimer: GioNodePlugin = {
  name: 'request-timer',
  version: '1.0.0',
  async onRequest(req) {
    started.set(req.id, performance.now());
    return req;
  },
  async onResponse(req, res) {
    const start = started.get(req.id);
    started.delete(req.id);
    if (start === undefined) return res;
    return { ...res, headers: { ...res.headers, 'server-timing': \`render;dur=\${(performance.now() - start).toFixed(1)}\` } };
  },
};`} />
      <p>
        An <code>onResponse</code> hook needs the whole body, so while one is registered
        pages are rendered completely instead of streamed.
      </p>

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          Unlike <code>next.config.js</code>, this file holds no server settings: ports, caching,
          headers, images and the rest are in <code>gio.toml</code>, which the Rust server reads.
          An unknown key here is an error, not a no-op.
        </li>
        <li>
          Plugins run in the order of the array. An <code>onRequest</code> that returns a
          response answers the request without rendering.
        </li>
        <li>
          A plugin that throws answers <code>500</code> for that request; it never takes the
          worker down.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/gio-config">gio.config.ts reference</a> - every key and hook.</li>
        <li><a href="/docs/functions/define-config"><code>defineConfig</code></a></li>
        <li><a href="/docs/configuration#gioconfigts">Configuration: gio.config.ts</a></li>
        <li><a href="/docs/file-conventions/gio-toml">gio.toml</a>, <a href="/docs/file-conventions/middleware">middleware.ts</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        { version: 'v0.1.0-beta.8', changes: <>Validated at startup: unknown keys and plugins without a <code>name</code> are errors. <code>defineConfig</code> and the <code>GioConfig</code> type.</> },
        { version: 'v0.1.0-beta.1', changes: <>Introduced, as <code>gio.config.ts</code> or <code>gio.config.js</code>, with Node plugins.</> },
      ]} />
    </>
  );
}
