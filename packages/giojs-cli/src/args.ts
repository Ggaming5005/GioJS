/**
 * giojs-cli/src/args.ts
 *
 * Strict flag parsing for `create-giojs`. An unknown flag is an error with a
 * did-you-mean hint rather than being ignored: a mistyped `--statc` that
 * silently scaffolds a server app is worse than a one-line failure.
 */
import { PACKAGE_MANAGERS, type PackageManager } from './package-manager.js';

export type Language = 'ts' | 'js';
export type Mode = 'server' | 'static';

export interface CliArgs {
  /** The positional project directory ('.' = the current directory). */
  projectDir?: string;
  language?: Language;
  mode?: Mode;
  installDeps?: boolean;
  git?: boolean;
  packageManager?: PackageManager;
  /** Scaffold into a non-empty directory. */
  force: boolean;
  /** Skip interactive prompts and accept defaults for anything not provided. */
  yes: boolean;
  help: boolean;
  version: boolean;
}

export class UsageError extends Error {
  override name = 'UsageError';
}

const BOOLEAN_FLAGS: Record<string, (args: CliArgs) => void> = {
  '--ts': args => { args.language = 'ts'; },
  '--typescript': args => { args.language = 'ts'; },
  '--js': args => { args.language = 'js'; },
  '--javascript': args => { args.language = 'js'; },
  '--server': args => { args.mode = 'server'; },
  '--static': args => { args.mode = 'static'; },
  '--install': args => { args.installDeps = true; },
  '--no-install': args => { args.installDeps = false; },
  '--git': args => { args.git = true; },
  '--no-git': args => { args.git = false; },
  '--force': args => { args.force = true; },
  '-f': args => { args.force = true; },
  '--yes': args => { args.yes = true; },
  '-y': args => { args.yes = true; },
  '--help': args => { args.help = true; },
  '-h': args => { args.help = true; },
  '--version': args => { args.version = true; },
  '-v': args => { args.version = true; },
};

const VALUE_FLAGS = ['--pm'] as const;

export const KNOWN_FLAGS: readonly string[] = [...Object.keys(BOOLEAN_FLAGS), ...VALUE_FLAGS];

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { force: false, yes: false, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    const [flag, inlineValue] = arg.startsWith('--') && arg.includes('=')
      ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]
      : [arg, undefined];

    const setter = BOOLEAN_FLAGS[flag];
    if (setter !== undefined && inlineValue === undefined) {
      setter(args);
      continue;
    }
    if (flag === '--pm') {
      const value = inlineValue ?? argv[++i];
      if (value === undefined || value.startsWith('-')) {
        throw new UsageError(`--pm needs a value: ${PACKAGE_MANAGERS.join(', ')}`);
      }
      if (!(PACKAGE_MANAGERS as readonly string[]).includes(value)) {
        throw new UsageError(`Unknown package manager "${value}" - use one of ${PACKAGE_MANAGERS.join(', ')}`);
      }
      args.packageManager = value as PackageManager;
      continue;
    }
    if (arg.startsWith('-') && arg !== '-') {
      const hint = didYouMean(flag, KNOWN_FLAGS);
      throw new UsageError(
        `Unknown option ${flag}${hint !== undefined ? ` - did you mean ${hint}?` : ''}\n` +
          'Run create-giojs --help to see every option.',
      );
    }
    if (args.projectDir !== undefined) {
      throw new UsageError(
        `Unexpected argument "${arg}": the project directory is already "${args.projectDir}".`,
      );
    }
    args.projectDir = arg;
  }
  return args;
}

/** The closest known option within a small edit distance, if any. */
export function didYouMean(input: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const distance = editDistance(input, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  // Two edits catches a typo or a dropped dash without matching unrelated
  // short flags (`-x` is one edit from `-y`, but that guess would mislead).
  return bestDistance <= Math.min(2, Math.floor(input.length / 3)) ? best : undefined;
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j] ?? 0;
      const substitution = diagonal + (a[i - 1] === b[j - 1] ? 0 : 1);
      row[j] = Math.min(above + 1, (row[j - 1] ?? 0) + 1, substitution);
      diagonal = above;
    }
  }
  return row[b.length] ?? 0;
}

export const USAGE = `Create a new GioJS app.

Usage:
  npm create giojs@latest [directory] -- [options]
  npm create giojs@latest -- migrate [dir]     Migrate a Next.js app (see migrate --help)

  [directory] is where the app goes ('.' = the current directory, which
  must then be empty). The npm package name is derived from its name.

Options:
  --ts, --typescript   TypeScript (default)
  --js, --javascript   JavaScript
  --server             server app: SSR, ISR caching, images, route handlers (default)
  --static             static site: \`npm run build\` exports plain HTML to out/
  --pm <name>          package manager: npm, pnpm, yarn or bun
                       (default: the one running create-giojs)
  --install            install dependencies (default)
  --no-install         skip installing dependencies
  --git                create a git repository with an initial commit (default)
  --no-git             skip git init
  -f, --force          scaffold into a directory that is not empty
  -y, --yes            accept the defaults for everything not given
  -h, --help           show this help
  -v, --version        print the create-giojs version

Without a terminal (CI, piped input) the defaults are used and nothing is asked.

Examples:
  npm create giojs@latest
  npm create giojs@latest my-app -- --js --static
  pnpm create giojs my-app --no-git
  npm create giojs@latest my-app -- --pm bun --no-install
  npm create giojs@latest . -- --yes
  npm create giojs@latest -- migrate ./my-next-app`;
