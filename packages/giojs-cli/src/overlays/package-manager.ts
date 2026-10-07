/**
 * giojs-cli/src/overlays/package-manager.ts
 *
 * The package manager a project uses, for the commands overlays write into
 * generated files (the CI workflow, the Dockerfile) and print as next steps.
 * An existing project's lockfile decides; a fresh scaffold has none yet, so
 * the manager that launched the CLI (npm_config_user_agent, set by
 * `npm create` / `pnpm create` / `yarn create` / `bun create`) does.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type PackageManagerName = 'npm' | 'pnpm' | 'yarn' | 'bun';

export interface PackageManager {
  name: PackageManagerName;
  /** The lockfile it writes. */
  lockfile: string;
  /** Install from scratch (adds/updates the lockfile). */
  install: string;
  /** Reproducible install from the committed lockfile. */
  ci: string;
  /** `npm run <script>` and friends. */
  run(script: string): string;
  /** Run a dependency's bin: `npx gio`. */
  exec(command: string): string;
}

const MANAGERS: Record<PackageManagerName, PackageManager> = {
  npm: {
    name: 'npm',
    lockfile: 'package-lock.json',
    install: 'npm install',
    ci: 'npm ci',
    run: script => `npm run ${script}`,
    exec: command => `npx ${command}`,
  },
  pnpm: {
    name: 'pnpm',
    lockfile: 'pnpm-lock.yaml',
    install: 'pnpm install',
    ci: 'pnpm install --frozen-lockfile',
    run: script => `pnpm run ${script}`,
    exec: command => `pnpm exec ${command}`,
  },
  yarn: {
    name: 'yarn',
    lockfile: 'yarn.lock',
    install: 'yarn install',
    ci: 'yarn install --frozen-lockfile',
    run: script => `yarn run ${script}`,
    exec: command => `yarn ${command}`,
  },
  bun: {
    name: 'bun',
    lockfile: 'bun.lock',
    install: 'bun install',
    ci: 'bun install --frozen-lockfile',
    run: script => `bun run ${script}`,
    exec: command => `bunx ${command}`,
  },
};

export function packageManager(name: PackageManagerName): PackageManager {
  return MANAGERS[name];
}

/**
 * The command a generated file (Dockerfile, CI workflow) runs a script
 * with. A script the project does not have yet still runs with npm and pnpm
 * - they skip a missing one themselves - so one added later (`add tailwind`
 * gives a project its build script) runs without editing the file; yarn
 * and bun fail on a missing script, so they get null.
 */
export function runScript(pm: PackageManager, script: string, defined: boolean): string | null {
  if (defined) return pm.run(script);
  if (pm.name === 'npm') return `npm run ${script} --if-present`;
  if (pm.name === 'pnpm') return `pnpm run --if-present ${script}`;
  return null;
}

/** `pnpm/9.1.0 npm/? node/v22...` → pnpm; undefined for anything else. */
export function managerFromUserAgent(userAgent: string | undefined): PackageManagerName | undefined {
  const name = userAgent?.split('/')[0];
  return name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun' ? name : undefined;
}

const LOCKFILES: ReadonlyArray<[string, PackageManagerName]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
];

export function detectPackageManager(
  projectDir: string,
  userAgent: string | undefined = process.env['npm_config_user_agent'],
): PackageManager {
  for (const [lockfile, name] of LOCKFILES) {
    if (existsSync(join(projectDir, lockfile))) return MANAGERS[name];
  }
  return MANAGERS[managerFromUserAgent(userAgent) ?? 'npm'];
}
