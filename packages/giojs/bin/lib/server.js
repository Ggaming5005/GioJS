'use strict';
/**
 * giojs/bin/lib/server.js
 *
 * Runs the Rust server for `gio dev`, `gio start` and the `giojs-server` bin.
 * The launcher stays in the foreground until the server exits and exits with
 * its code. For dev/start it also resolves the listen address the way the
 * server will (--check-config), waits for /_gio/health to report the Node
 * worker ready, prints the local and network URLs, and optionally opens a
 * browser.
 */
const { spawn } = require('child_process');
const { existsSync } = require('fs');
const http = require('http');
const https = require('https');
const { dirname, join } = require('path');
const { locateBinary, missingBinaryMessage } = require('../find-binary');
const { connectBaseUrl, resolveConfig, serverUrls } = require('./config');
const { detectPackageManager, findCoreDir, findTsxCli, ownPackage, projectPaths } = require('./project');

/**
 * @gio.js/core's worker entry, which the server spawns under tsx, and tsx's
 * package directory. The server's own tsx lookup only knows a few paths
 * relative to its working directory; this one follows Node's resolution
 * from @gio.js/core, wherever the package manager put it.
 */
function findWorkerPaths() {
  const coreDir = findCoreDir();
  if (!coreDir) return { nodeScript: null, tsxPkg: null };
  const candidate = join(coreDir, 'src', 'index.ts');
  const tsxCli = findTsxCli(coreDir);
  return {
    nodeScript: existsSync(candidate) ? candidate : null,
    tsxPkg: tsxCli ? dirname(dirname(tsxCli)) : null,
  };
}

/**
 * The server's environment: `mode` sets NODE_ENV ('development' |
 * 'production'; null keeps the caller's), --port/--host become
 * GIO_PORT/GIO_HOST, which outrank PORT and gio.toml.
 */
function serverEnv({ base = process.env, mode = null, port = null, host = null, worker = {} }) {
  const env = { ...base };
  if (mode) env.NODE_ENV = mode;
  if (port !== null) env.GIO_PORT = String(port);
  if (host !== null) env.GIO_HOST = host;
  if (worker.nodeScript) env.GIO_NODE_SCRIPT = worker.nodeScript;
  if (worker.tsxPkg && !env.GIO_TSX_PKG) env.GIO_TSX_PKG = worker.tsxPkg;
  // stdin is a pipe this launcher holds open and never writes: if it dies -
  // even by SIGKILL, which it cannot forward - the server reads EOF and shuts
  // down instead of lingering on the port with its worker.
  env.GIO_EXIT_ON_STDIN_EOF = '1';
  return env;
}

/** The binary, or exit 1 with what to install. */
function requireBinary() {
  const binary = locateBinary();
  if (!binary.found) {
    const message = missingBinaryMessage(binary, {
      version: ownPackage().version,
      packageManager: detectPackageManager().name,
    });
    console.error(message);
    process.exit(1);
  }
  return binary;
}

function spawnServer(binaryPath, args, env) {
  const server = spawn(binaryPath, args, { stdio: ['pipe', 'inherit', 'inherit'], env });
  server.stdin.on('error', () => {});
  server.on('error', (err) => {
    console.error(`gio: could not start the server (${binaryPath}): ${err.message}`);
    process.exit(1);
  });
  // A terminal Ctrl+C reaches the server directly (same process group, or
  // the same console on Windows); on Unix, forwarding covers signals sent to
  // this launcher alone. Windows never forwards: kill() there is
  // TerminateProcess, which would cut short the server's graceful shutdown.
  // Either way the launcher stays until the server has exited.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      if (process.platform !== 'win32') server.kill(signal);
    });
  }
  server.on('exit', (code, signal) => process.exit(code ?? (signal === null ? 0 : 1)));
  return server;
}

/** One GET of /_gio/health: the parsed body, or null. */
function fetchHealth(baseUrl) {
  return new Promise((resolve) => {
    const url = new URL('/_gio/health', baseUrl);
    const client = url.protocol === 'https:' ? https : http;
    // Our own child on this machine: a dev certificate need not verify.
    const request = client.get(url, { rejectUnauthorized: false, timeout: 2000 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (_) {
          resolve(null);
        }
      });
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(null));
  });
}

/**
 * Resolves true once the server reports a ready Node worker, false if the
 * server exits first. Polls fast while a dev build would still be quick,
 * then backs off.
 */
function waitForReady(baseUrl, server, startedAt = Date.now()) {
  return new Promise((resolve) => {
    let done = false;
    server.once('exit', () => {
      done = true;
      resolve(false);
    });
    const poll = async () => {
      if (done) return;
      const health = await fetchHealth(baseUrl);
      if (done) return;
      if (health && health.nodeReady === true) {
        done = true;
        resolve(true);
        return;
      }
      const delay = Date.now() - startedAt < 10_000 ? 150 : 1000;
      setTimeout(poll, delay).unref();
    };
    poll();
  });
}

function formatBanner({ mode, version, urls }) {
  const title = ['GioJS', version, mode === 'development' ? '(dev)' : '(production)']
    .filter(Boolean)
    .join(' ');
  const lines = ['', `  ${title}`, `  - Local:    ${urls.local}`];
  if (urls.network.length > 0) {
    for (const url of urls.network) lines.push(`  - Network:  ${url}`);
  } else {
    lines.push('  - Network:  not exposed (listening on loopback only; use --host 0.0.0.0)');
  }
  lines.push('');
  return lines.join('\n');
}

/** The command that opens `url` in the default browser on `platform`. */
function browserCommand(url, platform = process.platform) {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  // `start` is a cmd builtin; its first quoted argument is the window title.
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '""', url] };
  return { command: 'xdg-open', args: [url] };
}

function openBrowser(url) {
  const { command, args } = browserCommand(url);
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => console.error(`gio: could not open a browser - visit ${url}`));
    child.unref();
  } catch (_) {
    console.error(`gio: could not open a browser - visit ${url}`);
  }
}

/** `gio dev` / `gio start`. */
function runServerCommand({ mode, port = null, host = null, open = false }) {
  const binary = requireBinary();
  const env = serverEnv({ mode, port, host, worker: findWorkerPaths() });
  const pkg = ownPackage();
  const { projectRoot } = projectPaths(env);
  // The address the server will bind, before it starts: env, .env files and
  // gio.toml all have a say. A config error is left for the server to report.
  const config = resolveConfig({ binary, env, projectRoot, cliVersion: pkg.version });
  const server = spawnServer(binary.path, [], env);
  if (!config.ok || !config.listen || config.listen.port === 0) return;
  waitForReady(connectBaseUrl(config.listen), server).then((ready) => {
    if (!ready) return;
    const urls = serverUrls(config.listen);
    console.log(formatBanner({ mode, version: pkg.version, urls }));
    if (open) openBrowser(urls.local);
  });
}

/**
 * The `giojs-server` bin: start the server exactly as before the gio CLI
 * had commands - arguments go to the binary, NODE_ENV is the caller's.
 */
function runCompatServer(args) {
  const binary = requireBinary();
  spawnServer(binary.path, args, serverEnv({ worker: findWorkerPaths() }));
}

module.exports = {
  serverEnv,
  findWorkerPaths,
  requireBinary,
  fetchHealth,
  formatBanner,
  browserCommand,
  runServerCommand,
  runCompatServer,
};
