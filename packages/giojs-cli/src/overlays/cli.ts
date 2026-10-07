/**
 * giojs-cli/src/overlays/cli.ts
 *
 * The create flow's side of feature overlays: the "Add features" prompt and
 * applying the chosen overlays to the fresh scaffold. The feature flags
 * (--tailwind --api --auth --db --docker --ci, --features a,b,c) are part of
 * create's strict parser (args.ts). create.ts and prompts.ts call into here
 * through a few marked lines; everything else about overlays stays in this
 * directory.
 */
import { UsageError } from '../args.js';
import { applyPlan, planOverlays, type OverlayPlan, type ProjectInfo } from './apply.js';
import { multiselect } from './multiselect.js';
import { OVERLAYS } from './registry.js';
import { FEATURE_NAMES, type FeatureName, type OverlayMode } from './types.js';

/** `auth needs a server app - ...`, or null when every feature fits the build target. */
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
    // A usage error like an unknown flag: refused before anything is asked or written.
    if (problem !== null) throw new UsageError(`${problem}.`);
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

export interface CreateFeaturesResult {
  /** The next-steps text to print (empty when no features were chosen). */
  steps: string;
  /** Every file the overlays wrote, project-relative and '/'-separated. */
  files: string[];
  /**
   * The files among them that were already there and that the overlays
   * added to rather than wrote whole (a pre-existing .env.development
   * given the demo login): they still hold what was in them before.
   */
  merged: string[];
}

export interface CreateFeaturesOptions {
  /**
   * A create --force run into a non-empty directory: replace files that were
   * already there, the way the template copy itself does.
   */
  force?: boolean;
  /** Ctrl+C: stops before the first write. */
  signal?: AbortSignal;
  /** Receives the paths about to be written, before the first write (for a rollback). */
  planned?: (paths: string[]) => void;
}

/** Apply the chosen features to a freshly copied template. */
export async function applyCreateFeatures(
  destDir: string,
  project: ProjectInfo,
  features: readonly FeatureName[],
  options: CreateFeaturesOptions = {},
): Promise<CreateFeaturesResult> {
  if (features.length === 0) return { steps: '', files: [], merged: [] };
  const plan = await planOverlays(destDir, features, project, { force: options.force === true });
  const problem = unsupportedMessage(plan.unsupported.map(u => u.feature), project.mode);
  if (problem !== null) throw new UsageError(`${problem}.`);
  if (plan.conflicts.length > 0) {
    throw new Error(`The template conflicts with the selected features:\n${formatConflicts(plan)}`);
  }
  options.signal?.throwIfAborted();
  options.planned?.([...plan.writes.keys()]);
  await applyPlan(destDir, plan);
  console.log(`Added: ${plan.features.map(feature => OVERLAYS[feature].title).join(', ')}.`);
  return { steps: formatPostSteps(plan), files: [...plan.writes.keys()], merged: plan.merged };
}
