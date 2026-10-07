/**
 * giojs-cli/src/project-name.ts
 *
 * npm package name rules (validate-npm-package-name's for new packages,
 * implemented here to keep create-giojs dependency-free) and a sanitizer
 * that turns a directory name like "My App" into a valid default.
 *
 * The validated name is also what lands in the templates' source files
 * ({{PROJECT_NAME}} in TSX, TOML and JSON), so these rules are what keep a
 * quote or a brace in a folder name from breaking the generated code.
 */
import { builtinModules } from 'node:module';

const MAX_LENGTH = 214;
const BLOCKED = new Set(['node_modules', 'favicon.ico']);
export const DEFAULT_PROJECT_NAME = 'my-giojs-app';

/** Why `name` is not a valid npm package name, or undefined when it is. */
export function validatePackageName(name: string): string | undefined {
  if (name.length === 0) return 'the name cannot be empty';
  if (name.length > MAX_LENGTH) return `the name cannot be longer than ${MAX_LENGTH} characters`;
  if (name.trim() !== name) return 'the name cannot start or end with spaces';
  if (name.startsWith('.')) return 'the name cannot start with a dot';
  if (name.startsWith('_')) return 'the name cannot start with an underscore';
  if (name.toLowerCase() !== name) return 'the name must be lowercase';
  if (BLOCKED.has(name)) return `"${name}" is a reserved name`;
  if (builtinModules.includes(name)) return `"${name}" is the name of a Node.js built-in module`;
  if (/[~'!()*]/.test(name)) return 'the name cannot contain ~\'!()*';

  const scoped = /^@([^/]+)\/([^/]+)$/.exec(name);
  const parts = scoped !== null ? [scoped[1] ?? '', scoped[2] ?? ''] : [name];
  for (const part of parts) {
    if (part.startsWith('.') || part.startsWith('_')) return 'the name cannot start with a dot or underscore';
    if (encodeURIComponent(part) !== part) {
      return 'the name can only contain URL-safe characters (letters, digits, - . _)';
    }
  }
  return undefined;
}

/** A valid package name derived from `raw` (e.g. a directory name). */
export function sanitizePackageName(raw: string): string {
  const name = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._~-]+/g, '-')
    .replace(/~/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+/, '')
    .slice(0, MAX_LENGTH)
    .replace(/[-.]+$/, '');
  if (name === '' || BLOCKED.has(name)) return DEFAULT_PROJECT_NAME;
  return builtinModules.includes(name) ? `${name}-app` : name;
}
