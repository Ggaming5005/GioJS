/**
 * A production container built from `gio build standalone`: the build stage
 * installs everything and packs the app into standalone/ (Rust server,
 * bundled worker.js, static assets, gio.toml - see the standalone docs), and
 * the runtime stage is a slim Node image holding only that folder, run as
 * the unprivileged `node` user with a HEALTHCHECK on /_gio/health.
 *
 * The runtime image needs write access in exactly two places: .gio/ (the
 * server's page cache and IPC sockets) and data/ (SQLite, uploads); the app
 * itself stays root-owned and read-only to the process.
 */
import type { PackageManager } from '../package-manager.js';
import type { Overlay, OverlayContext } from '../types.js';

/** COPY + install lines for the build stage. */
function installLines(pm: PackageManager): string[] {
  switch (pm.name) {
    case 'pnpm':
      return [
        'COPY package.json pnpm-lock.yaml* ./',
        'RUN corepack enable pnpm && if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; else pnpm install; fi',
      ];
    case 'yarn':
      return [
        'COPY package.json yarn.lock* .yarnrc.yml* ./',
        'RUN corepack enable yarn && if [ -f yarn.lock ]; then yarn install --frozen-lockfile; else yarn install; fi',
      ];
    case 'bun':
      return [
        'COPY package.json bun.lock* ./',
        'RUN npm install -g bun && if [ -f bun.lock ]; then bun install --frozen-lockfile; else bun install; fi',
      ];
    case 'npm':
      return [
        'COPY package.json package-lock.json* ./',
        'RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi',
      ];
  }
}

export function dockerfile(ctx: OverlayContext): string {
  const pm = ctx.packageManager;
  const hasBuild = ctx.packageJson.scripts?.['build'] !== undefined;
  const build = [
    ...(hasBuild ? [pm.run('build')] : []),
    pm.exec('gio build standalone --out standalone'),
  ].join(' && ');
  return `# syntax=docker/dockerfile:1
# Production image for ${ctx.projectName}: \`gio build standalone\` packs the app
# into one folder (Rust server, bundled worker.js, static assets), so the
# runtime stage needs only Node - no node_modules, no build tools.
#
#   docker build -t ${ctx.projectName} .
#   docker run -p 3000:3000 --env-file .env.production.local ${ctx.projectName}
#
# The server binary comes from the @gio.js/server-<platform> package the build
# stage installs; there is no linux-arm64 build yet, so on ARM machines (Apple
# Silicon) build with --platform linux/amd64.

ARG NODE_VERSION=22

FROM node:\${NODE_VERSION}-slim AS build
WORKDIR /app
${installLines(pm).join('\n')}
COPY . .
RUN ${build}
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
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \\
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/_gio/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "run.mjs"]
`;
}

export const docker: Overlay = {
  name: 'docker',
  title: 'Docker',
  hint: 'a production Dockerfile (gio build standalone) + compose',
  modes: ['server'],
  templateDirs: ['docker'],
  agents:
    '- Docker: `Dockerfile` builds with `gio build standalone` and runs `node run.mjs` as the `node` user;\n' +
    '  `docker-compose.yml` passes `.env.production.local` and keeps `data/` in a volume.',
  generate: ctx => [{ path: 'Dockerfile', content: dockerfile(ctx) }],
  gitignore: ['# gio build standalone output', 'standalone/'],
  postSteps: ctx => [
    `docker compose up --build   (or: docker build -t ${ctx.projectName} .)`,
    'Server secrets go in .env.production.local (git- and docker-ignored), which docker-compose.yml passes to the container.',
  ],
};
