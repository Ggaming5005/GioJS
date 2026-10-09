/**
 * giojs-cli/src/overlays/add.ts
 *
 * `create-giojs add <feature...>` (exposed as `gio add` too): applies feature
 * overlays to an existing project. The whole run is planned first and
 * written only if nothing conflicts, so a refusal leaves the project as it
 * was. A feature that is already set up keeps the user's edits to its files
 * and changes nothing else, so running it again is safe - also together
 * with a new feature (`add auth db` after editing the login page).
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { didYouMean, FEATURE_FLAGS, featureArg, parseFeatureList, UsageError } from '../args.js';
import { applyPlan, planOverlays, type OverlayPlan, type ProjectInfo } from './apply.js';
import { formatConflicts, formatPostSteps } from './cli.js';
import { detectPackageManager } from './package-manager.js';
import { OVERLAYS } from './registry.js';
import { FEATURE_NAMES, type FeatureName, type PackageJson } from './types.js';

export const ADD_USAGE = `Usage: create-giojs add <feature...> [options]

Adds starter features to an existing GioJS project:
${FEATURE_NAMES.map(name => `  ${name.padEnd(10)} ${OVERLAYS[name].hint}`).join('\n')}

The features can also be given the way create takes them: --tailwind,
--auth, ... or --features tailwind,auth.

Files you changed are never overwritten. Running it again is safe: a
feature that is already set up (all its files exist) keeps your edits to
them and changes nothing. For a feature that is not set up yet, a file of
yours in its way is a conflict: the run stops before anything is written
and shows what the feature would change.

Options:
  --cwd <dir>   the project directory (default: the current directory)
  --dry-run     show what would change without writing anything
  -f, --force   overwrite files and scripts that differ from the feature's
  -h, --help    show this help

An unknown option or feature is a usage error (exit code 2).`;

interface AddArgs {
  features: FeatureName[];
  cwd: string;
  dryRun: boolean;
  force: boolean;
  help: boolean;
}

const BOOLEAN_FLAGS: Record<string, (args: AddArgs) => void> = {
  '--dry-run': args => { args.dryRun = true; },
  '--force': args => { args.force = true; },
  '-f': args => { args.force = true; },
  '--help': args => { args.help = true; },
  '-h': args => { args.help = true; },
};

const KNOWN_FLAGS: readonly string[] = [
  ...Object.keys(BOOLEAN_FLAGS),
  ...Object.keys(FEATURE_FLAGS),
  '--cwd',
  '--features',
];

/**
 * Strict like create's parser (args.ts), whose feature flags it takes too:
 * an unknown option or feature is a UsageError with a did-you-mean hint.
 */
function parseAddArgs(argv: readonly string[], cwd: string): AddArgs {
  const args: AddArgs = { features: [], cwd, dryRun: false, force: false, help: false };
  const add = (features: readonly FeatureName[]): void => {
    for (const feature of features) if (!args.features.includes(feature)) args.features.push(feature);
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    // The npm-style separator pnpm, yarn and bun pass on (`... add -- --dry-run`).
    if (arg === '--') continue;
    const [flag, inlineValue] = arg.startsWith('--') && arg.includes('=')
      ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]
      : [arg, undefined];

    const setter = Object.hasOwn(BOOLEAN_FLAGS, flag) ? BOOLEAN_FLAGS[flag] : undefined;
    const feature = Object.hasOwn(FEATURE_FLAGS, flag) ? FEATURE_FLAGS[flag] : undefined;
    if (setter !== undefined || feature !== undefined) {
      if (inlineValue !== undefined) throw new UsageError(`${flag} does not take a value`);
      if (setter !== undefined) setter(args);
      if (feature !== undefined) add([feature]);
    } else if (flag === '--features') {
      add(parseFeatureList(inlineValue ?? argv[++i]));
    } else if (flag === '--cwd') {
      const dir = inlineValue ?? argv[++i];
      if (dir === undefined || dir === '' || (inlineValue === undefined && dir.startsWith('-'))) {
        throw new UsageError('--cwd needs a directory');
      }
      args.cwd = resolve(cwd, dir);
    } else if (arg.startsWith('-') && arg !== '-') {
      const hint = didYouMean(flag, KNOWN_FLAGS);
      throw new UsageError(
        `Unknown option ${flag}${hint !== undefined ? ` - did you mean ${hint}?` : ''}\n` +
          'Run create-giojs add --help to see the features and options.',
      );
    } else {
      add(arg.split(',').filter(part => part.trim() !== '').map(featureArg));
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
  // Static sites build with `gio export` (create-giojs --static writes that;
  // `node .../bin/gio.js export` in a scaffold inside the GioJS repository).
  const mode = /\bgio(?:\.js)? export\b/.test(pkg.scripts?.['build'] ?? '') ? 'static' : 'server';
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
  if (plan.kept.length > 0) {
    const kept = plan.kept.map(k => `  ${k.path}${k.script === undefined ? '' : ` (script "${k.script}")`}`);
    const them = kept.length === 1 ? 'it' : 'them';
    console.log(`Kept your version of:\n${kept.join('\n')}\n(--force replaces ${them} with the feature's version)`);
  }

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
    if (!(err instanceof UsageError)) throw err;
    // create's usage-error contract: `Error: ...`, exit code 2.
    console.error(`Error: ${err.message}`);
    return 2;
  }
  if (args.help) {
    console.log(ADD_USAGE);
    return 0;
  }
  if (args.features.length === 0) {
    console.error(`Error: Name at least one feature to add.\n\n${ADD_USAGE}`);
    return 2;
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
