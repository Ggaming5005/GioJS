import React from 'react';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Deployment &amp; Operations</div>
      <h1>Deploying</h1>
      <p className="page-subtitle">
        Step-by-step recipes for Docker, Fly.io, Railway, Render, and a plain Linux server
        behind nginx or Caddy.
      </p>

      <p>
        A GioJS server is one Rust binary that supervises its Node render worker(s). It
        needs Node 20 or newer on the host and nothing else: no CDN, no separate image
        service, no build server. There are two ways to ship it:
      </p>
      <ul>
        <li>
          <strong>A standalone folder</strong> (recommended for containers and platforms).{' '}
          <code>gio build standalone</code> packages the server binary, your whole Node side
          bundled into one <code>worker.js</code>, the prebuilt client chunks and{' '}
          <code>public/</code> into <code>./standalone</code>. It runs with{' '}
          <code>node run.mjs</code> - no <code>node_modules</code>, no{' '}
          <code>npm install</code> on the host. See <a href="/docs/standalone">Standalone Deploys</a>.
        </li>
        <li>
          <strong>From source.</strong> Copy the project, <code>npm ci --omit=dev</code>, and{' '}
          <code>npm start</code>. There is no build step: routes are discovered and client
          bundles built when the server starts, and <code>npm update</code> stays your
          upgrade path.
        </li>
      </ul>
      <p>Whichever you pick, the same few facts drive every recipe below:</p>
      <ul>
        <li>
          <strong>Production mode</strong> is anything but <code>NODE_ENV=development</code>.{' '}
          <code>npm start</code> and <code>run.mjs</code> both default to production.
        </li>
        <li>
          <strong>The port</strong> comes from <code>GIO_PORT</code>, then <code>PORT</code>{' '}
          (which Fly.io, Railway, Render, Heroku and Cloud Run set), then{' '}
          <code>[server] port</code>, then <code>3000</code>. The host defaults to{' '}
          <code>0.0.0.0</code> - keep it that way in containers.
        </li>
        <li>
          <strong>Secrets</strong> come from the environment - see{' '}
          <a href="/docs/guides/environment-variables">Environment Variables</a>.
        </li>
        <li>
          <strong>Health:</strong> <code>GET /_gio/health</code> answers 200 with JSON. The
          port only opens once the first Node worker is up, so a platform&apos;s HTTP check
          passing means the app can render.
        </li>
        <li>
          <strong>Behind a proxy</strong> (every platform here has one), set{' '}
          <code>[server] trusted_proxies</code> so rate limits and <code>req.ip</code> see
          real visitors, and <code>[security] hsts = true</code> once the site is HTTPS-only.
          See <a href="#platform-proxies">Trusting the platform&apos;s proxy</a>.
        </li>
      </ul>
      <p>
        Before going live, work through the{' '}
        <a href="/docs/guides/production-checklist">production checklist</a>.
      </p>

      <h2 id="docker">Docker</h2>
      <p>
        A two-stage image: the first stage installs dependencies and runs{' '}
        <code>gio build standalone</code>; the runtime stage is a slim Node image holding
        only the standalone folder, run as an unprivileged user.
      </p>
      <CodeBlock lang="dockerfile" code={`# Dockerfile
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx gio build standalone --out /standalone

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /standalone ./
RUN mkdir -p .gio/cache && chown node:node /app .gio/cache
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s CMD node -e "fetch('http://127.0.0.1:' + (process.env.GIO_PORT || process.env.PORT || 3000) + '/_gio/health').then(r => r.json()).then(h => process.exit(h.nodeReady ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "run.mjs"]`} />
      <CodeBlock lang="text" code={`# .dockerignore
node_modules
.git
.gio
out
standalone
.env*.local
*.log`} />
      <CodeBlock lang="bash" code={`docker build -t my-app .
docker run -p 3000:3000 --stop-timeout 20 \\
  -e GIO_SESSION_SECRET="$GIO_SESSION_SECRET" \\
  my-app`} />
      <ul>
        <li>
          <strong>Writable <code>.gio/</code>.</strong> The server keeps its page and image
          caches and its IPC sockets under <code>.gio/</code> in the folder it runs from, so
          the runtime user must own <code>/app</code>. The cache is lost with the container;
          mount a volume at <code>/app/.gio/cache</code> to keep it across restarts.
        </li>
        <li>
          <strong>Public variables are baked in.</strong> <code>GIO_PUBLIC_*</code> values are
          read during <code>gio build standalone</code> (from the build environment and the
          committed <code>.env</code> / <code>.env.production</code> files). To vary one per
          environment, declare it in the build stage (<code>ARG GIO_PUBLIC_API_URL</code>{' '}
          before the build command) and pass <code>--build-arg</code>. Server variables are read when the
          container starts; the image carries no <code>.env</code> file, and{' '}
          <code>.dockerignore</code> keeps local secrets out of the build context.
        </li>
        <li>
          <strong>Architecture.</strong> The build stage packages the server binary for the
          platform it runs on. Prebuilt binaries exist for <code>linux/amd64</code> (glibc
          and musl) but not yet for <code>linux/arm64</code>, so on an Apple Silicon Mac or an
          ARM CI runner build with <code>docker build --platform linux/amd64</code>. Keep
          both stages on the same base: an Alpine build stage packages the musl binary, which
          then needs an Alpine runtime.
        </li>
        <li>
          <strong>Stopping.</strong> <code>run.mjs</code> is PID 1 and forwards{' '}
          <code>SIGTERM</code>; the server ends open event streams (SSE and{' '}
          <code>text/event-stream</code> route handlers), drains requests and streamed downloads
          for up to 8 seconds (a download still running then is cut off, which the client sees as
          a failed transfer) and then gives the workers a few more to exit. Docker&apos;s default 10-second stop timeout can cut
          that short - use <code>--stop-timeout 20</code> (Compose:{' '}
          <code>stop_grace_period: 20s</code>).
        </li>
        <li>
          The <code>HEALTHCHECK</code> reads <code>nodeReady</code>, so a container whose
          only worker is stuck respawning reports unhealthy even though{' '}
          <code>/_gio/health</code> itself still answers 200. It assumes the port comes from{' '}
          <code>GIO_PORT</code>, <code>PORT</code> or the default - adjust it if{' '}
          <code>gio.toml</code> sets another.
        </li>
      </ul>
      <p>
        The <a href="/docs/guides/docker">Docker starter recipe</a> walks through an image
        like this one. With pnpm or Yarn, swap the lockfile and install command in the first
        stage.
      </p>
      <CodeBlock lang="yaml" code={`# docker-compose.yml
services:
  app:
    build: .
    ports:
      - "3000:3000"
    env_file: .env.production.local     # server secrets, kept out of the image
    volumes:
      - gio-cache:/app/.gio/cache
    stop_grace_period: 20s
    restart: unless-stopped
volumes:
  gio-cache:`} />

      <h2 id="fly">Fly.io</h2>
      <p>
        Fly builds the Dockerfile above and runs it on its machines; its proxy terminates
        TLS and forwards to the port in <code>fly.toml</code>. Set <code>PORT</code> to
        that same port:
      </p>
      <CodeBlock lang="toml" code={`# fly.toml
app = "my-app"
primary_region = "fra"
kill_timeout = 20   # seconds to drain before a forced stop (Fly's default is 5)

[env]
  PORT = "8080"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 1

  [[http_service.checks]]
    method = "GET"
    path = "/_gio/health"
    interval = "15s"
    timeout = "5s"
    grace_period = "20s"`} />
      <CodeBlock lang="bash" code={`fly launch --no-deploy          # creates the app; keep the fly.toml above
fly secrets set GIO_SESSION_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")"
fly deploy`} />
      <ul>
        <li>
          <strong>Keep <code>kill_timeout</code>.</strong> Fly stops a machine with{' '}
          <code>SIGINT</code>, which GioJS drains like <code>SIGTERM</code>, but force-stops
          it after 5 seconds by default - less than the drain needs (see{' '}
          <a href="#docker">Stopping</a> above), so every deploy or scale-down would cut
          requests off mid-response.
        </li>
        <li>
          Each machine has its own page cache, on a disk that is reset when the machine is
          replaced; a machine stopped by <code>auto_stop_machines</code> starts with a cold
          memory cache. Mount a <a href="https://fly.io/docs/volumes/">volume</a> at{' '}
          <code>/app/.gio/cache</code> if warm restarts matter.
        </li>
        <li>
          With several machines, purge on-demand revalidations on each one - see{' '}
          <a href="/docs/deployment#multi-instance">Multi-instance deployments</a>.
        </li>
      </ul>

      <h2 id="railway">Railway</h2>
      <p>
        Railway builds the Dockerfile in your repository and sets <code>PORT</code>{' '}
        itself. Add a <code>railway.json</code> for the health check and the shutdown grace
        period:
      </p>
      <CodeBlock lang="json" code={`{
  "$schema": "https://railway.com/railway.schema.json",
  "build": { "builder": "DOCKERFILE", "dockerfilePath": "Dockerfile" },
  "deploy": {
    "healthcheckPath": "/_gio/health",
    "restartPolicyType": "ON_FAILURE",
    "drainingSeconds": 20
  }
}`} />
      <p>
        Set <code>GIO_SESSION_SECRET</code> and your other secrets under the service&apos;s{' '}
        <em>Variables</em>, then generate a domain under <em>Settings › Networking</em>.
        Railway terminates TLS in front of the container.
      </p>
      <p>
        Keep <code>drainingSeconds</code> (or set the service variable{' '}
        <code>RAILWAY_DEPLOYMENT_DRAINING_SECONDS=20</code>): Railway sends the old
        deployment <code>SIGTERM</code> and, by default, <code>SIGKILL</code> right after it,
        which gives GioJS no time to finish in-flight requests on every deploy.
      </p>

      <h2 id="render">Render</h2>
      <p>
        Create a <em>Web Service</em> from the repository with the Docker runtime, or
        describe it in a <code>render.yaml</code> Blueprint. Render sets <code>PORT</code>{' '}
        (10000 by default) and expects the app on <code>0.0.0.0</code>, which is GioJS&apos;s
        default:
      </p>
      <CodeBlock lang="yaml" code={`# render.yaml
services:
  - type: web
    name: my-app
    runtime: docker
    healthCheckPath: /_gio/health
    envVars:
      - key: GIO_SESSION_SECRET
        generateValue: true`} />
      <p>
        Render terminates TLS and routes traffic to the service over its private network.
        The filesystem is ephemeral, so the disk cache starts empty on each deploy unless you
        attach a persistent disk at <code>/app/.gio/cache</code>. On a deploy Render sends the
        old instance <code>SIGTERM</code> and waits up to 30 seconds by default before{' '}
        <code>SIGKILL</code>, which is enough for GioJS to drain - if you set{' '}
        <code>maxShutdownDelaySeconds</code>, keep it at 20 or more.
      </p>

      <h2 id="platform-proxies">Trusting the platform&apos;s proxy</h2>
      <p>
        On every platform above, connections reach GioJS from the platform&apos;s router, not
        from visitors. Until you trust that router, all visitors share one{' '}
        <code>[[rate_limits]]</code> bucket and <code>req.ip</code> is the router&apos;s
        address. The routers append the visitor to <code>X-Forwarded-For</code> and set{' '}
        <code>X-Forwarded-Proto</code>, but they do not all document the address they connect
        from - so look once. With <code>trusted_proxies</code> empty, <code>req.ip</code> is
        the connecting address:
      </p>
      <CodeBlock lang="ts" code={`// app/api/whoami/route.ts - temporary: deploy, request it once, delete it
export function GET(req) {
  return { peer: req.ip, forwardedFor: req.headers['x-forwarded-for'] ?? null };
}`} />
      <p>
        Trust the private range that address belongs to (for example{' '}
        <code>&quot;10.0.0.0/8&quot;</code> or <code>&quot;172.16.0.0/12&quot;</code>), then
        remove the route:
      </p>
      <CodeBlock lang="toml" code={`# gio.toml
[server]
trusted_proxies = ["10.0.0.0/8"]   # the range your platform's router connects from
accept_request_id = false          # the router may pass a client's X-Request-Id through

[security]
hsts = true                        # the platform terminates TLS; send HSTS yourself`} />
      <div className="callout">
        Trusting a private range is safe only while visitors cannot reach the app from it -
        true when the platform&apos;s router is the only way in, as on the platforms above
        with their default networking. Never trust a public range your visitors can connect
        from. The <a href="/docs/deployment#client-ips">deployment reference</a> explains the exact
        rules and has settings for nginx, Caddy, Traefik, AWS, Google Cloud, Kubernetes and
        Cloudflare.
      </div>

      <h2 id="vps">A Linux server with systemd</h2>
      <p>
        On a VPS or bare metal, run the standalone folder as a systemd service behind nginx
        or Caddy, which terminate TLS. GioJS listens on <code>127.0.0.1</code> only, so
        nothing reaches it around the proxy.
      </p>

      <h3>1. Build and copy the folder</h3>
      <CodeBlock lang="bash" code={`# On your machine or in CI. From macOS or Windows, add --target linux-x64
# (after: npm i @gio.js/server-linux-x64 --force).
npx gio build standalone

# Copy it, keeping the server's cache and local env file in place
rsync -a --delete --exclude .gio/cache --exclude '.env*.local' \\
  standalone/ deploy@example.com:/srv/my-app/`} />
      <p>
        The server needs Node 20 or newer and an unprivileged user that owns the folder:
      </p>
      <CodeBlock lang="bash" code={`sudo useradd --system --home /srv/my-app --shell /usr/sbin/nologin gio
sudo chown -R gio:gio /srv/my-app`} />

      <h3>2. Configure</h3>
      <CodeBlock lang="toml" code={`# /srv/my-app/gio.toml (your project's gio.toml, copied by the build)
[server]
host = "127.0.0.1"                       # reachable only through the proxy
trusted_proxies = ["127.0.0.1", "::1"]   # the proxy runs on this machine

[security]
hsts = true                              # once the site is HTTPS-only`} />
      <CodeBlock lang="bash" code={`# /etc/my-app.env - secrets, readable by root only (systemd reads it before dropping privileges)
GIO_SESSION_SECRET=...
DATABASE_URL=postgres://...`} />
      <CodeBlock lang="bash" code={`sudo chmod 600 /etc/my-app.env`} />

      <h3>3. The systemd unit</h3>
      <CodeBlock lang="ini" code={`# /etc/systemd/system/my-app.service
[Unit]
Description=my-app (GioJS)
After=network-online.target
Wants=network-online.target

[Service]
User=gio
Group=gio
WorkingDirectory=/srv/my-app
ExecStart=/usr/bin/node /srv/my-app/run.mjs
Environment=NODE_ENV=production
EnvironmentFile=/etc/my-app.env
Restart=always
RestartSec=2
# SIGTERM to the launcher only: it stops the server, which drains requests
# and then stops its workers. Anything left after the timeout is killed.
KillMode=mixed
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/srv/my-app

[Install]
WantedBy=multi-user.target`} />
      <CodeBlock lang="bash" code={`sudo systemctl daemon-reload
sudo systemctl enable --now my-app
journalctl -u my-app -f                  # logs; GIO_LOG_FORMAT=json for a log shipper`} />
      <p>
        After each deploy, <code>sudo systemctl restart my-app</code>. The server restarts in
        a few seconds; for zero-downtime deploys run two instances on different ports behind
        the proxy and restart them one at a time.
      </p>

      <h3 id="nginx">4a. nginx</h3>
      <CodeBlock lang="nginx" code={`# /etc/nginx/sites-available/my-app
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    server_name example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name example.com;
    ssl_certificate     /etc/letsencrypt/live/example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;

    client_max_body_size 2m;   # match gio.toml [server] max_body_bytes (2 MiB default)

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;          # WebSockets
        proxy_set_header   Connection $connection_upgrade;
        proxy_set_header   Host $host;                     # CSRF and WebSocket origin checks compare against it
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_set_header   X-Forwarded-Host $host;
        proxy_set_header   X-Request-Id $request_id;       # nginx's id becomes GioJS's
        proxy_buffering    off;                            # stream SSR, SSE and streamed responses as they render
    }
}`} />
      <CodeBlock lang="bash" code={`sudo ln -s /etc/nginx/sites-available/my-app /etc/nginx/sites-enabled/
sudo certbot --nginx -d example.com      # or point the ssl_ lines at your own certificate
sudo nginx -t && sudo systemctl reload nginx`} />
      <ul>
        <li>
          Without <code>proxy_buffering off</code>, nginx holds streamed pages and
          server-sent events until they finish - the page still works, but loses the point of
          streaming.
        </li>
        <li>
          GioJS already compresses responses; leave nginx&apos;s <code>gzip</code> off for
          this location (or turn off <code>[compression]</code> in <code>gio.toml</code>{' '}
          instead - not both).
        </li>
        <li>
          This config opens a fresh upstream connection per request. If you add an{' '}
          <code>upstream</code> block with <code>keepalive</code>, keep its{' '}
          <code>keepalive_timeout</code> below 10 seconds - see{' '}
          <a href="/docs/deployment#reverse-proxy">Behind a reverse proxy</a>.
        </li>
      </ul>

      <h3 id="caddy">4b. Caddy</h3>
      <p>
        Caddy gets and renews the certificate itself, keeps <code>Host</code>, sets the
        forwarding headers and ignores spoofed ones:
      </p>
      <CodeBlock lang="text" code={`# /etc/caddy/Caddyfile
example.com {
    reverse_proxy 127.0.0.1:3000 {
        header_up X-Request-Id {http.request.uuid}   # Caddy passes a client's own id through otherwise
    }
}`} />
      <p>
        The <code>gio.toml</code> from step 2 applies unchanged. Caddy does not send HSTS on
        its own either, so keep <code>[security] hsts = true</code>.
      </p>

      <h3 id="from-source">Without a standalone build</h3>
      <p>
        To run from source instead, copy the project (without <code>node_modules</code>),
        install production dependencies on the server and point the unit at the{' '}
        <code>giojs-server</code> launcher:
      </p>
      <CodeBlock lang="bash" code={`cd /srv/my-app && npm ci --omit=dev`} />
      <CodeBlock lang="ini" code={`ExecStart=/srv/my-app/node_modules/.bin/giojs-server`} />
      <p>
        Everything else - the environment file, <code>KillMode=mixed</code>, the proxy - stays
        the same. The first start after a deploy takes a little longer while the server
        builds the client bundles.
      </p>

      <h2>Other targets</h2>
      <ul>
        <li>
          <strong>Kubernetes</strong>: Deployment, Service, Ingress and HPA manifests in{' '}
          <a href="https://github.com/Ggaming5005/GioJS/blob/main/docs/deployment/kubernetes.md">docs/deployment/kubernetes.md</a>.
          Use the Docker image above and a readiness probe on <code>/_gio/health</code>.
        </li>
        <li>
          <strong>Windows Server</strong>: run it as a service with NSSM -{' '}
          <a href="https://github.com/Ggaming5005/GioJS/blob/main/docs/deployment/windows-nssm.md">docs/deployment/windows-nssm.md</a>.
        </li>
        <li>
          <strong>Static hosts</strong> (Cloudflare Pages, GitHub Pages, Netlify, S3): when
          the site needs no server features, <a href="/docs/static-export">export it</a> to
          plain HTML instead.
        </li>
      </ul>
      <p>
        For proxies, load balancers, worker sizing, graceful shutdown and running several
        instances, see the <a href="/docs/deployment">deployment reference</a>.
      </p>
    </>
  );
}
