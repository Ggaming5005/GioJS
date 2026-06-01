import { createInterface } from 'readline/promises';
import { select } from './select.js';

export type Language = 'ts' | 'js';

export interface ProjectConfig {
  projectName: string;
  language: Language;
  template: 'default' | 'default-js';
  installDeps: boolean;
}

export interface CliArgs {
  projectName?: string;
  language?: Language;
  installDeps?: boolean;
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
    return {
      projectName: args.projectName?.trim() || 'my-giojs-app',
      language,
      template: templateFor(language),
      installDeps: args.installDeps ?? true,
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
      { label: 'TypeScript', value: 'ts', hint: '.tsx — recommended' },
      { label: 'JavaScript', value: 'js', hint: '.jsx' },
    ],
    0,
  ));

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

  return { projectName, language, template: templateFor(language), installDeps };
}
