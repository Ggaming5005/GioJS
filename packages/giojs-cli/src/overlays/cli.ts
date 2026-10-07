/**
 * giojs-cli/src/overlays/cli.ts
 *
 * The create flow's side of feature overlays: the feature flags
 * (--tailwind --api --auth --db --docker --ci, --features a,b,c), the
 * "Add features" prompt, and applying the chosen overlays to the fresh
 * scaffold. create.ts and prompts.ts call into here through a few marked
 * lines; everything else about overlays stays in this directory.
 */
import { applyPlan, planOverlays, type OverlayPlan, type ProjectInfo } from './apply.js';
import { multiselect } from './multiselect.js';
import { OVERLAYS, featureByName } from './registry.js';
import { FEATURE_NAMES, type FeatureName, type OverlayMode } from './types.js';

export const FEATURE_USAGE = `Features (any combination; prompted for when none are given):
  --tailwind           Tailwind CSS v4
  --api                JSON route.ts + <GioForm> page action
  --auth               cookie sessions, login/logout, guarded /dashboard
  --db                 SQLite + Drizzle ORM (Node 22.16+)
  --docker             production Dockerfile + docker-compose.yml
  --ci                 GitHub Actions workflow
  --features a,b,c     the same, as a list`;

export interface FeatureArgs {
  /** Undefined when no feature flag was given (the prompt decides). */
  features: FeatureName[] | undefined;
  /** argv without the feature flags. */
  rest: string[];
}

function parseList(value: string | undefined, flag: string): FeatureName[] {
  if (value === undefined || value.startsWith('-')) {
    throw new Error(`${flag} needs a comma-separated list: ${FEATURE_NAMES.join(',')}`);
  }
  return value
    .split(',')
    .filter(name => name.trim() !== '')
    .map(name => {
      const feature = featureByName(name);
      if (feature === undefined) {
        throw new Error(`Unknown feature "${name.trim()}" - choose from: ${FEATURE_NAMES.join(', ')}`);
      }
      return feature;
    });
}

/** Take the feature flags out of argv, leaving the rest for the create flow's own parser. */
export function extractFeatureArgs(argv: readonly string[]): FeatureArgs {
  let features: FeatureName[] | undefined;
  const rest: string[] = [];
  const add = (names: FeatureName[]): void => {
    features = [...new Set([...(features ?? []), ...names])];
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const flagged = arg.startsWith('--') ? featureByName(arg.slice(2)) : undefined;
    if (arg === '--features') {
      add(parseList(argv[++i], arg));
    } else if (arg.startsWith('--features=')) {
      add(parseList(arg.slice('--features='.length), '--features'));
    } else if (flagged !== undefined) {
      add([flagged]);
    } else {
      rest.push(arg);
    }
  }
  return { features, rest };
}

function unsupportedMessage(features: readonly FeatureName[], mode: OverlayMode): string | null {
  const unsupported = features.filter(feature => !OVERLAYS[feature].modes.includes(mode));
  if (unsupported.length === 0) return null;
  return `${unsupported.join(', ')} need${unsupported.length === 1 ? 's' : ''} a server app - a ${mode} site has no server to run ${unsupported.length === 1 ? 'it' : 'them'}`;
}

/** The features to add: the flags' if any were given, else the prompt's (none when not interactive). */
export async function chooseFeatures(
  given: FeatureName[] | undefined,
  mode: OverlayMode,
  interactive: boolean,
): Promise<FeatureName[]> {
  if (given !== undefined) {
    const problem = unsupportedMessage(given, mode);
    if (problem !== null) throw new Error(`Cannot add ${problem}.`);
    return given;
  }
  if (!interactive) return [];
  const choices = FEATURE_NAMES.filter(name => OVERLAYS[name].modes.includes(mode)).map(name => ({
    label: OVERLAYS[name].title,
    value: name,
    hint: OVERLAYS[name].hint,
  }));
  return multiselect('Add features', choices);
}

export function formatConflicts(plan: OverlayPlan): string {
  return plan.conflicts
    .map(conflict => [`  ${conflict.path}: ${conflict.reason}`, ...conflict.diff.map(line => `      ${line}`)].join('\n'))
    .join('\n');
}

export function formatPostSteps(plan: OverlayPlan): string {
  const lines: string[] = [];
  for (const { feature, steps } of plan.postSteps) {
    lines.push(`  ${OVERLAYS[feature].title}:`, ...steps.map(step => `    - ${step}`));
  }
  if (plan.manual.length > 0) {
    lines.push('  To do by hand:', ...plan.manual.map(step => `    - ${step}`));
  }
  return lines.join('\n');
}

/**
 * Apply the chosen features to a freshly copied template. Returns the
 * next-steps text to print (empty when no features were chosen).
 */
export async function applyCreateFeatures(
  destDir: string,
  project: ProjectInfo,
  features: readonly FeatureName[],
): Promise<string> {
  if (features.length === 0) return '';
  const plan = await planOverlays(destDir, features, project);
  const problem = unsupportedMessage(plan.unsupported.map(u => u.feature), project.mode);
  if (problem !== null) throw new Error(`Cannot add ${problem}.`);
  if (plan.conflicts.length > 0) {
    throw new Error(`The template conflicts with the selected features:\n${formatConflicts(plan)}`);
  }
  await applyPlan(destDir, plan);
  console.log(`Added: ${plan.features.map(feature => OVERLAYS[feature].title).join(', ')}.`);
  return formatPostSteps(plan);
}
