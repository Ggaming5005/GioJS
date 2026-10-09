/**
 * docs-site/lib/search.mjs
 *
 * The docs search engine: an in-memory inverted index over the sections of
 * search-index.json (built by search-index.mjs), with no dependencies. The
 * search dialog (components/DocsSearch.tsx) imports it lazily, on first
 * open, together with the index; the tests import it directly.
 *
 * Matching, per query word: the exact token, then tokens it is a prefix of
 * ("revalid" → revalidate), other inflections of it ("cookies" → cookie,
 * "upgrade" → upgrading), the words a small synonym map gives ("vars" →
 * variables, "isr" → revalidate), then tokens within one or two typos
 * ("revalidte", and a mistyped prefix of the word still being typed). The
 * last segment of a page's URL counts as part of its title (/docs/env-vars
 * answers "env vars"). A number is a weak word: next to other words a
 * section need not hold it (the line number of a pasted error), and it is
 * never an API name (`429` quoted in reference code).
 * Identifiers are indexed whole and by their parts, so `useRouter`,
 * `max_body_bytes` and `GIO_PUBLIC_` are found by "userouter", "router",
 * "body bytes" or "gio_public".
 *
 * Ranking: a word scores by where it occurs - the page title, a heading, an
 * inline-code term, the text - times how well it matched. Sections with
 * every query word come before sections with some of them. A query that is
 * exactly a page title or a heading, ignoring case and punctuation
 * ("redirect", "useRouter()", "gio.toml"), puts that page or section first,
 * and so does a section of the code API reference (components, hooks,
 * functions, page exports) that names it in inline code - an overview
 * listing `useRouter()`: exact API names rank above every prose mention. A
 * per-item page titled with the name still beats the overview, and a
 * mention in a guide, the gio.toml or the CLI reference gets a small bonus
 * only. A section that defines the name ranks above any mention: a row of
 * its reference table (a gio.toml key like `skew_protection`, a prop), or
 * its heading on an API Reference page that writes the name as code
 * (`GioNodePlugin`, `refresh()`). A CLI page titled `gio typegen` answers
 * `typegen` as if titled with it, a page titled `GET, POST, ...` answers
 * each of them, and a gio.toml key is also found by its full name
 * (`server.idle_timeout_secs`, `[security.headers]`). Between two titles or
 * two definitions that differ only in punctuation, the one typed wins:
 * `[security]` is the gio.toml page, `Security` the guide; `proxy_headers`
 * the gio.toml key, `proxyHeaders` a report field. A CLI flag row defines
 * its flags as typed (`--json`, `-H`), never the bare word (`json`). Within
 * a page, a table row that defines a plain word (`details`) opens the page
 * before a mere mention of it, such as the version history. A query that
 * names a page in another inflection or by its URL ("rate limiting" →
 * `[[rate_limits]]`) puts that page near an exact title, and one that names
 * a gio.toml section among other words ("disable csrf") lifts that section's
 * page. Only identifier-shaped queries get the code-reference bonus: a
 * header (`x-frame-options`) or a path quoted there is no API name, and
 * "POST /_gio/revalidate" names the `/_gio/revalidate` heading. A page's
 * version history counts for little and comes after its other sections.
 *
 * Results are grouped by page, best page first, each with its best
 * sections and a snippet around the first match; matched spans come back
 * as `{ text, hit }` parts for the UI to wrap in <mark>.
 *
 * Types: search.d.mts.
 */

/** Field weights for a token found in... */
const W_TITLE_INTRO = 12; // the page title, on the page's own (intro) entry
const W_TITLE_SECTION = 2.5; // the page title, on one of its sections
const W_HEADING = 9;
const W_CODE = 4;
const W_TEXT = 1;
const W_CODE_BLOCK = 0.8; // a word only found in a code block
/** A token that is only part of an identifier (`router` in `useRouter`) counts this much. */
const PART_FACTOR = 0.6;

/** Match quality of a candidate token for a query word. */
const Q_EXACT = 1;
const Q_PREFIX = 0.75;
const Q_TYPO_1 = 0.55;
const Q_TYPO_2 = 0.35;
const Q_TYPO_PREFIX = 0.4;
/** Another inflection of the word (`upgrading` for "upgrade", `cookie` for "cookies"). */
const Q_STEM = 0.85;
/** A word the docs use for the one typed (`variables` for "vars"). */
const Q_SYNONYM = 0.7;
const MAX_CANDIDATES = 80;

/** Bonuses for a query that names a page or section exactly. */
const B_EXACT_TITLE = 100;
/** On top: the title as typed, punctuation included - `[security]` is the gio.toml page, not Security. */
const B_LITERAL_TITLE = 12;
/**
 * A section that defines the name: a row of its reference table (a prop, a
 * gio.toml key), or its heading on an API Reference page. Above a mention
 * in reference code, below a page titled with the name.
 */
const B_DEFINED = 80;
/**
 * On top: the row or API heading as typed, punctuation included -
 * `proxy_headers` is the gio.toml key, `proxyHeaders` a field of the
 * server's report.
 */
const B_LITERAL_DEFINED = 12;
/**
 * Within one page only (it never moves the page): a section whose table
 * defines the name in any spelling, a plain word included, comes before the
 * page's sections that only mention it - `details` opens [health] at its
 * key table, not at the version history - but after a heading for it.
 */
const B_ROW_IN_PAGE = 40;
/** An inline-code term of a code API reference page: above any heading elsewhere, below a title. */
const B_EXACT_REFERENCE_CODE = 70;
const B_EXACT_HEADING = 60;
const B_TITLE_PREFIX = 12;
/**
 * The query names a page in another inflection, or by its URL: "upgrade" is
 * Upgrading, "rate limiting" is `[[rate_limits]]`, "env vars" is
 * /docs/env-vars. Below a title as typed, above a mention in reference code.
 */
const B_STEM_TITLE = 75;
/**
 * A gio.toml section page whose table the query names among other words:
 * "disable csrf" → `[security.csrf]`, "disable rate limit" → `[[rate_limits]]`.
 */
const B_TABLE_CONCEPT = 20;
/**
 * The version history of a page only mentions what changed: its score
 * counts this much, and it comes after every other section of its page.
 */
const VERSION_HISTORY_FACTOR = 0.3;
const VERSION_HISTORY = 'version-history';
const B_EXACT_CODE = 6;
/** The pages whose inline code names the API itself - the page and its subpages. */
const CODE_REFERENCE = /^\/docs\/(?:components|hooks|functions|page-exports)(?:\/|$)/;
/** The nav section of the API reference: its headings name what they document. */
const API_REFERENCE = 'API Reference';
/** A name written as an identifier: snake_case, a dot, a dash, `$` or a capital. */
const IDENTIFIER = /[_$.-]|\p{Lu}/u;
/**
 * A CLI flag row (`--json`, `-p, --port <port>`): it defines each flag as
 * written, dashes included, never the bare word (`json`, `static`).
 */
const FLAG_ROW = /^-/;
const FLAG = /^-[\w-]+$/;
/**
 * A query that can be an API name as typed: no space, slash, colon or dash,
 * and not only digits. A header (`x-frame-options`), a path
 * (`POST /_gio/revalidate`) or a status code (`429`) quoted in a code
 * reference is not the API that page documents.
 */
const API_NAME = /^[^\s/:-]*[\p{L}_$][^\s/:-]*$/u;
/** An HTTP method before a path: "POST /_gio/revalidate" names the `/_gio/revalidate` heading. */
const METHOD_PREFIX = /^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\s+(?=\/)/i;
/** The title of a gio.toml section page: `[server]`, `[[rate_limits]]`. */
const GIO_TOML_TABLE = /^\[\[?([\w.]+)\]\]?$/;
/** A CLI command's page title (`gio typegen`) also answers the bare command (`typegen`). */
const COMMAND_PREFIX = /^gio\s+/;

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'do', 'for', 'from', 'how', 'i', 'in', 'is', 'it',
  'of', 'on', 'or', 'the', 'to', 'what', 'when', 'where', 'with', 'can', 'my',
]);

/**
 * Words a reader types for a word the docs use instead. Each query word
 * also matches its listed words, a little below its own inflections.
 */
const SYNONYMS = new Map([
  ['env', ['environment']],
  ['vars', ['variables']],
  ['var', ['variable']],
  ['isr', ['revalidate', 'revalidation', 'revalidating']],
  ['config', ['configuration']],
  ['disable', ['off']],
]);

const WORD = /[\p{L}\p{N}_$]+/gu;
/** A word that splits into parts: snake_case, $-joined, camelCase or PascalCase. */
const HAS_PARTS = /[_$]|[\p{Ll}\p{N}]\p{Lu}|\p{Lu}\p{Lu}\p{Ll}/u;
/** A word that is only digits, such as a status code: never an API name. */
const NUMBER = /^\p{N}+$/u;

/** Lowercase, punctuation-free form used to compare a query with a name: "useRouter()" → "userouter". */
export function normalizeName(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * A light stem of a lowercase word, so its inflections meet: `upgrade` and
 * `upgrading` → upgrad; `cookies` and `cookie` → cooki; `limits` and
 * `limiting` → limit. It drops a plural `s`, then an `ing` or `ed` ending,
 * then a final `e`, and reads a final `y` as `i` (`entry`, `entries`). A
 * stem keeps at least four letters, so short words stay whole.
 */
export function stem(word) {
  let out = word;
  if (out.length > 4 && out.endsWith('s') && !out.endsWith('ss')) out = out.slice(0, -1);
  if (out.length > 6 && out.endsWith('ing')) out = out.slice(0, -3);
  else if (out.length > 5 && out.endsWith('ed')) out = out.slice(0, -2);
  if (out.length > 4 && out.endsWith('e')) out = out.slice(0, -1);
  if (out.length > 4 && out.endsWith('y')) out = `${out.slice(0, -1)}i`;
  return out;
}

/** The stems of the words of `text`, joined: "Rate limiting" and `rate_limits` → ratelimit. */
function stemName(text) {
  const words = [];
  for (const [word] of text.matchAll(WORD)) {
    const parts = HAS_PARTS.test(word) ? identifierParts(word) : [];
    for (const part of parts.length > 0 ? parts : [word.toLowerCase()]) words.push(stem(part));
  }
  return words.join('');
}

/** The parts of an identifier: `useRouter` → use, router; `max_body_bytes` → max, body, bytes. */
function identifierParts(word) {
  const parts = word
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
    .split(/[\s_$]+/)
    .filter((part) => part.length > 0);
  return parts.length > 1 ? parts.map((part) => part.toLowerCase()) : [];
}

/**
 * Call `visit(token, part)` for each index token of `text`: each word
 * lowercased (part = false), then the parts of an identifier (part = true).
 */
function forEachToken(text, visit) {
  for (const [word] of text.matchAll(WORD)) {
    visit(word.toLowerCase(), false);
    if (HAS_PARTS.test(word)) for (const part of identifierParts(word)) visit(part, true);
  }
}

/** The index tokens of `text`, as forEachToken visits them. */
export function tokenize(text) {
  const out = [];
  forEachToken(text, (token, part) => out.push({ token, part }));
  return out;
}

/** The words of a query, lowercased; stop words dropped unless nothing else is left. */
export function queryTerms(query) {
  const words = [...query.matchAll(WORD)].map(([word]) => word.toLowerCase());
  const content = words.filter((word) => !STOP_WORDS.has(word));
  return [...new Set(content.length > 0 ? content : words)];
}

/**
 * Optimal-string-alignment distance between `a` and `b` (a transposition
 * counts as one edit), or `max + 1` as soon as it must exceed `max`.
 */
export function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const width = b.length + 1;
  let prevPrev = new Uint16Array(width);
  let prev = new Uint16Array(width);
  let row = new Uint16Array(width);
  for (let j = 0; j < width; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    row[0] = i;
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, prevPrev[j - 2] + 1);
      }
      row[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return max + 1;
    [prevPrev, prev, row] = [prev, row, prevPrev];
  }
  return Math.min(prev[b.length], max + 1);
}

/** Add `weight` for `token` to a section's token map. */
function add(map, token, weight) {
  map.set(token, (map.get(token) ?? 0) + weight);
}

/** First index of `lo..hi` in sorted `list` whose value is >= `value`. */
function lowerBound(list, value) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Whether a token may start at `at`: a word start, or an identifier part (`Router` in `useRouter`). */
function startsWord(text, at) {
  if (at === 0) return true;
  const before = text[at - 1];
  if (!/[\p{L}\p{N}]/u.test(before)) return true;
  return /\p{Lu}/u.test(text[at]) && /[\p{Ll}\p{N}]/u.test(before);
}

/**
 * Split `text` into `{ text, hit }` parts, marking each occurrence of a
 * matched token that starts a word or an identifier part.
 */
export function highlight(text, tokens) {
  const lower = text.toLowerCase();
  const ranges = [];
  for (const token of tokens) {
    if (token.length === 0) continue;
    for (let at = lower.indexOf(token); at !== -1; at = lower.indexOf(token, at + 1)) {
      if (!startsWord(text, at)) continue;
      // A prefix match lights up to the end of the word it matched.
      let end = at + token.length;
      while (end < text.length && /[\p{L}\p{N}_]/u.test(text[end]) && /[\p{Ll}\p{N}]/u.test(text[end])) end++;
      ranges.push([at, end]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const parts = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (end <= cursor) continue;
    const from = Math.max(start, cursor);
    if (from > cursor) parts.push({ text: text.slice(cursor, from), hit: false });
    parts.push({ text: text.slice(from, end), hit: true });
    cursor = end;
  }
  if (cursor < text.length || parts.length === 0) parts.push({ text: text.slice(cursor), hit: false });
  return parts;
}

/**
 * A window of `text` around the first matched token, cut at word
 * boundaries, with ellipses where it was cut.
 */
export function snippet(text, tokens, length = 160) {
  const lower = text.toLowerCase();
  let first = -1;
  for (const token of tokens) {
    let at = lower.indexOf(token);
    while (at !== -1 && !startsWord(text, at)) at = lower.indexOf(token, at + 1);
    if (at !== -1 && (first === -1 || at < first)) first = at;
  }
  let start = first <= 40 ? 0 : first - 40;
  if (start > 0) {
    const space = text.indexOf(' ', start);
    start = space !== -1 && space < first ? space + 1 : start;
  }
  let end = Math.min(text.length, start + length);
  if (end < text.length) {
    const space = text.lastIndexOf(' ', end);
    if (space > first && space > start) end = space;
  }
  return `${start > 0 ? '… ' : ''}${text.slice(start, end)}${end < text.length ? ' …' : ''}`;
}

/** Build a searcher over a parsed search-index.json. */
export function createSearch(index) {
  const pages = index.pages;
  const sections = index.sections;
  /** token → flat [sectionIndex, weight, sectionIndex, weight, ...] */
  const postings = new Map();

  // The last segment of a page's URL names it as well as its title does:
  // /docs/env-vars is found by "env" and "vars", /docs/upgrading by "upgrading".
  const slugs = pages.map((page) => page.u.split('/').at(-1) ?? '');
  const titleTokens = pages.map((page, p) => {
    const map = new Map();
    forEachToken(`${page.t} ${page.n ?? ''}`, (token, part) => {
      if (!map.has(token) || !part) map.set(token, part ? PART_FACTOR : 1);
    });
    forEachToken(slugs[p], (token) => map.set(token, 1));
    return map;
  });

  const weights = new Map();
  const counts = new Map();
  sections.forEach((section, s) => {
    weights.clear();
    counts.clear();
    const titleWeight = section.l === 1 ? W_TITLE_INTRO : W_TITLE_SECTION;
    for (const [token, factor] of titleTokens[section.p]) add(weights, token, titleWeight * factor);
    const headingWeight = section.l === 3 ? W_HEADING - 1 : W_HEADING;
    forEachToken(section.h, (token, part) => add(weights, token, headingWeight * (part ? PART_FACTOR : 1)));
    if (section.k) {
      const code = new Map();
      forEachToken(section.k, (token, part) => {
        if (!code.has(token) || !part) code.set(token, part ? PART_FACTOR : 1);
      });
      for (const [token, factor] of code) add(weights, token, W_CODE * factor);
    }
    forEachToken(section.x, (token, part) => add(counts, token, part ? PART_FACTOR : 1));
    if (section.c) {
      forEachToken(section.c, (token, part) => {
        if (!counts.has(token)) counts.set(token, W_CODE_BLOCK * (part ? PART_FACTOR : 1));
      });
    }
    const post = (token, weight) => {
      const list = postings.get(token);
      if (list === undefined) postings.set(token, [s, weight]);
      else list.push(s, weight);
    };
    // Repeats help a little, then stop helping: a long section must not win on volume.
    for (const [token, count] of counts) {
      post(token, W_TEXT * Math.min(2.5, 0.5 + 0.5 * count) + (weights.get(token) ?? 0));
    }
    for (const [token, weight] of weights) {
      if (!counts.has(token)) post(token, weight);
    }
  });

  const vocabulary = [...postings.keys()].sort();
  /** stem → the indexed tokens with that stem */
  const stems = new Map();
  for (const token of vocabulary) {
    const key = stem(token);
    const list = stems.get(key);
    if (list === undefined) stems.set(key, [token]);
    else list.push(token);
  }
  const pageNames = pages.map((page) => [normalizeName(page.t), normalizeName(page.n ?? '')]);
  const literalTitles = pages.map((page) => [page.t, page.n ?? ''].map((text) => text.trim().toLowerCase()));
  // A page titled with a list of names (`GET, POST, PUT, PATCH, DELETE`) is
  // titled with each of them.
  const titleItems = pages.map((page) => {
    const items = page.t.split(',').map((item) => item.trim());
    return items.length > 1 && items.every((item) => IDENTIFIER.test(item) && !/\s/.test(item)) ? items : [];
  });
  titleItems.forEach((items, p) => {
    pageNames[p].push(...items.map(normalizeName));
    literalTitles[p].push(...items.map((item) => item.toLowerCase()));
  });
  // Titles, nav labels and URL slugs by stem: "upgrade" names Upgrading.
  const pageStemNames = pages.map((page, p) =>
    [page.t, page.n ?? '', slugs[p]].map(stemName).filter((name) => name.length > 0));
  const commandNames = pages.map((page) =>
    (COMMAND_PREFIX.test(page.t) ? normalizeName(page.t.replace(COMMAND_PREFIX, '')) : ''));
  const codeReference = pages.map((page) => CODE_REFERENCE.test(page.u));
  const apiReference = pages.map((page) => page.s === API_REFERENCE);
  const headingNames = sections.map((section) => normalizeName(section.h));
  /** An identifier-shaped heading as written (`GioNodePlugin`); not a topic ('Rate limits'). */
  const literalHeadings = sections.map((section) =>
    (IDENTIFIER.test(section.h) && !/\s/.test(section.h.trim()) ? section.h.trim().toLowerCase() : null));
  const codeNames = sections.map((section) =>
    (section.k ? new Set(section.k.split('\n').map(normalizeName)) : null));
  // A table row defines a name only when the name reads as one: a plain
  // word (`layouts`, `cookies`) is as likely a topic, which a guide's
  // heading answers better. On a gio.toml section page (titled `[server]`)
  // every key is also defined by its full name: `server.idle_timeout_secs`,
  // `[security.headers]`. A flag row defines only its flags as typed.
  const tableNames = pages.map((page) => GIO_TOML_TABLE.exec(page.t)?.[1]);
  // The words of the table a gio.toml section page is about, by stem: the
  // last part of its name (`[security.csrf]` → csrf, `[[rate_limits]]` → rate, limit).
  const tableConcepts = tableNames.map((name) =>
    (name === undefined ? null : (name.split('.').at(-1) ?? '').split('_').map(stem)));
  const versionHistory = sections.map((section) => section.a === VERSION_HISTORY);
  const definedNames = [];
  const definedLiterals = [];
  const definedFlags = [];
  const rowNames = [];
  sections.forEach((section) => {
    const rows = section.d ? section.d.split('\n') : [];
    const flagRows = rows.filter((row) => FLAG_ROW.test(row));
    const nameRows = rows.filter((row) => !FLAG_ROW.test(row));
    const identifiers = nameRows.filter((name) => IDENTIFIER.test(name));
    const names = identifiers.map(normalizeName);
    const table = tableNames[section.p];
    if (table !== undefined) names.push(...nameRows.map((name) => normalizeName(`${table}.${name}`)));
    const literals = identifiers.map((name) => name.toLowerCase());
    // Flags keep their case: `-H` is --host, `-h` is --help.
    const flags = [];
    for (const row of flagRows) {
      flags.push(row);
      for (const word of row.split(/[\s,/]+/)) if (FLAG.test(word)) flags.push(word);
    }
    definedNames.push(names.length > 0 ? new Set(names) : null);
    definedLiterals.push(literals.length > 0 ? new Set(literals) : null);
    definedFlags.push(flags.length > 0 ? new Set(flags) : null);
    rowNames.push(nameRows.length > 0 ? new Set(nameRows.map(normalizeName)) : null);
  });
  // Per page, every name it writes as code: a heading among them names an
  // API item (`GioNodePlugin`, `refresh()`), not a topic ('Layouts').
  const pageCodeNames = pages.map(() => new Set());
  sections.forEach((section, s) => {
    const names = [...(codeNames[s] ?? []), ...(section.d ? section.d.split('\n').map(normalizeName) : [])];
    for (const name of names) pageCodeNames[section.p].add(name);
  });
  const candidateCache = new Map();

  /** Candidate tokens for one query word: [token, quality][], best first. */
  function candidates(term, last) {
    const key = `${last ? '1' : '0'}${term}`;
    const cached = candidateCache.get(key);
    if (cached !== undefined) return cached;
    const found = new Map();
    const offer = (token, quality) => {
      if ((found.get(token) ?? 0) < quality) found.set(token, quality);
    };
    const exact = postings.has(term);
    if (exact) offer(term, Q_EXACT);
    // Prefixes: the shortest completions are the likeliest.
    const completions = [];
    for (let i = lowerBound(vocabulary, term); i < vocabulary.length && vocabulary[i].startsWith(term); i++) {
      if (vocabulary[i] !== term) completions.push(vocabulary[i]);
    }
    completions.sort((a, b) => a.length - b.length);
    for (const token of completions.slice(0, MAX_CANDIDATES)) {
      offer(token, Q_PREFIX * Math.sqrt(term.length / token.length));
    }
    // Other inflections ("cookies" → cookie, "upgrade" → upgrading), then
    // the words the docs use for it ("vars" → variables), in any inflection.
    const inflections = stems.get(stem(term)) ?? [];
    for (const token of inflections) offer(token, Q_STEM);
    for (const synonym of SYNONYMS.get(term) ?? []) {
      for (const token of stems.get(stem(synonym)) ?? []) offer(token, Q_SYNONYM);
    }
    // Typos: only for a word that names nothing as typed or inflected, and
    // is long enough that one edit is unlikely to make it a different word.
    if (term.length >= 4 && !exact && inflections.length === 0 && completions.length < 3) {
      const max = term.length >= 8 ? 2 : 1;
      for (const token of vocabulary) {
        if (Math.abs(token.length - term.length) > max) continue;
        const distance = editDistance(term, token, max);
        if (distance === 1) offer(token, Q_TYPO_1);
        else if (distance === 2 && max >= 2) offer(token, Q_TYPO_2);
      }
      // The word still being typed may hold a typo too: compare it with
      // each token's start ("revaldi" → revalidate) - one shorter and one
      // longer as well, since a dropped or an extra letter shifts the rest.
      if (last) {
        for (const token of vocabulary) {
          if (token.length <= term.length || token[0] !== term[0]) continue;
          for (let cut = term.length - 1; cut <= term.length + 1; cut++) {
            if (cut < token.length && editDistance(term, token.slice(0, cut), 1) <= 1) {
              offer(token, Q_TYPO_PREFIX);
              break;
            }
          }
        }
      }
    }
    const list = [...found].sort((a, b) => b[1] - a[1]).slice(0, MAX_CANDIDATES);
    if (candidateCache.size > 500) candidateCache.clear();
    candidateCache.set(key, list);
    return list;
  }

  /**
   * Search. Returns `{ pages, total }`: `pages` holds at most `limit` pages
   * (each with up to `perPage` sections), `total` counts every matching page.
   */
  function search(query, { limit = 8, perPage = 4 } = {}) {
    const terms = queryTerms(query);
    if (terms.length === 0) return { pages: [], total: 0 };
    const nameQuery = normalizeName(query);
    const typedQuery = query.trim();
    const literalQuery = typedQuery.toLowerCase();
    const apiName = API_NAME.test(typedQuery);
    const headingQuery = normalizeName(typedQuery.replace(METHOD_PREFIX, ''));
    const stemQuery = stemName(query);
    const queryStems = new Set(terms.map(stem));

    // Per query word, each section's best score for it.
    const termScores = terms.map((term, t) => {
      const scores = new Float32Array(sections.length);
      for (const [token, quality] of candidates(term, t === terms.length - 1)) {
        const list = postings.get(token);
        for (let i = 0; i < list.length; i += 2) {
          const score = quality * list[i + 1];
          if (score > scores[list[i]]) scores[list[i]] = score;
        }
      }
      return scores;
    });
    // The tokens to light up in what is shown: every candidate of every word.
    const shown = [...new Set(terms.flatMap((term, t) =>
      candidates(term, t === terms.length - 1).slice(0, 12).map(([token]) => token)))]
      .sort((a, b) => b.length - a.length);

    // A number (a status code, the line of a pasted error) is a weak word:
    // next to other words, a section need not hold it to match them all.
    const required = terms.map((term) => !NUMBER.test(term) || terms.every((other) => NUMBER.test(other)));
    const requiredCount = required.filter(Boolean).length;

    const complete = [];
    const partial = [];
    for (let s = 0; s < sections.length; s++) {
      let score = 0;
      let matched = 0;
      let matchedRequired = 0;
      termScores.forEach((scores, t) => {
        if (scores[s] > 0) {
          matched++;
          if (required[t]) matchedRequired++;
          score += scores[s];
        }
      });
      if (matched === 0) continue;
      const section = sections[s];
      let bonus = 0;
      let inPage = 0;
      if (nameQuery.length > 0) {
        const [title] = pageNames[section.p];
        const named = pageNames[section.p].includes(nameQuery) || commandNames[section.p] === nameQuery;
        if (section.l === 1 && named) {
          bonus += B_EXACT_TITLE;
          if (literalTitles[section.p].includes(literalQuery)) bonus += B_LITERAL_TITLE;
        } else if (section.l === 1 && pageStemNames[section.p].includes(stemQuery)) {
          bonus += B_STEM_TITLE;
        } else if (section.l === 1 && title.startsWith(nameQuery)) bonus += B_TITLE_PREFIX;
        const concept = tableConcepts[section.p];
        if (concept && !named && queryStems.size > concept.length && concept.every((word) => queryStems.has(word))) {
          bonus += B_TABLE_CONCEPT;
        }
        const exactHeading = headingNames[s] === nameQuery || headingNames[s] === headingQuery;
        const apiHeading = exactHeading && apiReference[section.p] && pageCodeNames[section.p].has(headingNames[s]);
        // A definition outranks a mention; the two do not add up, so a
        // reference page that also quotes the name stays below its own page.
        const literalRow = (definedLiterals[s]?.has(literalQuery) || definedFlags[s]?.has(typedQuery)) ?? false;
        if (definedNames[s]?.has(nameQuery) || literalRow || apiHeading) {
          bonus += B_DEFINED;
          if (literalRow || (apiHeading && literalHeadings[s] === literalQuery)) bonus += B_LITERAL_DEFINED;
        } else {
          if (exactHeading) bonus += B_EXACT_HEADING;
          if (codeNames[s]?.has(nameQuery) && !NUMBER.test(nameQuery)) {
            bonus += codeReference[section.p] && apiName ? B_EXACT_REFERENCE_CODE : B_EXACT_CODE;
          }
        }
        // A plain-word row: above the page's mentions, below its heading for the name.
        if (bonus < B_EXACT_HEADING && rowNames[s]?.has(nameQuery)) inPage = B_ROW_IN_PAGE;
      }
      if (versionHistory[s]) {
        score *= VERSION_HISTORY_FACTOR;
        bonus *= VERSION_HISTORY_FACTOR;
        inPage = 0;
      }
      if (matchedRequired === requiredCount) {
        complete.push({ s, score: score + bonus, base: score, rank: score + bonus + inPage, complete: true });
      } else {
        const share = 0.2 * (matched / terms.length);
        const scaled = (score + bonus) * share;
        partial.push({ s, score: scaled, base: score * share, rank: scaled + inPage * share, complete: false });
      }
    }
    // Sections with every word first; the rest only when those are few.
    const pool = complete.length >= limit ? complete : complete.concat(partial);

    /** page index → its scored sections */
    const byPage = new Map();
    for (const entry of pool) {
      const p = sections[entry.s].p;
      const group = byPage.get(p);
      if (group === undefined) byPage.set(p, [entry]);
      else group.push(entry);
    }
    const ranked = [...byPage].map(([p, entries]) => {
      const history = (entry) => Number(versionHistory[entry.s]);
      entries.sort((a, b) =>
        Number(b.complete) - Number(a.complete) || history(a) - history(b) || b.score - a.score || a.s - b.s);
      // The best section decides; more matching sections nudge a page up -
      // by how well they match, not by the exact-name bonus, so an overview
      // naming an API in several sections stays below that API's own page.
      const rest = entries.slice(1, 4).reduce((sum, entry) => sum + entry.base, 0);
      const best = entries[0];
      // Then the page's own order, which only B_ROW_IN_PAGE changes.
      entries.sort((a, b) =>
        Number(b.complete) - Number(a.complete) || history(a) - history(b) || b.rank - a.rank || a.s - b.s);
      return { p, entries, complete: best.complete, score: best.score + 0.15 * rest };
    });
    ranked.sort((a, b) => Number(b.complete) - Number(a.complete) || b.score - a.score || a.p - b.p);

    return {
      total: ranked.length,
      pages: ranked.slice(0, limit).map(({ p, entries, score }) => {
        const page = pages[p];
        return {
          url: page.u,
          title: page.t,
          titleParts: highlight(page.t, shown),
          section: page.s,
          group: page.g,
          score,
          items: entries.slice(0, perPage).map((entry) => {
            const section = sections[entry.s];
            const text = section.x.length > 0 ? snippet(section.x, shown) : '';
            return {
              url: section.a ? `${page.u}#${section.a}` : page.u,
              heading: section.h,
              headingParts: section.h ? highlight(section.h, shown) : [],
              level: section.l,
              snippet: highlight(text, shown),
              score: entry.score,
            };
          }),
        };
      }),
    };
  }

  return { search, size: sections.length };
}
