/**
 * giojs-cli/test/overlays.test.ts
 *
 * Feature overlays (src/overlays): each one applied to a fresh scaffold
 * produces its files, package.json, gio.toml and env additions; combined
 * they compose; applied twice they change nothing; `add` refuses to
 * overwrite a file the user changed and writes nothing at all then; and the
 * create flow's flags reach them.
 *   npm test   (runs tsc first: the tests import dist/)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ALL_FEATURES,
  tailwindFeature,
  applyFeatures,
  cliDir,
  overlayCli,
  overlays,
  pm,
  read,
  readJson,
  runHealthcheck,
  scaffold,
  toml,
  type Scaffold,
} from './overlay-helpers.ts';

interface Pkg {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: Record<string, string>;
}

async function withProject(
  language: 'ts' | 'js',
  run: (project: Scaffold) => Promise<void>,
  mode: 'server' | 'static' = 'server',
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'gio-overlay-'));
  try {
    await run(await scaffold(join(root, 'app'), language, mode));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function editPackageJson(dir: string, edit: (pkg: Pkg & Record<string, unknown>) => void): Promise<void> {
  const pkg = await readJson<Pkg & Record<string, unknown>>(dir, 'package.json');
  edit(pkg);
  await writeFile(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
}

function runCli(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [join(cliDir, 'dist', 'index.js'), ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, npm_config_user_agent: '' },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// ── flags ─────────────────────────────────────────────────────────────────────

test('feature flags are taken out of argv; everything else is left for the create flow', () => {
  assert.deepEqual(overlayCli.extractFeatureArgs(['my-app', '--ts', '--yes']), {
    features: undefined,
    rest: ['my-app', '--ts', '--yes'],
  });
  assert.deepEqual(overlayCli.extractFeatureArgs(['my-app', '--tailwind', '--db', '--no-install']), {
    features: ['tailwind', 'db'],
    rest: ['my-app', '--no-install'],
  });
  // The list form, both spellings, aliases and duplicates.
  assert.deepEqual(overlayCli.extractFeatureArgs(['--features', 'api,auth,database', '--auth', 'x']).features, [
    'api',
    'auth',
    'db',
  ]);
  assert.deepEqual(overlayCli.extractFeatureArgs(['--features=docker,ci']).features, ['docker', 'ci']);
  assert.throws(() => overlayCli.extractFeatureArgs(['--features', 'redis']), /Unknown feature "redis"/);
  assert.throws(() => overlayCli.extractFeatureArgs(['--features']), /needs a comma-separated list/);
});

test('server-only features are refused for a static site; no flags and no TTY means no features', async () => {
  await assert.rejects(overlayCli.chooseFeatures(['tailwind', 'auth'], 'static', false), {
    message: 'auth needs a server app - a static site has no server to run it.',
  });
  await assert.rejects(overlayCli.chooseFeatures(['auth', 'db'], 'static', false), {
    message: 'auth, db need a server app - a static site has no server to run them.',
  });
  assert.deepEqual(await overlayCli.chooseFeatures(['tailwind', 'ci'], 'static', false), ['tailwind', 'ci']);
  assert.deepEqual(await overlayCli.chooseFeatures(undefined, 'server', false), []);
});

// ── merge helpers ─────────────────────────────────────────────────────────────

test('gio.toml keys go into the existing table, merging arrays and keeping everything else', () => {
  const key = { table: 'dev', key: 'watch_ignore', values: ['data/**'], comment: ['why'] };
  const fresh = toml.addTomlKey('[server]\nport = 3000\n', key);
  assert.equal(fresh.content, '[server]\nport = 3000\n\n[dev]\n# why\nwatch_ignore = ["data/**"]\n');

  const existing = '[dev]\nallowed_hosts = ["vm.local"]  # LAN\n\n[images]\nquality = 80\n';
  assert.equal(
    toml.addTomlKey(existing, key).content,
    '[dev]\nallowed_hosts = ["vm.local"]  # LAN\n# why\nwatch_ignore = ["data/**"]\n\n[images]\nquality = 80\n',
  );

  // A comment above the next table stays with that table.
  const commented = '[dev]\nallowed_hosts = []\n\n# Guards\n[[guards]]\npath = "/a"\n';
  assert.equal(
    toml.addTomlKey(commented, key).content,
    '[dev]\nallowed_hosts = []\n# why\nwatch_ignore = ["data/**"]\n\n# Guards\n[[guards]]\npath = "/a"\n',
  );

  const merged = toml.addTomlKey('[dev]\nwatch_ignore = ["*.log", \'db.json\']\n', key);
  assert.equal(merged.content, '[dev]\nwatch_ignore = ["*.log", "db.json", "data/**"]\n');
  assert.equal(toml.addTomlKey(merged.content, key).content, merged.content);

  // Not a single-line array: left alone, reported as a manual step.
  const multiline = '[dev]\nwatch_ignore = [\n  "a",\n]\n';
  const result = toml.addTomlKey(multiline, key);
  assert.equal(result.content, multiline);
  assert.match(result.manual[0] ?? '', /add "data\/\*\*" to \[dev\] watch_ignore/);
});

test('gio.toml [[table]] entries are appended once per path', () => {
  const entry = { table: 'guards', path: '/dashboard/*rest', body: 'path = "/dashboard/*rest"\nrequire_session = true\nredirect_to = "/login"' };
  const once = toml.addTomlArrayEntry('[server]\nport = 3000\n', entry).content;
  assert.match(once, /\n\n\[\[guards\]\]\npath = "\/dashboard\/\*rest"\nrequire_session = true\nredirect_to = "\/login"\n$/);
  assert.equal(toml.addTomlArrayEntry(once, entry).content, once);
  // Another guard does not count as this one.
  const other = '[[guards]]\npath = "/admin/*rest"\nrequire_cookie = "x"\nredirect_to = "/"\n';
  assert.match(toml.addTomlArrayEntry(other, entry).content, /\/admin\/\*rest[\s\S]*\/dashboard\/\*rest/);
});

test('env and .gitignore lines are added only when their key or pattern is missing, with their comments', () => {
  const keyOf = (line: string): string | undefined => /^([A-Z_]+)=/.exec(line)?.[1];
  const lines = ['# the secret', 'SECRET=', '', '# demo', 'DEMO=1'];
  assert.equal(overlays.appendMissingLines('', lines, keyOf), '# the secret\nSECRET=\n\n# demo\nDEMO=1\n');
  assert.equal(overlays.appendMissingLines('SECRET=abc\n', lines, keyOf), 'SECRET=abc\n\n# demo\nDEMO=1\n');
  assert.equal(overlays.appendMissingLines('SECRET=abc\nDEMO=2\n', lines, keyOf), 'SECRET=abc\nDEMO=2\n');

  // A commented-out key is documented but unset: added as a key (with its
  // comments), and present once either form of it is in the file.
  const commentedKeyOf = (line: string): string | undefined => /^(?:#\s*)?([A-Z_]+)=/.exec(line)?.[1];
  const optional = ['# optional:', '# DEMO=', 'OTHER='];
  assert.equal(overlays.appendMissingLines('', optional, commentedKeyOf), '# optional:\n# DEMO=\nOTHER=\n');
  assert.equal(overlays.appendMissingLines('DEMO=x\n', optional, commentedKeyOf), 'DEMO=x\n\nOTHER=\n');
  assert.equal(overlays.appendMissingLines('# DEMO=\nOTHER=1\n', optional, commentedKeyOf), '# DEMO=\nOTHER=1\n');
});

test('the package manager comes from the lockfile, then from the user agent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gio-pm-'));
  try {
    assert.equal(pm.detectPackageManager(dir, undefined).name, 'npm');
    assert.equal(pm.detectPackageManager(dir, 'pnpm/9.12.0 npm/? node/v22.16.0 linux x64').name, 'pnpm');
    await writeFile(join(dir, 'yarn.lock'), '');
    assert.equal(pm.detectPackageManager(dir, 'pnpm/9.12.0').name, 'yarn');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── each overlay on a fresh scaffold ──────────────────────────────────────────

test('tailwind: CLI build into an imported stylesheet, the watcher in dev, a build before build/start', async () => {
  await withProject('ts', async project => {
    await applyFeatures(project, ['tailwind']);
    const pkg = await readJson<Pkg>(project.dir, 'package.json');
    assert.ok(pkg.devDependencies?.['@tailwindcss/cli'] && pkg.devDependencies['tailwindcss']);
    const build = 'tailwindcss -i ./app/tailwind.css -o ./app/tailwind.out.css --minify';
    assert.equal(pkg.scripts['css:build'], build);
    assert.equal(pkg.scripts['css:watch'], 'tailwindcss -i ./app/tailwind.css -o ./app/tailwind.out.css --watch');
    assert.equal(pkg.scripts['dev'], 'node scripts/dev.mjs');
    assert.equal(pkg.scripts['dev:server'], 'cross-env NODE_ENV=development giojs-server');
    assert.equal(pkg.scripts['build'], `${build} && tsc --noEmit`);
    assert.equal(pkg.scripts['start'], `${build} && cross-env NODE_ENV=production giojs-server`);

    const layout = await read(project.dir, 'app/layout.tsx');
    assert.match(layout, /^import '\.\/tailwind\.out\.css';$/m);
    assert.doesNotMatch(layout, /globals\.css/, 'the starter stylesheet now comes through Tailwind');
    const input = await read(project.dir, 'app/tailwind.css');
    assert.match(input, /^@import "tailwindcss";$/m);
    assert.match(input, /^@import "\.\.\/public\/styles\/globals\.css" layer\(base\);$/m);
    assert.match(await read(project.dir, '.gitignore'), /^app\/tailwind\.out\.css$/m);
    assert.match(await read(project.dir, '.gitignore'), /^node_modules\/$/m);
    assert.match(await read(project.dir, 'scripts/dev.mjs'), /css:watch[\s\S]*dev:server/);
    assert.match(await read(project.dir, 'AGENTS.md'), /## Starter features\n\n- Tailwind CSS v4/);
  });
});

test('tailwind: a layout that imports globals.css, or none, gets the generated stylesheet import', () => {
  const imported = "import React from 'react';\nimport './globals.css';\n\nexport default 1;\n";
  assert.equal(
    tailwindFeature.importTailwindOutput(imported),
    "import React from 'react';\nimport './tailwind.out.css';\n\nexport default 1;\n",
  );
  assert.match(tailwindFeature.tailwindInput(imported), /^@import "\.\/globals\.css" layer\(base\);$/m);

  const bare = "import React from 'react';\nimport {\n  a,\n  b,\n} from './x';\n\nexport default 1;\n";
  assert.equal(
    tailwindFeature.importTailwindOutput(bare),
    "import React from 'react';\nimport {\n  a,\n  b,\n} from './x';\nimport './tailwind.out.css';\n\nexport default 1;\n",
  );
  assert.doesNotMatch(tailwindFeature.tailwindInput(bare), /layer\(base\)/);
  const done = tailwindFeature.importTailwindOutput(bare);
  assert.equal(tailwindFeature.importTailwindOutput(done), done);
});

test('tailwind on a static site prefixes the export build', async () => {
  await withProject(
    'js',
    async project => {
      await applyFeatures(project, ['tailwind', 'ci']);
      const pkg = await readJson<Pkg>(project.dir, 'package.json');
      assert.equal(pkg.scripts['build'], 'tailwindcss -i ./app/tailwind.css -o ./app/tailwind.out.css --minify && gio export');
      assert.equal(pkg.scripts['start'], undefined);
      assert.match(await read(project.dir, 'app/layout.jsx'), /^import '\.\/tailwind\.out\.css';$/m);
      const workflow = await read(project.dir, '.github/workflows/ci.yml');
      assert.match(workflow, /run: npm run build\n/);
      assert.match(workflow, /path: out\//);
      assert.doesNotMatch(workflow, /standalone|Typecheck/);
    },
    'static',
  );
});

test('api: a JSON route.ts and a GioForm page over shared validation', async () => {
  for (const language of ['ts', 'js'] as const) {
    await withProject(language, async project => {
      await applyFeatures(project, ['api']);
      const [src, page] = language === 'ts' ? ['ts', 'tsx'] : ['js', 'jsx'];
      const route = await read(project.dir, `app/api/guestbook/route.${src}`);
      assert.match(route, /export function GET\(/);
      assert.match(route, /export function POST\(/);
      assert.match(route, /req\.json\(\)/);
      assert.match(route, /isUnsupportedMediaTypeError\(error\)\) throw error/);
      assert.match(route, /status: 400/);
      assert.match(route, /status: 422/);
      assert.match(route, /status: 201/);
      const form = await read(project.dir, `app/guestbook/page.${page}`);
      assert.match(form, /export async function action\(/);
      assert.match(form, /status: 422, data: \{ errors: result\.errors, values \}/);
      assert.match(form, /return redirect\('\/guestbook'\)/);
      assert.match(form, /<GioForm /);
      assert.ok(existsSync(join(project.dir, `lib/guestbook.server.${src}`)));
      assert.ok(existsSync(join(project.dir, 'components/forms.css')));
      // No TS variant leaks into a JS project and vice versa.
      assert.ok(!existsSync(join(project.dir, `app/guestbook/page.${language === 'ts' ? 'jsx' : 'tsx'}`)));
    });
  }
});

test('auth: sessions, login/logout, a Rust guard and rate limit, the secret documented', async () => {
  await withProject('ts', async project => {
    await applyFeatures(project, ['auth']);
    assert.match(await read(project.dir, 'lib/session.server.ts'), /createSessionStorage<UserSession>\(\)/);
    const auth = await read(project.dir, 'lib/auth.server.ts');
    assert.match(auth, /timingSafeEqual/);
    assert.match(auth, /process\.env\.DEMO_PASSWORD/);
    const login = await read(project.dir, 'app/login/page.tsx');
    assert.match(login, /export async function action/);
    assert.match(login, /commitSession\(session\)/);
    assert.match(login, /CSRF/);
    assert.match(await read(project.dir, 'app/logout/route.ts'), /destroySession\(\)/);
    assert.match(await read(project.dir, 'app/dashboard/page.tsx'), /sessions\.getSession\(ctx\)/);

    const gio = await read(project.dir, 'gio.toml');
    assert.match(gio, /\[\[guards\]\]\npath = "\/dashboard\/\*rest"\nrequire_session = true\nredirect_to = "\/login"/);
    assert.match(gio, /\[\[rate_limits\]\]\npath = "\/login"\nper_ip = 10/);
    const example = await read(project.dir, '.env.example');
    assert.match(example, /^GIO_SESSION_SECRET=$/m);
    assert.match(example, /randomBytes\(32\)\.toString\('base64url'\)/);
    // Demo credentials only for development: production fails closed.
    assert.match(await read(project.dir, '.env.development'), /^DEMO_PASSWORD=\S+$/m);
    // Documented but commented out: `cp .env.example .env.local` must not
    // override .env.development's demo user with empty values (the first
    // file that sets a variable wins, and .env.local comes first).
    assert.match(example, /^# DEMO_EMAIL=$/m);
    assert.match(example, /^# DEMO_PASSWORD=$/m);
    assert.doesNotMatch(example, /^DEMO_/m);
    // Applied again (or over a .env.example that already has them), nothing is added twice.
    await applyFeatures(project, ['auth']);
    assert.equal(await read(project.dir, '.env.example'), example);
  });
});

test('db: Drizzle on node:sqlite, migrations, a seeded table, data/ ignored by git and the dev watcher', async () => {
  await withProject('ts', async project => {
    await applyFeatures(project, ['db']);
    const pkg = await readJson<Pkg>(project.dir, 'package.json');
    assert.ok(pkg.dependencies['drizzle-orm']);
    assert.ok(pkg.devDependencies?.['drizzle-kit']);
    // No native driver: nothing to compile, and it bundles into standalone.
    for (const native of ['better-sqlite3', '@libsql/client', 'sqlite3']) {
      assert.equal(pkg.dependencies[native], undefined);
    }
    assert.equal(pkg.engines?.['node'], '>=22.16.0');
    assert.equal(pkg.scripts['db:generate'], 'drizzle-kit generate');
    assert.equal(pkg.scripts['db:migrate'], 'node scripts/db-migrate.mjs');

    const db = await read(project.dir, 'lib/db.server.ts');
    assert.match(db, /from 'node:sqlite'/);
    assert.match(db, /drizzle-orm\/sqlite-proxy/);
    assert.match(db, /migrate\(sqlite\)/);
    assert.match(await read(project.dir, 'lib/schema.ts'), /sqliteTable\('notes'/);
    assert.match(await read(project.dir, 'drizzle/0001_seed.sql'), /INSERT INTO `notes`/);
    const journal = await readJson<{ entries: Array<{ tag: string }> }>(project.dir, 'drizzle/meta/_journal.json');
    assert.deepEqual(journal.entries.map(entry => entry.tag), ['0000_init', '0001_seed']);
    assert.match(await read(project.dir, 'app/notes/page.tsx'), /getServerSideProps[\s\S]*export async function action/);

    assert.match(await read(project.dir, 'gio.toml'), /\[dev\]\n# .*\nwatch_ignore = \["data\/\*\*"\]/);
    assert.match(await read(project.dir, '.gitignore'), /^data\/$/m);
    assert.match(await read(project.dir, '.env.example'), /^DATABASE_PATH=data\/app\.db$/m);
    assert.equal((await readJson<{ compilerOptions: Record<string, unknown> }>(project.dir, 'tsconfig.json')).compilerOptions['skipLibCheck'], true);
  });
});

test('docker: a multi-stage standalone Dockerfile, non-root, with a health check, plus compose and ignore files', async () => {
  await withProject('ts', async project => {
    await applyFeatures(project, ['docker']);
    const dockerfile = await read(project.dir, 'Dockerfile');
    assert.match(dockerfile, /FROM node:\$\{NODE_VERSION\}-slim AS build/);
    assert.match(dockerfile, /RUN npm run build && npx gio build standalone --out standalone/);
    assert.match(dockerfile, /FROM node:\$\{NODE_VERSION\}-slim AS runtime/);
    assert.match(dockerfile, /COPY --from=build \/app\/standalone \.\//);
    assert.match(dockerfile, /^USER node$/m);
    assert.match(dockerfile, /HEALTHCHECK[\s\S]*\/_gio\/health/);
    assert.match(dockerfile, /PORT=3000/);
    assert.match(dockerfile, /GIO_HOST=0\.0\.0\.0/);
    assert.match(dockerfile, /CMD \["node", "run\.mjs"\]/);
    assert.ok(dockerfile.indexOf('USER node') > dockerfile.lastIndexOf('FROM '), 'the runtime stage drops root');
    const ignore = await read(project.dir, '.dockerignore');
    for (const pattern of ['node_modules', '.gio', 'data', '.env*.local']) assert.match(ignore, new RegExp(`^${pattern.replace(/[.*]/g, '\\$&')}$`, 'm'));
    const compose = await read(project.dir, 'docker-compose.yml');
    assert.match(compose, /image: overlay-app/);
    assert.match(compose, /\.env\.production\.local/);
    assert.match(await read(project.dir, '.gitignore'), /^standalone\/$/m);
  });
});

test('docker: the HEALTHCHECK passes only when /_gio/health reports a ready Node worker', async () => {
  await withProject('ts', async project => {
    await applyFeatures(project, ['docker']);
    const dockerfile = await read(project.dir, 'Dockerfile');
    let health: Record<string, unknown> = {};
    // /_gio/health is a 200 whenever the Rust server runs, worker or not.
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(health));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      health = { status: 'ok', nodeReady: true, workers: { configured: 1, ready: 1 } };
      assert.equal(await runHealthcheck(dockerfile, port), 0);
      health = { status: 'ok', nodeReady: false, workers: { configured: 1, ready: 0 } };
      assert.equal(await runHealthcheck(dockerfile, port), 1, 'every worker down is unhealthy');
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
    // Nothing listening: unhealthy, not a crash.
    assert.equal(await runHealthcheck(dockerfile, port), 1);
  });
});

test('docker and ci follow the package manager', async () => {
  await withProject('ts', async project => {
    await applyFeatures(project, ['docker', 'ci'], { packageManager: 'pnpm' });
    const dockerfile = await read(project.dir, 'Dockerfile');
    assert.match(dockerfile, /COPY package\.json pnpm-lock\.yaml\* \.\//);
    assert.match(dockerfile, /corepack enable pnpm && if \[ -f pnpm-lock\.yaml \]; then pnpm install --frozen-lockfile/);
    assert.match(dockerfile, /RUN pnpm run build && pnpm exec gio build standalone/);
    const workflow = await read(project.dir, '.github/workflows/ci.yml');
    assert.match(workflow, /uses: pnpm\/action-setup@v4\n {8}with:\n {10}version: 10\n/);
    assert.match(workflow, /cache: pnpm/);
    assert.match(workflow, /run: pnpm install --frozen-lockfile/);
    assert.match(workflow, /run: pnpm exec tsc --noEmit/);
    assert.match(workflow, /run: pnpm run --if-present test/);
    assert.match(workflow, /run: pnpm exec gio build standalone/);
  });
});

test('ci: pnpm/action-setup takes the version from packageManager when package.json pins one', async () => {
  await withProject('ts', async project => {
    // action-setup fails ("Multiple versions of pnpm specified") when its
    // version input and packageManager disagree - `10` vs "pnpm@10.28.0" does.
    await editPackageJson(project.dir, pkg => {
      pkg['packageManager'] = 'pnpm@10.28.0';
    });
    await applyFeatures(project, ['ci'], { packageManager: 'pnpm' });
    const workflow = await read(project.dir, '.github/workflows/ci.yml');
    assert.match(workflow, /- uses: pnpm\/action-setup@v4\n {6}- uses: actions\/setup-node@v4/);
    assert.doesNotMatch(workflow, /version: 10/);
  });
});

test('ci: install, typecheck, test, build standalone, keep the artifact', async () => {
  await withProject('ts', async project => {
    await applyFeatures(project, ['ci']);
    const workflow = await read(project.dir, '.github/workflows/ci.yml');
    const order = ['npm ci', 'npx tsc --noEmit', 'npm test --if-present', 'npm run build', 'npx gio build standalone', 'upload-artifact'];
    let last = -1;
    for (const step of order) {
      const at = workflow.indexOf(step);
      assert.ok(at > last, `"${step}" missing or out of order:\n${workflow}`);
      last = at;
    }
    assert.match(workflow, /include-hidden-files: true/);
    assert.match(workflow, /permissions:\n {2}contents: read/);
  });
  // JS projects have no typecheck step; yarn runs tests only when there is a script.
  await withProject('js', async project => {
    await applyFeatures(project, ['ci'], { packageManager: 'yarn' });
    const workflow = await read(project.dir, '.github/workflows/ci.yml');
    assert.doesNotMatch(workflow, /Typecheck|name: Test/);
    assert.match(workflow, /run: yarn install --frozen-lockfile/);
  });
});

// ── composition and idempotency ───────────────────────────────────────────────

test('tailwind + auth + db + docker compose, and docker builds the Tailwind output', async () => {
  await withProject('ts', async project => {
    // Order does not matter: overlays always apply in the canonical order.
    const plan = await applyFeatures(project, ['docker', 'db', 'auth', 'tailwind']);
    assert.deepEqual(plan.features, ['tailwind', 'auth', 'db', 'docker']);
    const pkg = await readJson<Pkg>(project.dir, 'package.json');
    assert.ok(pkg.dependencies['drizzle-orm'] && pkg.devDependencies?.['@tailwindcss/cli']);
    assert.match(pkg.scripts['build'] ?? '', /^tailwindcss .* --minify && tsc --noEmit$/);
    assert.match(await read(project.dir, 'Dockerfile'), /RUN npm run build && npx gio build standalone/);
    assert.match(await read(project.dir, 'Dockerfile'), /cp -R drizzle standalone\/drizzle/);

    const gio = await read(project.dir, 'gio.toml');
    assert.equal(gio.match(/^\[dev\]$/gm)?.length, 1);
    assert.equal(gio.match(/^\[\[guards\]\]$/gm)?.length, 1);
    const gitignore = await read(project.dir, '.gitignore');
    for (const line of ['app/tailwind.out.css', 'data/', 'standalone/', 'node_modules/']) {
      assert.equal(gitignore.split('\n').filter(l => l === line).length, 1, line);
    }
    // The shared form stylesheet comes from two overlays without a conflict.
    assert.ok(existsSync(join(project.dir, 'components/forms.css')));
    assert.equal((await read(project.dir, 'AGENTS.md')).match(/^## Starter features$/gm)?.length, 1);
  });
});

test('tailwind gives a project without a build script one, which docker and ci run (a migrated app)', async () => {
  await withProject('ts', async project => {
    // `create-giojs migrate` deletes `next build` and adds no build script.
    await editPackageJson(project.dir, pkg => {
      delete pkg.scripts['build'];
    });
    await applyFeatures(project, ['tailwind', 'docker', 'ci']);
    const build = 'tailwindcss -i ./app/tailwind.css -o ./app/tailwind.out.css --minify';
    assert.equal((await readJson<Pkg>(project.dir, 'package.json')).scripts['build'], build);
    // app/tailwind.out.css is git-ignored, so a clean checkout (the Docker
    // build context, a CI runner) has it only if something runs the build.
    assert.match(await read(project.dir, 'Dockerfile'), /^RUN npm run build && npx gio build standalone --out standalone$/m);
    assert.match(await read(project.dir, '.github/workflows/ci.yml'), /- name: Build\n {8}run: npm run build\n/);
    assert.deepEqual((await applyFeatures(project, ['tailwind', 'docker', 'ci'])).unchanged, ['tailwind', 'docker', 'ci']);
  });
});

test('docker and ci run a build script added later, where the package manager can skip a missing one', async () => {
  await withProject('ts', async project => {
    await editPackageJson(project.dir, pkg => {
      delete pkg.scripts['build'];
    });
    await applyFeatures(project, ['docker', 'ci']);
    assert.match(await read(project.dir, 'Dockerfile'), /^RUN npm run build --if-present && npx gio build standalone/m);
    assert.match(await read(project.dir, '.github/workflows/ci.yml'), /run: npm run build --if-present\n/);
    // Tailwind afterwards: the build script it adds runs in both.
    await applyFeatures(project, ['tailwind']);
    assert.match((await readJson<Pkg>(project.dir, 'package.json')).scripts['build'] ?? '', /^tailwindcss /);
  });
  await withProject('ts', async project => {
    await editPackageJson(project.dir, pkg => {
      delete pkg.scripts['build'];
    });
    await applyFeatures(project, ['docker', 'ci'], { packageManager: 'pnpm' });
    assert.match(await read(project.dir, 'Dockerfile'), /RUN pnpm run --if-present build && pnpm exec gio build standalone/);
    assert.match(await read(project.dir, '.github/workflows/ci.yml'), /run: pnpm run --if-present build\n/);
  });
  // yarn fails on a missing script: no build step until there is a script.
  await withProject('ts', async project => {
    await editPackageJson(project.dir, pkg => {
      delete pkg.scripts['build'];
    });
    await applyFeatures(project, ['docker', 'ci'], { packageManager: 'yarn' });
    assert.match(await read(project.dir, 'Dockerfile'), /^RUN yarn gio build standalone --out standalone$/m);
    assert.doesNotMatch(await read(project.dir, '.github/workflows/ci.yml'), /name: Build\n/);
  });
});

test('applying every overlay twice changes nothing the second time', async () => {
  for (const language of ['ts', 'js'] as const) {
    await withProject(language, async project => {
      const first = await applyFeatures(project, ALL_FEATURES);
      assert.deepEqual(first.conflicts, []);
      assert.deepEqual(first.manual, []);
      assert.deepEqual(first.unchanged, []);
      const second = await applyFeatures(project, ALL_FEATURES);
      assert.deepEqual([...second.writes.keys()], [], `${language}: the second run would write`);
      assert.deepEqual(second.unchanged, ALL_FEATURES);
      assert.deepEqual(second.conflicts, []);
    });
  }
});

// ── `create-giojs add` ────────────────────────────────────────────────────────

test('add applies a feature to an existing project and is idempotent', async () => {
  await withProject('ts', async project => {
    const first = runCli(['add', 'api', 'db'], project.dir);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /Did create:[\s\S]*app\/guestbook\/page\.tsx/);
    assert.match(first.stdout, /Run `npm install` to install drizzle-kit, drizzle-orm|Run `npm install` to install drizzle-orm, drizzle-kit/);
    const again = runCli(['add', 'api', 'db'], project.dir);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /API route \+ form is already set up/);
    assert.match(again.stdout, /Database \(SQLite \+ Drizzle\) is already set up/);
    assert.doesNotMatch(again.stdout, /Did (create|update)/);
  });
});

test('add refuses to overwrite a file of the user\'s in a new feature\'s way, shows the diff and writes nothing; --force overwrites', async () => {
  await withProject('ts', async project => {
    // The project has its own /guestbook page before the api feature.
    const page = join(project.dir, 'app/guestbook/page.tsx');
    await mkdir(join(project.dir, 'app/guestbook'), { recursive: true });
    await writeFile(page, 'export default function Mine() { return null; }\n');

    const refused = runCli(['add', 'api', 'auth', '--cwd', project.dir], join(project.dir, '..'));
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /Nothing was written/);
    assert.match(refused.stderr, /app\/guestbook\/page\.tsx: exists with different content/);
    assert.match(refused.stderr, /- export default function Mine\(\)/);
    assert.match(refused.stderr, /\+ import React from 'react';/);
    assert.match(refused.stderr, /more lines\)/, 'a long diff is capped');
    assert.match(refused.stderr, /--force/);
    // Neither feature was applied: a refused run is all or nothing.
    assert.ok(!existsSync(join(project.dir, 'app/api/guestbook/route.ts')));
    assert.ok(!existsSync(join(project.dir, 'app/login/page.tsx')));
    assert.doesNotMatch(await read(project.dir, 'gio.toml'), /guards/);
    assert.equal(await read(project.dir, 'app/guestbook/page.tsx'), 'export default function Mine() { return null; }\n');

    const forced = runCli(['add', 'api', 'auth', '--force'], project.dir);
    assert.equal(forced.status, 0, forced.stderr);
    assert.match(await read(project.dir, 'app/guestbook/page.tsx'), /GuestbookPage/);
    assert.ok(existsSync(join(project.dir, 'app/login/page.tsx')));
  });
});

test('add keeps the user\'s edits to a feature that is already set up, and still adds the new ones', async () => {
  await withProject('ts', async project => {
    assert.equal(runCli(['add', 'auth'], project.dir).status, 0);
    // The expected next step after scaffolding: make the starter pages yours.
    const loginPath = join(project.dir, 'app/login/page.tsx');
    const login = (await read(project.dir, 'app/login/page.tsx')).replace('<h1>Log in</h1>', '<h1>Sign in</h1>');
    assert.match(login, /Sign in/);
    await writeFile(loginPath, login);
    const forms = (await read(project.dir, 'components/forms.css')) + '\n.mine { color: red; }\n';
    await writeFile(join(project.dir, 'components/forms.css'), forms);

    const again = runCli(['add', 'auth'], project.dir);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /Authentication is already set up - nothing to change\./);
    assert.match(again.stdout, /Kept your version of:\n {2}app\/login\/page\.tsx\n/);
    assert.doesNotMatch(again.stdout, /Did (create|update)/);

    // Next to a new feature: auth keeps the edits, db (sharing forms.css) is added.
    const both = runCli(['add', 'auth', 'db'], project.dir);
    assert.equal(both.status, 0, both.stderr);
    assert.match(both.stdout, /Did create:[\s\S]*lib\/db\.server\.ts/);
    assert.match(both.stdout, /Kept your version of:\n {2}app\/login\/page\.tsx\n/);
    assert.equal(await read(project.dir, 'app/login/page.tsx'), login);
    assert.equal(await read(project.dir, 'components/forms.css'), forms);
    assert.ok(existsSync(join(project.dir, 'app/notes/page.tsx')));

    // A script of a set-up feature the user changed is kept the same way.
    await editPackageJson(project.dir, pkg => {
      pkg.scripts['db:migrate'] = 'node scripts/my-migrate.mjs';
    });
    const scripted = runCli(['add', 'db', '--dry-run'], project.dir);
    assert.equal(scripted.status, 0, scripted.stderr);
    assert.match(scripted.stdout, /Kept your version of:\n {2}package\.json \(script "db:migrate"\)/);

    // --force puts the starter's version back.
    const forced = runCli(['add', 'auth', '--force'], project.dir);
    assert.equal(forced.status, 0, forced.stderr);
    assert.match(await read(project.dir, 'app/login/page.tsx'), /<h1>Log in<\/h1>/);
  });
});

test('add refuses a script the user already defined differently', async () => {
  await withProject('ts', async project => {
    const pkg = await readJson<Pkg>(project.dir, 'package.json');
    pkg.scripts['db:migrate'] = 'my-own-migrator';
    await writeFile(join(project.dir, 'package.json'), JSON.stringify(pkg, null, 2));
    const refused = runCli(['add', 'db'], project.dir);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /package\.json: script "db:migrate" is already set/);
    assert.ok(!existsSync(join(project.dir, 'lib/db.server.ts')));
  });
});

test('add --dry-run writes nothing; a static site cannot get server features', async () => {
  await withProject('ts', async project => {
    const dry = runCli(['add', 'docker', '--dry-run'], project.dir);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /Would create:[\s\S]*Dockerfile/);
    assert.ok(!existsSync(join(project.dir, 'Dockerfile')));
  });
  await withProject(
    'js',
    async project => {
      const refused = runCli(['add', 'auth'], project.dir);
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /Cannot add auth to a static site/);
      assert.equal(runCli(['add', 'tailwind'], project.dir).status, 0);
    },
    'static',
  );
});

test('add explains bad input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gio-add-'));
  try {
    assert.match(runCli(['add'], dir).stderr, /Name at least one feature/);
    assert.match(runCli(['add', 'redis'], dir).stderr, /Unknown feature "redis"/);
    assert.match(runCli(['add', 'api'], dir).stderr, /No package\.json/);
    const help = runCli(['add', '--help'], dir);
    assert.equal(help.status, 0);
    for (const name of ALL_FEATURES) assert.match(help.stdout, new RegExp(`^  ${name} `, 'm'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── the create flow ───────────────────────────────────────────────────────────

test('create-giojs --tailwind --features db,ci scaffolds with the features applied', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'gio-create-features-'));
  try {
    const result = runCli(['app', '--yes', '--no-install', '--tailwind', '--features', 'db,ci'], cwd);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Added: Tailwind CSS, Database \(SQLite \+ Drizzle\), GitHub Actions CI\./);
    assert.match(result.stdout, /Your features:[\s\S]*Open \/notes/);
    const app = join(cwd, 'app');
    for (const file of ['app/tailwind.css', 'lib/db.server.ts', '.github/workflows/ci.yml', 'scripts/dev.mjs']) {
      assert.ok(existsSync(join(app, file)), file);
    }
    // The monorepo patch ran first: dev:server is the server command it set.
    assert.match((await readJson<Pkg>(app, 'package.json')).scripts['dev:server'] ?? '', /cargo run/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('create-giojs --static --auth fails before writing anything', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'gio-create-features-'));
  try {
    const result = runCli(['app', '--yes', '--no-install', '--static', '--auth'], cwd);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^auth needs a server app - a static site has no server to run it\.$/m);
    assert.ok(!existsSync(join(cwd, 'app')));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
