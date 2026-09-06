#!/usr/bin/env node
'use strict';
const { execFileSync, spawnSync } = require('child_process');
const { existsSync } = require('fs');
const { join, dirname } = require('path');

// `gio export` renders the app to static HTML (out/). It runs the Node
// exporter through tsx and never touches the Rust binary, so it works even
// where no platform binary is installed.
if (process.argv[2] === 'export') {
  runStaticExport();
}

// `gio bench` runs the zero-dependency load generator. bench.mjs is ESM, so
// it runs as a child node process to keep this entrypoint CJS.
if (process.argv[2] === 'bench') {
  runBench(process.argv.slice(3));
}

// `gio cache explain <url>` requests the URL and decodes the X-Gio-Cache
// header the server stamps on every response - one cache, one owner, and
// this is how you see what it did.
if (process.argv[2] === 'cache' && process.argv[3] === 'explain') {
  runCacheExplain(process.argv[4]);
} else {
  runRustServer();
}

function runBench(args) {
  const result = spawnSync(process.execPath, [join(__dirname, 'bench.mjs'), ...args], { stdio: 'inherit' });
  process.exit(result.status == null ? 1 : result.status);
}

function runCacheExplain(target) {
  if (!target) {
    console.error('usage: gio cache explain <url-or-path>   (e.g. gio cache explain /posts/1)');
    process.exit(1);
  }
  const url = target.startsWith('/') ? `http://localhost:3000${target}` : target;

  const EXPLANATIONS = {
    hit: 'Served from the Rust page cache without touching Node. "ttl" is the\n    seconds until this entry goes stale.',
    stale: 'Served instantly from the cache past its TTL while ONE background\n    render refreshes the entry (stale-while-revalidate). "age" is seconds\n    since the entry was rendered.',
    'miss; stored': 'Rendered by the Node worker and stored in the cache - the next\n    request for this key is a hit. Pages opt in via `export const revalidate`.',
    bypass: 'Rendered by the Node worker and NOT cached: the page did not declare\n    `revalidate`, the request was not GET/HEAD, the response varies per user,\n    or it set per-request headers.',
    static: 'Served directly by the Rust static file layer (public/ assets,\n    hashed chunks, fonts) - never touches the cache or Node.',
  };

  (async () => {
    let res;
    try {
      res = await fetch(url, { redirect: 'manual' });
    } catch (err) {
      console.error(`gio: could not reach ${url} - is the server running? (${err.cause?.code ?? err.message})`);
      process.exit(1);
    }
    const value = res.headers.get('x-gio-cache');
    console.log(`GET ${url}`);
    console.log(`  status       ${res.status}`);
    console.log(`  x-gio-cache  ${value ?? '(absent)'}`);
    if (value === null) {
      console.log('  → No cache header. Either this is an internal /_gio endpoint or the\n    server predates X-Gio-Cache (upgrade @gio.js/server).');
    } else {
      const key = value.startsWith('hit') ? 'hit' : value.startsWith('stale') ? 'stale' : value;
      console.log(`  → ${EXPLANATIONS[key] ?? value}`);
    }
    process.exit(0);
  })();
}

function runStaticExport() {
  let coreDir;
  try {
    coreDir = dirname(require.resolve('@gio.js/core/package.json'));
  } catch (_) {
    coreDir = join(__dirname, '..', '..', '..', 'packages', 'giojs-core');
  }
  const exportCli = join(coreDir, 'src', 'export-cli.ts');

  let tsxCli = [
    join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    join(coreDir, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
  ].find(existsSync);
  if (!tsxCli) {
    try { tsxCli = require.resolve('tsx/dist/cli.mjs', { paths: [process.cwd(), coreDir] }); } catch (_) {}
  }
  if (!tsxCli) {
    console.error('GioJS: tsx not found (required for `gio export`). Run `npm install`.');
    process.exit(1);
  }

  const env = Object.assign({}, process.env);
  env.GIO_APP_DIR = env.GIO_APP_DIR || join(process.cwd(), 'app');
  env.GIO_OUT_DIR = env.GIO_OUT_DIR || join(process.cwd(), 'out');
  const r = spawnSync(process.execPath, [tsxCli, exportCli], { stdio: 'inherit', env });
  process.exit(r.status == null ? 1 : r.status);
}

function findNodeScript() {
  // 1. Clean npm install: @gio.js/core is a sibling package
  try {
    const pkgDir = dirname(require.resolve('@gio.js/core/package.json'));
    const candidate = join(pkgDir, 'src', 'index.ts');
    if (existsSync(candidate)) return candidate;
  } catch (_) {}

  // 2. Monorepo dev fallback
  const dev = join(__dirname, '..', '..', '..', 'packages', 'giojs-core', 'src', 'index.ts');
  if (existsSync(dev)) return dev;

  return null;
}

function runRustServer() {
  const { path } = require('./find-binary');
  const env = Object.assign({}, process.env);
  const nodeScript = findNodeScript();
  if (nodeScript) env.GIO_NODE_SCRIPT = nodeScript;

  try {
    execFileSync(path, process.argv.slice(2), { stdio: 'inherit', env });
  } catch (err) {
    if (err.status != null) process.exit(err.status);
    throw err;
  }
}
