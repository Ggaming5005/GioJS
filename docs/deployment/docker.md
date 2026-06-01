# Docker Deployment

Run GioJS as a container. The multi-stage Dockerfile keeps the final image small by building Rust and Node separately.

## Dockerfile

```dockerfile
# Build stage: Rust binary
FROM rust:1.78 AS rust-builder
WORKDIR /app
COPY crates/ ./crates/
COPY Cargo.toml Cargo.lock ./
RUN cargo build --release -p giojs-server

# Build stage: Node dependencies + gio build
FROM node:20-slim AS node-builder
WORKDIR /app
COPY packages/ ./packages/
COPY package.json package-lock.json ./
RUN npm ci
COPY app/ ./app/
COPY gio.toml ./
RUN npm run build

# Runtime image
FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy compiled Rust binary
COPY --from=rust-builder /app/target/release/giojs-server ./giojs-server

# Copy Node worker and built assets
COPY --from=node-builder /app/packages/giojs-core/dist ./packages/giojs-core/dist
COPY --from=node-builder /app/node_modules ./node_modules
COPY --from=node-builder /app/.gio ./.gio
COPY --from=node-builder /app/app ./app

EXPOSE 3000

ENV NODE_ENV=production

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
  -e GIO_CACHE_REDIS_URL=redis://redis:6379 \
  my-app:latest
```

## docker-compose.yml

Includes an optional Redis container for multi-instance cache sharing:

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
      GIO_CACHE_REDIS_URL: redis://redis:6379
    depends_on:
      redis:
        condition: service_healthy
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://localhost:3000/_gio/health"]
      interval: 10s
      timeout: 5s
      retries: 3
      start_period: 15s

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    volumes:
      - redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5

volumes:
  redis-data:
```

```bash
# Start all services
docker compose up -d

# Follow logs
docker compose logs -f app

# Stop all services
docker compose down
```

## Environment variable reference

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | Runtime mode | `production` |
| `PORT` | HTTP listen port | `3000` |
| `GIO_CACHE_REDIS_URL` | Redis connection URL | unset (memory-only cache) |
| `GIO_SOCKET_PATH` | IPC socket path | `/tmp/giojs.sock` |
| `RUST_LOG` | Rust log level (`info`, `debug`, `trace`) | `info` |

## .dockerignore

```
target/
node_modules/
.git/
.next/
*.log
```
