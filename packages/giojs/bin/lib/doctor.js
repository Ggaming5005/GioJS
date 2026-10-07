'use strict';
/**
 * giojs/bin/lib/doctor.js
 *
 * `gio info` (environment report) and `gio doctor` (report + checks with a
 * fix for each failure). Gathering facts does the I/O; the checks are a pure
 * function of the facts, so tests describe any environment as plain data.
 *
 * Statuses: ok, info (a hint, nothing wrong), warn (likely to bite), error
 * (broken; doctor exits 1), skip (could not check).
 */
const { accessSync, constants, existsSync, readFileSync } = require('fs');
const net = require('net');
const os = require('os');
const { dirname, join } = require('path');
const { locateBinary, missingBinaryMessage } = require('../find-binary');
const { bareHost, displayAddress, resolveConfig } = require('./config');
const { detectPackageManager, findPackage, ownPackage, projectPaths, readJson } = require('./project');

const MIN_NODE = '>=20';

// Files whose presence says the app is deployed behind a proxy or load
// balancer, where the client address arrives in X-Forwarded-* headers.
const PROXY_HINT_FILES = [
  'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml',
  'fly.toml', 'render.yaml', 'railway.json', 'railway.toml', 'Procfile', 'app.yaml',
  'nginx.conf', 'Caddyfile',
];

// ── minimal semver for engines ranges ──────────────────────────────────────

function parseVersion(text) {
  const match = /^v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/.exec(String(text).trim());
  if (!match) return null;
  const part = (value) => (value === undefined || value === 'x' || value === '*' ? null : Number(value));
  return [Number(match[1]), part(match[2]), part(match[3])];
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Whether `version` satisfies one comparator (`>=20.6`, `^22`, `20.x`). */
function satisfiesComparator(version, comparator) {
  const match = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(comparator);
  if (!match) return null;
  const operator = match[1] || '=';
  const bound = parseVersion(match[2]);
  if (!bound) return null;
  const filled = bound.map((n) => n || 0);
  switch (operator) {
    case '>=': return compare(version, filled) >= 0;
    case '>': return compare(version, filled) > 0;
    case '<=': return compare(version, filled) <= 0;
    case '<': return compare(version, filled) < 0;
    case '^': return version[0] === bound[0] && compare(version, filled) >= 0;
    case '~': return version[0] === bound[0] && (bound[1] === null || version[1] === bound[1]) &&
      compare(version, filled) >= 0;
    default:
      // `20`, `20.x`, `20.6.0`: every given part must match.
      return bound.every((n, i) => n === null || version[i] === n);
  }
}

/** `version` against an engines range; null when the range is not understood. */
function satisfiesRange(versionText, range) {
  const version = parseVersion(versionText);
  if (!version) return null;
  const alternatives = String(range).split('||').map((alt) => alt.trim()).filter(Boolean);
  if (alternatives.length === 0) return true;
  let understood = false;
  for (const alternative of alternatives) {
    if (alternative === '*' || alternative === 'x') return true;
    const comparators = alternative.replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1').split(/\s+/);
    const results = comparators.map((comparator) => satisfiesComparator(version, comparator));
    if (results.includes(null)) continue;
    understood = true;
    if (results.every(Boolean)) return true;
  }
  return understood ? false : null;
}

// ── facts ──────────────────────────────────────────────────────────────────

/** tsconfig.json / jsconfig.json, comments and trailing commas allowed. */
function parseJsonc(text) {
  let out = '';
  let quote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      out += ch;
      if (ch === '\\') out += text[++i] || '';
      else if (ch === '"') quote = false;
    } else if (ch === '"') {
      quote = true;
      out += ch;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i === -1) break;
      i++;
    } else {
      out += ch;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (_) {
    return null;
  }
}

/** Whether `host` (as the server writes it: IPv6 in brackets) : `port` can be bound. */
function portState(host, port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', (err) => resolve(err.code === 'EADDRINUSE' ? 'in-use' : err.code || 'error'));
    probe.listen({ host: bareHost(host), port, exclusive: true }, () => probe.close(() => resolve('free')));
  });
}

/** Whether the directory (or the nearest ancestor that exists) is writable. */
function writableDir(dir) {
  let current = dir;
  for (;;) {
    if (existsSync(current)) {
      try {
        accessSync(current, constants.W_OK);
        return { writable: true, checked: current };
      } catch (_) {
        return { writable: false, checked: current };
      }
    }
    const parent = dirname(current);
    if (parent === current) return { writable: false, checked: current };
    current = parent;
  }
}

function libc() {
  if (process.platform !== 'linux') return null;
  try {
    return process.report.getReport().header.glibcVersionRuntime ? 'glibc' : 'musl';
  } catch (_) {
    return null;
  }
}

/**
 * The configuration doctor checks: `mode` ('development' from --dev,
 * 'production' from --prod) wins, else NODE_ENV decides as it does for the
 * server - development only when it says so. `explicit` is false when
 * production was only assumed because NODE_ENV is unset or unusual.
 */
function checkedMode(env, mode = null) {
  if (mode) return { name: mode, explicit: true, source: mode === 'development' ? '--dev' : '--prod' };
  const explicit = env.NODE_ENV === 'development' || env.NODE_ENV === 'production';
  return {
    name: env.NODE_ENV === 'development' ? 'development' : 'production',
    explicit,
    source: explicit ? 'NODE_ENV' : null,
  };
}

/** Everything the report and the checks look at, gathered once. */
async function gatherFacts({ env = process.env, cwd = process.cwd(), probePort = true, mode = null } = {}) {
  const { projectRoot, appDir } = projectPaths(env, cwd);
  const own = ownPackage();
  const ownDir = join(__dirname, '..', '..');
  const binary = locateBinary({ env });
  const projectPackage = readJson(join(projectRoot, 'package.json'));
  const packages = {
    '@gio.js/server': own.version || null,
    '@gio.js/core': (findPackage('@gio.js/core', [projectRoot, ownDir]) || {}).version || null,
    '@gio.js/react': (findPackage('@gio.js/react', [projectRoot]) || {}).version || null,
    'create-giojs': (findPackage('create-giojs', [projectRoot]) || {}).version || null,
  };
  const checked = checkedMode(env, mode);
  // The server picks its .env files (and the dev session secret) by
  // NODE_ENV, so the config is resolved under the mode being checked.
  const configEnv = mode ? { ...env, NODE_ENV: mode } : env;
  const config = resolveConfig({ binary, env: configEnv, projectRoot, cliVersion: own.version });

  let tsconfig = null;
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const text = readText(join(projectRoot, name));
    if (text === null) continue;
    try {
      tsconfig = { name, config: parseJsonc(text) };
    } catch (err) {
      tsconfig = { name, error: err.message };
    }
    break;
  }
  const middleware = ['middleware.ts', 'middleware.js', 'middleware.mjs']
    .map((name) => readText(join(projectRoot, name)))
    .find((text) => text !== null) || null;

  let port = null;
  if (probePort && config.ok && config.listen && config.listen.port !== 0) {
    port = await portState(config.listen.host, config.listen.port);
  }

  return {
    cliVersion: own.version || null,
    engines: own.engines && own.engines.node ? own.engines.node : MIN_NODE,
    projectEngines: projectPackage && projectPackage.engines ? projectPackage.engines.node || null : null,
    node: process.versions.node,
    platform: { os: process.platform, arch: process.arch, libc: libc(), release: os.release() },
    packageManager: detectPackageManager(env, projectRoot),
    projectRoot,
    appDir,
    appDirExists: existsSync(appDir),
    hasPackageJson: projectPackage !== null,
    binary,
    packages,
    config,
    mode: checked,
    nodeEnv: env.NODE_ENV || null,
    tsconfig,
    middlewareSessionGuards: middleware !== null && /requireSession\s*:\s*true/.test(middleware),
    port,
    cacheDir: config.cacheDir ? { path: config.cacheDir, ...writableDir(config.cacheDir) } : null,
    proxyHintFiles: PROXY_HINT_FILES.filter((name) => existsSync(join(projectRoot, name))),
  };
}

// ── report ─────────────────────────────────────────────────────────────────

function infoReport(facts) {
  const binary = facts.binary.found
    ? { path: facts.binary.path, source: facts.binary.source, package: facts.binary.packageName, version: facts.binary.version }
    : { missing: facts.binary.reason, package: facts.binary.packageName };
  return {
    gio: facts.cliVersion,
    node: facts.node,
    platform: `${facts.platform.os}-${facts.platform.arch}${facts.platform.libc ? ` (${facts.platform.libc})` : ''}`,
    osRelease: facts.platform.release,
    packageManager: facts.packageManager.version
      ? `${facts.packageManager.name} ${facts.packageManager.version}`
      : facts.packageManager.name,
    serverBinary: binary,
    packages: facts.packages,
    projectRoot: facts.projectRoot,
    gioToml: facts.config.configFile || null,
    nodeEnv: facts.nodeEnv,
  };
}

function formatInfo(report) {
  const sources = { env: 'GIO_SERVER_BIN', workspace: 'repository build' };
  const binary = report.serverBinary.path
    ? `${report.serverBinary.version || sources[report.serverBinary.source] || report.serverBinary.source} (${report.serverBinary.path})`
    : `not found (${report.serverBinary.missing})`;
  const rows = [
    ['gio', report.gio],
    ['Node.js', report.node],
    ['Platform', `${report.platform}, ${report.osRelease}`],
    ['Package manager', report.packageManager],
    ['Server binary', binary],
    ...Object.entries(report.packages).map(([name, version]) => [name, version || 'not installed']),
    ['Project', report.projectRoot],
    ['gio.toml', report.gioToml || 'none (defaults)'],
    ['NODE_ENV', report.nodeEnv || '(unset)'],
  ];
  const width = Math.max(...rows.map(([label]) => label.length)) + 2;
  return rows.map(([label, value]) => `  ${label.padEnd(width)}${value}`).join('\n');
}

// ── checks ─────────────────────────────────────────────────────────────────

function check(id, status, title, extra = {}) {
  return { id, status, title, ...extra };
}

function nodeCheck(facts) {
  const ok = satisfiesRange(facts.node, facts.engines);
  if (ok === false) {
    return check('node', 'error', `Node.js ${facts.node} is too old: GioJS needs ${facts.engines}`, {
      fix: 'Install Node.js 20 or newer (https://nodejs.org), e.g. `nvm install 22`.',
    });
  }
  const project = facts.projectEngines ? satisfiesRange(facts.node, facts.projectEngines) : null;
  if (project === false) {
    return check('node', 'warn', `Node.js ${facts.node} does not satisfy package.json engines "${facts.projectEngines}"`, {
      fix: 'Switch Node.js versions, or update "engines" in package.json.',
    });
  }
  return check('node', 'ok', `Node.js ${facts.node} (GioJS needs ${facts.engines})`);
}

function binaryCheck(facts) {
  const binary = facts.binary;
  if (!binary.found) {
    return check('binary', 'error', `No server binary for ${binary.key}`, {
      detail: missingBinaryMessage(binary, { version: facts.cliVersion, packageManager: facts.packageManager.name })
        .replace(/^gio: /, ''),
    });
  }
  const where = binary.source === 'package'
    ? `${binary.packageName} ${binary.version || ''}`.trim()
    : binary.source === 'env' ? 'GIO_SERVER_BIN' : 'repository cargo build';
  return check('binary', 'ok', `Server binary: ${where}`, { detail: binary.path });
}

function versionsCheck(facts) {
  const expected = facts.cliVersion;
  const versions = { ...facts.packages };
  delete versions['create-giojs'];
  if (facts.binary.found && facts.binary.source === 'package') versions[facts.binary.packageName] = facts.binary.version;
  if (!versions['@gio.js/core']) {
    return check('versions', 'error', '@gio.js/core is not installed', {
      fix: `Install it: ${facts.packageManager.name === 'npm' ? 'npm install' : `${facts.packageManager.name} add`} @gio.js/core@${expected}`,
    });
  }
  const differing = Object.entries(versions).filter(([, version]) => version && version !== expected);
  if (differing.length === 0) {
    return check('versions', 'ok', `@gio.js packages in lockstep (${expected})`);
  }
  const names = ['@gio.js/server', '@gio.js/core', ...(versions['@gio.js/react'] ? ['@gio.js/react'] : [])];
  const install = facts.packageManager.name === 'npm' ? 'npm install' : `${facts.packageManager.name} add`;
  // The Rust binary and the Node worker speak one IPC protocol version; the
  // React package only has to agree on props and client runtime.
  const severe = differing.some(([name]) => name !== '@gio.js/react');
  return check('versions', severe ? 'error' : 'warn',
    `Package versions differ from @gio.js/server ${expected}: ${differing.map(([n, v]) => `${n} ${v}`).join(', ')}`, {
      fix: `Install matching versions: ${install} ${names.map((name) => `${name}@${expected}`).join(' ')}`,
    });
}

function configCheck(facts) {
  const config = facts.config;
  if (config.fallback) {
    return check('config', 'skip', 'gio.toml not validated (needs a server binary of this version)', {
      detail: config.configFile ? 'Read leniently for the checks below; unknown keys are only caught by the server.' : undefined,
    });
  }
  if (!config.ok) {
    return check('config', 'error', 'The server would refuse to start with this configuration', {
      detail: config.errors.join('\n'),
      fix: 'Fix the setting named above (the server prints the same message at startup).',
    });
  }
  // Protections the file turns off or loosens - each line names its
  // setting.
  if (config.warnings && config.warnings.length > 0) {
    const count = config.warnings.length;
    return check('config', 'warn', `gio.toml: ${count} warning${count === 1 ? '' : 's'} the server logs at startup`, {
      detail: config.warnings.join('\n'),
      fix: 'Change each setting named above, or keep it if you meant to turn that protection off.',
    });
  }
  const files = config.envFilesDisabledBy
    ? `, .env files off (${config.envFilesDisabledBy})`
    : config.envFiles && config.envFiles.length > 0 ? `, env: ${config.envFiles.join(', ')}` : '';
  return check('config', 'ok', `${config.configFile ? 'gio.toml is valid' : 'No gio.toml (defaults apply)'}${files}`);
}

function appDirCheck(facts) {
  if (facts.appDirExists) return check('app', 'ok', `App directory: ${facts.appDir}`);
  return check('app', 'error', `No app/ directory at ${facts.appDir}`, {
    fix: facts.hasPackageJson
      ? 'Create app/page.tsx, or set GIO_APP_DIR to where your routes live.'
      : 'Run gio from your project root (the folder with package.json and app/).',
  });
}

function tsconfigCheck(facts) {
  const tsconfig = facts.tsconfig;
  if (!tsconfig) return check('tsconfig', 'skip', 'No tsconfig.json or jsconfig.json');
  if (tsconfig.error) {
    return check('tsconfig', 'warn', `${tsconfig.name} could not be parsed: ${tsconfig.error}`);
  }
  const listed = [...(tsconfig.config.include || []), ...(tsconfig.config.files || [])];
  // TypeScript's wildcards never match dot-folders, so only an explicit
  // .gio entry brings the generated declarations in.
  const covers = listed.some((entry) => /^(\.\/)?\.gio(\/|$)/.test(String(entry)));
  if (covers) return check('tsconfig', 'ok', `${tsconfig.name} includes .gio/routes.d.ts (typed routes)`);
  return check('tsconfig', 'warn', `${tsconfig.name} does not include .gio/routes.d.ts`, {
    detail: 'href(), PageProps and GsspContext fall back to untyped routes, and CSS Module imports do not typecheck.',
    fix: `Add ".gio/routes.d.ts" to "include" in ${tsconfig.name}, then run \`gio typegen\`.`,
  });
}

function sessionSecretCheck(facts) {
  const config = facts.config;
  const guards = (config.sessionGuards || 0) + (facts.middlewareSessionGuards ? 1 : 0);
  const hint = 'Generate one: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"';
  if (config.sessionSecret === 'invalid') {
    return check('session', 'error', 'GIO_SESSION_SECRET is invalid', {
      detail: config.sessionSecretError || 'Each comma-separated secret must be at least 32 bytes.',
      fix: hint,
    });
  }
  if (guards === 0) return check('session', 'ok', 'No require_session guards');
  if (config.sessionSecret === 'valid') return check('session', 'ok', 'GIO_SESSION_SECRET is set for require_session guards');
  if (config.mode === 'development') {
    return check('session', 'info', 'require_session guards use an ephemeral dev secret (sessions reset on restart)', {
      fix: `Set GIO_SESSION_SECRET (environment or .env) before deploying. ${hint}`,
    });
  }
  if (facts.mode && !facts.mode.explicit) {
    // Production was only assumed: `gio dev` runs this project fine.
    return check('session', 'warn', 'require_session guards need GIO_SESSION_SECRET under `gio start`, and it is not set', {
      detail: `Checked as production because NODE_ENV is ${facts.nodeEnv ? `"${facts.nodeEnv}"` : 'unset'}; ` +
        '`gio dev` uses an ephemeral secret instead. ' +
        'In production every guarded request is denied until a secret is configured. ' +
        '`gio doctor --dev` checks the development setup, `--prod` makes this an error.',
      fix: `Set GIO_SESSION_SECRET in the deploy environment. ${hint}`,
    });
  }
  return check('session', 'error', 'require_session guards exist but GIO_SESSION_SECRET is not set', {
    detail: 'In production every guarded request is denied until a secret is configured.',
    fix: `Set GIO_SESSION_SECRET in the deploy environment. ${hint}`,
  });
}

function portCheck(facts) {
  const listen = facts.config.listen;
  if (!listen || facts.port === null) return check('port', 'skip', 'Port not checked');
  const where = displayAddress(listen.host, listen.port);
  if (facts.port === 'free') return check('port', 'ok', `Port ${listen.port} is free (${where}, from ${listen.portSource})`);
  if (facts.port === 'in-use') {
    return check('port', 'warn', `Port ${listen.port} is in use (${where}) - is a server already running?`, {
      fix: `Stop the other process, or pick another port: gio dev --port ${listen.port + 1}`,
    });
  }
  if (facts.port === 'EACCES') {
    return check('port', 'warn', `Binding ${where} needs elevated privileges`, {
      fix: 'Use a port above 1024 behind a reverse proxy, or grant the capability (setcap cap_net_bind_service).',
    });
  }
  if (facts.port === 'EAFNOSUPPORT') {
    return check('port', 'warn', `Cannot bind ${where}: this machine has no IPv6 support`, {
      fix: 'Bind an IPv4 address instead ([server] host / GIO_HOST / --host 0.0.0.0 or 127.0.0.1).',
    });
  }
  return check('port', 'warn', `Cannot bind ${where} (${facts.port})`, {
    fix: 'Check [server] host in gio.toml / GIO_HOST: it must be an address of this machine.',
  });
}

function proxyCheck(facts) {
  const config = facts.config;
  if ((config.trustedProxies || 0) > 0) {
    return check('proxy', 'ok', `trusted_proxies: ${config.trustedProxies} entr${config.trustedProxies === 1 ? 'y' : 'ies'} (${config.proxyHeaders})`);
  }
  const reasons = [];
  if (facts.proxyHintFiles.length > 0) reasons.push(`deploy files found (${facts.proxyHintFiles.join(', ')})`);
  if ((config.rateLimitRules || 0) > 0) reasons.push(`${config.rateLimitRules} rate limit rule(s) key on the client IP`);
  if (reasons.length === 0) return check('proxy', 'ok', 'No trusted proxies (clients connect directly)');
  return check('proxy', 'info', 'Behind a reverse proxy or load balancer? Set [server] trusted_proxies', {
    detail: `${reasons.join('; ')}. Without it X-Forwarded-For/-Proto are ignored, so every request ` +
      'appears to come from the proxy: rate limits share one bucket and logs show the proxy address.',
    fix: 'In gio.toml: [server] trusted_proxies = ["10.0.0.0/8"]  (your proxy\'s address or CIDR block)',
  });
}

function cacheDirCheck(facts) {
  if (!facts.cacheDir) return check('cache', 'skip', 'Cache directory not checked');
  if (facts.cacheDir.writable) return check('cache', 'ok', `Cache directory is writable (${facts.cacheDir.path})`);
  return check('cache', 'error', `Cache directory is not writable: ${facts.cacheDir.checked}`, {
    fix: 'Make it writable for the user running gio, or point GIO_CACHE_DIR / [cache] disk_path elsewhere.',
  });
}

function runChecks(facts) {
  return [
    nodeCheck(facts),
    binaryCheck(facts),
    versionsCheck(facts),
    appDirCheck(facts),
    configCheck(facts),
    tsconfigCheck(facts),
    sessionSecretCheck(facts),
    portCheck(facts),
    proxyCheck(facts),
    cacheDirCheck(facts),
  ];
}

const SYMBOLS = { ok: '✓', info: 'i', warn: '!', error: '✗', skip: '-' };

function indent(text, prefix) {
  return String(text).split('\n').map((line) => `${prefix}${line}`).join('\n');
}

function formatChecks(checks) {
  const lines = [];
  for (const item of checks) {
    lines.push(`  ${SYMBOLS[item.status]} ${item.title}`);
    if (item.detail && item.status !== 'ok') lines.push(indent(item.detail, '      '));
    if (item.fix && item.status !== 'ok') lines.push(indent(`fix: ${item.fix}`, '      '));
  }
  const errors = checks.filter((item) => item.status === 'error').length;
  const warnings = checks.filter((item) => item.status === 'warn').length;
  lines.push('');
  lines.push(errors + warnings === 0
    ? 'No problems found.'
    : `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}.`);
  return lines.join('\n');
}

/** Which configuration the checks looked at, and why. */
function formatMode(mode, nodeEnv) {
  const command = mode.name === 'development' ? '`gio dev`' : '`gio start`';
  const head = `Checking the ${mode.name} configuration (what ${command} runs)`;
  if (mode.source === '--dev' || mode.source === '--prod') return `${head}, as ${mode.source} asked.`;
  if (mode.source === 'NODE_ENV') return `${head}: NODE_ENV=${nodeEnv}.`;
  return `${head}: NODE_ENV is ${nodeEnv ? `"${nodeEnv}"` : 'unset'}. Use --dev to check \`gio dev\` instead.`;
}

async function runInfo({ json }) {
  const report = infoReport(await gatherFacts({ probePort: false }));
  console.log(json ? JSON.stringify(report, null, 2) : formatInfo(report));
}

async function runDoctor({ json, mode = null }) {
  const facts = await gatherFacts({ mode });
  const report = infoReport(facts);
  const checks = runChecks(facts);
  const failed = checks.some((item) => item.status === 'error');
  if (json) {
    console.log(JSON.stringify({ ok: !failed, mode: facts.mode, environment: report, checks }, null, 2));
  } else {
    console.log(`GioJS doctor\n\n${formatInfo(report)}\n\n${formatMode(facts.mode, facts.nodeEnv)}\n\n` +
      formatChecks(checks));
  }
  process.exitCode = failed ? 1 : 0;
}

module.exports = {
  satisfiesRange,
  parseJsonc,
  portState,
  checkedMode,
  formatMode,
  gatherFacts,
  infoReport,
  formatInfo,
  runChecks,
  formatChecks,
  runInfo,
  runDoctor,
};
