import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';
import { PropsTable, VersionHistory } from '../../../../components/ReferenceTable.tsx';

export const metadata: Metadata = {
  title: 'defineConfig',
  description:
    'Type gio.config.ts, the file for settings only JavaScript can express - today, Node plugins.',
};

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>defineConfig</h1>
      <p className="page-subtitle">
        Type <code>gio.config.ts</code>, the file for settings only JavaScript can express -
        today, Node plugins.
      </p>
      <CodeBlock lang="ts" title="gio.config.ts" code={`import { defineConfig } from '@gio.js/core';
import { auditPlugin } from './lib/audit-plugin.ts';

export default defineConfig({
  plugins: [auditPlugin],
});`} />

      <h2 id="reference">Reference</h2>
      <p>
        <code>defineConfig(config)</code> returns <code>config</code> unchanged; it gives the
        default export the <code>GioConfig</code> type. The file is <code>gio.config.ts</code>{' '}
        or <code>gio.config.js</code> at the project root, next to <code>gio.toml</code>, and
        it is optional.
      </p>
      <PropsTable kind="Key" rows={[
        {
          name: 'plugins',
          type: 'GioNodePlugin[]',
          default: '[]',
          description: (
            <>
              Node plugins, run in order around every request the worker handles. Each one
              needs a <code>name</code>.
            </>
          ),
        },
      ]} />
      <h3 id="gionodeplugin">GioNodePlugin</h3>
      <PropsTable kind="Field" rows={[
        { name: 'name', type: 'string', required: true, description: <>Shown in errors and logs.</> },
        { name: 'version', type: 'string', required: true, description: <>Your plugin&apos;s version (required by the type).</> },
        {
          name: 'onRequest',
          type: '(req: IPCRequest) => Promise<IPCRequest | IPCResponse>',
          description: <>Runs before routing. Return the (possibly changed) request, or a response to answer without rendering - the remaining plugins are skipped.</>,
        },
        {
          name: 'onResponse',
          type: '(req: IPCRequest, res: IPCResponse) => Promise<IPCResponse>',
          description: <>Runs on the response before it goes back to Rust. Its presence turns streaming SSR off, since it must see the whole body.</>,
        },
        { name: 'onStartup', type: '() => Promise<void>', description: <>Runs when a worker process starts - in every worker of a pool, and again after a respawn.</> },
        { name: 'onShutdown', type: '() => Promise<void>', description: <>Runs when a worker shuts down, plugins in reverse order.</> },
      ]} />
      <h3 id="behavior">Behavior</h3>
      <ul>
        <li>
          The worker loads the file once at boot. An <code>onRequest</code> that throws
          answers that request with a <code>500</code> (
          <code>Internal Server Error (plugin: name)</code>); an <code>onResponse</code> that
          throws is logged and the response goes out as it was. Neither crashes the worker.
        </li>
        <li>
          The file is strict, like <code>gio.toml</code>: an unknown key, a{' '}
          <code>plugins</code> value that is not an array, or a plugin without a{' '}
          <code>name</code> stops the worker at boot with an error naming the file.
        </li>
      </ul>
      <CodeBlock lang="text" code={`gio.config.ts: unknown key "plugin" - did you mean "plugins"? (gio.config takes plugins; server settings belong in gio.toml)`} />

      <h2 id="examples">Examples</h2>
      <h3 id="a-response-header-plugin">A response header plugin</h3>
      <CodeBlock lang="ts" title="gio.config.ts" code={`import { defineConfig, type GioNodePlugin } from '@gio.js/core';

const workerHeader: GioNodePlugin = {
  name: 'worker-header',
  version: '1.0.0',
  async onResponse(req, res) {
    return { ...res, headers: { ...res.headers, 'x-rendered-by': \`worker \${process.env.GIO_WORKER_INDEX ?? '0'}\` } };
  },
};

export default defineConfig({
  plugins: [workerHeader],
});`} />
      <p>
        Every page and route-handler response then carries{' '}
        <code>x-rendered-by: worker 0</code> (or the index of the pool worker that answered).
      </p>

      <h2 id="good-to-know">Good to know</h2>
      <ul>
        <li>
          <strong>Server settings belong in <code>gio.toml</code>.</strong> Ports, caching,
          security, rules - everything declarative - lives there, read by the Rust server.{' '}
          <code>gio.config.ts</code> is read by the Node worker only.
        </li>
        <li>
          <strong>Plugins see what the worker sees.</strong> Requests Rust answers itself -
          cache hits, static files, rule redirects, guards - never reach them.
        </li>
        <li>
          <strong>Pools run every plugin in every worker.</strong> Guard one-time jobs with{' '}
          <code>GIO_WORKER_INDEX</code>, which is <code>&quot;0&quot;</code> in one worker per
          server.
        </li>
        <li>
          <strong>Tests load it too.</strong> <code>renderPage</code> and{' '}
          <code>callRoute</code> run your plugins, including <code>onStartup</code>, and{' '}
          <code>resetTestApp</code> runs <code>onShutdown</code>.
        </li>
        <li>
          Changes to <code>gio.config.ts</code> change the derived deployment id (unless{' '}
          <code>GIO_DEPLOYMENT_ID</code> pins it), so pages cached by the previous build are
          dropped.
        </li>
      </ul>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/gio-config">gio.config.ts reference</a></li>
        <li><a href="/docs/file-conventions/gio-config">gio.config.ts file convention</a></li>
        <li><a href="/docs/configuration#gioconfigts">Configuration: gio.config.ts</a></li>
        <li><a href="/docs/functions/define-middleware">defineMiddleware</a></li>
      </ul>

      <h2 id="version-history">Version history</h2>
      <VersionHistory entries={[
        {
          version: 'v0.1.0-beta.8',
          changes: (
            <>
              Introduced <code>defineConfig</code> and the <code>GioConfig</code> type;
              unknown keys and unnamed plugins stop the worker at boot.
            </>
          ),
        },
      ]} />
    </>
  );
}
