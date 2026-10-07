import React from 'react';
import { CodeBlock } from '../../../../components/CodeBlock.tsx';

export const revalidate = false;

export default function Page(): React.JSX.Element {
  return (
    <>
      <div className="docs-eyebrow">Guides</div>
      <h1>Deploying with Docker</h1>
      <p className="page-subtitle">
        A small production image built from <code>gio build standalone</code>: only Node and
        one folder, running as an unprivileged user with a health check.
      </p>

      <CodeBlock lang="bash" code={`npm create giojs@latest my-app -- --docker   # a new app
npx create-giojs add docker                    # an existing app

docker compose up --build                      # → http://localhost:3000`} />

      <h2>The Dockerfile</h2>
      <p>
        The build stage installs every dependency, runs <code>npm run build</code> (the
        typecheck, plus the Tailwind build when that feature is on) and packs the app with{' '}
        <a href="/docs/standalone"><code>gio build standalone</code></a>: the Rust server, the
        whole Node side bundled into <code>worker.js</code>, prebuilt client assets,{' '}
        <code>public/</code> and <code>gio.toml</code>. The runtime stage copies only that
        folder into a slim Node image - no <code>node_modules</code>, no build tools.
      </p>
      <CodeBlock lang="dockerfile" code={`ARG NODE_VERSION=22

FROM node:\${NODE_VERSION}-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY . .
RUN npm run build && npx gio build standalone --out standalone
# Migrations (drizzle/) are read at runtime: ship them next to the server.
RUN if [ -d drizzle ]; then cp -R drizzle standalone/drizzle; fi

FROM node:\${NODE_VERSION}-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \\
    GIO_HOST=0.0.0.0 \\
    PORT=3000
COPY --from=build /app/standalone ./
# Writable by the app: the page cache and IPC sockets (.gio) and data/.
RUN mkdir -p .gio data && chown -R node:node .gio data
USER node
EXPOSE 3000
# /_gio/health answers 200 whenever the Rust server is up; nodeReady says
# whether a Node worker is too (false while every worker is restarting).
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \\
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/_gio/health').then((r) => r.json()).then((health) => process.exit(health.nodeReady === true ? 0 : 1), () => process.exit(1))"]
CMD ["node", "run.mjs"]`} />
      <ul>
        <li>
          The install lines follow your package manager (pnpm, yarn and bun through corepack or
          npm); the version shown is npm&apos;s.
        </li>
        <li>
          <code>GIO_HOST=0.0.0.0</code> makes the server listen on the container&apos;s
          interface and <code>PORT</code> sets the port; both override <code>gio.toml</code>.
        </li>
        <li>
          The app files stay owned by root, so the process cannot modify its own code. It can
          write only where the server needs to: <code>.gio/</code> (page cache, IPC sockets)
          and <code>data/</code> (SQLite, uploads).
        </li>
        <li>
          The health check calls <code>/_gio/health</code>, which the Rust server answers with{' '}
          <code>200</code> as long as it runs. The check passes only when its{' '}
          <code>nodeReady</code> field is <code>true</code> - a Node worker is up - so a
          container whose worker keeps crashing is reported unhealthy, not healthy.
        </li>
        <li>
          The server binary comes from the <code>@gio.js/server-&lt;platform&gt;</code> package
          the build stage installs, and no <code>linux-arm64</code> build is published yet: on
          ARM machines (Apple Silicon) build for <code>linux/amd64</code> -{' '}
          <code>docker build --platform linux/amd64 .</code>, or the{' '}
          <code>platform</code> line in <code>docker-compose.yml</code>.
        </li>
      </ul>

      <h2>docker-compose.yml</h2>
      <CodeBlock lang="text" code={`services:
  app:
    build: .
    image: my-app
    platform: linux/amd64
    ports:
      - "3000:3000"
    environment:
      PORT: 3000
    env_file:
      - path: .env.production.local
        required: false
    volumes:
      - app-data:/app/data
    restart: unless-stopped

volumes:
  app-data:`} />
      <p>
        Server secrets such as <code>GIO_SESSION_SECRET</code> go in{' '}
        <code>.env.production.local</code>: compose passes it to the container, and both{' '}
        <code>.gitignore</code> and <code>.dockerignore</code> keep it out of git and out of
        the image. The standalone folder carries no <code>.env</code> files, so runtime
        variables always come from the environment. <code>GIO_PUBLIC_*</code> values are the
        exception: they are inlined into the client bundles at build time, from the build
        context&apos;s <code>.env</code> / <code>.env.production</code>.
      </p>
      <p>
        The <code>app-data</code> volume keeps <code>data/</code> - the SQLite database of the{' '}
        <a href="/docs/guides/database">database feature</a> - across rebuilds.
      </p>

      <h2>Without compose</h2>
      <CodeBlock lang="bash" code={`docker build -t my-app .
docker run -p 3000:3000 --env-file .env.production.local -v my-app-data:/app/data my-app`} />
      <p>
        Behind a reverse proxy or load balancer, list it in <code>[server] trusted_proxies</code>{' '}
        so client IPs and rate limits see the real visitor (see{' '}
        <a href="/docs/deployment">Deployment</a>).
      </p>
    </>
  );
}
