import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const metadata: Metadata = {
  title: 'Adapters',
  description:
    'GioJS needs no platform adapter: it is one long-running server process. What a host ' +
    'must provide, where it runs, and where it does not.',
};

export const revalidate = false;

const REPO = 'https://github.com/Ggaming5005/GioJS/blob/main';

export default function Page(): React.JSX.Element {
  return (
    <>
      <h1>Adapters</h1>
      <p className="page-subtitle">
        GioJS needs no platform adapter: it is one long-running server process. What a host
        must provide, where it runs, and where it does not.
      </p>

      <p>
        Frameworks built around serverless functions need an adapter per platform to split
        the app into functions, routes and edge handlers. GioJS is built the other way round:
        the Rust server is a single binary that starts its own Node render workers, answers
        HTTP/1.1 and HTTP/2, terminates TLS if you want, and keeps the page cache in memory
        and on disk. Deploying means running that process - the same build runs unchanged on
        every host that can.
      </p>
      <CodeBlock lang="bash" code={`npm start                  # from source: cross-env NODE_ENV=production giojs-server
node standalone/run.mjs    # a standalone build: no node_modules needed on the host`} />

      <h2 id="what-a-host-must-provide">What a host must provide</h2>
      <table>
        <thead>
          <tr><th>Requirement</th><th>Why</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>A long-running process</td>
            <td>The server keeps its workers, page cache, WebSocket rooms and rate-limit buckets in memory between requests.</td>
          </tr>
          <tr>
            <td>Node.js 20 or newer</td>
            <td>The render workers run on Node.</td>
          </tr>
          <tr>
            <td>A server binary for the platform</td>
            <td>Published for Linux x64 (glibc and musl), macOS x64 and arm64, and Windows x64. On other platforms - Linux arm64 included - build it from source and point <code>GIO_SERVER_BIN</code> (or, for standalone builds, <code>GIO_STANDALONE_SERVER_BIN</code>) at it.</td>
          </tr>
          <tr>
            <td>A port to listen on</td>
            <td><code>GIO_PORT</code>, then <code>PORT</code> (set by most platforms), then <code>[server] port</code>, then 3000.</td>
          </tr>
          <tr>
            <td>A writable cache directory</td>
            <td><code>.gio/cache/pages</code> by default, or <code>GIO_CACHE_DIR</code>. Without a persistent disk the cache starts empty after each restart, which is fine.</td>
          </tr>
          <tr>
            <td>A graceful stop</td>
            <td><code>SIGTERM</code>, then enough time to drain (8 seconds) and let the workers exit before a hard kill. The <a href="/docs/guides/deploying">Deploying</a> recipes set this.</td>
          </tr>
          <tr>
            <td>A health check (optional)</td>
            <td><code>GET /_gio/health</code> answers <code>200</code> with <code>nodeReady</code> in its JSON body.</td>
          </tr>
        </tbody>
      </table>

      <h2 id="where-it-runs">Where it runs</h2>
      <table>
        <thead>
          <tr><th>Target</th><th>Guide</th></tr>
        </thead>
        <tbody>
          <tr><td>Docker, Docker Compose</td><td><a href="/docs/guides/deploying#docker">Deploying: Docker</a>, <a href="/docs/guides/docker">the starter&apos;s Dockerfile</a></td></tr>
          <tr><td>Fly.io</td><td><a href="/docs/guides/deploying#fly">Deploying: Fly.io</a></td></tr>
          <tr><td>Railway</td><td><a href="/docs/guides/deploying#railway">Deploying: Railway</a></td></tr>
          <tr><td>Render</td><td><a href="/docs/guides/deploying#render">Deploying: Render</a></td></tr>
          <tr><td>A Linux server with systemd, behind nginx or Caddy</td><td><a href="/docs/guides/deploying#vps">Deploying: VPS</a></td></tr>
          <tr><td>Kubernetes</td><td><a href={`${REPO}/docs/deployment/kubernetes.md`}><code>docs/deployment/kubernetes.md</code></a></td></tr>
          <tr><td>Windows Server (as a service with NSSM)</td><td><a href={`${REPO}/docs/deployment/windows-nssm.md`}><code>docs/deployment/windows-nssm.md</code></a></td></tr>
          <tr><td>Any static host (no server features)</td><td><a href="/docs/static-export">Static Export</a></td></tr>
        </tbody>
      </table>
      <p>
        For hosts without Node packages at runtime - a slim container, a VM image -{' '}
        <a href="/docs/standalone"><code>gio build standalone</code></a> bundles the app, its
        dependencies and the binary into one folder.
      </p>

      <h2 id="where-it-does-not-run">Where it does not run</h2>
      <ul>
        <li>
          <strong>Serverless functions</strong> (AWS Lambda, Vercel or Netlify functions, Cloud
          Functions): they start a handler per request and freeze it in between, so there is no
          process to keep a cache, workers or WebSockets. Container-based platforms that keep
          an instance running (Cloud Run with a minimum instance, App Runner, Azure Container
          Apps) work like any container host.
        </li>
        <li>
          <strong>Edge runtimes</strong> (Cloudflare Workers, Vercel Edge): GioJS needs Node and
          its native server binary. Put a CDN in front instead - cached pages send{' '}
          <code>Cache-Control</code> with <code>s-maxage</code> for it.
        </li>
      </ul>

      <h2 id="several-instances">Several instances</h2>
      <p>
        Each instance has its own page cache, rate-limit buckets and WebSocket rooms - there is
        no shared backend yet. Behind a load balancer:
      </p>
      <ul>
        <li>Set the same <code>GIO_DEPLOYMENT_ID</code> on every instance of a release, so their caches and skew detection agree.</li>
        <li>Send <code>POST /_gio/revalidate</code> to every instance; a purge reaches only the one that receives it.</li>
        <li>Expect N instances to allow N times a configured rate limit.</li>
        <li>Use sticky sessions for WebSockets if clients of one room must meet on one instance.</li>
      </ul>
      <p>
        See <a href="/docs/deployment#multi-instance">Proxies, Sizing &amp; Scaling</a> and{' '}
        <a href="/docs/known-issues">Known Limitations</a>.
      </p>

      <h2 id="related">Related</h2>
      <ul>
        <li><a href="/docs/guides/deploying">Deploying</a></li>
        <li><a href="/docs/standalone">Standalone Deploys</a></li>
        <li><a href="/docs/guides/production-checklist">Production Checklist</a></li>
        <li><a href="/docs/env-vars">Environment variables</a> the server reads</li>
      </ul>
    </>
  );
}
