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

const { path } = require('./find-binary');

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

const env = Object.assign({}, process.env);
const nodeScript = findNodeScript();
if (nodeScript) env.GIO_NODE_SCRIPT = nodeScript;

try {
  execFileSync(path, process.argv.slice(2), { stdio: 'inherit', env });
} catch (err) {
  if (err.status != null) process.exit(err.status);
  throw err;
}
