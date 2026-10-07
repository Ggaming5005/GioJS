#!/usr/bin/env node
/**
 * docs-site/scripts/check-links.mjs
 *
 * Dead-link and navigation check for the docs site. Run via
 * `npm run check-links` (or `node scripts/check-links.mjs`); exits 1 on any
 * error. Its tests (and the docs-content checks): `npm test` in docs-site/.
 *
 * - Every internal href in app/ and components/ (`href="/docs/..."`, and the
 *   nav's `href: '/docs/...'` entries) must name a page that exists, and a
 *   `#fragment` must name an `id` on that page.
 * - Every page under app/docs/ must be in the docs nav - the files that
 *   components/nav/index.ts aggregates - exactly once: a page nobody can
 *   navigate to is a bug, and a page listed twice breaks prev/next. Every
 *   nav file must be aggregated by index.ts, or its pages would be missing
 *   from the sidebar while looking listed.
 * - https://giojs.com/docs/... links in README.md and docs/*.md must resolve
 *   too, so the repository's markdown cannot drift from the site.
 *
 * A page another workstream is adding (PENDING) may be linked early from the
 * body of a page - a forward reference, reported as a warning - but never
 * from components/ (the nav and the rest of the chrome on every page) or
 * the repository's markdown, where a link to it would be a dead link on every
 * page of the deployed site. Its nav entry lands with the page itself.
 *
 * Code samples are skipped: hrefs inside template literals (the CodeBlock
 * `code={`...`}` strings) are example app code, not links on this site.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptFile = fileURLToPath(import.meta.url);

// Pages another workstream is adding. Linking them early from a page body is
// deliberate; until they exist they are reported as warnings, and once they
// do the entry here should go (the check warns) and the page needs its
// nav entry (an error until it has one). The create-giojs starter guides
// (/docs/guides/{tailwind,authentication-example,database,docker}) have
// landed, so nothing is pending.
export const PENDING = new Set([]);

// Written by build.mjs next to the exported pages, not by a page module.
const GENERATED = new Set(['/llms.txt', '/llms-full.txt', '/sitemap.xml', '/robots.txt', '/search-index.json']);

const HREF = /\bhref\s*(?:=\s*\{?\s*|:\s*)(["'])(.*?)\1/g;
const SITE_LINK = /https:\/\/giojs\.com(\/(?:docs|releases)[^\s)"'<>`*]*)/g;
const PAGE_FILE = /^page\.(tsx|jsx|ts|js)$/;
const SOURCE_FILE = /\.(tsx|jsx|ts|js)$/;

/**
 * The docs nav as components/nav/index.ts aggregates it, read statically
 * (no TypeScript loader needed): the nav files index.ts imports, every
 * `href: '...'` entry in them with the file and line it is on, and the nav
 * files index.ts does not import.
 */
export function readNav(componentsDir) {
  const navDir = join(componentsDir, 'nav');
  const indexFile = join(navDir, 'index.ts');
  if (!existsSync(indexFile)) return { files: [], entries: [], unaggregated: [] };
  const index = readFileSync(indexFile, 'utf8');
  const imported = new Set(
    [...index.matchAll(/^import\s+(?!type\b)[^;]*?from\s+'\.\/([\w.-]+\.ts)'/gm)].map((m) => m[1]),
  );
  const files = [indexFile, ...[...imported].map((name) => join(navDir, name))].filter(existsSync);
  const entries = [];
  for (const file of files) {
    const source = withoutTemplates(readFileSync(file, 'utf8'));
    for (const match of source.matchAll(HREF)) {
      entries.push({ href: match[2].split('#')[0], file, line: lineOf(source, match.index) });
    }
  }
  const unaggregated = readdirSync(navDir)
    .filter((name) => name.endsWith('.ts') && name !== 'index.ts' && name !== 'types.ts' && !imported.has(name))
    .map((name) => join(navDir, name));
  return { files, entries, unaggregated };
}

/** Recursively list files under `dir` whose name passes `keep`. */
function walk(dir, keep) {
  if (!existsSync(dir)) return [];
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

/**
 * Source with code samples blanked out (line numbers preserved): template
 * literals, and JSX string expressions holding markup (`{'<a href="/x">'}`).
 */
export function withoutTemplates(source) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  return source
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, blank)
    .replace(/\{\s*(['"])(?:(?!\1)[^\n])*<(?:(?!\1)[^\n])*\1\s*\}/g, blank);
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

/**
 * Check the docs site rooted at `siteDir` (app/, components/, public/) and
 * the markdown of the repository at `repoDir`. Returns the problems found
 * instead of printing them: `{ errors, warnings, checked, pageCount }`.
 */
export function checkLinks({
  siteDir = join(dirname(scriptFile), '..'),
  repoDir = join(siteDir, '..'),
  pending = PENDING,
} = {}) {
  const appDir = join(siteDir, 'app');
  const componentsDir = join(siteDir, 'components');
  const publicDir = join(siteDir, 'public');

  /** URL path of an app/**\/page.tsx file, mirroring the router's conventions. */
  function routeOf(pageFile) {
    const segments = relative(appDir, dirname(pageFile)).split(sep).filter(Boolean);
    if (segments.some((s) => s.startsWith('_'))) return null; // private folder
    const visible = segments.filter((s) => !(s.startsWith('(') && s.endsWith(')')));
    return '/' + visible.join('/');
  }

  const pages = new Map(); // route -> page file
  for (const file of walk(appDir, (name) => PAGE_FILE.test(name))) {
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
   * `allowPending` says whether a forward reference to a PENDING page is
   * acceptable here. Returns nothing, records problems.
   */
  function checkLink(href, where, fromRoute, allowPending) {
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
    if (pending.has(path)) {
      if (allowPending) {
        warnings.push(`${where}: ${href} - pending page, not in this tree yet`);
      } else {
        errors.push(
          `${where}: ${href} - pending page, not in this tree yet; only a page body may link ` +
            'it early - navigation and markdown links land with the page',
        );
      }
      return;
    }
    if (GENERATED.has(path)) return;
    // public/ files answer at the site root and under /public/*.
    const asset = path.startsWith('/public/') ? path.slice('/public'.length) : path;
    const assetFile = join(publicDir, ...asset.split('/'));
    if (existsSync(assetFile) && statSync(assetFile).isFile()) return;
    errors.push(`${where}: ${href} - no such page`);
  }

  // 1. Links in the site's own source. Pages may forward-reference a pending
  // page; components/ is the chrome on every page, so it may not.
  let checked = 0;
  const sources = [
    ...walk(appDir, (name) => SOURCE_FILE.test(name)).map((file) => ({ file, allowPending: true })),
    ...walk(componentsDir, (name) => SOURCE_FILE.test(name)).map((file) => ({ file, allowPending: false })),
  ];
  for (const { file, allowPending } of sources) {
    const source = withoutTemplates(readFileSync(file, 'utf8'));
    const fromRoute = PAGE_FILE.test(file.split(sep).pop()) ? routeOf(file) : null;
    for (const match of source.matchAll(HREF)) {
      const href = match[2];
      if (!href.startsWith('/') && !href.startsWith('#')) continue; // external, mailto:, ...
      if (href.startsWith('//')) continue;
      checked++;
      checkLink(href, `${relative(siteDir, file)}:${lineOf(source, match.index)}`, fromRoute, allowPending);
    }
  }

  // 2. Every docs page is in the nav, once; every nav file is aggregated.
  const nav = readNav(componentsDir);
  const navHrefs = new Map();
  for (const entry of nav.entries) {
    const first = navHrefs.get(entry.href);
    if (first !== undefined) {
      errors.push(
        `${relative(siteDir, entry.file)}:${entry.line}: ${entry.href} is already in the nav ` +
          `(${relative(siteDir, first.file)}:${first.line}) - each page appears once`,
      );
    } else {
      navHrefs.set(entry.href, entry);
    }
  }
  for (const file of nav.unaggregated) {
    errors.push(`${relative(siteDir, file)}: nav file not imported by components/nav/index.ts`);
  }
  for (const [route, file] of pages) {
    if (!route.startsWith('/docs/')) continue;
    if (!navHrefs.has(route)) {
      errors.push(`${relative(siteDir, file)}: ${route} is not in the docs nav (components/nav/)`);
    }
  }

  // A pending page that has landed: its PENDING entry is stale.
  for (const path of pending) {
    if (pages.has(path)) {
      warnings.push(`${path} exists now - remove it from PENDING in scripts/check-links.mjs`);
    }
  }

  // 3. giojs.com docs links in the repository's markdown.
  const markdown = [
    join(repoDir, 'README.md'),
    ...walk(join(repoDir, 'docs'), (name) => name.endsWith('.md')),
  ].filter(existsSync);
  for (const file of markdown) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(SITE_LINK)) {
      checked++;
      const href = match[1].replace(/[.,;:]+$/, '');
      checkLink(href, `${relative(repoDir, file)}:${lineOf(source, match.index)}`, null, false);
    }
  }

  return { errors, warnings, checked, pageCount: pages.size };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === scriptFile) {
  const { errors, warnings, checked, pageCount } = checkLinks();
  for (const warning of warnings) console.warn(`warning: ${warning}`);
  for (const error of errors) console.error(`error: ${error}`);
  console.log(
    `[check-links] ${checked} link(s) across ${pageCount} page(s): ` +
      `${errors.length} error(s), ${warnings.length} warning(s)`,
  );
  process.exit(errors.length > 0 ? 1 : 0);
}
