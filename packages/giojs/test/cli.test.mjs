/**
 * giojs/test/cli.test.mjs
 *
 * The gio command end to end, in child processes: help, version, unknown
 * commands and options (exit 2 with a did-you-mean), the missing-binary
 * message (exit 1, no stack trace), how dev/start/giojs-server hand
 * NODE_ENV, --port and --host to the server binary (a fake that records its
 * environment), the ready banner, `gio routes` / `gio typegen` against a
 * temp app, `gio cache explain`'s default base, and `gio add`'s delegation.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import {
  compatBin,
  cleanEnv,
  fakeServerBinary,
  freePort,
  gioBin,
  hasStackTrace,
  packageDir,
  run,
  runAsync,
  tempDir,
  tempProject,
} from './helpers.mjs';

const require = createRequire(import.meta.url);
const { COMMANDS } = require('../bin/lib/commands.js');
const posix = process.platform !== 'win32';

describe('help and version', () => {
  test('gio --help lists every command and the exit codes', () => {
    const { status, stdout } = run(['--help']);
    assert.equal(status, 0);
    for (const name of Object.keys(COMMANDS)) assert.match(stdout, new RegExp(`^  ${name} `, 'm'));
    assert.match(stdout, /Exit codes:/);
    assert.match(stdout, /2 {2}usage error/);
  });

  test('gio help <command> and gio <command> --help show the same command help', () => {
    const viaHelp = run(['help', 'dev']);
    const viaFlag = run(['dev', '--help']);
    assert.equal(viaHelp.status, 0);
    assert.equal(viaFlag.status, 0);
    assert.equal(viaHelp.stdout, viaFlag.stdout);
    assert.match(viaHelp.stdout, /^Usage: gio dev/);
    assert.match(viaHelp.stdout, /--port <port>/);
    assert.match(viaHelp.stdout, /--open/);
  });

  test('every command has help', () => {
    for (const name of Object.keys(COMMANDS)) {
      const { status, stdout } = run(['help', name]);
      assert.equal(status, 0, name);
      assert.match(stdout, new RegExp(`^Usage: gio ${name}`), name);
    }
  });

  test('gio help <unknown> is a usage error', () => {
    const { status, stderr } = run(['help', 'nope']);
    assert.equal(status, 2);
    assert.match(stderr, /unknown command "nope"/);
  });

  test('bare gio prints help to stderr and exits 2 instead of starting a server', () => {
    const { status, stdout, stderr } = run([]);
    assert.equal(status, 2);
    assert.equal(stdout, '');
    assert.match(stderr, /^Usage: gio <command>/);
    assert.match(stderr, /gio dev \(development\) or gio start \(production\)/);
  });

  test('gio --version reports the CLI, server binary and @gio.js/core', () => {
    const ownVersion = require('../package.json').version;
    const { status, stdout } = run(['--version'], { env: { GIO_SERVER_BIN: process.execPath } });
    assert.equal(status, 0);
    assert.match(stdout, new RegExp(`^gio +${ownVersion.replace(/\./g, '\\.')} \\(@gio.js/server\\)$`, 'm'));
    assert.match(stdout, /^server binary +GIO_SERVER_BIN \(/m);
    assert.match(stdout, /^@gio.js\/core +\d+\.\d+\.\d+/m);
    assert.equal(run(['-v'], { env: { GIO_SERVER_BIN: process.execPath } }).stdout, stdout);
  });

  test('gio --version without a binary still answers', () => {
    const { status, stdout, stderr } = run(['--version'], { env: { GIO_SERVER_BIN: '/nonexistent/giojs-server' } });
    assert.equal(status, 0, stderr);
    assert.match(stdout, /^server binary +not installed/m);
  });
});

describe('unknown commands and options', () => {
  test('a typo suggests the closest command', () => {
    for (const [typo, command] of [['strat', 'start'], ['dve', 'dev'], ['doc', 'doctor'], ['rotues', 'routes']]) {
      const { status, stdout, stderr } = run([typo]);
      assert.equal(status, 2, typo);
      assert.equal(stdout, '');
      assert.match(stderr, new RegExp(`unknown command "${typo}" - did you mean \`gio ${command}\`\\?`), typo);
    }
  });

  test('common non-commands get a pointer', () => {
    assert.match(run(['serve']).stderr, /try `gio start`/);
    assert.match(run(['create']).stderr, /try `npm create giojs@latest`/);
  });

  test('gibberish gets no suggestion', () => {
    const { status, stderr } = run(['xyzzy']);
    assert.equal(status, 2);
    assert.match(stderr, /unknown command "xyzzy"\n/);
  });

  test('unknown options are usage errors with a suggestion', () => {
    const typo = run(['dev', '--prot', '4000']);
    assert.equal(typo.status, 2);
    assert.match(typo.stderr, /unknown option "--prot" - did you mean --port\?/);
    assert.match(typo.stderr, /Run `gio dev --help`/);
    const global = run(['--frobnicate']);
    assert.equal(global.status, 2);
    assert.match(global.stderr, /unknown option "--frobnicate"/);
  });

  test('bad --port and --host values are usage errors', () => {
    assert.match(run(['start', '--port', 'abc']).stderr, /--port expects a port number/);
    assert.equal(run(['start', '--port', '70000']).status, 2);
    const host = run(['dev', '--host', 'example.com']);
    assert.equal(host.status, 2);
    assert.match(host.stderr, /--host expects an IP address/);
    for (const bad of ['[127.0.0.1]', '[::1', '[]', '::1]']) {
      assert.equal(run(['dev', '--host', bad]).status, 2, bad);
    }
  });

  test('build and cache subcommands are checked', () => {
    const build = run(['build', 'standalon']);
    assert.equal(build.status, 2);
    assert.match(build.stderr, /did you mean `gio build standalone`\?/);
    const cache = run(['cache', 'explian', '/']);
    assert.equal(cache.status, 2);
    assert.match(cache.stderr, /did you mean `gio cache explain`\?/);
    assert.equal(run(['cache']).status, 2);
    assert.equal(run(['cache', 'explain']).status, 2);
  });

  test('plain gio build still explains deploys', () => {
    const { status, stdout } = run(['build']);
    assert.equal(status, 0);
    assert.match(stdout, /no build step for normal deploys/);
    assert.match(stdout, /gio build standalone/);
  });
});

describe('gio build standalone --out', () => {
  test('refuses an --out it would destroy: the project, an ancestor, app/, a foreign directory', () => {
    const project = tempProject({
      'gio.toml': '[app]\nname = "keep"\n',
      'IMPORTANT.txt': 'do not delete\n',
      'app/page.tsx': 'export default function Page() { return null; }\n',
      'notes/todo.txt': 'mine\n',
    });
    // The out check runs before the server binary is needed; a dummy keeps
    // a build that got past it from failing for that reason instead.
    const env = { GIO_STANDALONE_SERVER_BIN: join(project, 'IMPORTANT.txt') };
    for (const [out, message] of [
      ['.', /is the project directory or contains it/],
      ['..', /is the project directory or contains it/],
      ['app', /inside the app directory/],
      ['app/out', /inside the app directory/],
      ['notes', /is not empty and is not a previous standalone build/],
      ['IMPORTANT.txt', /is not a directory/],
    ]) {
      const result = run(['build', 'standalone', '--out', out], { cwd: project, env });
      assert.equal(result.status, 1, `--out ${out}: ${result.stdout}${result.stderr}`);
      assert.match(result.stderr, message, `--out ${out}`);
      assert.ok(!hasStackTrace(result.stderr), result.stderr);
    }
    for (const file of ['gio.toml', 'IMPORTANT.txt', 'app/page.tsx', 'notes/todo.txt']) {
      assert.ok(existsSync(join(project, file)), `${file} was deleted`);
    }
  });
});

describe('missing server binary', () => {
  test('gio start says what to fix, exits 1, never prints a stack trace', () => {
    const { status, stdout, stderr } = run(['start'], { env: { GIO_SERVER_BIN: '/nonexistent/giojs-server' } });
    assert.equal(status, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /GIO_SERVER_BIN points at \/nonexistent\/giojs-server/);
    assert.equal(hasStackTrace(stderr), false, stderr);
  });

  test('the giojs-server bin reports it the same way', () => {
    const { status, stderr } = run([], { bin: compatBin, env: { GIO_SERVER_BIN: '/nonexistent/giojs-server' } });
    assert.equal(status, 1);
    assert.match(stderr, /GIO_SERVER_BIN points at/);
    assert.equal(hasStackTrace(stderr), false, stderr);
  });
});

describe('dev / start / giojs-server environment', { skip: !posix && 'fake binary needs a shebang' }, () => {
  let binary;
  before(() => {
    binary = fakeServerBinary();
  });

  function recorded(args, env = {}, bin = gioBin) {
    const out = join(tempDir(), 'server.json');
    const result = run(args, { bin, env: { GIO_SERVER_BIN: binary, FAKE_SERVER_OUT: out, ...env } });
    assert.ok(existsSync(out), `the fake server did not run:\n${result.stderr}`);
    return { ...result, server: JSON.parse(readFileSync(out, 'utf8')) };
  }

  test('gio dev runs the server in development with --port/--host as GIO_PORT/GIO_HOST', () => {
    const { status, server } = recorded(['dev', '--port', '4567', '--host', '127.0.0.1']);
    assert.equal(status, 0);
    assert.equal(server.env.NODE_ENV, 'development');
    assert.equal(server.env.GIO_PORT, '4567');
    assert.equal(server.env.GIO_HOST, '127.0.0.1');
    assert.equal(server.env.GIO_EXIT_ON_STDIN_EOF, '1', 'orphan protection');
    assert.deepEqual(server.argv, [], 'no CLI arguments reach the binary');
  });

  test('gio start forces production and maps -H localhost to 127.0.0.1', () => {
    const { server } = recorded(['start', '-p', '8080', '-H', 'localhost'], { NODE_ENV: 'development' });
    assert.equal(server.env.NODE_ENV, 'production');
    assert.equal(server.env.GIO_PORT, '8080');
    assert.equal(server.env.GIO_HOST, '127.0.0.1');
  });

  test('IPv6 --host values reach the server bracketed, as GIO_HOST requires', () => {
    for (const [flag, expected] of [['::', '[::]'], ['[::]', '[::]'], ['::1', '[::1]'], ['[::1]', '[::1]'], ['2001:db8::5', '[2001:db8::5]']]) {
      const { status, server } = recorded(['start', '--host', flag]);
      assert.equal(status, 0, flag);
      assert.equal(server.env.GIO_HOST, expected, flag);
    }
  });

  test('without flags the listen variables are left to PORT and gio.toml', () => {
    const { server } = recorded(['start'], { PORT: '9999' });
    assert.equal(server.env.GIO_PORT, undefined);
    assert.equal(server.env.GIO_HOST, undefined);
    assert.equal(server.env.PORT, '9999');
  });

  test('the server exit code becomes the CLI exit code', () => {
    assert.equal(recorded(['start'], { FAKE_SERVER_EXIT: '3' }).status, 3);
  });

  test('giojs-server keeps NODE_ENV and passes its arguments through', () => {
    const { status, server } = recorded(['--some-flag'], { NODE_ENV: 'development' }, compatBin);
    assert.equal(status, 0);
    assert.equal(server.env.NODE_ENV, 'development');
    assert.deepEqual(server.argv, ['--some-flag']);
    assert.equal(server.env.GIO_EXIT_ON_STDIN_EOF, '1');
    assert.equal(recorded([], {}, compatBin).server.env.NODE_ENV, undefined);
  });

  for (const [label, extraEnv] of [
    ['--check-config', {}],
    ['a binary without --check-config', { FAKE_SERVER_NO_CHECK: '1' }],
    // The server binds only once a worker is ready, so any answer will do.
    ['[health] enabled = false', { FAKE_SERVER_HEALTH: 'off' }],
  ]) {
    test(`the local URL is printed once /_gio/health reports nodeReady (${label})`, async () => {
      const port = await freePort();
      const child = spawn(process.execPath, [gioBin, 'start', '--port', String(port), '--host', '127.0.0.1'], {
        env: cleanEnv({ GIO_SERVER_BIN: binary, FAKE_SERVER_MODE: 'serve', ...extraEnv }),
      });
      let stdout = '';
      const banner = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 20_000);
        child.stdout.on('data', (chunk) => {
          stdout += chunk;
          if (stdout.includes('Local:')) {
            clearTimeout(timer);
            resolve(stdout);
          }
        });
      });
      const exited = new Promise((resolve) => child.on('exit', resolve));
      child.kill('SIGTERM');
      await exited;
      assert.ok(banner, `no banner printed:\n${stdout}`);
      assert.match(banner, new RegExp(`- Local: +http://localhost:${port}\\n`));
      assert.match(banner, /- Network: +not exposed/);
      assert.match(banner, /\(production\)/);
    });
  }
});

describe('gio routes / gio typegen', () => {
  const PAGE = 'export default function Page() { return null; }\n';
  let project;
  before(() => {
    project = tempProject({
      'app/layout.tsx': PAGE,
      'app/page.tsx': PAGE,
      'app/posts/[id]/page.tsx': PAGE,
      'app/api/hello/route.ts': 'console.log("route module side effect");\nexport function GET() { return {}; }\n',
      'app/chat/route.ts': 'export function wsHandler() {}\n',
      'app/robots.ts': 'export default { rules: [] };\n',
    });
  });

  test('--json lists every route without starting a server', () => {
    const { status, stdout, stderr } = run(['routes', '--json'], { cwd: project });
    assert.equal(status, 0, stderr);
    const { routes } = JSON.parse(stdout);
    const summary = routes.map((r) => `${r.pattern} ${r.kind} ${r.methods.join(',')}`);
    assert.deepEqual(summary, [
      '/ page GET',
      '/api/hello route GET',
      '/chat websocket ',
      '/posts/:id page GET',
      '/robots.txt metadata GET',
    ]);
    const post = routes.find((r) => r.pattern === '/posts/:id');
    assert.deepEqual(post.params, [{ name: 'id', catchAll: false, optional: false }]);
    assert.deepEqual(post.layouts, ['app/layout.tsx']);
    // A route module's own output is kept off stdout.
    assert.match(stderr, /route module side effect/);
  });

  test('the table shows types, files and layouts', () => {
    const { status, stdout } = run(['routes'], { cwd: project });
    assert.equal(status, 0);
    assert.match(stdout, /^Route +Type +File +Wrapped by$/m);
    assert.match(stdout, /^\/posts\/:id +page +app\/posts\/\[id\]\/page\.tsx +layout app\/$/m);
    assert.match(stdout, /^\/api\/hello +route GET +app\/api\/hello\/route\.ts$/m);
    assert.match(stdout, /^5 routes, 1 dynamic/m);
  });

  test('typegen writes .gio/routes.d.ts, then reports it up to date', () => {
    const first = run(['typegen'], { cwd: project });
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /wrote .*routes\.d\.ts \(3 routes\)/);
    const types = readFileSync(join(project, '.gio', 'routes.d.ts'), 'utf8');
    assert.match(types, /'\/posts\/:id': \{ id: string \};/);
    assert.match(types, /'\/api\/hello': Record<string, never>;/);
    assert.ok(existsSync(join(project, '.gio', 'css-modules.d.ts')));
    const second = run(['typegen'], { cwd: project });
    assert.match(second.stdout, /is up to date/);
  });

  test('a route.ts that throws at import is marked, with what the server does about it', () => {
    const broken = tempProject({
      'app/page.tsx': PAGE,
      'app/api/broken/route.ts': 'throw new Error("REQ_VAR is not set");\nexport function GET() { return {}; }\n',
    });
    const { status, stdout, stderr } = run(['routes'], { cwd: broken });
    assert.equal(status, 0, stderr);
    assert.match(stdout, /^\/api\/broken +route \(failed to load\) +app\/api\/broken\/route\.ts/m);
    assert.match(stdout, /^! app\/api\/broken\/route\.ts failed to load - the server answers 500 for its URL .*1011.*: REQ_VAR is not set$/m);
    assert.doesNotMatch(stdout, /skips/);
  });

  test('a route conflict fails with the boot error', () => {
    const conflicted = tempProject({
      'app/(a)/about/page.tsx': PAGE,
      'app/(b)/about/page.tsx': PAGE,
    });
    const { status, stderr } = run(['routes'], { cwd: conflicted });
    assert.equal(status, 1);
    assert.match(stderr, /route conflict/);
    assert.equal(hasStackTrace(stderr), false, stderr);
  });

  test('outside a project both fail and write nothing', () => {
    const elsewhere = tempDir();
    for (const command of ['typegen', 'routes']) {
      const { status, stdout, stderr } = run([command], { cwd: elsewhere });
      assert.equal(status, 1, `${command}: ${stdout}`);
      assert.match(stderr, new RegExp(`gio ${command}: no app/ directory at .*\\n.*project root.*GIO_APP_DIR`));
    }
    assert.equal(existsSync(join(elsewhere, '.gio')), false, 'no stray .gio/');
    const missing = run(['typegen'], { cwd: project, env: { GIO_APP_DIR: 'src/app' } });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /no app\/ directory at .*src[\\/]app/);
  });
});

describe('gio export / gio routes outside the project', () => {
  // A project whose tsconfig selects the automatic JSX runtime (a page with
  // no React import) and maps `@lib/*`: both work only with that tsconfig,
  // not the cwd's.
  const LAYOUT = 'export default function RootLayout({ children }: { children: unknown }) {\n' +
    '  return <html lang="en"><body>{children as never}</body></html>;\n}\n';
  let project;
  before(() => {
    project = tempProject({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { jsx: 'react-jsx', strict: true, baseUrl: '.', paths: { '@lib/*': ['lib/*'] } },
      }),
      'lib/greet.ts': 'export const greet = () => ({ hello: true });\n',
      'app/layout.tsx': LAYOUT,
      'app/page.tsx': 'export default function Home() {\n  return <p>EXPORT_AUTOMATIC_JSX</p>;\n}\n',
      // Resolves only through the tsconfig's `paths`.
      'app/api/hello/route.ts': "import { greet } from '@lib/greet';\nexport function GET() { return greet(); }\n",
    });
    const coreModules = join(packageDir, '..', 'giojs-core', 'node_modules');
    mkdirSync(join(project, 'node_modules'));
    for (const dep of ['react', 'react-dom']) {
      symlinkSync(join(coreModules, dep), join(project, 'node_modules', dep), 'junction');
    }
  });

  test('gio export compiles the app with the project tsconfig, whatever the cwd', () => {
    const out = join(tempDir(), 'out');
    const { status, stdout, stderr } = run(['export'], {
      cwd: tempDir(),
      env: { GIO_APP_DIR: join(project, 'app'), GIO_OUT_DIR: out },
    });
    assert.equal(status, 0, `${stdout}\n${stderr}`);
    assert.doesNotMatch(stdout + stderr, /React is not defined/);
    assert.match(readFileSync(join(out, 'index.html'), 'utf8'), /EXPORT_AUTOMATIC_JSX/);
  });

  test('gio routes loads route modules with the project tsconfig, whatever the cwd', () => {
    const { status, stdout, stderr } = run(['routes', '--json'], {
      cwd: tempDir(),
      env: { GIO_APP_DIR: join(project, 'app') },
    });
    assert.equal(status, 0, stderr);
    assert.doesNotMatch(stdout, /failed to load/);
    const hello = JSON.parse(stdout).routes.find((r) => r.pattern === '/api/hello');
    assert.deepEqual(hello.methods, ['GET']);
  });
});

describe('gio cache explain base URL', { skip: !posix && 'fake binary needs a shebang' }, () => {
  let binary;
  let server;
  let port;
  const seen = [];
  before(async () => {
    binary = fakeServerBinary();
    port = await freePort();
    server = createServer((req, res) => {
      seen.push(req.url);
      res.setHeader('x-gio-cache', 'hit; ttl=30');
      res.end('ok');
    });
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  });

  test('a path goes to gio.toml\'s port when no binary answers --check-config', async (t) => {
    t.after(() => server.close());
    const project = tempProject({ 'gio.toml': `[server]\nport = ${port}\nhost = "0.0.0.0"\n` });
    const fromToml = await runAsync(['cache', 'explain', '/posts/1'], {
      cwd: project,
      env: { GIO_SERVER_BIN: binary, FAKE_SERVER_NO_CHECK: '1' },
    });
    assert.equal(fromToml.status, 0, fromToml.stderr);
    assert.match(fromToml.stdout, new RegExp(`GET http://127\\.0\\.0\\.1:${port}/posts/1`));
    assert.match(fromToml.stdout, /x-gio-cache {2}hit; ttl=30/);
    assert.match(fromToml.stdout, /Served from the Rust page cache/);

    // PORT outranks gio.toml, as in the server.
    const other = tempProject({ 'gio.toml': '[server]\nport = 1\n' });
    const fromPort = await runAsync(['cache', 'explain', '/a'], {
      cwd: other,
      env: { GIO_SERVER_BIN: binary, FAKE_SERVER_NO_CHECK: '1', PORT: String(port) },
    });
    assert.match(fromPort.stdout, new RegExp(`GET http://127\\.0\\.0\\.1:${port}/a`));

    // The binary's --check-config answer wins when it has one.
    const fromCheck = await runAsync(['cache', 'explain', '/b'], {
      cwd: other,
      env: { GIO_SERVER_BIN: binary, GIO_PORT: String(port) },
    });
    assert.match(fromCheck.stdout, new RegExp(`GET http://127\\.0\\.0\\.1:${port}/b`));

    const explicit = await runAsync(['cache', 'explain', '/c', '--base', `http://127.0.0.1:${port}`], { cwd: other });
    assert.match(explicit.stdout, new RegExp(`GET http://127\\.0\\.0\\.1:${port}/c`));
    assert.deepEqual(seen, ['/posts/1', '/a', '/b', '/c']);
  });
});

describe('gio add / gio migrate delegation', () => {
  /**
   * A project with a fake create-giojs that records every invocation - with
   * any arguments, `--help` included - in invocations.log, the way an old
   * release would scaffold a new app for any argument it does not know.
   */
  function projectWithCreateGiojs(pkg) {
    const project = tempProject({
      'node_modules/create-giojs/package.json': JSON.stringify({ name: 'create-giojs', version: '0.0.0-test', ...pkg }),
      'node_modules/create-giojs/dist/index.js':
        'const { appendFileSync } = require("fs");\n' +
        `appendFileSync(${JSON.stringify('LOG')}, process.argv.slice(2).join(" ") + "\\n");\n` +
        'console.log("create-giojs got: " + process.argv.slice(2).join(" "));\n',
    });
    const log = join(project, 'invocations.log');
    const entry = join(project, 'node_modules/create-giojs/dist/index.js');
    writeFileSync(entry, readFileSync(entry, 'utf8').replace('"LOG"', JSON.stringify(log)));
    return { project, invocations: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []) };
  }

  test('runs the installed create-giojs subcommand with the arguments, and nothing else', () => {
    const { project, invocations } = projectWithCreateGiojs({
      exports: { './migrate': './dist/migrate-command.js', './add': './dist/add.js', './package.json': './package.json' },
    });
    const { status, stdout } = run(['add', 'tailwind', '--yes'], { cwd: project });
    assert.equal(status, 0);
    assert.match(stdout, /create-giojs got: add tailwind --yes/);
    assert.match(run(['migrate', './next-app'], { cwd: project }).stdout, /create-giojs got: migrate \.\/next-app/);
    assert.deepEqual(invocations(), ['add tailwind --yes', 'migrate ./next-app'], 'no --help probe ran first');
  });

  test('a create-giojs without the subcommand is reported and never run, not even with --help', () => {
    // create-giojs <= 0.1.0-beta.7 has no exports map and scaffolds a new
    // app for any argument it does not know: `--help`, `add`, ...
    const { project, invocations } = projectWithCreateGiojs({ bin: { 'create-giojs': 'dist/index.js' } });
    for (const subcommand of ['add', 'migrate']) {
      const { status, stdout, stderr } = run([subcommand, 'x'], { cwd: project });
      assert.equal(status, 1);
      assert.doesNotMatch(stdout, /create-giojs got/);
      assert.match(stderr, new RegExp(`installed create-giojs 0\\.0\\.0-test \\(.*\\) is too old for \`gio ${subcommand}\`: ` +
        `it does not export create-giojs/${subcommand}, so it was not run`));
      assert.match(stderr, /npm install --save-dev create-giojs@/);
    }
    assert.deepEqual(invocations(), []);
    assert.equal(existsSync(join(project, 'my-giojs-app')), false);
  });
});
