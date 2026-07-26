'use strict';
const { existsSync } = require('fs');
const { join, dirname } = require('path');

const EXT = process.platform === 'win32' ? '.exe' : '';

// Alpine and other musl distros need the musl build; a glibc binary fails
// there with a confusing loader error. process.report exposes the runtime
// libc without shelling out (no glibcVersionRuntime on linux = musl).
function isMusl() {
  if (process.platform !== 'linux') return false;
  try {
    return !process.report.getReport().header.glibcVersionRuntime;
  } catch (_) {
    return false;
  }
}

const key = `${process.platform}-${process.arch}${isMusl() ? '-musl' : ''}`;

const PLATFORM_PACKAGES = {
  'linux-x64':      '@gio.js/server-linux-x64',
  'linux-x64-musl': '@gio.js/server-linux-x64-musl',
  'linux-arm64':    '@gio.js/server-linux-arm64',
  'win32-x64':      '@gio.js/server-win32-x64',
  'darwin-x64':     '@gio.js/server-darwin-x64',
  'darwin-arm64':   '@gio.js/server-darwin-arm64',
};

function findBinary() {
  const pkgName = PLATFORM_PACKAGES[key];

  if (pkgName) {
    try {
      const pkgDir = dirname(require.resolve(`${pkgName}/package.json`));
      const bin = join(pkgDir, 'bin', `giojs-server${EXT}`);
      if (existsSync(bin)) return bin;
    } catch (_) {}
  }

  // Monorepo dev fallback: packages/giojs/bin/ -> ../../../target/debug/
  const devBin = join(__dirname, '..', '..', '..', 'target', 'debug', `giojs-server${EXT}`);
  if (existsSync(devBin)) return devBin;

  const hint = pkgName
    ? `npm install ${pkgName}`
    : `No pre-built binary available for platform: ${key}`;
  throw new Error(`GioJS: no binary found for your platform (${key}).\n  Try: ${hint}`);
}

module.exports = { path: findBinary() };
