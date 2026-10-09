'use strict';
/**
 * giojs/bin/lib/project.js
 *
 * Where things are: the project root and app/, installed package versions,
 * @gio.js/core's sources and tsx (the commands that run TypeScript), and the
 * user's package manager. Packages are found by walking node_modules
 * upwards rather than require.resolve('<pkg>/package.json'): @gio.js/react's
 * exports map does not expose its package.json.
 */
const { existsSync, readFileSync, realpathSync, statSync } = require('fs');
const { dirname, join, resolve } = require('path');

/** The project root and its app/ directory (GIO_APP_DIR, else ./app). */
function projectPaths(env = process.env, cwd = process.cwd()) {
  const appDir = env.GIO_APP_DIR ? resolve(cwd, env.GIO_APP_DIR) : join(cwd, 'app');
  return { projectRoot: dirname(appDir), appDir };
}

/**
 * `env` for a tsx child that compiles app code, with TSX_TSCONFIG_PATH set
 * to the project's own tsconfig.json (else jsconfig.json) - as the server
 * sets it on its worker (ipc.rs worker_tsconfig). tsx otherwise reads the
 * tsconfig of the cwd, so a command run from outside the project (with
 * GIO_APP_DIR) compiled the app with another project's settings, or none:
 * a starter page without a React import failed with `React is not
 * defined`. A TSX_TSCONFIG_PATH already in `env` wins.
 */
function tsxEnv(env, projectRoot) {
  if (env.TSX_TSCONFIG_PATH) return env;
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const candidate = resolve(projectRoot, name);
    let isFile = false;
    try {
      isFile = statSync(candidate).isFile();
    } catch (_) {
      // Missing: try the next name.
    }
    if (isFile) return { ...env, TSX_TSCONFIG_PATH: candidate };
  }
  return env;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (_) {
    return null;
  }
}

function realpathOr(path) {
  try {
    return realpathSync(path);
  } catch (_) {
    return path;
  }
}

/**
 * The installed copy of `name` visible from any of `fromDirs` (Node's lookup:
 * each directory's node_modules, then its parents'), as { dir, version }.
 */
function findPackage(name, fromDirs) {
  for (const start of fromDirs) {
    let dir = realpathOr(start);
    for (;;) {
      const candidate = join(dir, 'node_modules', name, 'package.json');
      const pkg = existsSync(candidate) ? readJson(candidate) : null;
      if (pkg) return { dir: realpathOr(dirname(candidate)), version: pkg.version || null };
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

/** This package's (@gio.js/server's) package.json. */
function ownPackage() {
  return readJson(join(__dirname, '..', '..', 'package.json')) || {};
}

/**
 * @gio.js/core's directory: installed next to @gio.js/server (or in the
 * project), else the GioJS repository's packages/giojs-core.
 */
function findCoreDir(projectRoot = process.cwd()) {
  const found = findPackage('@gio.js/core', [join(__dirname, '..', '..'), projectRoot]);
  if (found) return found.dir;
  const workspace = join(__dirname, '..', '..', '..', 'giojs-core');
  return existsSync(join(workspace, 'package.json')) ? workspace : null;
}

/** tsx's CLI, which runs @gio.js/core's TypeScript entry points. */
function findTsxCli(coreDir, projectRoot = process.cwd()) {
  const dirs = [projectRoot, coreDir].filter(Boolean);
  const found = findPackage('tsx', dirs);
  if (found) {
    const cli = join(found.dir, 'dist', 'cli.mjs');
    if (existsSync(cli)) return cli;
  }
  return null;
}

/**
 * The package manager running us (npm_config_user_agent, set by every
 * `<pm> run` and `<pm> exec`), else the one whose lockfile the project has.
 */
function detectPackageManager(env = process.env, projectRoot = process.cwd(), exists = existsSync) {
  const agent = /^(npm|pnpm|yarn|bun)\/(\S+)/.exec(env.npm_config_user_agent || '');
  if (agent) return { name: agent[1], version: agent[2] };
  const lockfiles = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
    ['package-lock.json', 'npm'],
  ];
  for (const [file, name] of lockfiles) {
    if (exists(join(projectRoot, file))) return { name, version: null };
  }
  return { name: 'npm', version: null };
}

module.exports = {
  projectPaths,
  tsxEnv,
  readJson,
  findPackage,
  ownPackage,
  findCoreDir,
  findTsxCli,
  detectPackageManager,
};
