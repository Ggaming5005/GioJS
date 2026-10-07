/**
 * giojs-cli/src/overlays/registry.ts
 *
 * Every feature overlay, by name. Order matters where overlays build on each
 * other's package.json (FEATURE_NAMES order: tailwind wraps `build` before
 * docker and ci read it), and apply.ts always applies them in that order.
 */
import { api } from './features/api.js';
import { auth } from './features/auth.js';
import { ci } from './features/ci.js';
import { db } from './features/db.js';
import { docker } from './features/docker.js';
import { tailwind } from './features/tailwind.js';
import { FEATURE_NAMES, type FeatureName, type Overlay } from './types.js';

export const OVERLAYS: Record<FeatureName, Overlay> = { tailwind, api, auth, db, docker, ci };

/** `--auth`-style flag spellings and aliases accepted for each feature. */
const ALIASES: Record<string, FeatureName> = {
  tailwind: 'tailwind',
  tailwindcss: 'tailwind',
  api: 'api',
  auth: 'auth',
  db: 'db',
  database: 'db',
  sqlite: 'db',
  drizzle: 'db',
  docker: 'docker',
  ci: 'ci',
  'github-actions': 'ci',
};

export function featureByName(name: string): FeatureName | undefined {
  return ALIASES[name.trim().toLowerCase()];
}

export function isFeatureName(name: string): name is FeatureName {
  return (FEATURE_NAMES as readonly string[]).includes(name);
}
