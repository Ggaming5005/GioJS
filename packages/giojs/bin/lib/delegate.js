'use strict';
/**
 * giojs/bin/lib/delegate.js
 *
 * `gio migrate` and `gio add` run create-giojs's subcommands of the same
 * name, so the scaffolder stays the one owner of templates and transforms.
 * The installed create-giojs is preferred (project, then next to
 * @gio.js/server, then the GioJS repository's build); otherwise
 * create-giojs@<this CLI's version> runs through the user's package manager
 * (npx / pnpm dlx / bunx), so CLI and scaffolder versions match.
 *
 * Which subcommands a create-giojs has is read from its package.json, never
 * found out by running it: releases from before a subcommand treat any
 * argument they do not know - `--help` included - as the name of a new
 * project, then scaffold it and run npm install. From the release that adds
 * a subcommand, create-giojs exports its module as create-giojs/<name>
 * (create-giojs/migrate, create-giojs/add), so a create-giojs only runs when
 * its package.json exports the subcommand: read from disk for an installed
 * copy, from the registry (`npm view`, which downloads and runs nothing) for
 * create-giojs@<version>.
 */
const { spawnSync } = require('child_process');
const { existsSync } = require('fs');
const { dirname, join } = require('path');
const { detectPackageManager, findPackage, ownPackage, projectPaths, readJson } = require('./project');

// A registry lookup is one small request; past this, report it and stop.
const REGISTRY_TIMEOUT_MS = 60_000;

/** The installed create-giojs, as a runner plus its package.json, or null. */
function localCreateGiojs(projectRoot) {
  const found = findPackage('create-giojs', [projectRoot, join(__dirname, '..', '..')]);
  const candidates = [];
  if (found) candidates.push(join(found.dir, 'dist', 'index.js'));
  candidates.push(join(__dirname, '..', '..', '..', 'giojs-cli', 'dist', 'index.js'));
  const entry = candidates.find((candidate) => existsSync(candidate));
  if (!entry) return null;
  const dir = dirname(dirname(entry));
  return {
    command: process.execPath,
    args: [entry],
    label: dir,
    shell: false,
    pkg: readJson(join(dir, 'package.json')),
  };
}

/** How to run create-giojs@`version` through `packageManager` without installing it. */
function execCommand(packageManager, version, platform = process.platform) {
  const spec = `create-giojs@${version}`;
  // npx and friends are .cmd shims on Windows, which only a shell runs.
  const shell = platform === 'win32';
  switch (packageManager) {
    case 'pnpm': return { command: 'pnpm', args: ['dlx', spec], label: `pnpm dlx ${spec}`, shell };
    case 'bun': return { command: 'bunx', args: [spec], label: `bunx ${spec}`, shell };
    default: return { command: 'npx', args: [spec], label: `npx ${spec}`, shell };
  }
}

/** The dev-dependency install command for `packageManager`. */
function installDevCommand(spec, packageManager) {
  switch (packageManager) {
    case 'pnpm': return `pnpm add --save-dev ${spec}`;
    case 'yarn': return `yarn add --dev ${spec}`;
    case 'bun': return `bun add --dev ${spec}`;
    default: return `npm install --save-dev ${spec}`;
  }
}

/** Quote for cmd.exe when the command runs through a shell. */
function shellQuote(arg) {
  return /^[\w@./:=-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`;
}

function run(runner, args, options, spawn = spawnSync) {
  const allArgs = [...runner.args, ...args];
  return spawn(runner.shell ? `${runner.command} ${allArgs.map(shellQuote).join(' ')}` : runner.command,
    runner.shell ? [] : allArgs,
    { ...options, shell: runner.shell });
}

/** Whether create-giojs's package.json (`pkg`) declares `subcommand`. */
function declaresSubcommand(pkg, subcommand) {
  const exports = pkg && pkg.exports;
  return Boolean(exports) && typeof exports === 'object' && !Array.isArray(exports) &&
    Object.prototype.hasOwnProperty.call(exports, `./${subcommand}`);
}

/**
 * Parse `npm view <spec> version exports --json`: an object when the
 * release has exports, else just the version string. Null when unreadable.
 */
function parseViewOutput(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    if (typeof value === 'string') return { version: value };
    if (value && typeof value === 'object' && !Array.isArray(value) && !value.error) return value;
  } catch (_) {
    // fall through
  }
  return null;
}

/** Why `npm view` failed, in one line (npm's E404 summary when it gave one). */
function viewFailure(result) {
  try {
    const parsed = JSON.parse(String(result.stdout || '').trim());
    if (parsed && parsed.error && parsed.error.summary) return parsed.error.summary;
  } catch (_) {
    // not JSON
  }
  const line = String(result.stderr || '').split(/\r?\n/).map((l) => l.replace(/^npm (error|ERR!)\s*/, '').trim())
    .find((l) => l && !/^code\b/.test(l));
  return line || `npm view exited with ${result.status}`;
}

/**
 * create-giojs@`version`'s package.json fields (version, exports) from the
 * registry: { ok: true, manifest } or { ok: false, reason }.
 */
function registryManifest(version, { platform = process.platform, spawn = spawnSync } = {}) {
  // npm ships with Node, whichever package manager the project uses.
  const npm = {
    command: 'npm',
    args: ['view', `create-giojs@${version}`, 'version', 'exports', '--json'],
    shell: platform === 'win32',
  };
  const result = run(npm, [], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: REGISTRY_TIMEOUT_MS,
    windowsHide: true,
  }, spawn);
  if (result.error) return { ok: false, reason: `npm could not run: ${result.error.message}` };
  if (result.status !== 0) return { ok: false, reason: viewFailure(result) };
  const manifest = parseViewOutput(result.stdout);
  return manifest ? { ok: true, manifest } : { ok: false, reason: 'the registry answer could not be read' };
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function delegate(subcommand, args) {
  const { projectRoot } = projectPaths();
  const version = ownPackage().version;
  const packageManager = detectPackageManager(process.env, projectRoot).name;
  const install = installDevCommand(`create-giojs@${version}`, packageManager);
  const local = localCreateGiojs(projectRoot);
  let runner = local;
  if (local) {
    if (!declaresSubcommand(local.pkg, subcommand)) {
      const installed = local.pkg && local.pkg.version ? `create-giojs ${local.pkg.version}` : 'create-giojs';
      fail(`gio ${subcommand}: the installed ${installed} (${local.label}) is too old for \`gio ${subcommand}\`: ` +
        `it does not export create-giojs/${subcommand}, so it was not run.\n` +
        `  Install the release that matches this CLI: ${install}`);
    }
  } else {
    runner = execCommand(packageManager, version);
    const lookup = registryManifest(version);
    if (!lookup.ok) {
      fail(`gio ${subcommand}: create-giojs is not installed and create-giojs@${version} could not be looked up ` +
        `(${lookup.reason}).\n  Install it and retry: ${install}`);
    }
    if (!declaresSubcommand(lookup.manifest, subcommand)) {
      fail(`gio ${subcommand}: create-giojs@${version} is too old for \`gio ${subcommand}\`: ` +
        `it does not export create-giojs/${subcommand}, so it was not run.\n` +
        `  It arrives with a newer release: ${installDevCommand('create-giojs@latest', packageManager)}`);
    }
    // A download may follow; say what is being fetched and run.
    console.error(`gio ${subcommand}: create-giojs is not installed, running ${runner.label}`);
  }
  const result = run(runner, [subcommand, ...args], { stdio: 'inherit' });
  if (result.error) {
    fail(`gio ${subcommand}: could not run create-giojs (${runner.label}): ${result.error.message}\n` +
      `  Install it and retry: ${install}`);
  }
  process.exit(result.status == null ? 1 : result.status);
}

module.exports = {
  delegate,
  execCommand,
  installDevCommand,
  declaresSubcommand,
  parseViewOutput,
  registryManifest,
  shellQuote,
};
