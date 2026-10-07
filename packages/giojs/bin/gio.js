#!/usr/bin/env node
'use strict';
/**
 * giojs/bin/gio.js
 *
 * The `gio` command. Each command's module loads only when that command
 * runs, so `gio --help` and friends start instantly. Help text and the
 * command table live in lib/commands.js. Exit codes: 0 success, 1 the
 * command failed, 2 usage error. The `giojs-server` bin is giojs-server.js:
 * it starts the server with no command parsing, as it always has.
 */
const { spawnSync } = require('child_process');
const { join } = require('path');
const { parseArgs } = require('util');
const { COMMANDS, HINTS, commandHelp, didYouMean, mainHelp } = require('./lib/commands');

const USAGE_ERROR = 2;

function usageError(message, command = null) {
  const help = command ? `gio ${command} --help` : 'gio --help';
  console.error(`gio: ${message}\nRun \`${help}\` for usage.`);
  process.exit(USAGE_ERROR);
}

/** Strict flag parsing for one command; a bad flag is a usage error. */
function parseFlags(command, args, options, { positionals = 0 } = {}) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: { help: { type: 'boolean', short: 'h' }, ...options },
      allowPositionals: positionals > 0,
      strict: true,
    });
  } catch (err) {
    const unknown = /^Unknown option '--([^'=]+)/.exec(err.message);
    const suggestion = unknown && didYouMean(unknown[1], ['help', ...Object.keys(options)]);
    if (unknown) {
      usageError(`unknown option "--${unknown[1]}"${suggestion ? ` - did you mean --${suggestion}?` : ''}`, command);
    }
    // Other parseArgs messages are full sentences naming the option.
    usageError(err.message.replace(/\. To specify a positional argument.*$/s, ''), command);
  }
  if (parsed.values.help) {
    console.log(commandHelp(command));
    process.exit(0);
  }
  if (parsed.positionals.length > positionals) {
    usageError(`unexpected argument "${parsed.positionals[positionals]}"`, command);
  }
  return parsed;
}

function parsePort(value, command) {
  if (value === undefined) return null;
  if (!/^\d+$/.test(value) || Number(value) > 65535) {
    usageError(`--port expects a port number (0-65535), got "${value}"`, command);
  }
  return Number(value);
}

/**
 * --host as the server reads GIO_HOST: an IPv4 address, or IPv6 in
 * brackets (`::1` and `[::1]` are both accepted and passed bracketed).
 */
function parseHost(value, command) {
  if (value === undefined) return null;
  // The server binds IP addresses only (shells set HOST to the machine's
  // name, so names are never resolved); localhost is the one obvious alias.
  if (value === 'localhost') return '127.0.0.1';
  const { isIP } = require('net');
  const bare = /^\[(.*)\]$/.exec(value);
  if (bare ? isIP(bare[1]) === 6 : isIP(value) === 4) return value;
  if (!bare && isIP(value) === 6) return `[${value}]`;
  usageError(`--host expects an IP address such as 0.0.0.0 (every interface), 127.0.0.1 (this machine only) or [::] (every IPv6 interface), got "${value}"`, command);
}

function runNodeScript(script, args, env = process.env) {
  const result = spawnSync(process.execPath, [join(__dirname, script), ...args], { stdio: 'inherit', env });
  process.exit(result.status == null ? 1 : result.status);
}

// ── commands ───────────────────────────────────────────────────────────────

function cmdServer(mode, command, args) {
  const { values } = parseFlags(command, args, {
    port: { type: 'string', short: 'p' },
    host: { type: 'string', short: 'H' },
    open: { type: 'boolean' },
  });
  require('./lib/server').runServerCommand({
    mode,
    port: parsePort(values.port, command),
    host: parseHost(values.host, command),
    open: Boolean(values.open),
  });
}

// `gio build standalone` packages the app into a self-contained deploy dir
// (Rust binary + bundled worker.js + prebuilt chunks); standalone.mjs is
// ESM, so it runs as a child node process. Plain `gio build` only explains
// that normal deploys need no build step.
function cmdBuild(args) {
  if (args[0] === 'standalone') runNodeScript('standalone.mjs', args.slice(1));
  if (args[0] === '--help' || args[0] === '-h') {
    console.log(commandHelp('build'));
    process.exit(0);
  }
  if (args.length > 0) {
    const suggestion = didYouMean(args[0], ['standalone']);
    usageError(`unknown build target "${args[0]}"${suggestion ? ` - did you mean \`gio build ${suggestion}\`?` : ''}`, 'build');
  }
  console.log('GioJS has no build step for normal deploys: `gio start` starts the server,');
  console.log('renders on demand, and caches in Rust. To package a self-contained');
  console.log('deploy directory (one folder, runs anywhere Node is installed), use:');
  console.log('');
  console.log('  gio build standalone [--out <dir>] [--target <platform>]');
  process.exit(0);
}

// `gio export` renders the app to static HTML (out/). It runs the Node
// exporter through tsx and never touches the Rust binary, so it works even
// where no platform binary is installed.
function cmdExport(args) {
  parseFlags('export', args, {});
  const { findCoreDir, findTsxCli } = require('./lib/project');
  const coreDir = findCoreDir();
  if (!coreDir) {
    console.error('gio export: @gio.js/core is not installed. Run your package manager\'s install.');
    process.exit(1);
  }
  const tsxCli = findTsxCli(coreDir);
  if (!tsxCli) {
    console.error('GioJS: tsx not found (required for `gio export`). Run `npm install`.');
    process.exit(1);
  }
  const env = Object.assign({}, process.env);
  env.GIO_APP_DIR = env.GIO_APP_DIR || join(process.cwd(), 'app');
  env.GIO_OUT_DIR = env.GIO_OUT_DIR || join(process.cwd(), 'out');
  // Same mode rule as the Rust server sets on its worker: dev iff
  // NODE_ENV=development. An unset NODE_ENV would load React's dev build,
  // which writes Suspense error messages and stacks into the exported HTML.
  env.NODE_ENV = env.NODE_ENV === 'development' ? 'development' : 'production';
  const r = spawnSync(process.execPath, [tsxCli, join(coreDir, 'src', 'export-cli.ts')], { stdio: 'inherit', env });
  process.exit(r.status == null ? 1 : r.status);
}

function cmdRoutes(args) {
  const { values } = parseFlags('routes', args, { json: { type: 'boolean' } });
  require('./lib/routes').runRoutes({ json: Boolean(values.json) });
}

function cmdTypegen(args) {
  parseFlags('typegen', args, {});
  require('./lib/routes').runTypegen();
}

async function cmdDoctor(command, args) {
  const modes = command === 'doctor' ? { dev: { type: 'boolean' }, prod: { type: 'boolean' } } : {};
  const { values } = parseFlags(command, args, { json: { type: 'boolean' }, ...modes });
  if (values.dev && values.prod) usageError('--dev and --prod cannot be combined', command);
  const doctor = require('./lib/doctor');
  if (command === 'info') await doctor.runInfo({ json: Boolean(values.json) });
  else {
    const mode = values.dev ? 'development' : values.prod ? 'production' : null;
    await doctor.runDoctor({ json: Boolean(values.json), mode });
  }
}

function cmdCache(args) {
  if (args.length === 0) usageError('missing subcommand: gio cache explain <url-or-path>', 'cache');
  if (args[0] === '--help' || args[0] === '-h') {
    console.log(commandHelp('cache'));
    process.exit(0);
  }
  if (args[0] !== 'explain') {
    const suggestion = didYouMean(args[0], ['explain']);
    usageError(`unknown cache command "${args[0]}"${suggestion ? ` - did you mean \`gio cache ${suggestion}\`?` : ''}`, 'cache');
  }
  const { values, positionals } = parseFlags('cache', args.slice(1), { base: { type: 'string' } }, { positionals: 1 });
  if (positionals.length === 0) {
    usageError('usage: gio cache explain <url-or-path>   (e.g. gio cache explain /posts/1)', 'cache');
  }
  return require('./lib/cache-explain').runCacheExplain(positionals[0], { base: values.base || null });
}

// `gio bench` runs the zero-dependency load generator (ESM, so a child
// node process). Paths and --suite default to the local server's address.
function cmdBench(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(commandHelp('bench'));
    process.exit(0);
  }
  const needsBase = !args.includes('--base') && (args.includes('--suite') || args.some((arg) => arg.startsWith('/')));
  const extra = needsBase ? ['--base', require('./lib/cache-explain').localBaseUrl()] : [];
  runNodeScript('bench.mjs', [...args, ...extra]);
}

function cmdDelegate(subcommand, args) {
  require('./lib/delegate').delegate(subcommand, args);
}

function cmdHelp(args) {
  if (args.length === 0) {
    console.log(mainHelp());
    process.exit(0);
  }
  const help = commandHelp(args[0]);
  if (!help) unknownCommand(args[0]);
  console.log(help);
  process.exit(0);
}

function cmdVersion() {
  const { locateBinary } = require('./find-binary');
  const { findCoreDir, ownPackage, readJson } = require('./lib/project');
  const binary = locateBinary();
  const coreDir = findCoreDir();
  const core = coreDir ? readJson(join(coreDir, 'package.json')) : null;
  const server = binary.found
    ? binary.source === 'package'
      ? `${binary.version || 'unknown'} (${binary.packageName})`
      : `${binary.source === 'env' ? 'GIO_SERVER_BIN' : 'repository build'} (${binary.path})`
    : `not installed (${binary.packageName || `no package for ${binary.key}`})`;
  const rows = [
    ['gio', `${ownPackage().version} (@gio.js/server)`],
    ['server binary', server],
    ['@gio.js/core', core && core.version ? core.version : 'not installed'],
  ];
  for (const [label, value] of rows) console.log(`${label.padEnd(15)}${value}`);
  process.exit(0);
}

function unknownCommand(name) {
  const hint = HINTS[name];
  const suggestion = hint ? null : didYouMean(name, Object.keys(COMMANDS));
  const tail = hint ? ` - try \`${hint}\`` : suggestion ? ` - did you mean \`gio ${suggestion}\`?` : '';
  usageError(`unknown command "${name}"${tail}`);
}

async function main(argv) {
  const [command, ...args] = argv;
  if (command === undefined) {
    // Nothing to run: the help, and a non-zero exit so a script that relied
    // on bare `gio` starting the server (before it had commands) fails
    // loudly instead of succeeding without a server.
    console.error(mainHelp());
    console.error('\nTo start the server: gio dev (development) or gio start (production).');
    process.exit(USAGE_ERROR);
  }
  switch (command) {
    case '-h':
    case '--help':
      return cmdHelp([]);
    case '-v':
    case '--version':
      return cmdVersion();
    case 'help': return cmdHelp(args);
    case 'dev': return cmdServer('development', 'dev', args);
    case 'start': return cmdServer('production', 'start', args);
    case 'build': return cmdBuild(args);
    case 'export': return cmdExport(args);
    case 'routes': return cmdRoutes(args);
    case 'typegen': return cmdTypegen(args);
    case 'doctor':
    case 'info':
      return cmdDoctor(command, args);
    case 'cache': return cmdCache(args);
    case 'bench': return cmdBench(args);
    case 'migrate':
    case 'add':
      return cmdDelegate(command, args);
    default:
      if (command.startsWith('-')) usageError(`unknown option "${command}"`);
      return unknownCommand(command);
  }
}

main(process.argv.slice(2)).catch((err) => {
  // Every expected failure exits with its own message; this is a bug.
  console.error(`gio: unexpected error: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
