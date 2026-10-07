import React from 'react';
import type { Metadata } from '@gio.js/core';
import { CodeBlock } from '../../../components/CodeBlock.tsx';

export const metadata: Metadata = {
  title: 'Deployment',
  description:
    'How a GioJS server behaves in production: static files, health checks, reverse proxies, ' +
    'process supervision, sizing, and running several instances.',
};

export const revalidate = false;

export default function DeploymentPage(): React.JSX.Element {
  return (
    <>
      <h1>Deployment</h1>
      <p className="page-subtitle">
        How a GioJS server behaves in production: static files, health checks, reverse
        proxies, process supervision, sizing, and running several instances.
      </p>

      <p>
        A GioJS server is two kinds of process: the <a href="/docs/cli/giojs-server"><code>giojs-server</code></a> Rust binary
        (HTTP, routing, caching, compression) and the Node.js worker(s) it spawns for React
        rendering. Starting the server starts everything. For step-by-step setups - Docker,
        Fly.io, Railway, Render, or a Linux server with systemd and nginx or Caddy - follow{' '}
        <a href="/docs/guides/deploying">Deploying</a>; before going live, work through the{' '}
        <a href="/docs/guides/production-checklist">production checklist</a>. This page is
        the reference those guides point to.
      </p>

      <table>
        <thead>
          <tr><th>Situation</th><th>Recipe</th></tr>
        </thead>
        <tbody>
          <tr><td>Container, single instance or scaling</td><td><a href="/docs/guides/deploying#docker">Docker</a> (a standalone build in a slim Node image)</td></tr>
          <tr><td>Managed platform</td><td><a href="/docs/guides/deploying#fly">Fly.io</a>, <a href="/docs/guides/deploying#railway">Railway</a>, <a href="/docs/guides/deploying#render">Render</a></td></tr>
          <tr><td>Linux VPS or bare metal</td><td><a href="/docs/guides/deploying#vps">systemd + nginx or Caddy</a></td></tr>
          <tr><td>Kubernetes, Windows Server</td><td><code>docs/deployment/kubernetes.md</code> and <code>docs/deployment/windows-nssm.md</code> in the repository</td></tr>
          <tr><td>No server features needed</td><td><a href="/docs/static-export">Static export</a> to any static host</td></tr>
        </tbody>
      </table>

      <p>
        Ship either a <a href="/docs/standalone">standalone folder</a> (
        <a href="/docs/cli/build-standalone"><code>gio build standalone</code></a>: the server binary and a bundled worker that run with{' '}
        <code>node run.mjs</code> on any host with Node 20+) or the project itself (
        <code>npm ci --omit=dev</code> and <code>npm start</code> - no build step, and{' '}
        <code>npm update</code> stays your upgrade path). Either way, run with{' '}
        <code>NODE_ENV=production</code> (or unset) and typecheck before you ship (
        <code>tsc --noEmit</code>).
      </p>

      <h2 id="static-files">Static files</h2>
      <p>
        Ship <a href="/docs/file-conventions/public-folder"><code>public/</code></a> next to <code>app/</code>. Rust serves its files at the
        site root (<code>/robots.txt</code>, <code>/favicon.ico</code>,{' '}
        <code>/.well-known/...</code>) and under <code>/public/*</code>, ahead of the page cache
        and the Node worker. Dotfiles (other than <code>.well-known/</code>), symlinks, and a
        top-level <code>public/_gio/</code> are served under <code>/public/*</code> only. The
        root-served set is indexed at startup, so add files as part of the deploy - files
        copied in while the server runs are picked up on the next restart (they are reachable
        under <code>/public/*</code> immediately). Point <code>GIO_PUBLIC_DIR</code> elsewhere
        if your assets live outside the project.
      </p>
      <p>
        Guards, header rules, and <a href="/docs/configuration/rate-limits"><code>[[rate_limits]]</code></a> for <code>/public/*</code> paths
        cover the root URL of the same file as well. A static export (<a href="/docs/cli/export"><code>gio export</code></a>)
        copies <code>public/</code> into <code>out/</code> at both places, so static hosts serve
        the same URLs.
      </p>

      <h2 id="health-check">Health check</h2>
      <p>
        <code>/_gio/health</code> returns JSON and always answers 200 - cached and static
        content keeps serving even while the Node worker is respawning. <code>nodeReady</code>{' '}
        is <code>false</code> while no worker is ready (with a worker pool, only when every
        worker is down at once), and <code>workers</code> counts the ready ones. Readiness
        probes should read <code>nodeReady</code>.
        Use it for readiness probes, load balancer health checks, and uptime monitors.
        With <code>[health] details = false</code> it answers only{' '}
        <code>{'{'}&quot;status&quot;:&quot;ok&quot;,&quot;nodeReady&quot;:...{'}'}</code>; with{' '}
        <code>[health] enabled = false</code> it is a <code>404</code>, and probes must use
        a page of your own (the port only opens once a worker is ready, so{' '}
        <a href="/docs/cli/start"><code>gio start</code></a> and the testing kit treat that <code>404</code> as ready):
      </p>
      <CodeBlock lang="json" code={`{
  "status": "ok",
  "http2": true,
  "tls": false,
  "deploymentId": "0e92bc3a01f4ea44",
  "nodeReady": true,
  "workers": { "configured": 2, "ready": 2 },
  "cacheEntries": 42,
  "uptimeSecs": 3600
}`} />
      <p>
        <code>deploymentId</code> is 16 hex characters derived from the build, or the value
        of <a href="/docs/env-vars#gio-deployment-id"><code>GIO_DEPLOYMENT_ID</code></a> (up to 64 characters)
        when you pin one - compare it across instances to see that a rollout has finished.
      </p>

      <h2 id="reverse-proxy">Behind a reverse proxy or load balancer</h2>
      <p>
        GioJS closes an HTTP/1.1 keep-alive connection after{' '}
        <code>header_read_timeout_secs</code> (10 seconds by default) without a new request,
        and any connection after <code>idle_timeout_secs</code> (60 seconds) with nothing in
        flight. Proxies that pool upstream connections (nginx <code>upstream</code>{' '}
        keep-alive, ingress-nginx, AWS ALB) keep them idle for 60 seconds by default and
        ignore the <code>Keep-Alive</code> hint, so they can reuse a connection at the moment
        GioJS closes it and answer that request with a 502. Either keep the proxy&apos;s
        upstream idle timeout below 10 seconds, or raise both GioJS deadlines above the
        proxy&apos;s. The proxy reads every request head in full, so a longer head deadline
        behind it costs nothing:
      </p>
      <CodeBlock lang="toml" code={`[server]
header_read_timeout_secs = 65   # above a 60s ALB / ingress-nginx idle timeout
idle_timeout_secs = 65`} />
      <p>
        A plain <code>proxy_pass</code> with no <code>upstream</code> keep-alive opens a fresh
        connection per request and needs neither. See{' '}
        <a href="/docs/configuration">Configuration</a> for every connection limit.
      </p>
      <p>
        Keep the original <code>Host</code> header (<code>proxy_set_header Host $host;</code>{' '}
        in nginx): CSRF protection and the WebSocket origin check compare the browser&apos;s{' '}
        <code>Origin</code> with it, so a proxy that rewrites it makes same-origin form posts
        and WebSockets fail with 403. And when the proxy terminates TLS, GioJS does not send{' '}
        <code>Strict-Transport-Security</code> by itself - set <a href="/docs/configuration/security"><code>[security] hsts = true</code></a>.
        See <a href="/docs/security">Security</a>.
      </p>

      <h3 id="client-ips">Client IPs, HTTPS and request IDs</h3>
      <p>
        Behind a proxy, every connection comes from the proxy, so rate limits would put all
        visitors in one bucket and <code>req.ip</code> would be the proxy&apos;s address.
        List the proxy in <code>trusted_proxies</code> and GioJS reads the real client from
        the headers it adds (see{' '}
        <a href="/docs/configuration">Reverse proxies &amp; client IPs</a> for the exact
        rules). Whatever the proxy, get four things right:
      </p>
      <ul>
        <li>
          <strong>Trust only the proxy.</strong> Put its address (or the private range it
          connects from) in <code>trusted_proxies</code>, and make sure clients cannot reach
          GioJS directly - bind to <code>127.0.0.1</code> or firewall the port.
        </li>
        <li>
          <strong>Forward <code>X-Forwarded-For</code>, <code>X-Forwarded-Proto</code> and{' '}
          <code>X-Forwarded-Host</code></strong>, with the proxy setting Proto and Host
          rather than passing a client&apos;s values through. Appending is fine: GioJS reads{' '}
          <code>X-Forwarded-For</code> from the right and takes the last Proto and Host
          value, the one the nearest proxy wrote (HAProxy&apos;s <code>add-header</code>{' '}
          works as well as <code>set-header</code>).
        </li>
        <li>
          <strong>Keep the <code>Host</code> header</strong> (or set{' '}
          <code>X-Forwarded-Host</code>), so the host GioJS sees is the one the browser used.
          It is still client-supplied unless the proxy only routes your own domains to
          GioJS - never base a security decision on <code>req.host</code>.
        </li>
        <li>
          <strong>Decide who sets <code>X-Request-Id</code>.</strong> GioJS adopts a valid id
          from a trusted proxy. If yours passes a client&apos;s header through instead of
          setting one (most do), make it set or strip the header, or set{' '}
          <code>accept_request_id = false</code> so GioJS generates every id.
        </li>
      </ul>
      <p>nginx (on the same machine):</p>
      <CodeBlock lang="nginx" code={`location / {
    proxy_pass         http://127.0.0.1:3000;
    proxy_set_header   Host $host;
    proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_set_header   X-Forwarded-Host $host;
    proxy_set_header   X-Request-Id $request_id;   # nginx's own id becomes GioJS's
}

# gio.toml
[server]
host = "127.0.0.1"
trusted_proxies = ["127.0.0.1", "::1"]`} />
      <p>
        Caddy&apos;s <code>reverse_proxy</code> sets all three forwarding headers and keeps{' '}
        <code>Host</code> by default, and Traefik does the same for its routers - both drop
        forwarding headers sent by untrusted clients. Neither sets an{' '}
        <code>X-Request-Id</code>, so a client&apos;s own would pass straight through: have
        Caddy set one, and have Traefik strip it (a headers middleware with{' '}
        <code>customRequestHeaders: {'{'} X-Request-Id: &quot;&quot; {'}'}</code>) or turn
        adoption off:
      </p>
      <CodeBlock lang="text" title="Caddyfile" code={`example.com {
    reverse_proxy 127.0.0.1:3000 {
        header_up X-Request-Id {http.request.uuid}
    }
}

# gio.toml - Caddy on the same host; for Traefik in Docker, trust the
# network it connects from instead, e.g. ["172.16.0.0/12"]
[server]
trusted_proxies = ["127.0.0.1", "::1"]
# accept_request_id = false   # Traefik without the strip middleware`} />
      <p>
        Cloud load balancers connect from addresses inside your network: trust that range.
        AWS ALB appends to <code>X-Forwarded-For</code>, sets <code>X-Forwarded-Proto</code>{' '}
        and keeps <code>Host</code>; Google Cloud&apos;s HTTPS load balancer appends both the
        client IP <em>and its own forwarding-rule IP</em>, so add that public IP and
        Google&apos;s proxy ranges (<code>35.191.0.0/16</code>, <code>130.211.0.0/22</code>).
        Neither sets <code>X-Request-Id</code> or <code>X-Forwarded-Host</code>, nor can
        either remove them, so a client&apos;s own values arrive as if the load balancer had
        sent them. Turn request-id adoption off, and treat the host as client-supplied:
      </p>
      <CodeBlock lang="toml" code={`# gio.toml behind AWS ALB (your VPC CIDR) or Google Cloud LB
[server]
trusted_proxies   = ["10.0.0.0/16"]
accept_request_id = false   # the LB would pass a client's X-Request-Id through`} />
      <p>
        In Kubernetes, trust the pod CIDR the ingress controller runs in. ingress-nginx sends
        an <code>X-Request-ID</code>, but it deliberately reuses one the client sent; keep{' '}
        <code>accept_request_id</code> on only if a client-chosen id is acceptable in your
        logs. Behind Cloudflare, trust Cloudflare&apos;s published IP ranges; it does not set{' '}
        <code>X-Request-Id</code> either, so turn adoption off or remove the header with a
        Transform Rule.
      </p>
      <p>
        Every response carries <code>X-Request-Id</code>, and the same id is on the server and
        worker log lines for the request - see{' '}
        <a href="/docs/observability">Observability</a>.
      </p>

      <h2 id="process-supervision">Process supervision</h2>
      <p>
        One GioJS server is two processes: the Rust server (the one your supervisor -
        systemd, Docker, Kubernetes, PM2 - starts) and the Node worker it spawns and
        restarts on its own (one worker per <a href="/docs/configuration/server"><code>[server] workers</code></a>, each
        supervised on its own). Send the server <code>SIGTERM</code> to stop: it stops
        accepting, closes idle keep-alive connections at once, lets in-flight requests
        finish (8 seconds at most), then gives every worker a few seconds to run its
        plugin shutdown hooks and exit before taking whatever is left down with it.
      </p>
      <p>
        A server that dies without that chance - <code>SIGKILL</code>, the OOM killer, a
        crash, a container runtime that kills only the main process - never leaves a
        worker behind. Each worker&apos;s stdin is a pipe the server holds open and never
        writes; the operating system closes it however the server dies, and the worker
        reads end-of-file and exits within moments (Windows uses a job object for the
        same guarantee). Launchers apply the same scheme one level up: <code>gio</code>{' '}
        and a standalone <code>run.mjs</code> start the server with a piped stdin and{' '}
        <code>GIO_EXIT_ON_STDIN_EOF=1</code>, so killing the launcher outright stops the
        server and frees the port too.
      </p>
      <div className="callout">
        In a container, run the server (or <code>run.mjs</code>) as the main process so
        your runtime&apos;s stop signal reaches it - and keep{' '}
        <code>GIO_EXIT_ON_STDIN_EOF</code> unset when you start the server binary
        directly: with stdin attached to <code>/dev/null</code> or a terminal it is
        ignored anyway, but it exists for launchers that hold the pipe.
      </div>

      <h2 id="sizing">Sizing</h2>
      <p>
        By default a server renders on one Node worker, which keeps memory low and is
        plenty for sites where most traffic is cache hits and static files - Rust serves
        those on all cores without touching Node. When renders are the bottleneck (many
        uncached or personalized pages, slow <a href="/docs/page-exports/get-server-side-props"><code>getServerSideProps</code></a>, CPU-heavy
        route handlers), run a worker pool:
      </p>
      <CodeBlock lang="toml" code={`[server]
workers = "auto"   # one per CPU core, at most 8 - or an exact count`} />
      <ul>
        <li>
          <strong>Memory.</strong> Each worker is a full Node process holding its own copy
          of your app, React and any in-memory data - budget the RSS of one worker (often
          100-200 MB, more for large apps) times the worker count, plus the Rust server.
          In a container, set the memory limit for the whole pool; <code>&quot;auto&quot;</code>{' '}
          counts the CPUs the container may use, not its memory.
        </li>
        <li>
          <strong>CPU.</strong> More workers than cores only adds memory. Leave a core for
          the Rust server when the box is busy with TLS, compression and images.
        </li>
        <li>
          <strong>State.</strong> Anything a module keeps in memory (a counter, an
          in-process cache, a rate limiter) exists once per worker. Requests from the same
          visitor can land on different workers, so keep shared state outside the process.
        </li>
        <li>
          <strong>Plugin hooks.</strong> A Node plugin&apos;s <code>onStartup</code> runs in
          every worker - N times at once - and again in each respawned worker. Move
          one-time jobs (migrations, schedulers, queue consumers) out of the server, or
          run them only where <code>GIO_WORKER_INDEX</code> is <code>&quot;0&quot;</code>{' '}
          and make them idempotent (and take a lock when several instances run).
        </li>
        <li>
          <strong>Many small instances or one big one.</strong> A pool shares one page
          cache, one image cache and one set of WebSocket rooms; separate instances each
          keep their own. Prefer a pool per machine and scale out with instances beyond it.
        </li>
      </ul>
      <p>
        <code>/_gio/metrics</code> shows each worker&apos;s requests in flight and restart
        count (<code>gio_worker_in_flight</code>, <code>gio_worker_restarts_total</code>),
        which tells you whether a pool is saturated or a worker keeps crashing. It does
        not show worker memory: <code>gio_memory_bytes</code> is the Rust server process
        alone. Measure a worker&apos;s RSS with your process tools (<code>ps</code> or{' '}
        <code>top</code> on the <code>node</code> processes under the server) once it has
        served real traffic for a while, and size the limit from the container&apos;s
        total memory under load.
      </p>

      <h2 id="multi-instance">Multi-instance deployments</h2>
      <p>
        The page cache is per-instance (in-memory LRU plus a local disk tier) - there is no
        shared cache backend yet. When running multiple instances (Kubernetes, multiple VMs),
        set <code>GIO_DEPLOYMENT_ID</code> to the same value on every instance so they agree
        on the deployment ID. By default the ID is derived from the app&apos;s content (the
        client build each instance produces at startup, the app&apos;s server-side sources
        and the gio.toml settings pages render with), so identical builds already agree - pinning it explicitly protects you
        when pods roll out at different times:
      </p>
      <CodeBlock lang="bash" code={`GIO_DEPLOYMENT_ID=release-2026-09-06`} />
      <p>
        A browser still running the previous deployment&apos;s code gets a <code>409</code>{' '}
        on its next client navigation and reloads into the new build. If your rollout keeps
        the old client chunks reachable (a CDN in front), <code>[server] skew_protection =
        false</code> ignores the old id instead, so those pages keep navigating without a
        reload (startup logs a warning).
      </p>
    </>
  );
}
