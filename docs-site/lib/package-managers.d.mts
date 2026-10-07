/** Types for package-managers.mjs (plain JS so the tests run it without a compiler). */
export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';
export const PACKAGE_MANAGERS: PackageManager[];
export function pmCommands(npm: string): Record<PackageManager, string>;
