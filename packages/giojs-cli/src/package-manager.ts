/**
 * giojs-cli/src/package-manager.ts
 *
 * Which package manager the scaffold installs with and names in its next
 * steps. `npm create`, `pnpm create`, `yarn create` and `bun create` each
 * set npm_config_user_agent ("pnpm/9.1.0 npm/? node/v22.2.0 linux x64"), so
 * the one the user ran is the one they get - a pnpm user handed an
 * `npm install` ends up with two lockfiles.
 */
export const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

export function detectPackageManager(userAgent: string | undefined): PackageManager {
  const name = userAgent?.split(' ')[0]?.split('/')[0];
  return (PACKAGE_MANAGERS as readonly string[]).includes(name ?? '') ? (name as PackageManager) : 'npm';
}

/** The command that installs a project's dependencies. */
export function installCommand(pm: PackageManager): string {
  return `${pm} install`;
}

/** The command that runs a package.json script. */
export function runCommand(pm: PackageManager, script: string): string {
  // npm needs `run` for anything but start/test; bun reserves bare
  // `bun <name>` for its own subcommands first (`bun build` is the bundler).
  return pm === 'npm' || pm === 'bun' ? `${pm} run ${script}` : `${pm} ${script}`;
}
