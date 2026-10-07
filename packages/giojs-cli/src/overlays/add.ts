/**
 * giojs-cli/src/overlays/add.ts
 *
 * `create-giojs add <feature...>` (exposed as `gio add` too): applies feature
 * overlays to an existing project. The whole run is planned first and
 * written only if nothing conflicts, so a refusal leaves the project as it
 * was; a feature that is already set up changes nothing, so running it
 * again is safe.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { applyPlan, planOverlays, type OverlayPlan, type ProjectInfo } from './apply.js';
import { formatConflicts, formatPostSteps } from './cli.js';
import { detectPackageManager } from './package-manager.js';
import { OVERLAYS, featureByName } from './registry.js';
import { FEATURE_NAMES, type FeatureName, type PackageJson } from './types.js';

export const ADD_USAGE = `Usage: create-giojs add <feature...> [options]

Adds starter features to an existing GioJS project:
${FEATURE_NAMES.map(name => `  ${name.padEnd(10)} ${OVERLAYS[name].hint}`).join('\n')}

Files you changed are never overwritten: a conflict stops the run before
anything is written and shows what the feature would change. Running it
again is safe - a feature that is already set up changes nothing.

Options:
  --cwd <dir>   the project directory (default: the current directory)
  --dry-run     show what would change without writing anything
  --force       overwrite conflicting files and scripts
  -h, --help    show this help`;

interface AddArgs {
  features: FeatureName[];
  cwd: string;
  dryRun: boolean;
  force: boolean;
  help: boolean;
}

function parseAddArgs(argv: readonly string[], cwd: string): AddArgs {
  const args: AddArgs = { features: [], cwd, dryRun: false, force: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '-h' || arg === '--help') args.help = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--force') args.force = true;
    else if (arg === '--cwd') {
      const dir = argv[++i];
      if (dir === undefined) throw new Error('--cwd needs a directory');
      args.cwd = resolve(cwd, dir);
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option ${arg}\n\n${ADD_USAGE}`);
    } else {
      for (const name of arg.split(',').filter(part => part.trim() !== '')) {
        const feature = featureByName(name);
        if (feature === undefined) {
          throw new Error(`Unknown feature "${name}" - choose from: ${FEATURE_NAMES.join(', ')}`);
        }
        if (!args.features.includes(feature)) args.features.push(feature);
      }
    }
  }
  return args;
}

/** What `add` needs to know about an existing project, read from its files. */
export function detectProject(dir: string): ProjectInfo {
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) throw new Error(`No package.json in ${dir} - run this in a GioJS project (or pass --cwd).`);
  if (!existsSync(join(dir, 'gio.toml')) && !existsSync(join(dir, 'app'))) {
    throw new Error(`${dir} has no gio.toml or app/ - is it a GioJS project?`);
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as PackageJson & { name?: unknown };
  const language =
    existsSync(join(dir, 'tsconfig.json')) ||
    (!existsSync(join(dir, 'jsconfig.json')) && existsSync(join(dir, 'app', 'layout.tsx')))
      ? 'ts'
      : 'js';
  // Static sites build with `gio export` (create-giojs --static writes that).
  const mode = /\bgio export\b/.test(pkg.scripts?.['build'] ?? '') ? 'static' : 'server';
  return {
    projectName: typeof pkg.name === 'string' && pkg.name !== '' ? pkg.name : basename(dir),
    language,
    mode,
    packageManager: detectPackageManager(dir),
  };
}

function dependencyNames(raw: string | undefined): Set<string> {
  if (raw === undefined) return new Set();
  const pkg = JSON.parse(raw) as PackageJson;
  return new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
}

/** Dependencies the plan adds to package.json. */
function addedDependencies(dir: string, plan: OverlayPlan): string[] {
  const after = plan.writes.get('package.json');
  if (after === undefined) return [];
  const before = dependencyNames(readFileSync(join(dir, 'package.json'), 'utf8'));
  return [...dependencyNames(after)].filter(name => !before.has(name));
}

function report(plan: OverlayPlan, project: ProjectInfo, addedDeps: readonly string[], dryRun: boolean): void {
  const verb = dryRun ? 'Would' : 'Did';
  const list = (label: string, paths: readonly string[]): void => {
    if (paths.length > 0) console.log(`${verb} ${label}:\n${paths.map(path => `  ${path}`).join('\n')}`);
  };
  list('create', plan.created);
  list('update', plan.updated);
  for (const feature of plan.unchanged) console.log(`${OVERLAYS[feature].title} is already set up - nothing to change.`);

  const steps = formatPostSteps(plan);
  if (steps !== '') console.log(`\nNext steps:\n${steps}`);
  if (addedDeps.length > 0) {
    console.log(
      dryRun
        ? `\nWould add dependencies: ${addedDeps.join(', ')}`
        : `\nRun \`${project.packageManager.install}\` to install ${addedDeps.join(', ')}.`,
    );
  }
}

/** Runs `add`; resolves to the process exit code. */
export async function runAdd(argv: string[], cwd: string = process.cwd()): Promise<number> {
  let args: AddArgs;
  try {
    args = parseAddArgs(argv, cwd);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  if (args.help) {
    console.log(ADD_USAGE);
    return 0;
  }
  if (args.features.length === 0) {
    console.error(`Name at least one feature to add.\n\n${ADD_USAGE}`);
    return 1;
  }

  let project: ProjectInfo;
  try {
    project = detectProject(args.cwd);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const plan = await planOverlays(args.cwd, args.features, project, { force: args.force });
  if (plan.unsupported.length > 0) {
    const names = plan.unsupported.map(u => u.feature).join(', ');
    console.error(`Cannot add ${names} to a static site: it needs the GioJS server (build: gio export has none).`);
    return 1;
  }
  if (plan.conflicts.length > 0) {
    console.error(
      `Nothing was written - these files differ from what the feature adds:\n${formatConflicts(plan)}\n\n` +
        'Keep your version (rename or merge it by hand), or rerun with --force to overwrite.',
    );
    return 1;
  }
  const addedDeps = addedDependencies(args.cwd, plan);
  if (!args.dryRun) await applyPlan(args.cwd, plan);
  report(plan, project, addedDeps, args.dryRun);
  return 0;
}
