/**
 * giojs/test/doctor.test.mjs
 *
 * `gio doctor`'s checks are a pure function of gathered facts: each test
 * describes an environment as data (a broken install, a misconfigured
 * project) and asserts the status and the fix. Plus the engines range
 * matcher, the tsconfig reader, and one end-to-end `gio doctor --json`.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fakeServerBinary, run, tempProject } from './helpers.mjs';

const require = createRequire(import.meta.url);
const {
  satisfiesRange, parseJsonc, runChecks, formatChecks, infoReport, formatInfo, checkedMode, formatMode, portState,
} = require('../bin/lib/doctor.js');

const VERSION = '1.2.3';

/** A healthy project; tests override what they break. */
function facts(overrides = {}) {
  const base = {
    cliVersion: VERSION,
    engines: '>=20',
    projectEngines: null,
    node: '22.3.0',
    platform: { os: 'linux', arch: 'x64', libc: 'glibc', release: '6.0' },
    packageManager: { name: 'npm', version: '10.0.0' },
    projectRoot: '/app',
    appDir: '/app/app',
    appDirExists: true,
    hasPackageJson: true,
    binary: {
      found: true, path: '/app/node_modules/@gio.js/server-linux-x64/bin/giojs-server',
      source: 'package', key: 'linux-x64', packageName: '@gio.js/server-linux-x64', version: VERSION,
    },
    packages: { '@gio.js/server': VERSION, '@gio.js/core': VERSION, '@gio.js/react': VERSION, 'create-giojs': null },
    mode: { name: 'production', explicit: true, source: 'NODE_ENV' },
    config: {
      ok: true, errors: [], warnings: [], mode: 'production', configFile: 'gio.toml', envFiles: [],
      listen: { host: '0.0.0.0', port: 3000, portSource: 'default', tls: false },
      trustedProxies: 0, proxyHeaders: 'x-forwarded', rateLimitRules: 0, sessionGuards: 0,
      sessionSecret: 'unset', sessionSecretError: null, cacheDir: '/app/.gio/cache/pages',
    },
    nodeEnv: null,
    tsconfig: { name: 'tsconfig.json', config: { include: ['app', '.gio/routes.d.ts'] } },
    middlewareSessionGuards: false,
    port: 'free',
    cacheDir: { path: '/app/.gio/cache/pages', writable: true, checked: '/app' },
    proxyHintFiles: [],
  };
  const merged = { ...base, ...overrides };
  if (overrides.config) merged.config = { ...base.config, ...overrides.config };
  return merged;
}

function checkOf(f, id) {
  const found = runChecks(f).find((item) => item.id === id);
  assert.ok(found, `no ${id} check`);
  return found;
}

describe('doctor checks', () => {
  test('a healthy project passes every check', () => {
    const checks = runChecks(facts());
    assert.deepEqual(checks.filter((c) => c.status !== 'ok').map((c) => c.id), []);
    assert.match(formatChecks(checks), /No problems found\./);
  });

  test('Node.js older than engines is an error; the project\'s own engines a warning', () => {
    const old = checkOf(facts({ node: '18.19.0' }), 'node');
    assert.equal(old.status, 'error');
    assert.match(old.fix, /Node\.js 20 or newer/);
    const project = checkOf(facts({ projectEngines: '^24' }), 'node');
    assert.equal(project.status, 'warn');
  });

  test('a missing binary names the package to install', () => {
    const missing = checkOf(facts({
      binary: { found: false, reason: 'not-installed', key: 'linux-x64', packageName: '@gio.js/server-linux-x64' },
    }), 'binary');
    assert.equal(missing.status, 'error');
    assert.match(missing.detail, /npm install --save-optional @gio\.js\/server-linux-x64@1\.2\.3/);
    const pnpm = checkOf(facts({
      packageManager: { name: 'pnpm', version: null },
      binary: { found: false, reason: 'not-installed', key: 'linux-x64', packageName: '@gio.js/server-linux-x64' },
    }), 'binary');
    assert.match(pnpm.detail, /pnpm add --save-optional @gio\.js\/server-linux-x64@1\.2\.3/);
  });

  test('versions out of lockstep: core or binary is an error, react a warning', () => {
    const core = checkOf(facts({ packages: { ...facts().packages, '@gio.js/core': '1.2.0' } }), 'versions');
    assert.equal(core.status, 'error');
    assert.match(core.title, /@gio\.js\/core 1\.2\.0/);
    assert.match(core.fix, /npm install @gio\.js\/server@1\.2\.3 @gio\.js\/core@1\.2\.3 @gio\.js\/react@1\.2\.3/);
    const binary = checkOf(facts({ binary: { ...facts().binary, version: '1.1.0' } }), 'versions');
    assert.equal(binary.status, 'error');
    assert.match(binary.title, /@gio\.js\/server-linux-x64 1\.1\.0/);
    const react = checkOf(facts({ packages: { ...facts().packages, '@gio.js/react': '1.0.0' } }), 'versions');
    assert.equal(react.status, 'warn');
    const noCore = checkOf(facts({ packages: { ...facts().packages, '@gio.js/core': null } }), 'versions');
    assert.equal(noCore.status, 'error');
    assert.match(noCore.fix, /@gio\.js\/core@1\.2\.3/);
  });

  test('gio.toml errors from --check-config are errors; skipped rules warnings; fallback skipped', () => {
    const invalid = checkOf(facts({
      config: { ok: false, errors: ['gio.toml:2: unknown key `server.prot` - did you mean `server.port`?'] },
    }), 'config');
    assert.equal(invalid.status, 'error');
    assert.match(invalid.detail, /did you mean `server\.port`/);
    const skipped = checkOf(facts({ config: { warnings: ['[[redirects]] /a: bad status'] } }), 'config');
    assert.equal(skipped.status, 'warn');
    const fallback = checkOf(facts({ config: { fallback: true } }), 'config');
    assert.equal(fallback.status, 'skip');
  });

  test('a missing app/ directory is an error', () => {
    const missing = checkOf(facts({ appDirExists: false, hasPackageJson: false }), 'app');
    assert.equal(missing.status, 'error');
    assert.match(missing.fix, /project root/);
  });

  test('tsconfig must name .gio/routes.d.ts explicitly', () => {
    for (const include of [['.gio/routes.d.ts'], ['./.gio/routes.d.ts'], ['.gio/**/*.d.ts']]) {
      assert.equal(checkOf(facts({ tsconfig: { name: 'tsconfig.json', config: { include } } }), 'tsconfig').status, 'ok');
    }
    // TypeScript's wildcards skip dot-folders.
    const wildcard = checkOf(facts({ tsconfig: { name: 'tsconfig.json', config: { include: ['**/*.ts'] } } }), 'tsconfig');
    assert.equal(wildcard.status, 'warn');
    assert.match(wildcard.fix, /Add "\.gio\/routes\.d\.ts" to "include" in tsconfig\.json/);
    assert.equal(checkOf(facts({ tsconfig: null }), 'tsconfig').status, 'skip');
    assert.equal(checkOf(facts({ tsconfig: { name: 'jsconfig.json', config: {} } }), 'tsconfig').status, 'warn');
  });

  test('require_session guards need GIO_SESSION_SECRET in production', () => {
    const missing = checkOf(facts({ config: { sessionGuards: 2 } }), 'session');
    assert.equal(missing.status, 'error');
    assert.match(missing.fix, /randomBytes\(32\)/);
    assert.equal(checkOf(facts({ config: { sessionGuards: 2, mode: 'development' } }), 'session').status, 'info');
    assert.equal(checkOf(facts({ config: { sessionGuards: 2, sessionSecret: 'valid' } }), 'session').status, 'ok');
    assert.equal(checkOf(facts({ middlewareSessionGuards: true }), 'session').status, 'error');
    assert.equal(checkOf(facts({ config: { sessionSecret: 'invalid' } }), 'session').status, 'error');
    assert.equal(checkOf(facts(), 'session').status, 'ok');
  });

  test('with production only assumed (NODE_ENV unset), a missing secret is a warning', () => {
    const assumed = { name: 'production', explicit: false, source: null };
    const missing = checkOf(facts({ mode: assumed, config: { sessionGuards: 1 } }), 'session');
    assert.equal(missing.status, 'warn');
    assert.match(missing.detail, /NODE_ENV is unset/);
    assert.match(missing.detail, /gio doctor --dev/);
    assert.equal(checkOf(facts({ mode: assumed, nodeEnv: 'test', config: { sessionGuards: 1 } }), 'session').detail
      .includes('NODE_ENV is "test"'), true);
    // An invalid secret is broken in every mode.
    assert.equal(checkOf(facts({ mode: assumed, config: { sessionSecret: 'invalid' } }), 'session').status, 'error');
  });

  test('the checked mode: --dev / --prod, else NODE_ENV, else assumed production', () => {
    assert.deepEqual(checkedMode({}, 'development'), { name: 'development', explicit: true, source: '--dev' });
    assert.deepEqual(checkedMode({ NODE_ENV: 'development' }, 'production'), { name: 'production', explicit: true, source: '--prod' });
    assert.deepEqual(checkedMode({ NODE_ENV: 'development' }), { name: 'development', explicit: true, source: 'NODE_ENV' });
    assert.deepEqual(checkedMode({ NODE_ENV: 'production' }), { name: 'production', explicit: true, source: 'NODE_ENV' });
    assert.deepEqual(checkedMode({}), { name: 'production', explicit: false, source: null });
    assert.deepEqual(checkedMode({ NODE_ENV: 'test' }), { name: 'production', explicit: false, source: null });
    assert.match(formatMode(checkedMode({}), null), /production configuration \(what `gio start` runs\): NODE_ENV is unset\. Use --dev/);
    assert.match(formatMode(checkedMode({}, 'development'), null), /development configuration \(what `gio dev` runs\), as --dev asked/);
  });

  test('a busy port is a warning with another port to use', () => {
    const busy = checkOf(facts({ port: 'in-use' }), 'port');
    assert.equal(busy.status, 'warn');
    assert.match(busy.fix, /gio dev --port 3001/);
    assert.equal(checkOf(facts({ port: null }), 'port').status, 'skip');
    const v6 = checkOf(facts({ port: 'free', config: { listen: { host: '[::1]', port: 3000, portSource: 'gio.toml', tls: false } } }), 'port');
    assert.match(v6.title, /\(\[::1\]:3000, from gio\.toml\)/);
    const noV6 = checkOf(facts({ port: 'EAFNOSUPPORT', config: { listen: { host: '[::]', port: 3000, portSource: 'default', tls: false } } }), 'port');
    assert.match(noV6.title, /Cannot bind \[::\]:3000: this machine has no IPv6 support/);
  });

  test('the port probe binds IPv6 hosts written in brackets, as gio.toml has them', async () => {
    // Whatever this machine's IPv6 support ('free', or EAFNOSUPPORT without
    // it), [::1] must behave as ::1 - never a DNS lookup of "[::1]" (ENOTFOUND).
    for (const [bracketed, bare] of [['[::1]', '::1'], ['[::]', '::']]) {
      const state = await portState(bracketed, 0);
      assert.notEqual(state, 'ENOTFOUND');
      assert.equal(state, await portState(bare, 0), bracketed);
    }
  });

  test('trusted_proxies is suggested when a proxy is likely', () => {
    const docker = checkOf(facts({ proxyHintFiles: ['Dockerfile'] }), 'proxy');
    assert.equal(docker.status, 'info');
    assert.match(docker.detail, /Dockerfile/);
    assert.match(docker.fix, /trusted_proxies/);
    assert.equal(checkOf(facts({ config: { rateLimitRules: 1 } }), 'proxy').status, 'info');
    assert.equal(checkOf(facts({ proxyHintFiles: ['fly.toml'], config: { trustedProxies: 1 } }), 'proxy').status, 'ok');
  });

  test('an unwritable cache directory is an error', () => {
    const cache = checkOf(facts({ cacheDir: { path: '/ro/cache', writable: false, checked: '/ro' } }), 'cache');
    assert.equal(cache.status, 'error');
    assert.match(cache.fix, /GIO_CACHE_DIR/);
  });

  test('the summary counts errors and warnings', () => {
    const output = formatChecks(runChecks(facts({ port: 'in-use', node: '18.0.0' })));
    assert.match(output, /✗ Node\.js 18\.0\.0 is too old/);
    assert.match(output, /fix: Install Node\.js/);
    assert.match(output, /1 error, 1 warning\./);
  });
});

describe('info report', () => {
  test('carries versions and the binary for bug reports', () => {
    const report = infoReport(facts());
    assert.equal(report.gio, VERSION);
    assert.equal(report.platform, 'linux-x64 (glibc)');
    assert.equal(report.packageManager, 'npm 10.0.0');
    assert.equal(report.serverBinary.version, VERSION);
    assert.match(formatInfo(report), /Server binary +1\.2\.3 \(/);
    const missing = infoReport(facts({ binary: { found: false, reason: 'unsupported', key: 'freebsd-x64', packageName: null } }));
    assert.match(formatInfo(missing), /Server binary +not found \(unsupported\)/);
  });
});

describe('satisfiesRange', () => {
  test('understands the common engines forms', () => {
    const cases = [
      ['20.0.0', '>=20', true],
      ['18.20.0', '>=20', false],
      ['20.6.0', '>=20.6.0', true],
      ['20.5.1', '>=20.6', false],
      ['22.1.0', '^22.0.0', true],
      ['23.0.0', '^22', false],
      ['20.11.0', '~20.11.0', true],
      ['20.12.0', '~20.11.0', false],
      ['20.9.0', '20.x', true],
      ['21.0.0', '>=20 <21', false],
      ['18.19.0', '^18.19 || >=20', true],
      ['22.0.0', '>= 20', true],
      ['22.0.0', '*', true],
    ];
    for (const [version, range, expected] of cases) {
      assert.equal(satisfiesRange(version, range), expected, `${version} ${range}`);
    }
    assert.equal(satisfiesRange('22.0.0', 'latest'), null);
  });
});

describe('parseJsonc', () => {
  test('reads tsconfig files with comments and trailing commas', () => {
    const parsed = parseJsonc(`{
      // compiler options
      "compilerOptions": { "paths": { "@/*": ["./*"] }, }, /* block */
      "include": ["app", ".gio/routes.d.ts",],
    }`);
    assert.deepEqual(parsed.include, ['app', '.gio/routes.d.ts']);
    assert.deepEqual(parsed.compilerOptions.paths, { '@/*': ['./*'] });
  });
});

describe('gio doctor end to end', { skip: process.platform === 'win32' && 'fake binary needs a shebang' }, () => {
  test('--json reports checks and exits 1 when one fails', () => {
    const project = tempProject({
      'package.json': '{"name":"app"}',
      'tsconfig.json': '{ "include": ["app"] }',
      'gio.toml': '[[guards]]\npath = "/admin/*rest"\nrequire_session = true\nredirect_to = "/login"\n',
    });
    const { status, stdout } = run(['doctor', '--json'], {
      cwd: project,
      env: { GIO_SERVER_BIN: fakeServerBinary(), FAKE_SERVER_NO_CHECK: '1' },
    });
    assert.equal(status, 1);
    const report = JSON.parse(stdout);
    assert.equal(report.ok, false);
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c.status]));
    assert.equal(byId.app, 'error', 'no app/ directory');
    assert.equal(byId.tsconfig, 'warn');
    assert.equal(byId.config, 'skip', 'the fake binary cannot validate');
    assert.equal(byId.session, 'warn', 'guard without a secret (read by the fallback reader), production assumed');
    assert.deepEqual(report.mode, { name: 'production', explicit: false, source: null });
    assert.equal(report.environment.serverBinary.source, 'env');
  });

  test('a dev project passes with NODE_ENV unset; --prod checks what gio start needs', () => {
    // `gio dev` runs this project fine (ephemeral dev secret): doctor must
    // not fail it just because NODE_ENV is unset in the shell.
    const project = tempProject({
      'package.json': '{"name":"app"}',
      'tsconfig.json': '{ "include": ["app", ".gio/routes.d.ts"] }',
      'app/page.tsx': 'export default function Page() { return null; }\n',
      'gio.toml': '[[guards]]\npath = "/admin/*rest"\nrequire_session = true\nredirect_to = "/login"\n',
      '.env.development': `GIO_SESSION_SECRET=${'d'.repeat(32)}\n`,
    });
    const env = { GIO_SERVER_BIN: fakeServerBinary(), FAKE_SERVER_NO_CHECK: '1' };
    const sessionOf = (result) => JSON.parse(result.stdout).checks.find((c) => c.id === 'session');

    const assumed = run(['doctor', '--json'], { cwd: project, env });
    assert.equal(assumed.status, 0, assumed.stdout);
    assert.equal(sessionOf(assumed).status, 'warn');

    const prod = run(['doctor', '--json', '--prod'], { cwd: project, env });
    assert.equal(prod.status, 1);
    assert.equal(sessionOf(prod).status, 'error');
    assert.equal(JSON.parse(prod.stdout).mode.source, '--prod');

    // --dev reads .env.development, where this project keeps its secret.
    const dev = run(['doctor', '--json', '--dev'], { cwd: project, env });
    assert.equal(dev.status, 0, dev.stdout);
    assert.equal(sessionOf(dev).status, 'ok');
    assert.equal(JSON.parse(dev.stdout).mode.name, 'development');

    const text = run(['doctor'], { cwd: project, env });
    assert.match(text.stdout, /Checking the production configuration \(what `gio start` runs\): NODE_ENV is unset/);
    assert.equal(run(['doctor', '--dev', '--prod'], { cwd: project, env }).status, 2);
    assert.equal(run(['info', '--dev'], { cwd: project, env }).status, 2, 'info has no mode');
  });

  test('gio info --json needs no project', () => {
    const { status, stdout } = run(['info', '--json'], { cwd: tempProject({}) });
    assert.equal(status, 0);
    const report = JSON.parse(stdout);
    assert.equal(report.node, process.versions.node);
    assert.ok('@gio.js/core' in report.packages);
  });
});
