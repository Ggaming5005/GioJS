import { createInterface } from 'readline/promises';
import { select } from './select.js';
import { chooseFeatures } from './overlays/cli.js';
import type { FeatureName } from './overlays/types.js';

export type Language = 'ts' | 'js';
export type Mode = 'server' | 'static';

export interface ProjectConfig {
  projectName: string;
  language: Language;
  mode: Mode;
  template: 'default' | 'default-js';
  installDeps: boolean;
  /** Feature overlays to apply (overlays/). */
  features: FeatureName[];
}

export interface CliArgs {
  projectName?: string;
  language?: Language;
  mode?: Mode;
  installDeps?: boolean;
  /** Feature flags (overlays/cli.ts extractFeatureArgs); undefined = ask. */
  features?: FeatureName[];
  /** Skip interactive prompts and accept defaults for anything not provided. */
  yes: boolean;
}

function templateFor(language: Language): ProjectConfig['template'] {
  return language === 'js' ? 'default-js' : 'default';
}

export async function gatherConfig(args: CliArgs): Promise<ProjectConfig> {
  const interactive = process.stdin.isTTY === true && !args.yes;

  if (!interactive) {
    const language = args.language ?? 'ts';
    const mode = args.mode ?? 'server';
    return {
      projectName: args.projectName?.trim() || 'my-giojs-app',
      language,
      mode,
      template: templateFor(language),
      installDeps: args.installDeps ?? true,
      features: await chooseFeatures(args.features, mode, false),
    };
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let projectName: string;
  let installDeps: boolean;
  try {
    if (args.projectName?.trim()) {
      projectName = args.projectName.trim();
    } else {
      const raw = await rl.question('Project name (my-giojs-app): ');
      projectName = raw.trim() || 'my-giojs-app';
    }
  } finally {
    rl.close();
  }

  const language = args.language ?? (await select<Language>(
    'Which language would you like to use?',
    [
      { label: 'TypeScript', value: 'ts', hint: '.tsx - recommended' },
      { label: 'JavaScript', value: 'js', hint: '.jsx' },
    ],
    0,
  ));

  const mode = args.mode ?? (await select<Mode>(
    'What are you building?',
    [
      { label: 'Server app', value: 'server', hint: 'SSR, ISR, image optimization, route handlers - runs the GioJS server' },
      { label: 'Static site', value: 'static', hint: 'exports to HTML - deploy free to any static host' },
    ],
    0,
  ));

  // overlays: the "Add features" multi-select (skipped when flags chose).
  const features = await chooseFeatures(args.features, mode, true);

  if (args.installDeps !== undefined) {
    installDeps = args.installDeps;
  } else {
    const rl2 = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const depAnswer = await rl2.question('Install dependencies now? [Y/n] ');
      installDeps = depAnswer.trim().toLowerCase() !== 'n';
    } finally {
      rl2.close();
    }
  }

  return { projectName, language, mode, template: templateFor(language), installDeps, features };
}
