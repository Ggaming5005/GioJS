/** Types for search-index.mjs: the search-index.json format. */
export const INDEX_VERSION: number;

export interface SearchIndexPage {
  /** URL path. */
  u: string;
  /** The page's h1. */
  t: string;
  /** Its nav label, when that differs from the h1. */
  n?: string;
  /** Nav section ('Getting Started', 'API Reference', ...). */
  s: string;
  /** Nav group, when the page is in a titled one. */
  g?: string;
}

export interface SearchIndexSection {
  /** Index into `pages`. */
  p: number;
  /** Heading text; '' for the page's intro. */
  h: string;
  /** Heading id; '' for the intro. */
  a: string;
  /** 1 for the intro, else the heading level. */
  l: number;
  /** Plain text, code blocks left out. */
  x: string;
  /** Inline-code terms, one per line. */
  k?: string;
  /** Names the section's reference tables define (their first column), one per line. */
  d?: string;
  /** Words of the section's code blocks that `x` does not hold, space-separated. */
  c?: string;
}

export interface SearchIndex {
  v: number;
  pages: SearchIndexPage[];
  sections: SearchIndexSection[];
}

export interface ExtractedSection {
  heading: string;
  anchor: string;
  level: number;
  text: string;
  code: string[];
  defines: string[];
  blockWords: string[];
}

export interface NavPlace {
  section: string;
  group?: string | undefined;
  label: string;
}

export function extractSections(html: string): { title: string; sections: ExtractedSection[] };
export function buildSearchIndex(
  pages: ReadonlyArray<{ route: string; html: string }>,
  locate: (route: string) => NavPlace | undefined,
  fallbackSection?: string,
): SearchIndex;
