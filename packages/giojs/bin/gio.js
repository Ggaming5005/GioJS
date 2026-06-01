#!/usr/bin/env node
'use strict';
const { execFileSync } = require('child_process');
const { existsSync } = require('fs');
const { join, dirname } = require('path');
const { path } = require('./find-binary');

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
