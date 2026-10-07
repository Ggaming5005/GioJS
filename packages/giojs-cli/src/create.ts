import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { readFile, readdir, rm, writeFile } from 'fs/promises';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';
import type { CliArgs } from './args.js';
import { copyTemplate, scaffoldFileName, templateDir } from './copy-template.js';
import { initGitRepository } from './git.js';
import { applyCreateFeatures } from './overlays/cli.js';
import { packageManager as overlayPackageManager } from './overlays/package-manager.js';
import { installCommand, runCommand, type PackageManager } from './package-manager.js';
import { gatherConfig, type Mode, type ProjectConfig } from './prompts.js';
import { applyStaticVariant } from './static-variant.js';

function monorepoRoot(): string | null {
  // dist/create.js is at packages/giojs-cli/dist/ - four levels up is the workspace root
  const root = join(fileURLToPath(import.meta.url), '..', '..', '..', '..');
  return existsSync(join(root, 'gio.toml')) ? root : null;
}

/**
 * Builds the workspace packages a monorepo scaffold file-refs. They resolve
 * through their builds: @gio.js/react's dist/ (code and types) and
 * @gio.js/core's declarations in dist/types - without those, tsc falls back
 * to core's .ts sources, which an app tsconfig cannot compile (TS5097). A
 * stale build shadows later source edits the same way.
 */
const MONOREPO_BUILD_COMMAND = 'pnpm --filter @gio.js/core --filter @gio.js/react run build';

/** Patches the copied package.json; returns whether the app links the monorepo's packages. */
async function patchPackageJson(destDir: string, mode: Mode, typescript: boolean): Promise<boolean> {
  const pkgPath = join(destDir, 'package.json');
  const raw = await readFile(pkgPath, 'utf8');
  const pkg = JSON.parse(raw) as Record<string, unknown>;
  const deps = pkg['dependencies'] as Record<string, string>;
  const scripts = pkg['scripts'] as Record<string, string>;

  const root = monorepoRoot();
  let gio = 'gio';
  if (root !== null) {
    // Local workspace: @gio.js/* aren't published, so file-ref the core and
    // React packages and run the server straight from cargo instead of the
    // @gio.js/server bin.
    delete deps['@gio.js/server'];
    deps['@gio.js/core'] = 'file:../../packages/giojs-core';
    deps['@gio.js/react'] = 'file:../../packages/giojs-react';
    scripts['dev'] = 'cross-env NODE_ENV=development cargo run --manifest-path ../../Cargo.toml -p giojs-server';
    scripts['start'] = 'cross-env NODE_ENV=production cargo run --release --manifest-path ../../Cargo.toml -p giojs-server';
    gio = 'node ../../packages/giojs/bin/gio.js';
  }
  // Published mode keeps the template's pinned @gio.js/* version ranges as-is.

  if (mode === 'static') {
    // Static sites pre-render to out/ via `gio export` and ship no production
    // server. A TS build typechecks first, so a type error stops the export.
    scripts['build'] = typescript ? `tsc --noEmit && ${gio} export` : `${gio} export`;
    delete scripts['start'];
  }

  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  return root !== null;
}

/**
 * Undoes a scaffold that stopped partway: the whole directory when this run
 * created it, the template's top-level entries (and those of the feature
 * overlays' files, `extra`) when it was empty - harmless files like .git
 * never clash with them. Files a --force run overwrote cannot be restored,
 * so that case is left as it is.
 */
async function rollback(config: ProjectConfig, extra: readonly string[]): Promise<boolean> {
  if (config.targetState === 'missing') {
    await rm(config.targetDir, { recursive: true, force: true });
  } else if (config.targetState === 'empty') {
    const names = new Set((await readdir(templateDir(config.template))).map(scaffoldFileName));
    for (const path of extra) names.add(path.split('/')[0] ?? path);
    for (const name of names) {
      await rm(join(config.targetDir, name), { recursive: true, force: true });
    }
  }
  return config.targetState !== 'not-empty';
}

interface WrittenProject {
  linksMonorepo: boolean;
  /**
   * The files this run wrote whole - the template's and the features' -
   * relative and '/'-separated. A file that was already there and that a
   * feature only added to (a --force run's .env.development) is not one.
   */
  files: string[];
  /** Files that were already there and that a feature added to. */
  amended: string[];
  /** The chosen features' next steps (empty without features). */
  featureSteps: string;
}

async function writeProject(config: ProjectConfig): Promise<WrittenProject> {
  // Ctrl+C while files are being written stops the copy before its next
  // file and rolls back, instead of leaving a project that looks complete
  // but is missing files.
  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.once('SIGINT', onSigint);
  const featureFiles: string[] = [];
  try {
    const typescript = config.language === 'ts';
    const files = await copyTemplate(config.template, config.targetDir, config.packageName, controller.signal);
    const linksMonorepo = await patchPackageJson(config.targetDir, config.mode, typescript);
    if (config.mode === 'static') await applyStaticVariant(config.targetDir, typescript);
    console.log('Template copied.');
    // overlays: after the static variant (tailwind wraps its build script)
    // and before the install, so their dependencies are installed too. They
    // write the commands of the package manager this flow installs with.
    const features = await applyCreateFeatures(
      config.targetDir,
      {
        projectName: config.packageName,
        language: config.language,
        mode: config.mode,
        packageManager: overlayPackageManager(config.packageManager),
      },
      config.features,
      {
        force: config.targetState === 'not-empty',
        signal: controller.signal,
        planned: paths => featureFiles.push(...paths),
      },
    );
    controller.signal.throwIfAborted();
    // A file the features added to still holds what it held before: the
    // template's, or - when the template did not write it - what was in
    // the directory, which a --force commit must leave out.
    const template = new Set(files);
    const amended = features.merged.filter(path => !template.has(path));
    const added = features.files.filter(path => !amended.includes(path));
    return { linksMonorepo, files: [...new Set([...files, ...added])], amended, featureSteps: features.steps };
  } catch (err) {
    const removed = await rollback(config, featureFiles);
    if (!controller.signal.aborted) throw err;
    console.error(removed
      ? '\nCancelled - the partly written project was removed.'
      : '\nCancelled - the project is incomplete.');
    process.exit(130);
  } finally {
    process.off('SIGINT', onSigint);
  }
}

function install(dir: string, pm: PackageManager): boolean {
  console.log(`\nInstalling dependencies with ${pm}...`);
  // shell on Windows: npm, pnpm and yarn are .cmd shims there.
  const result = spawnSync(pm, ['install'], { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status === 0) return true;
  const reason = result.error !== undefined ? result.error.message : `exit code ${result.status ?? 'unknown'}`;
  console.log(`\n! ${installCommand(pm)} failed (${reason}). The project is complete - run it yourself once fixed.`);
  return false;
}

/** `amended`: files that were already there and that the features added to. */
function reportGit(dir: string, include?: (path: string) => boolean, amended: readonly string[] = []): void {
  const result = initGitRepository(dir, 'Initial commit from create-giojs', include);
  switch (result.status) {
    case 'committed': {
      console.log('Initialized a git repository with an initial commit.');
      const { leftOut } = result;
      if (leftOut.length > 0) {
        const shown = leftOut.slice(0, 5).join(', ') + (leftOut.length > 5 ? `, ... (${leftOut.length} files)` : '');
        const changed = amended.filter(path => leftOut.includes(path));
        console.log(
          `Note: files that were already in the directory are not in the commit: ${shown}\n` +
            (changed.length > 0
              ? `  ${changed.join(', ')} ${changed.length === 1 ? 'is' : 'are'} left out although the features added to ${changed.length === 1 ? 'it' : 'them'}.\n`
              : '') +
            '  Review them before you commit them (a .env may hold secrets).',
        );
      }
      break;
    }
    case 'unavailable':
      console.log('Note: git was not found, so no repository was created.');
      break;
    case 'inside-repo':
      console.log('Note: the project is inside an existing git repository, so no new one was created.');
      break;
    case 'no-commit':
      console.log(
        `Note: initialized a git repository, but the initial commit failed: ${result.reason}\n` +
          '  Set git user.name and user.email, then commit the files yourself.',
      );
      break;
    case 'failed':
      console.log(`Note: git init failed (${result.reason}), so no repository was created.`);
      break;
  }
}

/** A path as a shell argument in the printed steps. */
function shellPath(path: string): string {
  return /^[\w./-]+$/.test(path) ? path : `"${path}"`;
}

export async function create(args: CliArgs): Promise<void> {
  const config = await gatherConfig(args, {
    cwd: process.cwd(),
    interactive: process.stdin.isTTY === true,
    userAgent: process.env['npm_config_user_agent'],
  });

  const langLabel = config.language === 'js' ? 'JavaScript (.jsx)' : 'TypeScript (.tsx)';
  const modeLabel = config.mode === 'static' ? 'static site' : 'server app';
  const displayDir = relative(process.cwd(), config.targetDir) || '.';
  console.log(`\nCreating ${config.packageName} in ${config.targetDir} - ${langLabel}, ${modeLabel}...`);
  // A --force run's directory already holds files that are not ours to commit.
  const preexisting = config.git && config.targetState === 'not-empty'
    ? new Set(await readdir(config.targetDir))
    : undefined;
  const { linksMonorepo, files, amended, featureSteps } = await writeProject(config);

  const installed = config.installDeps && install(config.targetDir, config.packageManager);
  // After the install, so the initial commit includes the lockfile. Over
  // existing files it holds only what this run created: the files it wrote
  // whole and anything outside the entries that were already there.
  const written = new Set(files);
  const include = preexisting === undefined
    ? undefined
    : (path: string): boolean => written.has(path) || !preexisting.has(path.split('/')[0] ?? path);
  if (config.git) reportGit(config.targetDir, include, amended);

  const pm = config.packageManager;
  const steps = [
    ...(linksMonorepo ? [MONOREPO_BUILD_COMMAND] : []),
    ...(displayDir !== '.' ? [`cd ${shellPath(displayDir)}`] : []),
    ...(installed ? [] : [installCommand(pm)]),
    runCommand(pm, 'dev'),
  ].map(step => `  ${step}`).join('\n');
  const deploy = config.mode === 'static'
    ? `\n\nWhen you're ready to deploy:\n  ${runCommand(pm, 'build')}      # → out/ (deploy to any static host)`
    : '';
  const rebuild = linksMonorepo
    ? `\nThe first step builds the workspace's @gio.js/core and @gio.js/react, which\n` +
      `this app links: run it again after changing them.\n`
    : '';
  console.log(`\nDone! To get started:\n\n${steps}${deploy}\n${rebuild}`);
  if (featureSteps !== '') console.log(`Your features:\n${featureSteps}\n`);
}
