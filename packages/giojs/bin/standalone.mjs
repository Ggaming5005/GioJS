/**
 * giojs/bin/standalone.mjs
 *
 * `gio build standalone` - packages an app into a self-contained deploy
 * directory: the platform Rust binary, the entire Node side bundled to one
 * worker.js (registry entry generated from discovered app modules), prebuilt
 * hydration chunks and route stylesheets, public assets, and a run.mjs
 * launcher. CSS imports work as in `gio dev`/`gio start`: the stylesheets are
 * prebuilt under static/css, and CSS Module imports in worker.js evaluate to
 * the same class maps the hydration chunks carry. The output runs on
 * a bare server that has only Node: `node run.mjs`.
 *
 * Cross-deploys: `--target <platform>` picks a different platform package,
 * which must be installed (`npm i @gio.js/server-<target> --force`).
 *
 * Env: the project's production .env files load before bundling, so
 * GIO_PUBLIC_* values are frozen into the chunks and worker.js. The output
 * carries no .env files; run.mjs starts the server with the deploy dir as
 * cwd, and the server loads that dir's .env files at startup like any other
 * `gio` run.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TARGETS = [
  'linux-x64',
  'linux-x64-musl',
  'linux-arm64',
  'win32-x64',
  'darwin-x64',
  'darwin-arm64',
];

const USAGE = `usage: gio build standalone [--out <dir>] [--target <platform>]

  --out <dir>         output directory (default: ./standalone)
  --target <platform> platform package to deploy for: ${TARGETS.join(', ')}
                      cross-target requires: npm i @gio.js/server-<target> --force

Environment:
  GIO_APP_DIR                  app directory (default: ./app)
  GIO_STANDALONE_SERVER_BIN    explicit server binary path (overrides --target)

GIO_PUBLIC_* variables (from the environment or the project's .env,
.env.local, .env.production, .env.production.local) are inlined at build
time; changing one needs a rebuild. Server variables are read at runtime:
set them in the deploy environment or in .env files inside the output dir.
`;

function fail(message) {
  console.error(`gio build standalone: ${message}`);
  process.exit(1);
}

/** A bad flag or value: exit code 2, as every `gio` usage error. */
function usageError(message) {
  console.error(`gio build standalone: ${message}\nRun \`gio build standalone --help\` for usage.`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = { out: resolve('standalone'), target: null };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    // `--out=dir` as well as `--out dir`, like every other gio command.
    let inline;
    const equals = /^--(out|target)=/.exec(arg);
    if (equals) {
      inline = arg.slice(equals[0].length);
      arg = `--${equals[1]}`;
    }
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else if (arg === '--out') {
      const dir = value();
      if (!dir) usageError('--out requires a directory argument');
      options.out = resolve(dir);
    } else if (arg === '--target') {
      const target = value();
      if (!target) usageError('--target requires a platform argument');
      if (!TARGETS.includes(target)) {
        usageError(`unknown target "${target}" - expected one of: ${TARGETS.join(', ')}`);
      }
      options.target = target;
    } else {
      usageError(`unknown argument "${arg}"`);
    }
  }
  return options;
}

/** `path` with symlinks resolved as far as it exists. */
function realPath(path) {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(realPath(parent), basename(path));
  }
}

/** Whether `inner` is `outer` or below it. */
function isWithin(outer, inner) {
  const rel = relative(outer, inner);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * The build replaces --out wholesale (rm -rf, then write), so it must be a
 * directory this command owns: never the project, an ancestor of it or the
 * app directory, and never a non-empty directory without the files a
 * previous standalone build leaves (run.mjs and .gio/manifest.json).
 */
function outDirProblem(out, projectRoot, appDir) {
  const target = realPath(out);
  const project = realPath(projectRoot);
  const app = realPath(appDir);
  if (isWithin(target, project)) {
    return `--out ${out} is the project directory or contains it - the build empties --out first`;
  }
  if (isWithin(app, target)) {
    return `--out ${out} is inside the app directory ${appDir}`;
  }
  if (!existsSync(target)) return null;
  if (!statSync(target).isDirectory()) return `--out ${out} exists and is not a directory`;
  if (readdirSync(target).length === 0) return null;
  if (existsSync(join(target, 'run.mjs')) && existsSync(join(target, '.gio', 'manifest.json'))) return null;
  return (
    `--out ${out} is not empty and is not a previous standalone build - the build empties --out first.\n` +
    '  Pick a new directory, or remove this one yourself.'
  );
}

function findCoreDir(requireFromHere) {
  try {
    return dirname(requireFromHere.resolve('@gio.js/core/package.json'));
  } catch {
    const monorepoCore = join(
      dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'giojs-core',
    );
    if (existsSync(monorepoCore)) return monorepoCore;
    return null;
  }
}

function findServerBinary(requireFromHere, target) {
  if (process.env.GIO_STANDALONE_SERVER_BIN) {
    const bin = process.env.GIO_STANDALONE_SERVER_BIN;
    if (!existsSync(bin)) fail(`GIO_STANDALONE_SERVER_BIN does not exist: ${bin}`);
    return bin;
  }
  if (target !== null) {
    const pkgName = `@gio.js/server-${target}`;
    let pkgDir;
    try {
      pkgDir = dirname(requireFromHere.resolve(`${pkgName}/package.json`));
    } catch {
      fail(
        `platform package ${pkgName} is not installed.\n` +
        `  Cross-target builds need it present: npm i ${pkgName} --force`,
      );
    }
    const ext = target.startsWith('win32') ? '.exe' : '';
    const bin = join(pkgDir, 'bin', `giojs-server${ext}`);
    if (!existsSync(bin)) fail(`platform package ${pkgName} has no binary at ${bin}`);
    return bin;
  }
  const { locateBinary, missingBinaryMessage } = requireFromHere('./find-binary.js');
  const binary = locateBinary();
  if (!binary.found) {
    console.error(missingBinaryMessage(binary, { version: requireFromHere('../package.json').version }));
    process.exit(1);
  }
  return binary.path;
}

/**
 * `[css] minify` from the project's gio.toml. The route stylesheets are
 * baked into static/css here and the standalone worker never rebuilds them,
 * so the GIO_CSS_CONFIG the deployed server hands it cannot change them: the
 * build-time value is the one that counts. Lenient read (the deployed server
 * validates the file); anything but `false` minifies.
 */
function cssMinify(requireFromHere, projectRoot) {
  let text;
  try {
    text = readFileSync(join(projectRoot, 'gio.toml'), 'utf8');
  } catch {
    return true;
  }
  const { parseTomlLite } = requireFromHere('./lib/config.js');
  return parseTomlLite(text).css?.minify !== false;
}

/** Pick app/<base>.<ext> by the same precedence discovery uses, or null. */
function pickExisting(dir, base, exts) {
  for (const ext of exts) {
    const candidate = join(dir, `${base}.${ext}`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function generateRunLauncher(serverName) {
  return `// Generated by \`gio build standalone\`. Deploy = \`node run.mjs\`.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const server = spawn(join(here, ${JSON.stringify(serverName)}), process.argv.slice(2), {
  cwd: here,
  // stdin is a pipe this launcher holds open and never writes: if it dies -
  // even by SIGKILL, which it cannot forward - the server reads EOF and shuts
  // down instead of lingering on the port (GIO_EXIT_ON_STDIN_EOF).
  stdio: ['pipe', 'inherit', 'inherit'],
  env: {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV ?? 'production',
    GIO_EXIT_ON_STDIN_EOF: '1',
    GIO_STANDALONE: '1',
    GIO_NODE_SCRIPT: join(here, 'worker.js'),
    GIO_STATIC_DIR: join(here, 'static'),
  },
});
server.stdin.on('error', () => {});
// Windows never forwards: a console Ctrl+C already reaches the server, and
// kill() there is TerminateProcess, which skips its graceful shutdown.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (process.platform !== 'win32') server.kill(signal);
  });
}
server.on('exit', (code, signal) => process.exit(code ?? (signal === null ? 0 : 1)));
`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const requireFromHere = createRequire(import.meta.url);

  const appDir = resolve(process.env.GIO_APP_DIR ?? join(process.cwd(), 'app'));
  if (!existsSync(appDir)) fail(`app directory not found: ${appDir}`);
  const projectRoot = dirname(appDir);
  const outProblem = outDirProblem(options.out, projectRoot, appDir);
  if (outProblem !== null) fail(outProblem);

  const coreDir = findCoreDir(requireFromHere);
  if (coreDir === null) fail('@gio.js/core not found - run `npm install` first');
  const requireFromCore = createRequire(join(coreDir, 'package.json'));

  // Discovery and generation reuse giojs-core's TypeScript source, so the
  // build process itself runs under tsx hooks (build-time only - the bundle
  // never loads tsx).
  const tsxApi = await import(pathToFileURL(requireFromCore.resolve('tsx/esm/api')).href);
  tsxApi.register();
  const coreSrc = (name) => pathToFileURL(join(coreDir, 'src', name)).href;
  const router = await import(coreSrc('router.ts'));
  const { buildClientBundles, projectTsconfig, publicEnv, publicEnvDefines } = await import(
    coreSrc('client-build.ts')
  );
  const { buildRouteStylesheets } = await import(coreSrc('css-build.ts'));
  const { cssImportsAsClassMapsPlugin } = await import(coreSrc('css-modules.ts'));
  const { styleManifestToJson } = await import(coreSrc('style-manifest.ts'));
  const { generateStandaloneEntry, withStickyModuleErrors } = await import(coreSrc('standalone-gen.ts'));
  const { loadEnvFiles } = await import(coreSrc('env-files.ts'));

  // GIO_PUBLIC_* values are frozen in at build time (client chunks and the
  // worker bundle alike) from the environment and the project's production
  // .env files. Server-side variables are NOT baked in: the deployed server
  // reads them at runtime from the environment or .env files in the deploy
  // dir.
  let envFiles;
  try {
    envFiles = loadEnvFiles(projectRoot, { mode: 'production' });
  } catch (envError) {
    fail(envError instanceof Error ? envError.message : String(envError));
  }

  const serverBin = findServerBinary(requireFromHere, options.target);
  const serverName = extname(serverBin) === '.exe' ? 'server.exe' : 'server';

  console.log(`gio build standalone`);
  console.log(`  app:    ${appDir}`);
  console.log(`  server: ${serverBin}`);
  console.log(`  out:    ${options.out}`);
  if (envFiles.disabledBy) {
    console.log(`  env:    .env files not loaded (${envFiles.disabledBy} turns them off)`);
  } else if (envFiles.files.length > 0) {
    console.log(`  env:    ${envFiles.files.join(', ')} (GIO_PUBLIC_* inlined at build time)`);
  }
  if (envFiles.skipped.length > 0) {
    console.log(`  env:    skipped ${envFiles.skipped.join(', ')} (not a regular file)`);
  }

  const [routes, layouts, routeFiles, segmentFiles, metadataRoutes] = await Promise.all([
    router.discoverRoutes(appDir),
    router.discoverLayouts(appDir),
    router.discoverRouteFiles(appDir),
    router.discoverSegmentFiles(appDir),
    router.discoverMetadataRoutes(appDir),
  ]);
  router.assertNoRouteConflicts(appDir, routes, routeFiles);
  router.assertNoMetadataRouteConflicts(appDir, routes, routeFiles, metadataRoutes);
  if (routes.size === 0 && routeFiles.length === 0) {
    fail(`no pages or route files discovered under ${appDir}`);
  }

  console.log(`  routes: ${[...routes.keys()].join(', ') || '(none)'}`);

  const minifyCss = cssMinify(requireFromHere, projectRoot);
  if (!minifyCss) console.log('  css:    unminified ([css] minify = false)');
  const styleManifest = await buildRouteStylesheets({
    routes,
    layouts,
    segmentFiles,
    projectRoot,
    dev: false,
    minify: minifyCss,
  });
  const clientManifest = await buildClientBundles({
    routes,
    layouts,
    segmentFiles,
    projectRoot,
    dev: false,
    stylesheets: styleManifest.routes,
  });
  const stylesheets = styleManifestToJson(styleManifest);

  await rm(options.out, { recursive: true, force: true });
  await mkdir(options.out, { recursive: true });

  const spec = {
    entryModulePath: join(coreDir, 'src', 'standalone-entry.ts'),
    routes: [...routes.values()].map((r) => ({ pattern: r.urlPattern, dir: r.dir, filePath: r.filePath })),
    layouts: [...layouts.values()].map((l) => ({ dir: l.dir, filePath: l.filePath })),
    // discoverRouteFiles returns file URLs; imports want filesystem paths.
    routeFiles: routeFiles.map((f) => ({
      pattern: f.urlPattern,
      filePath: fileURLToPath(f.filePath),
    })),
    segmentFiles: [segmentFiles.notFound, segmentFiles.error, segmentFiles.loading].flatMap(
      (files) => [...files.values()].map((f) => ({ kind: f.kind, dir: f.dir, filePath: f.filePath })),
    ),
    metadataRoutes: Object.values(metadataRoutes).map((m) => ({ kind: m.kind, filePath: m.filePath })),
    clientScripts: Object.fromEntries(clientManifest),
    stylesheets,
  };
  const notFoundPath = pickExisting(appDir, 'not-found', ['tsx', 'jsx', 'js']);
  if (notFoundPath !== null) spec.notFoundPath = notFoundPath;
  const errorPath = pickExisting(appDir, 'error', ['tsx', 'jsx', 'js']);
  if (errorPath !== null) spec.errorPath = errorPath;
  const configPath = pickExisting(projectRoot, 'gio.config', ['ts', 'js']);
  if (configPath !== null) spec.configPath = configPath;
  const middlewarePath = pickExisting(projectRoot, 'middleware', ['ts', 'js']);
  if (middlewarePath !== null) spec.middlewarePath = middlewarePath;

  const entryDir = await mkdtemp(join(tmpdir(), 'gio-standalone-entry-'));
  try {
    const entryFile = join(entryDir, 'entry.mjs');
    await writeFile(entryFile, generateStandaloneEntry(spec), 'utf8');

    const esbuildModule = await import(pathToFileURL(requireFromCore.resolve('esbuild')).href);
    const esbuild = esbuildModule.default ?? esbuildModule;
    // jsxImportSource, decorators and paths apply as they did under tsx.
    const tsconfig = projectTsconfig(projectRoot);
    await esbuild.build({
      entryPoints: [entryFile],
      outfile: join(options.out, 'worker.js'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      jsx: 'automatic',
      // Build-time-only packages: never loaded on the registry path, so the
      // bundle runs without node_modules.
      external: ['tsx', 'tsx/*', 'esbuild'],
      // The same frozen GIO_PUBLIC_* values the client chunks got, so server
      // renders match what hydrates: inlined at each literal read, and set in
      // process.env before any app code runs for destructured and dynamic
      // reads. Everything else stays a runtime read.
      banner: {
        js:
          "import { createRequire as __gioCreateRequire } from 'node:module';\n" +
          'const require = __gioCreateRequire(import.meta.url);\n' +
          `Object.assign(process.env, ${JSON.stringify(publicEnv(process.env))});`,
      },
      // A CSS Module import is its class map (the names the chunks carry);
      // other .css imports are empty - the stylesheets ship in static/css.
      plugins: [cssImportsAsClassMapsPlugin()],
      loader: { '.css': 'empty' },
      ...(tsconfig !== undefined ? { tsconfig } : {}),
      define: publicEnvDefines(process.env),
      minify: false,
      sourcemap: false,
      logLevel: 'warning',
    });
    // App modules evaluate on first import (standalone-gen.ts); one that
    // throws must keep failing its importers, as under Node's ESM loader.
    const workerFile = join(options.out, 'worker.js');
    const patched = withStickyModuleErrors(await readFile(workerFile, 'utf8'));
    if (patched === null) {
      console.warn(
        'warning: unrecognized esbuild module-init helper in worker.js - a module that throws while it ' +
          'is imported fails only its first importer',
      );
    } else {
      await writeFile(workerFile, patched, 'utf8');
    }
  } finally {
    await rm(entryDir, { recursive: true, force: true });
  }
  const workerHash = await standaloneWorkerHash(join(options.out, 'worker.js'), entryDir);

  await copyFile(serverBin, join(options.out, serverName));
  if (serverName === 'server') {
    await chmod(join(options.out, serverName), 0o755);
  }

  const chunksDir = join(projectRoot, '.gio', 'build', 'static');
  if (existsSync(chunksDir)) {
    await cp(chunksDir, join(options.out, 'static'), { recursive: true });
  } else {
    await mkdir(join(options.out, 'static'), { recursive: true });
  }

  const publicDir = join(projectRoot, 'public');
  if (existsSync(publicDir)) {
    await cp(publicDir, join(options.out, 'public'), { recursive: true });
  }
  const gioToml = join(projectRoot, 'gio.toml');
  if (existsSync(gioToml)) {
    await copyFile(gioToml, join(options.out, 'gio.toml'));
  }

  // .gio/manifest.json is the content Rust hashes into the deployment ID, so
  // it stays deterministic for a given app (no timestamps).
  await mkdir(join(options.out, '.gio'), { recursive: true });
  await writeFile(
    join(options.out, '.gio', 'manifest.json'),
    JSON.stringify(
      {
        standalone: true,
        server: serverName,
        routes: [...routes.keys()].sort(),
        handlers: routeFiles.map((f) => f.urlPattern).sort(),
        clientScripts: Object.fromEntries([...clientManifest].sort()),
        stylesheets,
        // Everything server-side - the root layout, metadata exports, route
        // handlers, server libraries, dependencies - is in worker.js and
        // nowhere else above: without it a server-only change would keep
        // the deployment ID and the pages the old bundle cached.
        worker: workerHash,
      },
      null,
      2,
    ),
    'utf8',
  );
  // routes.d.ts references css-modules.d.ts, so the two travel together.
  for (const typesFile of ['routes.d.ts', 'css-modules.d.ts']) {
    const source = join(projectRoot, '.gio', typesFile);
    if (existsSync(source)) {
      await copyFile(source, join(options.out, '.gio', typesFile));
    }
  }

  await writeFile(
    join(options.out, 'package.json'),
    JSON.stringify({ name: 'giojs-standalone-app', private: true, type: 'module' }, null, 2),
    'utf8',
  );
  await writeFile(join(options.out, 'run.mjs'), generateRunLauncher(serverName), 'utf8');

  console.log(`\nstandalone build complete: ${options.out}`);
  console.log(`  ${serverName}, worker.js, run.mjs, static/, .gio/`);
  console.log(`\ndeploy the directory to a server that has Node, then:`);
  console.log(`  node ${basename(options.out)}/run.mjs`);
  process.exit(0);
}

/**
 * Content hash of the bundled worker.js. The generated entry lives in a
 * fresh temporary directory, whose name esbuild's module path comments
 * carry; it is normalized so the same app always hashes alike.
 */
async function standaloneWorkerHash(workerFile, entryDir) {
  const source = (await readFile(workerFile, 'utf8')).replaceAll(basename(entryDir), 'gio-standalone-entry');
  return createHash('sha256').update(source).digest('hex');
}

main().catch((buildError) => {
  fail(buildError instanceof Error ? (buildError.stack ?? buildError.message) : String(buildError));
});

