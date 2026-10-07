'use strict';
/**
 * giojs/bin/lib/config.js
 *
 * What the server will do with this project's configuration, asked of the
 * server itself: `giojs-server --check-config` loads the .env files and
 * gio.toml exactly as startup does and prints a JSON report (listen address,
 * validation errors, guard and proxy settings). The CLI never re-implements
 * the strict gio.toml rules.
 *
 * Fallback for when no binary that understands the flag is at hand (none
 * installed, or a different version): a lenient reader for the few keys the
 * CLI needs - [server] host/port/trusted_proxies, [server.tls] enabled,
 * [cache] disk_path, require_session guards, rate limit count - plus the
 * PORT / GIO_PORT / GIO_HOST variables from the environment and the .env
 * files. It validates nothing.
 */
const { spawnSync } = require('child_process');
const { existsSync, readFileSync } = require('fs');
const { isIP } = require('net');
const { networkInterfaces } = require('os');
const { join, resolve } = require('path');

const CHECK_CONFIG_FLAG = '--check-config';
// Startup reads a few small files; anything slower is not answering the flag.
const CHECK_CONFIG_TIMEOUT_MS = 15_000;

/**
 * Run `binary --check-config` with `env`. Returns the parsed report, or null
 * when the binary does not support the flag. A binary from before the flag
 * would ignore it and start a server: stdin is an already-closed pipe and
 * GIO_EXIT_ON_STDIN_EOF=1 makes such a server shut down at once, and the
 * timeout bounds the rest.
 */
function checkConfig(binary, env, cwd = process.cwd()) {
  const result = spawnSync(binary, [CHECK_CONFIG_FLAG], {
    cwd,
    env: { ...env, GIO_EXIT_ON_STDIN_EOF: '1' },
    input: '',
    encoding: 'utf8',
    timeout: CHECK_CONFIG_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error || typeof result.stdout !== 'string') return null;
  const lines = result.stdout.trim().split(/\r?\n/);
  try {
    const report = JSON.parse(lines[lines.length - 1]);
    return report && typeof report.ok === 'boolean' ? report : null;
  } catch (_) {
    return null;
  }
}

// ── lenient gio.toml reader ────────────────────────────────────────────────

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseScalar(raw) {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return value.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) return value.slice(1, -1);
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^[+-]?\d[\d_]*$/.test(value)) return Number(value.replace(/_/g, ''));
  return value;
}

function parseValue(raw) {
  const value = raw.trim();
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1);
    const items = [];
    let current = '';
    let quote = null;
    for (const ch of inner) {
      if (quote) {
        if (ch === quote) quote = null;
        current += ch;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
        current += ch;
      } else if (ch === ',') {
        if (current.trim()) items.push(parseScalar(current));
        current = '';
      } else {
        current += ch;
      }
    }
    if (current.trim()) items.push(parseScalar(current));
    return items;
  }
  return parseScalar(value);
}

/**
 * Tables, arrays of tables, and `key = value` with strings, integers,
 * booleans and (possibly multi-line) arrays of those. Dotted keys and inline
 * tables are skipped. Never throws: a line it cannot read is ignored.
 */
function parseTomlLite(text) {
  const root = {};
  let table = root;
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = stripComment(lines[i]).trim();
    if (!line) continue;
    const arrayTable = /^\[\[\s*([A-Za-z0-9_.-]+)\s*\]\]$/.exec(line);
    const plainTable = /^\[\s*([A-Za-z0-9_.-]+)\s*\]$/.exec(line);
    if (arrayTable || plainTable) {
      const path = (arrayTable || plainTable)[1].split('.');
      let node = root;
      for (const key of path.slice(0, -1)) {
        if (Array.isArray(node[key])) node = node[key][node[key].length - 1];
        else node = node[key] = typeof node[key] === 'object' && node[key] ? node[key] : {};
      }
      const last = path[path.length - 1];
      if (arrayTable) {
        if (!Array.isArray(node[last])) node[last] = [];
        table = {};
        node[last].push(table);
      } else {
        table = node[last] = typeof node[last] === 'object' && node[last] ? node[last] : {};
      }
      continue;
    }
    const assignment = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    if (!assignment) continue;
    let raw = assignment[2];
    // A multi-line array runs until its brackets balance.
    if (raw.trim().startsWith('[')) {
      while (bracketDepth(raw) > 0 && i + 1 < lines.length) {
        raw += ' ' + stripComment(lines[++i]).trim();
      }
    }
    if (raw.trim().startsWith('{')) continue;
    table[assignment[1]] = parseValue(raw);
  }
  return root;
}

function bracketDepth(text) {
  let depth = 0;
  let quote = null;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[') depth++;
    else if (ch === ']') depth--;
  }
  return depth;
}

// ── .env files (the listen variables only) ─────────────────────────────────

/** Same candidates and precedence as the server: first definition wins. */
function envFileCandidates(mode) {
  return [`.env.${mode}.local`, '.env.local', `.env.${mode}`, '.env'];
}

/** The values `names` take after the server's .env loading, never overriding `env`. */
function envWithFiles(env, projectRoot, mode, names) {
  const merged = {};
  for (const name of names) if (env[name] !== undefined) merged[name] = env[name];
  for (const file of envFileCandidates(mode)) {
    let text;
    try {
      text = readFileSync(join(projectRoot, file), 'utf8');
    } catch (_) {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match || !names.includes(match[1]) || merged[match[1]] !== undefined) continue;
      const quoted = /^(["'])(.*?)\1/.exec(match[2]);
      merged[match[1]] = quoted ? quoted[2] : match[2].replace(/\s+#.*$/, '');
    }
  }
  return merged;
}

const LISTEN_VARS = ['GIO_HOST', 'GIO_PORT', 'PORT', 'GIO_SESSION_SECRET'];

/**
 * A report shaped like --check-config's, from the lenient reader. `ok` is
 * true and `fallback` marks it: nothing was validated.
 */
function fallbackReport(env, projectRoot) {
  const mode = env.NODE_ENV === 'development' ? 'development' : 'production';
  const configFile = join(projectRoot, 'gio.toml');
  let toml = {};
  let configText = null;
  if (existsSync(configFile)) {
    try {
      configText = readFileSync(configFile, 'utf8');
      toml = parseTomlLite(configText);
    } catch (_) {
      toml = {};
    }
  }
  const server = toml.server || {};
  const vars = envWithFiles(env, projectRoot, mode, LISTEN_VARS);
  let port = Number.isInteger(server.port) ? server.port : 3000;
  let portSource = Number.isInteger(server.port) ? 'gio.toml' : 'default';
  for (const name of ['GIO_PORT', 'PORT']) {
    if (vars[name] && /^\d+$/.test(vars[name])) {
      port = Number(vars[name]);
      portSource = name;
      break;
    }
  }
  const host = vars.GIO_HOST || (typeof server.host === 'string' ? server.host : '0.0.0.0');
  const guards = Array.isArray(toml.guards) ? toml.guards : [];
  const secret = vars.GIO_SESSION_SECRET || '';
  const secrets = secret.split(',').map((s) => s.trim()).filter(Boolean);
  const cachePath = toml.cache && typeof toml.cache.disk_path === 'string'
    ? toml.cache.disk_path
    : '.gio/cache/pages';
  return {
    ok: true,
    fallback: true,
    errors: [],
    warnings: [],
    mode,
    configFile: configText === null ? null : configFile,
    listen: { host, port, portSource, tls: Boolean(server.tls && server.tls.enabled) },
    trustedProxies: Array.isArray(server.trusted_proxies) ? server.trusted_proxies.length : 0,
    proxyHeaders: typeof server.proxy_headers === 'string' ? server.proxy_headers : 'x-forwarded',
    rateLimitRules: Array.isArray(toml.rate_limits) ? toml.rate_limits.length : 0,
    sessionGuards: guards.filter((g) => g.require_session === true || g.requireSession === true).length,
    sessionSecret: secrets.length === 0 ? 'unset' : secrets.every((s) => s.length >= 32) ? 'valid' : 'invalid',
    cacheDir: env.GIO_CACHE_DIR ? resolve(env.GIO_CACHE_DIR) : join(projectRoot, cachePath),
  };
}

/**
 * The server's view of the configuration under `env`: --check-config when
 * `binary` (a locateBinary result) can answer it, else the fallback.
 * `cliVersion` gates the flag on installed packages: one of another version
 * may predate it.
 */
function resolveConfig({ binary, env, projectRoot, cliVersion }) {
  const canAsk = binary && binary.found &&
    (binary.source !== 'package' || binary.version === cliVersion);
  if (canAsk) {
    const report = checkConfig(binary.path, env);
    if (report) return report;
  }
  return fallbackReport(env, projectRoot);
}

// ── URLs ─────────────────────────────────────────────────────────────────

// The server writes IPv6 listen hosts in brackets (`[::1]`, as in a URL);
// Node's net and the checks below want the bare address.

/** `[::1]` -> `::1`; any other host unchanged. */
function bareHost(host) {
  const match = /^\[(.*)\]$/.exec(String(host));
  return match ? match[1] : String(host);
}

function hostForUrl(host) {
  const bare = bareHost(host);
  return isIP(bare) === 6 ? `[${bare}]` : bare;
}

/** `host:port` for messages, IPv6 bracketed. */
function displayAddress(host, port) {
  return `${hostForUrl(host)}:${port}`;
}

function isWildcard(host) {
  const bare = bareHost(host);
  return bare === '0.0.0.0' || bare === '::' || bare === '';
}

/** Where to connect (bare address) to reach a server bound to `host` from this machine. */
function connectHost(host) {
  const bare = bareHost(host);
  if (bare === '0.0.0.0' || bare === '') return '127.0.0.1';
  if (bare === '::') return '::1';
  return bare;
}

/** The base URL this machine reaches the server on. */
function connectBaseUrl(listen) {
  const scheme = listen.tls ? 'https' : 'http';
  return `${scheme}://${hostForUrl(connectHost(listen.host))}:${listen.port}`;
}

function isLoopback(host) {
  const bare = bareHost(host);
  return bare === '::1' || /^127\./.test(bare);
}

/**
 * The URLs to print: `local` for this machine, `network` for other devices
 * (empty when the server only listens on loopback).
 */
function serverUrls(listen, interfaces = networkInterfaces()) {
  const scheme = listen.tls ? 'https' : 'http';
  const url = (host) => `${scheme}://${hostForUrl(host)}:${listen.port}`;
  if (!isWildcard(listen.host)) {
    return {
      local: url(isLoopback(listen.host) ? 'localhost' : listen.host),
      network: isLoopback(listen.host) ? [] : [url(listen.host)],
    };
  }
  const network = [];
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses || []) {
      const v4 = address.family === 'IPv4' || address.family === 4;
      if (!address.internal && v4) network.push(url(address.address));
    }
  }
  return { local: url('localhost'), network };
}

module.exports = {
  CHECK_CONFIG_FLAG,
  checkConfig,
  parseTomlLite,
  envWithFiles,
  fallbackReport,
  resolveConfig,
  bareHost,
  displayAddress,
  connectHost,
  connectBaseUrl,
  serverUrls,
};
