/**
 * docs-site/components/nav/index.ts
 *
 * The docs navigation: one file per area, placed here in the four
 * top-level sections. Everything that walks the docs reads this list - the
 * sidebar, the breadcrumbs, the prev/next pager, the default <title>, the
 * search index's section labels (build.mjs) and the orphan check
 * (scripts/check-links.mjs, which requires every docs page to appear here
 * and every nav file to be imported here).
 *
 * Each content area edits only its own file, so parallel work on the docs
 * does not conflict here.
 */
import type { NavGroup, NavItem, NavSection } from './types.ts';
import { gettingStartedGroups } from './getting-started.ts';
import { guidesGroups } from './guides.ts';
import { componentsGroups } from './api-components.ts';
import { functionsGroups } from './api-functions.ts';
import { fileConventionsGroups } from './api-file-conventions.ts';
import { pageExportsGroups } from './api-page-exports.ts';
import { gioTomlGroups } from './api-gio-toml.ts';
import { otherReferenceGroups } from './api-other.ts';
import { runtimeReferenceGroups } from './api-runtime.ts';
import { architectureGroups } from './architecture.ts';

export type { NavGroup, NavItem, NavSection } from './types.ts';

/** Drop empty groups: an area whose pages have not landed yet renders nothing. */
const nonEmpty = (groups: NavGroup[]): NavGroup[] => groups.filter((group) => group.items.length > 0);

export const NAV: NavSection[] = [
  {
    title: 'Getting Started',
    description: 'Build your first GioJS app, one concept at a time - from install to deploy.',
    groups: nonEmpty(gettingStartedGroups),
  },
  {
    title: 'Guides',
    description: 'Task-oriented recipes: auth, databases, i18n, testing, security and production deploys.',
    groups: nonEmpty(guidesGroups),
  },
  {
    title: 'API Reference',
    description: 'Every component, hook, function, file convention, page export, gio.toml key and CLI command.',
    groups: nonEmpty([
      ...componentsGroups,
      ...functionsGroups,
      ...fileConventionsGroups,
      ...pageExportsGroups,
      ...gioTomlGroups,
      ...otherReferenceGroups,
      ...runtimeReferenceGroups,
    ]),
  },
  {
    title: 'Architecture',
    description: 'How the Rust server and the Node renderer split the work, and where GioJS stops.',
    groups: nonEmpty(architectureGroups),
  },
];

/** Where a page sits in the nav. */
export interface NavLocation {
  section: NavSection;
  /** Its group, or undefined for an untitled (flat) group. */
  group: NavGroup | undefined;
  item: NavItem;
  /**
   * The pages before and after it in reading order, across sections,
   * labelled by pageName() ('Components', not 'Overview').
   */
  prev: NavItem | undefined;
  next: NavItem | undefined;
}

interface FlatEntry {
  section: NavSection;
  group: NavGroup;
  item: NavItem;
}

/** Every nav entry in reading order (sidebar order, top to bottom). */
export function flattenNav(nav: NavSection[] = NAV): FlatEntry[] {
  return nav.flatMap((section) =>
    section.groups.flatMap((group) => group.items.map((item) => ({ section, group, item }))),
  );
}

const FLAT = flattenNav();

/** `/docs/x/` and `/docs/x#y` both name the page `/docs/x`. */
function pagePath(path: string): string {
  return path.replace(/[?#].*$/, '').replace(/\/+$/, '') || '/';
}

/** The nav location of `path`, or undefined for a page outside the nav (/docs itself). */
export function locatePage(path: string): NavLocation | undefined {
  const target = pagePath(path);
  const index = FLAT.findIndex((entry) => entry.item.href === target);
  const entry = FLAT[index];
  if (entry === undefined) return undefined;
  const neighbour = (other: FlatEntry | undefined): NavItem | undefined =>
    other === undefined ? undefined : { href: other.item.href, label: entryName(other.item, other.group) };
  return {
    section: entry.section,
    group: entry.group.title === undefined ? undefined : entry.group,
    item: entry.item,
    prev: neighbour(FLAT[index - 1]),
    next: neighbour(FLAT[index + 1]),
  };
}

function entryName(item: NavItem, group: NavGroup | undefined): string {
  return item.label === 'Overview' && group?.title !== undefined ? group.title : item.label;
}

/**
 * A page's name outside the sidebar (default <title>, breadcrumbs, pager,
 * search label): its label, except that a group's 'Overview' page is named
 * after the group.
 */
export function pageName(location: NavLocation): string {
  return entryName(location.item, location.group);
}

/**
 * A page's place as the search index labels it (lib/search-index.mjs), or
 * undefined for a page outside the nav - labelled 'Docs' there.
 */
export function searchPlace(route: string): { section: string; group?: string | undefined; label: string } | undefined {
  if (route === '/releases') return { section: 'Releases', label: 'Releases' };
  const location = locatePage(route);
  if (location === undefined) return undefined;
  return { section: location.section.title, group: location.group?.title, label: pageName(location) };
}

/** The first page of a section: where its /docs index card links. */
export function firstPageOf(section: NavSection): NavItem | undefined {
  return section.groups[0]?.items[0];
}
