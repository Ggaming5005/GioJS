# Docker Deployment

Run GioJS as a container. There is no build step for the app itself - route discovery and client bundles happen at server startup, so the image only needs the `giojs-server` binary, your app files, and the Node dependencies.

## Dockerfile (app scaffolded with `create-giojs`)

Apps that depend on the published `@gio.js/server` package get the Rust binary from npm (platform packages), so the whole image is a Node image:

```dockerfile
FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package.json gio.toml ./
COPY app/ ./app/
COPY public/ ./public/

EXPOSE 3000

CMD ["npx", "giojs-server"]
```

## Dockerfile (building from the GioJS source tree)

If you deploy from a checkout of the GioJS monorepo, build the Rust binary yourself. Note that `@gio.js/core` ships no `dist/` - the Node worker runs straight from `src/` via `tsx`, so the runtime image copies `src/` and the installed `node_modules`:

```dockerfile
# Build stage: Rust binary
FROM rust:1.78 AS rust-builder
WORKDIR /app
COPY crates/ ./crates/
COPY Cargo.toml Cargo.lock ./
RUN cargo build --release -p giojs-server

# Dependency stage: Node modules for the SSR worker (no compile step)
FROM node:20-slim AS node-deps
WORKDIR /app
COPY packages/ ./packages/
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable pnpm && pnpm install --frozen-lockfile --prod

# Runtime image - Node 20+ is required for the SSR worker
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production

# Compiled Rust binary
COPY --from=rust-builder /app/target/release/giojs-server ./giojs-server

# Node worker source + dependencies. The server's default worker path is
# packages/giojs-core/src/index.ts relative to the working directory.
COPY --from=node-deps /app/packages/giojs-core ./packages/giojs-core
COPY --from=node-deps /app/node_modules ./node_modules
COPY app/ ./app/
COPY public/ ./public/
COPY gio.toml ./

EXPOSE 3000

CMD ["./giojs-server"]
```

## Build and run

```bash
# Build the image
docker build -t my-app:latest .

# Run (basic)
docker run -p 3000:3000 my-app:latest

# Run with environment overrides
docker run \
  -p 3000:3000 \
  -e GIO_DEPLOYMENT_ID=release-abc123 \
  my-app:latest
```

The listen port comes from the `[server]` section of `gio.toml` (default `3000`) - there is no `PORT` environment variable.

## docker-compose.yml

```yaml
version: '3.9'

services:
  app:
    build: .
    image: my-app:latest
    ports:
      - "3000:3000"
    environment:
      NODE_ENV: production
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:3000/_gio/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 3
      start_period: 15s
```

```bash
# Start all services
docker compose up -d

# Follow logs
docker compose logs -f app

# Stop all services
docker compose down
```

## Running multiple containers

Each container keeps its own page cache (memory + disk). There is no shared cache across containers yet - cross-instance cache coherence is on the roadmap. When running replicas of the same build behind a load balancer, set `GIO_DEPLOYMENT_ID` to the same value (e.g. the release SHA) on every container so caches and version-skew detection agree.

## Environment variable reference

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | Runtime mode (`development` enables dev mode) | production behavior |
| `GIO_APP_DIR` | Path to the `app/` directory | `app` |
| `GIO_DEPLOYMENT_ID` | Pin the deployment ID across replicas | content-derived from the build |
| `GIO_SOCKET_PATH` | IPC socket path | per-instance `.gio/ipc-<pid>-<rand>.sock` |
| `RUST_LOG` | Rust log level (`info`, `debug`, `trace`) | `info` |

## .dockerignore

```
target/
node_modules/
.git/
.gio/
*.log
```
