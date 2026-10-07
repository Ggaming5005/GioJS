'use strict';
/**
 * giojs/bin/lib/routes.js
 *
 * `gio routes` and `gio typegen`: run @gio.js/core's routes-cli.ts through
 * tsx (route discovery is TypeScript and imports route.ts files), read its
 * `GIO_RESULT <json>` line, and print it. Neither starts the Rust server, so
 * both work without a platform binary. Anything else the child prints on
 * stdout (a route module's console.log) is passed on to stderr, keeping
 * `gio routes --json` parseable.
 */
const { spawnSync } = require('child_process');
const { existsSync } = require('fs');
const { join } = require('path');
const { findCoreDir, findTsxCli, projectPaths } = require('./project');

const RESULT_MARKER = 'GIO_RESULT ';

/** Run routes-cli.ts `command`; returns the parsed result or exits 1. */
function runRoutesCli(command) {
  const coreDir = findCoreDir();
  const entry = coreDir && join(coreDir, 'src', 'routes-cli.ts');
  if (!entry || !existsSync(entry)) {
    console.error(`gio ${command}: @gio.js/core is not installed (or predates \`gio ${command}\`).\n` +
      '  Install it next to @gio.js/server: npm install @gio.js/core');
    process.exit(1);
  }
  const tsxCli = findTsxCli(coreDir);
  if (!tsxCli) {
    console.error(`gio ${command}: tsx not found (a dependency of @gio.js/core). Run your package manager's install.`);
    process.exit(1);
  }
  const { appDir } = projectPaths();
  const result = spawnSync(process.execPath, [tsxCli, entry, command], {
    env: { ...process.env, GIO_APP_DIR: appDir },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  });
  let parsed = null;
  const passthrough = [];
  for (const line of (result.stdout || '').split(/\r?\n/)) {
    if (line.startsWith(RESULT_MARKER)) {
      try {
        parsed = JSON.parse(line.slice(RESULT_MARKER.length));
      } catch (_) {
        parsed = null;
      }
    } else if (line.length > 0) {
      passthrough.push(line);
    }
  }
  if (passthrough.length > 0) process.stderr.write(`${passthrough.join('\n')}\n`);
  if (result.status !== 0 || parsed === null) {
    if (result.error) console.error(`gio ${command}: ${result.error.message}`);
    process.exit(1);
  }
  return parsed;
}

const KIND_LABELS = { page: 'page', route: 'route', websocket: 'websocket', metadata: 'metadata' };

/** "app/posts/layout.tsx" -> "app/posts/" (the folder says it all in a table). */
function folderOf(file) {
  return file.slice(0, file.lastIndexOf('/') + 1);
}

function formatTable(headers, rows) {
  const widths = headers.map((_, column) =>
    Math.max(...[headers, ...rows].map((row) => String(row[column]).length)));
  return [headers, ...rows]
    .map((row) => row.map((cell, column) => String(cell).padEnd(widths[column])).join('  ').trimEnd())
    .join('\n');
}

/** The human-readable `gio routes` output. */
function formatRoutes(table) {
  const routes = table.routes || [];
  if (routes.length === 0) {
    return 'No routes found. Pages are app/**/page.tsx files; route handlers app/**/route.ts.';
  }
  const rows = routes.map((route) => {
    const kind = route.kind === 'route'
      ? `route ${route.loadError ? '(failed to load)' : route.methods.join(',')}`
      : KIND_LABELS[route.kind] || route.kind;
    const wraps = [];
    if (route.layouts.length > 0) wraps.push(`layout ${route.layouts.map(folderOf).join(' > ')}`);
    if (route.loading) wraps.push(`loading ${folderOf(route.loading)}`);
    if (route.error) wraps.push(`error ${folderOf(route.error)}`);
    if (route.notFound) wraps.push(`not-found ${folderOf(route.notFound)}`);
    return [route.pattern, kind, route.file, wraps.join('  ')];
  });
  const lines = [formatTable(['Route', 'Type', 'File', 'Wrapped by'], rows), ''];
  const dynamic = routes.filter((route) => route.params.length > 0).length;
  lines.push(`${routes.length} route${routes.length === 1 ? '' : 's'}, ${dynamic} dynamic` +
    '   (:param one segment, *param catch-all, *param? optional catch-all)');
  for (const route of routes.filter((r) => r.loadError)) {
    lines.push(`! ${route.file} failed to load - the server skips its handlers: ${route.loadError}`);
  }
  return lines.join('\n');
}

function runRoutes({ json }) {
  const table = runRoutesCli('routes');
  if (json) console.log(JSON.stringify({ routes: table.routes }, null, 2));
  else console.log(formatRoutes(table));
}

function runTypegen() {
  const result = runRoutesCli('typegen');
  const count = result.patterns.length;
  const what = `${count} route${count === 1 ? '' : 's'}`;
  console.log(result.wrote
    ? `gio typegen: wrote ${result.path} (${what})`
    : `gio typegen: ${result.path} is up to date (${what})`);
}

module.exports = { formatRoutes, runRoutes, runTypegen };
