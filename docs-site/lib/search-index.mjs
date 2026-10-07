/**
 * docs-site/lib/search-index.mjs
 *
 * Builds the docs search index from rendered page HTML: build.mjs writes it
 * to out/search-index.json from the exported pages, and in development
 * app/search-index.json/route.ts serves the same thing from pages rendered
 * on demand. One entry per section - the page's intro, then each h2 and h3
 * with its anchor - so a result can link straight to the part of the page
 * that matched. search.mjs is the matcher that reads it.
 *
 * Shape (short keys: the file is fetched by every visitor who searches):
 *   { v: 1,
 *     pages:    [{ u: url, t: h1 title, n?: nav label when it differs,
 *                  s: nav section, g?: nav group }],
 *     sections: [{ p: page index, h: heading ('' = the intro), a: anchor,
 *                  l: 1 | 2 | 3, x: plain text (code blocks left out),
 *                  k?: inline-code terms, one per line,
 *                  c?: words of the code blocks not in x }] }
 *
 * Types: search-index.d.mts.
 */
import { articleHtml, htmlToPlain, stripNonText, stripTags, uniqueSlug } from './text.mjs';

export const INDEX_VERSION = 1;

/** A section's text is cut here: the index stays small, and the start of a section is what a snippet shows. */
const MAX_SECTION_TEXT = 4000;
/** At most this many distinct inline-code terms per section. */
const MAX_CODE_TERMS = 60;
/** At most this many distinct words from a section's code blocks. */
const MAX_BLOCK_WORDS = 400;

const HEADING = /<h([23])\b([^>]*)>([\s\S]*?)<\/h\1>/gi;

/**
 * Split a rendered page into its title and sections. Headings without an
 * explicit id get the one the browser gives them (text.mjs uniqueSlug), so
 * every anchor in the index exists on the page.
 */
export function extractSections(html) {
  const article = articleHtml(html);
  const taken = new Set([...article.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(article);
  const title = h1 ? stripTags(h1[1]).replace(/\s+/g, ' ').trim() : '';

  const sections = [];
  let current = { heading: '', anchor: '', level: 1, start: h1 ? h1.index + h1[0].length : 0 };
  const close = (end) => {
    const body = article.slice(current.start, end);
    // Code blocks are searchable but not quoted: their words go in on their
    // own (a TOML key, a flag), which keeps the index and the snippets lean.
    const prose = stripNonText(body).replace(/<pre\b[\s\S]*?<\/pre>/gi, ' ');
    const text = htmlToPlain(prose).slice(0, MAX_SECTION_TEXT);
    sections.push({
      heading: current.heading,
      anchor: current.anchor,
      level: current.level,
      text,
      code: codeTerms(prose),
      blockWords: blockWords(body, text),
    });
  };
  for (const match of article.matchAll(HEADING)) {
    if (h1 && match.index < h1.index) continue;
    close(match.index);
    const heading = stripTags(stripNonText(match[3])).replace(/\s+/g, ' ').trim();
    const explicit = /\bid="([^"]+)"/.exec(match[2])?.[1];
    current = {
      heading,
      anchor: explicit ?? uniqueSlug(heading, taken),
      level: Number(match[1]),
      start: match.index + match[0].length,
    };
  }
  close(article.length);
  // An empty intro (the h1 is straight followed by an h2) still stands for
  // the page itself, so a title match has somewhere to land.
  return { title, sections };
}

/** The distinct inline `<code>` terms of a fragment without code blocks: API names to boost. */
function codeTerms(prose) {
  const terms = new Set();
  for (const match of prose.matchAll(/<code\b[^>]*>([\s\S]*?)<\/code>/gi)) {
    const term = stripTags(match[1]).trim();
    if (term.length > 0 && term.length <= 60) terms.add(term);
    if (terms.size >= MAX_CODE_TERMS) break;
  }
  return [...terms];
}

/** The distinct words of a fragment's code blocks that its text does not already hold. */
function blockWords(html, text) {
  const known = new Set(text.toLowerCase().match(/[\p{L}\p{N}_$]+/gu) ?? []);
  const words = new Set();
  for (const block of stripNonText(html).matchAll(/<pre\b([^>]*)>([\s\S]*?)<\/pre>/gi)) {
    // The file name a CodeBlock shows (data-title) is searchable with its code.
    const title = /\bdata-title="([^"]*)"/.exec(block[1])?.[1] ?? '';
    for (const [word] of stripTags(`${title}\n${block[2]}`).matchAll(/[\p{L}\p{N}_$]+/gu)) {
      if (word.length < 2 || known.has(word.toLowerCase()) || /^\d+$/.test(word)) continue;
      words.add(word);
      if (words.size >= MAX_BLOCK_WORDS) return [...words];
    }
  }
  return [...words];
}

/**
 * The index for `pages` ([{ route, html }]). `locate(route)` names a page's
 * place in the nav - `{ section, group?, label }` - or returns undefined for
 * a page outside it, which is labelled `fallbackSection` ('Docs').
 */
export function buildSearchIndex(pages, locate, fallbackSection = 'Docs') {
  const index = { v: INDEX_VERSION, pages: [], sections: [] };
  for (const { route, html } of pages) {
    const { title, sections } = extractSections(html);
    const place = locate(route);
    const page = { u: route, t: title || place?.label || route, s: place?.section ?? fallbackSection };
    if (place?.label && place.label !== page.t) page.n = place.label;
    if (place?.group) page.g = place.group;
    const p = index.pages.push(page) - 1;
    for (const section of sections) {
      const entry = { p, h: section.heading, a: section.anchor, l: section.level, x: section.text };
      if (section.code.length > 0) entry.k = section.code.join('\n');
      if (section.blockWords.length > 0) entry.c = section.blockWords.join(' ');
      index.sections.push(entry);
    }
  }
  return index;
}
