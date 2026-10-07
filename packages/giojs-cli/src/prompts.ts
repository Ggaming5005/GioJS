/**
 * giojs-cli/src/prompts.ts
 *
 * Resolves the scaffold's settings from the flags, asking for whatever is
 * missing - but only on an interactive terminal: without one (CI, piped
 * stdin) or with --yes every unanswered question takes its default, so a
 * scripted run can never block on a prompt. All questions come before the
 * first file is written, so Ctrl+C at any of them leaves nothing behind.
 */
import { basename, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { UsageError, type CliArgs, type Language, type Mode } from './args.js';
import { detectPackageManager, type PackageManager } from './package-manager.js';
import { DEFAULT_PROJECT_NAME, sanitizePackageName, validatePackageName } from './project-name.js';
import { CancelledError, select } from './select.js';
import { describeNonEmpty, inspectTargetDir, type TargetDirState } from './target-dir.js';

export type { Language, Mode } from './args.js';

export interface ProjectConfig {
  /** Absolute path of the project directory. */
  targetDir: string;
  /** What was there before: no directory, an empty one, or (--force) files. */
  targetState: 'missing' | 'empty' | 'not-empty';
  /** The validated npm package name, also substituted into the templates. */
  packageName: string;
  language: Language;
  mode: Mode;
  template: 'default' | 'default-js';
  installDeps: boolean;
  git: boolean;
  packageManager: PackageManager;
}

export interface PromptEnv {
  cwd: string;
  interactive: boolean;
  userAgent: string | undefined;
}

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  bold: '\x1b[1m',
};

function templateFor(language: Language): ProjectConfig['template'] {
  return language === 'js' ? 'default-js' : 'default';
}

/**
 * One line of input. Ctrl+C (and Ctrl+D) reject with CancelledError instead
 * of leaving readline's default handler to pause stdin mid-question.
 */
async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const controller = new AbortController();
  let answered = false;
  rl.on('SIGINT', () => controller.abort());
  rl.on('close', () => { if (!answered) controller.abort(); });
  try {
    const answer = await rl.question(question, { signal: controller.signal });
    answered = true;
    return answer;
  } catch (err) {
    if (controller.signal.aborted) throw new CancelledError();
    throw err;
  } finally {
    answered = true;
    rl.close();
  }
}

async function askText(label: string, fallback: string): Promise<string> {
  const answer = await ask(`${C.green}?${C.reset} ${C.bold}${label}${C.reset} ${C.dim}(${fallback})${C.reset} `);
  return answer.trim() || fallback;
}

async function askConfirm(label: string, fallback: boolean): Promise<boolean> {
  const hint = fallback ? 'Y/n' : 'y/N';
  const answer = (await ask(`${C.green}?${C.reset} ${C.bold}${label}${C.reset} ${C.dim}[${hint}]${C.reset} `))
    .trim()
    .toLowerCase();
  if (answer === '') return fallback;
  return answer === 'y' || answer === 'yes';
}

function warn(message: string): void {
  // Also printed by non-interactive runs, whose output is often a log file.
  const mark = process.stdout.isTTY === true ? `${C.yellow}!${C.reset}` : '!';
  console.log(`${mark} ${message}`);
}

/** What stands in the way of scaffolding into `state`, or undefined when nothing does. */
function targetProblem(state: TargetDirState, displayDir: string, force: boolean): string | undefined {
  if (state.kind === 'not-a-directory') return `${displayDir} exists and is not a directory.`;
  if (state.kind === 'not-empty' && !force) return describeNonEmpty(displayDir, state.entries);
  return undefined;
}

function display(cwd: string, targetDir: string): string {
  return relative(cwd, targetDir) || '.';
}

export async function gatherConfig(args: CliArgs, env: PromptEnv): Promise<ProjectConfig> {
  const interactive = env.interactive && !args.yes;

  // The directory first: a refusal should come before any other question.
  let targetDir: string;
  let state: TargetDirState;
  const given = args.projectDir ?? (interactive ? undefined : DEFAULT_PROJECT_NAME);
  if (given !== undefined) {
    targetDir = resolve(env.cwd, given);
    state = await inspectTargetDir(targetDir);
    const problem = targetProblem(state, display(env.cwd, targetDir), args.force);
    if (problem !== undefined) throw new UsageError(problem);
  } else {
    for (;;) {
      const answer = await askText('Project name:', DEFAULT_PROJECT_NAME);
      targetDir = resolve(env.cwd, answer);
      state = await inspectTargetDir(targetDir);
      const problem = targetProblem(state, display(env.cwd, targetDir), args.force);
      if (problem === undefined) break;
      warn(problem);
    }
  }

  // The package name comes from the directory's name ('.' = the current one).
  const derived = basename(targetDir);
  let packageName = derived;
  const invalid = validatePackageName(derived);
  if (invalid !== undefined) {
    const suggestion = sanitizePackageName(derived);
    if (interactive) {
      warn(`"${derived}" is not a valid npm package name: ${invalid}.`);
      for (;;) {
        packageName = await askText('Package name:', suggestion);
        const problem = validatePackageName(packageName);
        if (problem === undefined) break;
        warn(`"${packageName}" is not a valid npm package name: ${problem}.`);
      }
    } else {
      packageName = suggestion;
      warn(`Using the package name "${suggestion}" - "${derived}" is not a valid npm package name: ${invalid}.`);
    }
  }

  const language = args.language ?? (interactive
    ? await select<Language>(
      'Which language would you like to use?',
      [
        { label: 'TypeScript', value: 'ts', hint: '.tsx - recommended' },
        { label: 'JavaScript', value: 'js', hint: '.jsx' },
      ],
      0,
    )
    : 'ts');

  const mode = args.mode ?? (interactive
    ? await select<Mode>(
      'What are you building?',
      [
        { label: 'Server app', value: 'server', hint: 'SSR, ISR, image optimization, route handlers - runs the GioJS server' },
        { label: 'Static site', value: 'static', hint: 'exports to HTML - deploy free to any static host' },
      ],
      0,
    )
    : 'server');

  const packageManager = args.packageManager ?? detectPackageManager(env.userAgent);
  const installDeps = args.installDeps
    ?? (interactive ? await askConfirm(`Install dependencies with ${packageManager}?`, true) : true);

  return {
    targetDir,
    targetState: state.kind === 'not-a-directory' ? 'not-empty' : state.kind,
    packageName,
    language,
    mode,
    template: templateFor(language),
    installDeps,
    git: args.git ?? true,
    packageManager,
  };
}
