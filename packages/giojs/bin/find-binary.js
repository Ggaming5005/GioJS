'use strict';
/**
 * giojs/bin/find-binary.js
 *
 * Locates the giojs-server binary: GIO_SERVER_BIN, else the platform package
 * @gio.js/server installed as an optional dependency, else a cargo build in
 * the GioJS repository itself. When none is found, missingBinaryMessage()
 * explains which package this platform needs, how to install it and why it
 * is usually missing - never a stack trace.
 *
 * `require('./find-binary').path` (standalone.mjs, @gio.js/core's testing
 * kit) still resolves on access and throws, with that message, when there
 * is no binary.
 */
const { existsSync, readFileSync } = require('fs');
const { join, dirname } = require('path');

const PLATFORM_PACKAGES = {
  'linux-x64':      '@gio.js/server-linux-x64',
  'linux-x64-musl': '@gio.js/server-linux-x64-musl',
  'linux-arm64':    '@gio.js/server-linux-arm64',
  'win32-x64':      '@gio.js/server-win32-x64',
  'darwin-x64':     '@gio.js/server-darwin-x64',
  'darwin-arm64':   '@gio.js/server-darwin-arm64',
};

// Platforms with a package name reserved but nothing published yet.
const UNPUBLISHED = new Set(['linux-arm64']);

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

function platformKey(platform = process.platform, arch = process.arch, musl = isMusl()) {
  return `${platform}-${arch}${musl ? '-musl' : ''}`;
}

function readVersion(packageJsonPath) {
  try {
    return JSON.parse(readFileSync(packageJsonPath, 'utf8')).version || null;
  } catch (_) {
    return null;
  }
}

function defaultResolvePackage(name) {
  try {
    return dirname(require.resolve(`${name}/package.json`));
  } catch (_) {
    return null;
  }
}

/**
 * Where the binary is, or why there is none:
 *   { found: true, path, source: 'env' | 'package' | 'workspace', key, packageName, version }
 *   { found: false, reason: 'env-missing' | 'not-installed' | 'empty-package'
 *       | 'unpublished' | 'unsupported', key, packageName, path? }
 * Every input is injectable so tests can describe any platform.
 */
function locateBinary(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const key = options.key || platformKey(platform, options.arch || process.arch,
    options.musl === undefined ? isMusl() : options.musl);
  const resolvePackage = options.resolvePackage || defaultResolvePackage;
  const exists = options.exists || existsSync;
  const workspaceRoot = options.workspaceRoot === undefined
    ? join(__dirname, '..', '..', '..')
    : options.workspaceRoot;
  const ext = platform === 'win32' ? '.exe' : '';
  const packageName = PLATFORM_PACKAGES[key] || null;

  if (env.GIO_SERVER_BIN) {
    const path = env.GIO_SERVER_BIN;
    if (!exists(path)) return { found: false, reason: 'env-missing', key, packageName, path };
    return { found: true, path, source: 'env', key, packageName: null, version: null };
  }

  let emptyPackage = null;
  if (packageName) {
    const packageDir = resolvePackage(packageName);
    if (packageDir) {
      const path = join(packageDir, 'bin', `giojs-server${ext}`);
      if (exists(path)) {
        const version = readVersion(join(packageDir, 'package.json'));
        return { found: true, path, source: 'package', key, packageName, version };
      }
      emptyPackage = path;
    }
  }

  // The GioJS repository: packages/giojs/bin/ -> ../../../target/<profile>/
  if (workspaceRoot) {
    for (const profile of ['debug', 'release']) {
      const path = join(workspaceRoot, 'target', profile, `giojs-server${ext}`);
      if (exists(path)) return { found: true, path, source: 'workspace', key, packageName: null, version: null };
    }
    if (exists(join(workspaceRoot, 'crates', 'giojs-server', 'Cargo.toml'))) {
      return { found: false, reason: 'workspace-unbuilt', key, packageName };
    }
  }

  if (emptyPackage) return { found: false, reason: 'empty-package', key, packageName, path: emptyPackage };
  if (!packageName) return { found: false, reason: 'unsupported', key, packageName };
  if (UNPUBLISHED.has(key)) return { found: false, reason: 'unpublished', key, packageName };
  return { found: false, reason: 'not-installed', key, packageName };
}

const BUILD_FROM_SOURCE =
  '  Build it from source (Rust 1.89+) and point GIO_SERVER_BIN at it:\n' +
  '    git clone https://github.com/Ggaming5005/GioJS && cd GioJS\n' +
  '    cargo build --release -p giojs-server\n' +
  '    export GIO_SERVER_BIN=$PWD/target/release/giojs-server';

/** Optional-dependency install command for the user's package manager. */
function installOptionalCommand(spec, packageManager) {
  switch (packageManager) {
    case 'pnpm': return `pnpm add --save-optional ${spec}`;
    case 'yarn': return `yarn add --optional ${spec}`;
    case 'bun': return `bun add --optional ${spec}`;
    default: return `npm install --save-optional ${spec}`;
  }
}

/** The explanation for a `found: false` result, ready to print. */
function missingBinaryMessage(result, options = {}) {
  const version = options.version || null;
  const spec = result.packageName ? `${result.packageName}${version ? `@${version}` : ''}` : '';
  const install = spec ? installOptionalCommand(spec, options.packageManager) : '';
  switch (result.reason) {
    case 'env-missing':
      return `gio: GIO_SERVER_BIN points at ${result.path}, which does not exist.\n` +
        '  Fix the path, or unset GIO_SERVER_BIN to use the installed platform package.';
    case 'unsupported':
      return `gio: GioJS has no prebuilt server binary for this platform (${result.key}).\n` +
        `  Prebuilt: ${Object.keys(PLATFORM_PACKAGES).filter((key) => !UNPUBLISHED.has(key)).join(', ')}.\n` +
        `${BUILD_FROM_SOURCE}\n` +
        '  or run the app in a linux-x64 container (Docker).';
    case 'unpublished':
      return `gio: the server binary for ${result.key} (${result.packageName}) is not published yet.\n` +
        `${BUILD_FROM_SOURCE}\n` +
        '  or run the app in a linux-x64 container (Docker).';
    case 'workspace-unbuilt':
      return 'gio: the server binary is not built (running from the GioJS repository).\n' +
        '  Build it: cargo build -p giojs-server\n' +
        '  or point GIO_SERVER_BIN at a giojs-server binary (e.g. under CARGO_TARGET_DIR).';
    case 'empty-package':
      return `gio: ${result.packageName} is installed but has no binary at ${result.path}.\n` +
        '  The install was interrupted or a postinstall cleanup removed it. Reinstall it:\n' +
        `    ${install}`;
    default:
      return `gio: the GioJS server binary for ${result.key} is not installed.\n\n` +
        `  Install it:  ${install}\n\n` +
        `  @gio.js/server ships its Rust binary in ${result.packageName}, an optional\n` +
        '  dependency picked by OS and CPU. It is usually missing because:\n' +
        '    - optional dependencies were skipped (--no-optional, --omit=optional,\n' +
        '      or omit=optional in .npmrc)\n' +
        '    - the lockfile was written on another OS and left this platform out:\n' +
        '      delete node_modules and the lockfile, then install again\n' +
        '    - node_modules was copied from another machine or OS\n' +
        '  Or point GIO_SERVER_BIN at a giojs-server binary you built.';
  }
}

function ownVersion() {
  return readVersion(join(__dirname, '..', 'package.json'));
}

module.exports = {
  PLATFORM_PACKAGES,
  platformKey,
  locateBinary,
  missingBinaryMessage,
  installOptionalCommand,
};

// Lazy, so requiring this module for the helpers above never throws.
Object.defineProperty(module.exports, 'path', {
  enumerable: true,
  get() {
    const result = locateBinary();
    if (result.found) return result.path;
    const error = new Error(missingBinaryMessage(result, { version: ownVersion() }));
    error.code = 'GIO_BINARY_NOT_FOUND';
    throw error;
  },
});
