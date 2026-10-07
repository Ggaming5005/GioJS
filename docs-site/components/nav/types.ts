/**
 * docs-site/components/nav/types.ts
 *
 * The shapes of the docs navigation data. Each nav file exports the groups
 * of one area; index.ts places them in the four top-level sections.
 */

/** One page in the sidebar. */
export interface NavItem {
  /** The page's URL, e.g. '/docs/functions/redirect'. Each page appears once. */
  href: string;
  /** Sidebar label; also the breadcrumb, the pager label and the default <title>. */
  label: string;
}

/**
 * A collapsible group of pages. Without a `title` the items render flat at
 * the top of their section (Getting Started is one such group). A group
 * with an index page lists it first (`{ href: '/docs/components', label:
 * 'Overview' }`). A group with no items is not rendered.
 */
export interface NavGroup {
  title?: string;
  items: NavItem[];
}

/** One of the four top-level sidebar sections. */
export interface NavSection {
  title: string;
  /** One sentence for the /docs index card. */
  description: string;
  groups: NavGroup[];
}
