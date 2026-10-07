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
 * create-giojs releases from before a subcommand treat an unknown first
 * argument as the name of a new project - `create-giojs add` would scaffold
 * an app into ./add - so a subcommand is only invoked after its help output
 * shows it exists.
 */
const { spawnSync } = require('child_process');
const { existsSync } = require('fs');
const { join } = require('path');
const { detectPackageManager, findPackage, ownPackage, projectPaths } = require('./project');

function localCreateGiojs(projectRoot) {
  const found = findPackage('create-giojs', [projectRoot, join(__dirname, '..', '..')]);
  const candidates = [];
  if (found) candidates.push(join(found.dir, 'dist', 'index.js'));
  candidates.push(join(__dirname, '..', '..', '..', 'giojs-cli', 'dist', 'index.js'));
  const entry = candidates.find((candidate) => existsSync(candidate));
  return entry ? { command: process.execPath, args: [entry], label: entry, shell: false } : null;
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

/** Quote for cmd.exe when the command runs through a shell. */
function shellQuote(arg) {
  return /^[\w@./:=-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`;
}

function run(runner, args, stdio) {
  const allArgs = [...runner.args, ...args];
  return spawnSync(runner.shell ? `${runner.command} ${allArgs.map(shellQuote).join(' ')}` : runner.command,
    runner.shell ? [] : allArgs,
    { stdio, encoding: stdio === 'inherit' ? undefined : 'utf8', shell: runner.shell });
}

/** Whether `helpText` (create-giojs --help) lists `subcommand`. */
function supportsSubcommand(helpText, subcommand) {
  return new RegExp(`(^|\\s)${subcommand}(\\s|$)`, 'm').test(helpText || '');
}

function delegate(subcommand, args) {
  const { projectRoot } = projectPaths();
  const version = ownPackage().version;
  const local = localCreateGiojs(projectRoot);
  const runner = local || execCommand(detectPackageManager(process.env, projectRoot).name, version);
  // A download may follow; say what is being fetched and run.
  if (!local) console.error(`gio ${subcommand}: create-giojs is not installed, running ${runner.label}`);

  const help = run(runner, ['--help'], ['ignore', 'pipe', 'pipe']);
  if (help.error || help.status !== 0) {
    console.error(`gio ${subcommand}: could not run create-giojs (${runner.label})` +
      `${help.error ? `: ${help.error.message}` : ''}.\n` +
      `  Install it and retry: npm install --save-dev create-giojs@${version}`);
    process.exit(1);
  }
  if (!supportsSubcommand(help.stdout, subcommand)) {
    console.error(`gio ${subcommand}: this create-giojs (${runner.label}) has no \`${subcommand}\` command.\n` +
      `  It arrives with a newer release: npm install --save-dev create-giojs@latest`);
    process.exit(1);
  }
  const result = run(runner, [subcommand, ...args], 'inherit');
  process.exit(result.status == null ? 1 : result.status);
}

module.exports = { delegate, execCommand, supportsSubcommand, shellQuote };
