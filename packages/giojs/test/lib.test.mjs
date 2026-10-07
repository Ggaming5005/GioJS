/**
 * giojs/test/lib.test.mjs
 *
 * The CLI's pure helpers: did-you-mean, binary lookup and the missing-binary
 * message for every platform situation, the lenient gio.toml / .env reader
 * behind the listen-address fallback, URL building, the server environment
 * and browser command, and create-giojs delegation details.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tempProject } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { didYouMean } = require('../bin/lib/commands.js');
const findBinary = require('../bin/find-binary.js');
const {
  parseTomlLite, fallbackReport, serverUrls, connectBaseUrl, bareHost, displayAddress,
} = require('../bin/lib/config.js');
const { serverEnv, browserCommand, formatBanner } = require('../bin/lib/server.js');
const {
  execCommand, declaresSubcommand, parseViewOutput, registryManifest, installDevCommand, shellQuote,
} = require('../bin/lib/delegate.js');
const { targetUrl, explanationFor } = require('../bin/lib/cache-explain.js');
const { detectPackageManager, tsxEnv } = require('../bin/lib/project.js');

describe('didYouMean', () => {
  const commands = ['dev', 'start', 'build', 'routes', 'doctor', 'typegen'];
  test('finds typos, swaps and unambiguous prefixes', () => {
    assert.equal(didYouMean('strat', commands), 'start');
    assert.equal(didYouMean('buidl', commands), 'build');
    assert.equal(didYouMean('DEV', commands), 'dev');
    assert.equal(didYouMean('typgen', commands), 'typegen');
    assert.equal(didYouMean('doc', commands), 'doctor');
  });
  test('stays quiet when nothing is close', () => {
    assert.equal(didYouMean('xyzzy', commands), null);
    assert.equal(didYouMean('ab', commands), null);
  });
});

describe('locateBinary', () => {
  const noFiles = () => false;
  const base = { env: {}, workspaceRoot: null, exists: noFiles, resolvePackage: () => null };

  test('GIO_SERVER_BIN wins, and a missing one is reported as such', () => {
    const found = findBinary.locateBinary({ ...base, env: { GIO_SERVER_BIN: '/bin/x' }, exists: () => true });
    assert.equal(found.found, true);
    assert.equal(found.source, 'env');
    const missing = findBinary.locateBinary({ ...base, env: { GIO_SERVER_BIN: '/bin/x' } });
    assert.equal(missing.reason, 'env-missing');
  });

  test('the platform package binary, with its version', () => {
    const dir = tempProject({ 'package.json': '{"version":"9.9.9"}', 'bin/giojs-server': '' });
    const result = findBinary.locateBinary({
      ...base, key: 'linux-x64', platform: 'linux', resolvePackage: () => dir, exists: () => true,
    });
    assert.deepEqual(
      { found: result.found, source: result.source, version: result.version, path: result.path },
      { found: true, source: 'package', version: '9.9.9', path: join(dir, 'bin', 'giojs-server') },
    );
  });

  test('each missing case has its own reason', () => {
    const reason = (options) => findBinary.locateBinary({ ...base, ...options }).reason;
    assert.equal(reason({ key: 'linux-x64' }), 'not-installed');
    assert.equal(reason({ key: 'linux-arm64' }), 'unpublished');
    assert.equal(reason({ key: 'freebsd-x64' }), 'unsupported');
    assert.equal(reason({ key: 'win32-x64', resolvePackage: () => '/pkg' }), 'empty-package');
  });

  test('the musl build is picked on musl Linux', () => {
    assert.equal(findBinary.platformKey('linux', 'x64', true), 'linux-x64-musl');
    assert.equal(findBinary.platformKey('darwin', 'arm64', false), 'darwin-arm64');
  });
});

describe('missingBinaryMessage', () => {
  const message = (result, options = {}) => findBinary.missingBinaryMessage(
    { key: 'linux-x64', packageName: '@gio.js/server-linux-x64', ...result },
    { version: '1.2.3', ...options },
  );

  test('not installed: the pinned optional install and why it is usually missing', () => {
    const text = message({ reason: 'not-installed' });
    assert.match(text, /npm install --save-optional @gio\.js\/server-linux-x64@1\.2\.3/);
    assert.match(text, /--omit=optional/);
    assert.match(text, /lockfile was written on another OS/);
    assert.match(message({ reason: 'not-installed' }, { packageManager: 'yarn' }), /yarn add --optional/);
  });

  test('linux-arm64 is not shipped yet: build from source', () => {
    const text = message({ reason: 'unpublished', key: 'linux-arm64', packageName: '@gio.js/server-linux-arm64' });
    assert.match(text, /not published yet/);
    assert.match(text, /cargo build --release -p giojs-server/);
    assert.match(text, /GIO_SERVER_BIN/);
  });

  test('unsupported platforms list the prebuilt ones', () => {
    const text = message({ reason: 'unsupported', key: 'freebsd-x64', packageName: null });
    assert.match(text, /no prebuilt server binary for this platform \(freebsd-x64\)/);
    assert.match(text, /linux-x64, linux-x64-musl, win32-x64/);
    assert.doesNotMatch(text, /linux-arm64,/);
  });

  test('the path getter throws the message, not a lookup error', () => {
    const saved = process.env.GIO_SERVER_BIN;
    process.env.GIO_SERVER_BIN = '/nonexistent/giojs-server';
    try {
      assert.throws(() => findBinary.path, (err) => err.code === 'GIO_BINARY_NOT_FOUND' &&
        /GIO_SERVER_BIN points at/.test(err.message));
    } finally {
      if (saved === undefined) delete process.env.GIO_SERVER_BIN;
      else process.env.GIO_SERVER_BIN = saved;
    }
  });
});

describe('parseTomlLite', () => {
  test('reads the keys the CLI needs and ignores the rest', () => {
    const parsed = parseTomlLite(`
# comment
[server]
host = "127.0.0.1" # trailing comment
port = 8_080
trusted_proxies = [
  "10.0.0.0/8", # private
  "::1",
]
[server.tls]
enabled = true

[[guards]]
path = "/admin/*rest"
require_session = true
redirect_to = "/login#top"

[[guards]]
path = "/x"
require_cookie = 'token'
redirect_to = "/"

[headers.inline]
value = { a = 1 }
`);
    assert.equal(parsed.server.host, '127.0.0.1');
    assert.equal(parsed.server.port, 8080);
    assert.deepEqual(parsed.server.trusted_proxies, ['10.0.0.0/8', '::1']);
    assert.equal(parsed.server.tls.enabled, true);
    assert.equal(parsed.guards.length, 2);
    assert.equal(parsed.guards[0].redirect_to, '/login#top');
    assert.equal(parsed.guards[1].require_cookie, 'token');
    assert.equal(parsed.headers.inline.value, undefined);
  });

  test('never throws on garbage', () => {
    assert.deepEqual(parseTomlLite('[[[\n= = =\n"unterminated'), {});
  });
});

describe('fallbackReport', () => {
  test('resolves the listen address env > .env files > gio.toml > default', () => {
    const project = tempProject({
      'gio.toml': '[server]\nport = 4000\nhost = "127.0.0.1"\n',
      '.env': 'GIO_PORT=5000\n',
      '.env.development': 'export GIO_PORT="6000" # dev\n',
    });
    assert.equal(fallbackReport({}, project).listen.port, 5000);
    assert.equal(fallbackReport({}, project).listen.portSource, 'GIO_PORT');
    assert.equal(fallbackReport({ NODE_ENV: 'development' }, project).listen.port, 6000);
    assert.equal(fallbackReport({ GIO_PORT: '7000' }, project).listen.port, 7000);
    assert.equal(fallbackReport({}, project).listen.host, '127.0.0.1');
    const bare = fallbackReport({}, tempProject({}));
    assert.deepEqual(bare.listen, { host: '0.0.0.0', port: 3000, portSource: 'default', tls: false });
    assert.equal(bare.configFile, null);
    assert.equal(bare.fallback, true);
  });

  test('reads guards, the session secret and the cache directory', () => {
    const project = tempProject({
      'gio.toml': '[[guards]]\npath = "/a"\nrequire_session = true\nredirect_to = "/"\n' +
        '[cache]\ndisk_path = "data/cache"\n',
    });
    const report = fallbackReport({}, project);
    assert.equal(report.sessionGuards, 1);
    assert.equal(report.sessionSecret, 'unset');
    assert.equal(report.cacheDir, join(project, 'data/cache'));
    assert.equal(fallbackReport({ GIO_SESSION_SECRET: 'short' }, project).sessionSecret, 'invalid');
    assert.equal(fallbackReport({ GIO_SESSION_SECRET: 'x'.repeat(32) }, project).sessionSecret, 'valid');
  });

  test('skips the .env files when [env] files or GIO_ENV_FILES turns them off, as the server does', () => {
    const files = { '.env': 'GIO_PORT=5000\n' };
    const on = tempProject({ ...files, 'gio.toml': '[server]\nport = 4000\n' });
    const off = tempProject({ ...files, 'gio.toml': '[server]\nport = 4000\n\n[env]\nfiles = false\n' });
    assert.equal(fallbackReport({}, on).listen.port, 5000);
    assert.equal(fallbackReport({}, on).envFilesDisabledBy, null);
    assert.equal(fallbackReport({}, off).listen.port, 4000);
    assert.equal(fallbackReport({}, off).envFilesDisabledBy, '[env] files');
    assert.equal(fallbackReport({ GIO_ENV_FILES: '0' }, on).listen.port, 4000);
    assert.equal(fallbackReport({ GIO_ENV_FILES: '0' }, on).envFilesDisabledBy, 'GIO_ENV_FILES');
    assert.equal(fallbackReport({ GIO_ENV_FILES: '1' }, off).listen.port, 5000, 'the variable wins');
  });
});

describe('URLs', () => {
  const interfaces = {
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    eth0: [
      { address: '192.168.1.20', family: 'IPv4', internal: false },
      { address: 'fe80::1', family: 'IPv6', internal: false },
    ],
  };

  test('a wildcard host prints localhost plus every LAN address', () => {
    assert.deepEqual(serverUrls({ host: '0.0.0.0', port: 3000, tls: false }, interfaces), {
      local: 'http://localhost:3000',
      network: ['http://192.168.1.20:3000'],
    });
  });

  test('loopback hosts are not exposed; a specific address is its own network URL', () => {
    assert.deepEqual(serverUrls({ host: '127.0.0.1', port: 80, tls: false }, interfaces).network, []);
    assert.deepEqual(serverUrls({ host: '10.0.0.5', port: 443, tls: true }, interfaces), {
      local: 'https://10.0.0.5:443',
      network: ['https://10.0.0.5:443'],
    });
  });

  test('requests go to loopback for wildcard hosts', () => {
    assert.equal(connectBaseUrl({ host: '0.0.0.0', port: 3000, tls: false }), 'http://127.0.0.1:3000');
    assert.equal(connectBaseUrl({ host: '::', port: 3000, tls: true }), 'https://[::1]:3000');
    assert.equal(connectBaseUrl({ host: '10.1.2.3', port: 8080, tls: false }), 'http://10.1.2.3:8080');
  });

  test('IPv6 hosts as the server reports them (bracketed) are understood', () => {
    // [::1] is loopback: the local URL only, never a "network" URL.
    assert.deepEqual(serverUrls({ host: '[::1]', port: 3000, tls: false }, interfaces), {
      local: 'http://localhost:3000',
      network: [],
    });
    // [::] is the wildcard, like 0.0.0.0.
    assert.deepEqual(serverUrls({ host: '[::]', port: 3000, tls: false }, interfaces), {
      local: 'http://localhost:3000',
      network: ['http://192.168.1.20:3000'],
    });
    assert.deepEqual(serverUrls({ host: '[2001:db8::5]', port: 8080, tls: false }, interfaces), {
      local: 'http://[2001:db8::5]:8080',
      network: ['http://[2001:db8::5]:8080'],
    });
    assert.equal(connectBaseUrl({ host: '[::]', port: 3000, tls: false }), 'http://[::1]:3000');
    assert.equal(connectBaseUrl({ host: '[::1]', port: 3000, tls: false }), 'http://[::1]:3000');
    assert.equal(bareHost('[::1]'), '::1');
    assert.equal(bareHost('127.0.0.1'), '127.0.0.1');
    assert.equal(displayAddress('[::1]', 3000), '[::1]:3000');
    assert.equal(displayAddress('::1', 3000), '[::1]:3000');
    assert.equal(displayAddress('0.0.0.0', 3000), '0.0.0.0:3000');
  });

  test('cache explain targets', () => {
    assert.equal(targetUrl('/posts/1', 'http://127.0.0.1:4000/'), 'http://127.0.0.1:4000/posts/1');
    assert.equal(targetUrl('https://example.com/a', 'http://127.0.0.1:4000'), 'https://example.com/a');
  });

  test('cache explain: bypass covers refusals that never reached Node', () => {
    const bypass = explanationFor('bypass');
    assert.doesNotMatch(bypass, /^Rendered/, 'a refused request was not rendered');
    assert.match(bypass, /refused by the\s+server itself/);
  });
});

describe('server launch helpers', () => {
  test('serverEnv sets the mode, listen overrides and orphan protection', () => {
    const env = serverEnv({ base: { NODE_ENV: 'test', PATH: '/bin' }, mode: 'production', port: 0, host: '::1' });
    assert.equal(env.NODE_ENV, 'production');
    assert.equal(env.GIO_PORT, '0');
    assert.equal(env.GIO_HOST, '::1');
    assert.equal(env.GIO_EXIT_ON_STDIN_EOF, '1');
    assert.equal(env.PATH, '/bin');
    const kept = serverEnv({ base: { NODE_ENV: 'development', GIO_TSX_PKG: '/mine' }, worker: { tsxPkg: '/found' } });
    assert.equal(kept.NODE_ENV, 'development');
    assert.equal(kept.GIO_TSX_PKG, '/mine', 'an explicit GIO_TSX_PKG wins');
    assert.equal('GIO_PORT' in kept, false);
  });

  test('browserCommand per platform', () => {
    assert.deepEqual(browserCommand('http://localhost:3000', 'darwin'), { command: 'open', args: ['http://localhost:3000'] });
    assert.deepEqual(browserCommand('http://localhost:3000', 'linux'), { command: 'xdg-open', args: ['http://localhost:3000'] });
    assert.equal(browserCommand('http://localhost:3000', 'win32').command, 'cmd');
  });

  test('the banner lists every URL', () => {
    const banner = formatBanner({
      mode: 'development',
      version: '1.2.3',
      urls: { local: 'http://localhost:3000', network: ['http://192.168.1.20:3000'] },
    });
    assert.match(banner, /GioJS 1\.2\.3 \(dev\)/);
    assert.match(banner, /- Local: {4}http:\/\/localhost:3000/);
    assert.match(banner, /- Network: {2}http:\/\/192\.168\.1\.20:3000/);
  });
});

describe('create-giojs delegation', () => {
  test('a subcommand exists when create-giojs/<name> is exported, never by running it', () => {
    const current = { version: '1.2.3', exports: { './migrate': './dist/migrate-command.js', './package.json': './package.json' } };
    assert.equal(declaresSubcommand(current, 'migrate'), true);
    assert.equal(declaresSubcommand(current, 'add'), false);
    // Published releases up to 0.1.0-beta.7 have no exports map at all.
    assert.equal(declaresSubcommand({ version: '0.1.0-beta.7', bin: { 'create-giojs': 'dist/index.js' } }, 'migrate'), false);
    assert.equal(declaresSubcommand(null, 'migrate'), false);
    assert.equal(declaresSubcommand({ exports: './dist/index.js' }, 'migrate'), false);
    assert.equal(declaresSubcommand({ exports: { '.': './x.js' } }, 'toString'), false, 'no prototype keys');
  });

  test('npm view answers: exports object, bare version, or nothing usable', () => {
    assert.deepEqual(parseViewOutput('{"version":"1.2.3","exports":{"./add":"./dist/add.js"}}'),
      { version: '1.2.3', exports: { './add': './dist/add.js' } });
    assert.deepEqual(parseViewOutput('"0.1.0-beta.7"\n'), { version: '0.1.0-beta.7' });
    assert.equal(parseViewOutput(''), null);
    assert.equal(parseViewOutput('{"error":{"code":"E404"}}'), null);
    assert.equal(parseViewOutput('not json'), null);
  });

  test('the registry lookup runs npm view only, and reports why it failed', () => {
    const calls = [];
    const answer = (result) => (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: '', stderr: '', ...result };
    };
    const found = registryManifest('1.2.3', {
      platform: 'linux',
      spawn: answer({ stdout: '{"version":"1.2.3","exports":{"./migrate":"./m.js"}}' }),
    });
    assert.deepEqual(found, { ok: true, manifest: { version: '1.2.3', exports: { './migrate': './m.js' } } });
    assert.equal(calls[0].command, 'npm');
    assert.deepEqual(calls[0].args, ['view', 'create-giojs@1.2.3', 'version', 'exports', '--json']);
    assert.equal(calls[0].options.shell, false);

    const missing = registryManifest('9.9.9', {
      platform: 'linux',
      spawn: answer({
        status: 1,
        stdout: '{"error":{"code":"E404","summary":"No match found for version 9.9.9"}}',
        stderr: 'npm error code E404\nnpm error 404 No match found for version 9.9.9\n',
      }),
    });
    assert.deepEqual(missing, { ok: false, reason: 'No match found for version 9.9.9' });

    const noNpm = registryManifest('1.2.3', { platform: 'linux', spawn: answer({ error: new Error('spawn npm ENOENT'), status: null }) });
    assert.equal(noNpm.ok, false);
    assert.match(noNpm.reason, /npm could not run: spawn npm ENOENT/);

    registryManifest('1.2.3', { platform: 'win32', spawn: answer({ stdout: '"1.2.3"' }) });
    assert.equal(calls[calls.length - 1].command, 'npm view create-giojs@1.2.3 version exports --json', 'a .cmd shim needs a shell');
  });

  test('install hints follow the package manager', () => {
    assert.equal(installDevCommand('create-giojs@1.2.3', 'npm'), 'npm install --save-dev create-giojs@1.2.3');
    assert.equal(installDevCommand('create-giojs@1.2.3', 'pnpm'), 'pnpm add --save-dev create-giojs@1.2.3');
    assert.equal(installDevCommand('create-giojs@1.2.3', 'bun'), 'bun add --dev create-giojs@1.2.3');
  });

  test('runs create-giojs@<version> through the detected package manager', () => {
    assert.deepEqual(execCommand('npm', '1.2.3', 'linux'), {
      command: 'npx', args: ['create-giojs@1.2.3'], label: 'npx create-giojs@1.2.3', shell: false,
    });
    assert.equal(execCommand('pnpm', '1.2.3', 'linux').label, 'pnpm dlx create-giojs@1.2.3');
    assert.equal(execCommand('bun', '1.2.3', 'linux').command, 'bunx');
    assert.equal(execCommand('npm', '1.2.3', 'win32').shell, true);
    assert.equal(shellQuote('./my app'), '"./my app"');
    assert.equal(shellQuote('--dry-run'), '--dry-run');
  });

  test('tsx children get the project tsconfig (else jsconfig), unless the env names one', () => {
    const project = tempProject({ 'jsconfig.json': '{}' });
    assert.equal(tsxEnv({ A: '1' }, project).TSX_TSCONFIG_PATH, join(project, 'jsconfig.json'));
    const both = tempProject({ 'tsconfig.json': '{}', 'jsconfig.json': '{}' });
    const env = tsxEnv({ A: '1' }, both);
    assert.equal(env.TSX_TSCONFIG_PATH, join(both, 'tsconfig.json'));
    assert.equal(env.A, '1');
    assert.deepEqual(tsxEnv({ TSX_TSCONFIG_PATH: '/own.json' }, both), { TSX_TSCONFIG_PATH: '/own.json' });
    // Neither file (a directory of that name is not one): tsx keeps its own lookup.
    const none = tempProject({ 'tsconfig.json/x': '' });
    assert.deepEqual(tsxEnv({ A: '1' }, none), { A: '1' });
  });

  test('package manager detection: user agent, then lockfile', () => {
    assert.deepEqual(detectPackageManager({ npm_config_user_agent: 'pnpm/9.1.0 npm/? node/v22' }, '/x'),
      { name: 'pnpm', version: '9.1.0' });
    const exists = (path) => path.endsWith('yarn.lock');
    assert.equal(detectPackageManager({}, '/x', exists).name, 'yarn');
    assert.equal(detectPackageManager({}, '/x', () => false).name, 'npm');
  });
});
