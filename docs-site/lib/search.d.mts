/** Types for search.mjs, the docs search engine. */
import type { SearchIndex } from './search-index.mjs';

/** A run of text; `hit` marks a matched span. */
export interface TextPart {
  text: string;
  hit: boolean;
}

export interface SearchItem {
  /** Page URL, with `#anchor` for a section. */
  url: string;
  /** Section heading; '' for the page's intro. */
  heading: string;
  headingParts: TextPart[];
  level: number;
  snippet: TextPart[];
  score: number;
}

export interface SearchPage {
  url: string;
  title: string;
  titleParts: TextPart[];
  section: string;
  group: string | undefined;
  score: number;
  items: SearchItem[];
}

export interface SearchResult {
  pages: SearchPage[];
  /** Matching pages, before the limit. */
  total: number;
}

export interface Searcher {
  search(query: string, options?: { limit?: number; perPage?: number }): SearchResult;
  /** Sections indexed. */
  size: number;
}

export function createSearch(index: SearchIndex): Searcher;
export function normalizeName(text: string): string;
export function tokenize(text: string): Array<{ token: string; part: boolean }>;
export function queryTerms(query: string): string[];
export function editDistance(a: string, b: string, max: number): number;
export function highlight(text: string, tokens: readonly string[]): TextPart[];
export function snippet(text: string, tokens: readonly string[], length?: number): string;
export function stem(word: string): string;
