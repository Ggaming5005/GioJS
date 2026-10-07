/**
 * giojs-cli/src/overlays/apply.ts
 *
 * Plans and applies feature overlays. Planning runs every overlay against a
 * virtual view of the project (disk plus the writes planned so far, so
 * overlays compose - two of them adding .gitignore lines, tailwind wrapping
 * scripts another overlay set) and touches nothing; applying writes the
 * result. `add` refuses to apply a plan with conflicts, so a refused run
 * leaves the project exactly as it was - never half an overlay.
 *
 * A feature counts as set up once every file it adds exists. Its files and
 * scripts that differ from what it would write now are then the user's
 * (edited since, or generated for an earlier state of the project) - kept
 * (plan.kept), so running `add` again is safe. For a feature not set up
 * yet, a file it would add that exists with other content, or a
 * package.json script already set to something else, is a conflict. Either
 * way the user's version wins unless they pass --force.
 */
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lineDiff } from './diff.js';
import type { PackageManager } from './package-manager.js';
import { OVERLAYS } from './registry.js';
import { addTomlArrayEntry, addTomlKey } from './toml.js';
import {
  FEATURE_NAMES,
  type FeatureName,
  type GeneratedFile,
  type Overlay,
  type OverlayContext,
  type OverlayLanguage,
  type OverlayMode,
  type PackageJson,
} from './types.js';

const OVERLAY_TEMPLATES_DIR = join(fileURLToPath(import.meta.url), '..', '..', '..', 'templates', 'overlays');

export interface ProjectInfo {
  projectName: string;
  language: OverlayLanguage;
  mode: OverlayMode;
  packageManager: PackageManager;
}

export interface Conflict {
  path: string;
  reason: string;
  /** What the overlay would change, as -/+ lines. */
  diff: string[];
}

/** A user's edit to a set-up feature's file or script, left as it is. */
export interface Kept {
  feature: FeatureName;
  path: string;
  /** The script's name, for package.json. */
  script?: string;
}

export interface OverlayPlan {
  features: FeatureName[];
  /** Final content per project-relative path, in planning order. */
  writes: Map<string, string>;
  created: string[];
  updated: string[];
  conflicts: Conflict[];
  /** Files and scripts of features already set up that the user changed. */
  kept: Kept[];
  /** Changes that could not be made automatically. */
  manual: string[];
  /** Overlays that would change nothing: already set up. */
  unchanged: FeatureName[];
  /** Overlays that do not fit the project's build target. */
  unsupported: Array<{ feature: FeatureName; mode: OverlayMode }>;
  postSteps: Array<{ feature: FeatureName; steps: string[] }>;
}

export interface PlanOptions {
  /** Overwrite modified files and scripts instead of reporting conflicts. */
  force?: boolean;
}

/** Features in their canonical order, without duplicates. */
export function orderFeatures(features: Iterable<FeatureName>): FeatureName[] {
  const wanted = new Set(features);
  return FEATURE_NAMES.filter(name => wanted.has(name));
}

/** `dot_github` → `.github`: npm drops or renames some dotfiles on publish. */
function templatePath(relativePath: string): string {
  return relativePath
    .split(sep)
    .map(segment => (segment.startsWith('dot_') ? `.${segment.slice(4)}` : segment))
    .join('/');
}

async function listFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(path)));
    else out.push(path);
  }
  return out.sort();
}

async function templateFiles(overlay: Overlay, ctx: OverlayContext): Promise<GeneratedFile[]> {
  const files: GeneratedFile[] = [];
  for (const templateDir of overlay.templateDirs ?? []) {
    for (const variant of ['shared', ctx.language]) {
      const root = join(OVERLAY_TEMPLATES_DIR, templateDir, variant);
      for (const file of await listFiles(root)) {
        const content = await readFile(file, 'utf8');
        files.push({
          path: templatePath(relative(root, file)),
          content: content.replaceAll('{{PROJECT_NAME}}', ctx.projectName),
          // A file several overlays share (_forms) that is already there came
          // with another feature, so it is the user's to edit.
          ...(templateDir.startsWith('_') ? { onExisting: 'keep' as const } : {}),
        });
      }
    }
  }
  return files;
}

/** The project as disk plus planned writes. */
class VirtualProject {
  readonly writes = new Map<string, string>();
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  async read(path: string): Promise<string | undefined> {
    const planned = this.writes.get(path);
    if (planned !== undefined) return planned;
    const full = join(this.#dir, path);
    return existsSync(full) ? readFile(full, 'utf8') : undefined;
  }

  exists(path: string): boolean {
    return this.writes.has(path) || existsSync(join(this.#dir, path));
  }
}

function detectIndent(json: string): string {
  return /^[ \t]+(?=")/m.exec(json)?.[0] ?? '  ';
}

function sortedRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

/** A .gitignore created by an overlay starts with what every GioJS app ignores. */
export const BASE_GITIGNORE = [
  '# Dependencies and generated files',
  'node_modules/',
  '.gio/',
  'out/',
  '',
  '# Local env files hold secrets',
  '.env*.local',
  '',
].join('\n');

const AGENTS_HEADING = '## Starter features';

/** AGENTS.md with the overlay's note under "Starter features", once. */
export function withAgentsNote(current: string, note: string): string {
  if (current.includes(note)) return current;
  const base = current.replace(/\s+$/, '');
  const heading = base.includes(AGENTS_HEADING) ? '' : `\n\n${AGENTS_HEADING}\n`;
  return `${base}${heading}\n${note}\n`;
}

/** `KEY=...`, or a commented-out `# KEY=...` (documented, deliberately unset). */
const ENV_KEY = /^\s*(?:#\s*)?(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/**
 * Append `lines` to a dotenv-style or .gitignore-style file: each entry
 * (a KEY= line - commented out or not - or a pattern) is added when
 * missing, together with the comment lines right above it.
 */
export function appendMissingLines(
  current: string,
  lines: readonly string[],
  keyOf: (line: string) => string | undefined,
): string {
  const present = new Set(current.split('\n').map(keyOf).filter((key): key is string => key !== undefined));
  const added: string[] = [];
  let pendingComments: string[] = [];
  for (const line of lines) {
    const key = keyOf(line);
    if (key === undefined && (line.trim() === '' || line.trimStart().startsWith('#'))) {
      pendingComments.push(line);
      continue;
    }
    if (key !== undefined && !present.has(key)) {
      // Leading blank lines only separated this entry from a skipped one.
      while (added.length === 0 && pendingComments[0]?.trim() === '') pendingComments.shift();
      added.push(...pendingComments, line);
      present.add(key);
    }
    pendingComments = [];
  }
  if (added.length === 0) return current;
  const base = current.replace(/\s+$/, '');
  return `${base}${base === '' ? '' : '\n\n'}${added.join('\n')}\n`;
}

const envKey = (line: string): string | undefined => ENV_KEY.exec(line)?.[1];
const gitignoreKey = (line: string): string | undefined => {
  const trimmed = line.trim();
  return trimmed === '' || trimmed.startsWith('#') ? undefined : trimmed.replace(/^\/|\/$/g, '');
};

export async function planOverlays(
  dir: string,
  features: Iterable<FeatureName>,
  project: ProjectInfo,
  options: PlanOptions = {},
): Promise<OverlayPlan> {
  const ordered = orderFeatures(features);
  const fs = new VirtualProject(dir);
  const plan: OverlayPlan = {
    features: ordered,
    writes: fs.writes,
    created: [],
    updated: [],
    conflicts: [],
    kept: [],
    manual: [],
    unchanged: [],
    unsupported: [],
    postSteps: [],
  };

  for (const name of ordered) {
    const overlay = OVERLAYS[name];
    if (!overlay.modes.includes(project.mode)) {
      plan.unsupported.push({ feature: name, mode: project.mode });
    }
  }
  if (plan.unsupported.length > 0) return plan;

  for (const name of ordered) {
    const overlay = OVERLAYS[name];
    const issuesBefore = plan.conflicts.length + plan.manual.length;
    let changes = 0;

    const write = async (path: string, content: string): Promise<void> => {
      const existed = fs.exists(path);
      if (existed && (await fs.read(path)) === content) return;
      changes++;
      fs.writes.set(path, content);
      if (!existed && !plan.created.includes(path)) plan.created.push(path);
      else if (existed && !plan.created.includes(path) && !plan.updated.includes(path)) plan.updated.push(path);
    };

    const pkgRaw = await fs.read('package.json');
    if (pkgRaw === undefined) throw new Error(`no package.json in ${dir}`);
    const pkg = JSON.parse(pkgRaw) as PackageJson;
    const ctx: OverlayContext = { dir, ...project, packageJson: pkg };

    // Files. All of them there means the feature is already set up: one
    // that differs is the user's edit, not something in the feature's way.
    const files = [...(await templateFiles(overlay, ctx)), ...(overlay.generate?.(ctx) ?? [])];
    const setUp = files.length > 0 && files.every(file => fs.exists(file.path));
    for (const file of files) {
      const existing = await fs.read(file.path);
      if (existing === undefined || existing === file.content) {
        await write(file.path, file.content);
      } else if (file.onExisting === 'keep') {
        continue;
      } else if (options.force === true) {
        await write(file.path, file.content);
      } else if (setUp) {
        plan.kept.push({ feature: name, path: file.path });
      } else {
        plan.conflicts.push({
          path: file.path,
          reason: 'exists with different content',
          diff: lineDiff(existing, file.content),
        });
      }
    }

    // package.json.
    let pkgChanged = false;
    for (const [field, wanted] of [
      ['dependencies', overlay.dependencies],
      ['devDependencies', overlay.devDependencies],
    ] as const) {
      if (wanted === undefined) continue;
      const target = { ...(pkg[field] ?? {}) };
      let added = false;
      for (const [dep, range] of Object.entries(wanted)) {
        // A version the user already depends on (in either list) is theirs.
        if (pkg.dependencies?.[dep] !== undefined || pkg.devDependencies?.[dep] !== undefined) continue;
        target[dep] = range;
        added = true;
      }
      if (added) {
        pkg[field] = sortedRecord(target);
        pkgChanged = true;
      }
    }
    const scripts = { ...(pkg.scripts ?? {}) };
    for (const [script, change] of Object.entries(overlay.scripts?.(ctx) ?? {})) {
      const current = scripts[script];
      const next = typeof change === 'function' ? change(current) : change;
      if (next === undefined || next === current) continue;
      if (typeof change === 'string' && current !== undefined && options.force !== true) {
        if (setUp) {
          plan.kept.push({ feature: name, path: 'package.json', script });
          continue;
        }
        plan.conflicts.push({
          path: 'package.json',
          reason: `script "${script}" is already set`,
          diff: [`- "${script}": ${JSON.stringify(current)}`, `+ "${script}": ${JSON.stringify(next)}`],
        });
        continue;
      }
      scripts[script] = next;
      pkgChanged = true;
    }
    if (pkgChanged) pkg.scripts = scripts;
    for (const [field, value] of Object.entries(overlay.packageFields ?? {})) {
      if (pkg[field] !== undefined) {
        if (JSON.stringify(pkg[field]) !== JSON.stringify(value)) {
          plan.manual.push(`package.json: ${overlay.name} expects "${field}": ${JSON.stringify(value)}`);
        }
        continue;
      }
      pkg[field] = value;
      pkgChanged = true;
    }
    if (pkgChanged) await write('package.json', JSON.stringify(pkg, null, detectIndent(pkgRaw)) + '\n');

    // gio.toml.
    const tomlAdditions = overlay.toml;
    if (tomlAdditions !== undefined) {
      let toml = await fs.read('gio.toml');
      if (toml === undefined) {
        plan.manual.push(`gio.toml is missing: ${overlay.name} needs ${JSON.stringify(tomlAdditions)}`);
      } else {
        for (const key of tomlAdditions.keys ?? []) {
          const result = addTomlKey(toml, key);
          toml = result.content;
          plan.manual.push(...result.manual);
        }
        for (const entry of tomlAdditions.entries ?? []) {
          toml = addTomlArrayEntry(toml, entry).content;
        }
        await write('gio.toml', toml);
      }
    }

    // .env files and .gitignore.
    for (const [file, lines] of Object.entries(overlay.env ?? {})) {
      await write(file, appendMissingLines((await fs.read(file)) ?? '', lines, envKey));
    }
    if (overlay.gitignore !== undefined) {
      const current = (await fs.read('.gitignore')) ?? BASE_GITIGNORE;
      await write('.gitignore', appendMissingLines(current, overlay.gitignore, gitignoreKey));
    }
    const agents = await fs.read('AGENTS.md');
    if (overlay.agents !== undefined && agents !== undefined) {
      await write('AGENTS.md', withAgentsNote(agents, overlay.agents));
    }

    // Anchored edits to the project's own files.
    for (const edit of overlay.edits?.(ctx) ?? []) {
      const path = edit.paths.find(candidate => fs.exists(candidate));
      const content = path === undefined ? undefined : await fs.read(path);
      const next = path === undefined || content === undefined ? null : edit.apply(content, ctx);
      if (next === null) plan.manual.push(edit.manual);
      else if (path !== undefined) await write(path, next);
    }

    if (changes === 0 && plan.conflicts.length + plan.manual.length === issuesBefore) {
      plan.unchanged.push(name);
      continue;
    }
    const steps = overlay.postSteps?.(ctx) ?? [];
    if (steps.length > 0) plan.postSteps.push({ feature: name, steps });
  }
  return plan;
}

export async function applyPlan(dir: string, plan: OverlayPlan): Promise<void> {
  for (const [path, content] of plan.writes) {
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
}
