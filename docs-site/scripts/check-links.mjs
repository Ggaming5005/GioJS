#!/usr/bin/env node
/**
 * docs-site/scripts/check-links.mjs
 *
 * Dead-link and navigation check for the docs site. Run via
 * `npm run check-links` (or `node scripts/check-links.mjs`); exits 1 on any
 * error.
 *
 * - Every internal href in app/ and components/ (`href="/docs/..."`, and the
 *   sidebar's `href: '/docs/...'` entries) must name a page that exists, and a
 *   `#fragment` must name an `id` on that page.
 * - Every page under app/docs/ must be reachable from the sidebar
 *   (components/Sidebar.tsx) - a page nobody can navigate to is a bug.
 * - https://giojs.com/docs/... links in README.md and docs/*.md must resolve
 *   too, so the repository's markdown cannot drift from the site.
 *
 * Code samples are skipped: hrefs inside template literals (the CodeBlock
 * `code={`...`}` strings) are example app code, not links on this site.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = join(siteDir, '..');
const appDir = join(siteDir, 'app');
const publicDir = join(siteDir, 'public');

// Pages other workstreams add under app/docs/guides/ (the create-giojs
// starter recipes). Linking them early is deliberate; until they exist they
// are reported as warnings, and once they do the entry here should go.
const PENDING = new Set([
  '/docs/guides/tailwind',
  '/docs/guides/authentication-example',
  '/docs/guides/database',
  '/docs/guides/docker',
]);

// Written by build.mjs next to the exported pages, not by a page module.
const GENERATED = new Set(['/llms.txt', '/llms-full.txt', '/sitemap.xml', '/robots.txt']);

/** Recursively list files under `dir` whose name passes `keep`. */
function walk(dir, keep) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      found.push(...walk(full, keep));
    } else if (keep(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

/** URL path of an app/**\/page.tsx file, mirroring the router's conventions. */
function routeOf(pageFile) {
  const segments = relative(appDir, dirname(pageFile)).split(sep).filter(Boolean);
  if (segments.some((s) => s.startsWith('_'))) return null; // private folder
  const visible = segments.filter((s) => !(s.startsWith('(') && s.endsWith(')')));
  return '/' + visible.join('/');
}

/**
 * Source with code samples blanked out (line numbers preserved): template
 * literals, and JSX string expressions holding markup (`{'<a href="/x">'}`).
 */
function withoutTemplates(source) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  return source
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, blank)
    .replace(/\{\s*(['"])(?:(?!\1)[^\n])*<(?:(?!\1)[^\n])*\1\s*\}/g, blank);
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

const pages = new Map(); // route -> page file
for (const file of walk(appDir, (name) => /^page\.(tsx|jsx|ts|js)$/.test(name))) {
  const route = routeOf(file);
  if (route !== null) pages.set(route, file);
}

const idCache = new Map();
/** The `id="..."` values a page renders (static ones - enough for anchors). */
function idsOf(route) {
  if (!idCache.has(route)) {
    const source = readFileSync(pages.get(route), 'utf8');
    idCache.set(route, new Set([...source.matchAll(/\bid=["']([^"']+)["']/g)].map((m) => m[1])));
  }
  return idCache.get(route);
}

const errors = [];
const warnings = [];

/**
 * Check one internal link. `fromRoute` resolves bare `#fragment` links;
 * returns nothing, records problems.
 */
function checkLink(href, where, fromRoute) {
  const [pathPart, fragment] = href.split('#', 2);
  const path = pathPart === '' ? fromRoute : pathPart.replace(/\?.*$/, '').replace(/\/$/, '') || '/';
  if (path === null) {
    errors.push(`${where}: fragment link ${href} outside a page`);
    return;
  }
  if (pages.has(path)) {
    if (fragment && !idsOf(path).has(fragment)) {
      errors.push(`${where}: ${href} - page ${path} has no id="${fragment}"`);
    }
    return;
  }
  if (PENDING.has(path)) {
    warnings.push(`${where}: ${href} - pending page, not in this tree yet`);
    return;
  }
  if (GENERATED.has(path)) return;
  // public/ files answer at the site root and under /public/*.
  const asset = path.startsWith('/public/') ? path.slice('/public'.length) : path;
  const assetFile = join(publicDir, ...asset.split('/'));
  if (existsSync(assetFile) && statSync(assetFile).isFile()) return;
  errors.push(`${where}: ${href} - no such page`);
}

// 1. Links in the site's own source.
const sources = [
  ...walk(appDir, (name) => /\.(tsx|jsx|ts|js)$/.test(name)),
  ...walk(join(siteDir, 'components'), (name) => /\.(tsx|jsx|ts|js)$/.test(name)),
];
const HREF = /\bhref\s*(?:=\s*\{?\s*|:\s*)(["'])(.*?)\1/g;
let checked = 0;
for (const file of sources) {
  const source = withoutTemplates(readFileSync(file, 'utf8'));
  const isPage = /^page\.(tsx|jsx|ts|js)$/.test(file.split(sep).pop());
  const fromRoute = isPage ? routeOf(file) : null;
  for (const match of source.matchAll(HREF)) {
    const href = match[2];
    if (!href.startsWith('/') && !href.startsWith('#')) continue; // external, mailto:, ...
    if (href.startsWith('//')) continue;
    checked++;
    checkLink(href, `${relative(siteDir, file)}:${lineOf(source, match.index)}`, fromRoute);
  }
}

// 2. Every docs page is in the sidebar.
const sidebar = withoutTemplates(readFileSync(join(siteDir, 'components', 'Sidebar.tsx'), 'utf8'));
const navHrefs = new Set([...sidebar.matchAll(HREF)].map((m) => m[2].split('#')[0]));
for (const [route, file] of pages) {
  if (!route.startsWith('/docs/')) continue;
  if (!navHrefs.has(route)) {
    errors.push(`${relative(siteDir, file)}: ${route} is not linked from components/Sidebar.tsx`);
  }
}

// 3. giojs.com docs links in the repository's markdown.
const markdown = [
  join(repoDir, 'README.md'),
  ...walk(join(repoDir, 'docs'), (name) => name.endsWith('.md')),
].filter(existsSync);
const SITE_LINK = /https:\/\/giojs\.com(\/(?:docs|releases)[^\s)"'<>`*]*)/g;
for (const file of markdown) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(SITE_LINK)) {
    checked++;
    const href = match[1].replace(/[.,;:]+$/, '');
    checkLink(href, `${relative(repoDir, file)}:${lineOf(source, match.index)}`, null);
  }
}

for (const warning of warnings) console.warn(`warning: ${warning}`);
for (const error of errors) console.error(`error: ${error}`);
console.log(
  `[check-links] ${checked} link(s) across ${pages.size} page(s): ` +
    `${errors.length} error(s), ${warnings.length} warning(s)`,
);
process.exit(errors.length > 0 ? 1 : 0);
