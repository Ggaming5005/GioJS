/**
 * docs-site/lib/text.mjs
 *
 * Text extraction from rendered docs HTML, shared by everything that reads
 * pages as text: llms.txt / llms-full.txt and the per-page `.md` files
 * (build.mjs), the search index (search-index.mjs), and the "Copy page as
 * Markdown" fallback and heading ids in the browser. Plain string work with
 * no DOM and no dependencies, so it runs in Node and in the browser alike.
 * Types: text.d.mts.
 */

/** Decode the entities React and the pages emit. */
export function decodeEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, '&');
}

/**
 * The page content of a rendered docs page: the `<article class="docs-prose">`
 * the docs layout wraps every page in, else `<main>`, else `<body>`. Chrome
 * (sidebar, breadcrumbs, pager, page actions) sits outside the article.
 */
export function articleHtml(html) {
  return /<article[^>]*class="[^"]*\bdocs-prose\b[^"]*"[^>]*>([\s\S]*)<\/article>/.exec(html)?.[1]
    ?? /<main[^>]*>([\s\S]*?)<\/main>/.exec(html)?.[1]
    ?? /<body[^>]*>([\s\S]*)<\/body>/.exec(html)?.[1]
    ?? '';
}

/**
 * Markup that is not page text: scripts, styles, icons, buttons ("Copy"),
 * any element marked `data-no-index` (a code block's header, the other
 * package managers' tabs), and an eyebrow label over a title (the
 * releases page).
 */
export function stripNonText(html) {
  return html
    .replace(/<(script|style|svg|nav|button|template)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<(\w+)\b[^>]*\bdata-no-index\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<div class="docs-eyebrow"[^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

/** Tags stripped and entities decoded, whitespace kept as written. */
export function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, ''));
}

/** Inline markup as Markdown: code, links, emphasis. Still entity-encoded. */
function inlineMarkdown(html) {
  return html
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, code) => `\`${code.replace(/<[^>]+>/g, '')}\``)
    .replace(/<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
      const label = text.replace(/<[^>]+>/g, '').trim();
      return label === '' ? '' : `[${label}](${href})`;
    })
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*');
}

/** A <table> as a Markdown table (first row as the header). */
function tableMarkdown(body) {
  const rows = [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(([, row]) =>
    [...row.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map(([, cell]) =>
      inlineMarkdown(cell).replace(/<[^>]+>/g, ' ').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()));
  if (rows.length === 0) return '';
  const width = Math.max(...rows.map((row) => row.length));
  const line = (cells) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`;
  return `\n\n${[line(rows[0]), line(new Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n')}\n\n`;
}

/**
 * Markdown of an HTML fragment: headings, paragraphs, lists, tables, code
 * fences, inline code, links and emphasis. What llms-full.txt, the `.md`
 * pages and "Copy page" hold.
 */
export function htmlToText(html) {
  const fences = [];
  const markdown = stripNonText(html)
    // Code blocks are set aside so nothing below rewrites their content.
    .replace(/<pre([^>]*)>([\s\S]*?)<\/pre>/gi, (_, attrs, code) => {
      const lang = /\bdata-lang="([\w-]*)"/.exec(attrs)?.[1] ?? '';
      // A CodeBlock's file name goes on the fence: ```tsx title="app/page.tsx"
      const title = /\bdata-title="([^"]*)"/.exec(attrs)?.[1];
      const info = title === undefined ? lang : `${lang} title="${decodeEntities(title)}"`;
      fences.push({ info, code: decodeEntities(code.replace(/<[^>]+>/g, '')).replace(/\n+$/, '') });
      return `\n\n\u0000${fences.length - 1}\u0000\n\n`;
    })
    .replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_, body) => tableMarkdown(body))
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
      (_, level, text) => `\n\n${'#'.repeat(Number(level))} ${inlineMarkdown(text).replace(/<[^>]+>/g, '').trim()}\n\n`)
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/?(?:p|div|section|article|ul|ol|blockquote)\b[^>]*>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n');
  return decodeEntities(inlineMarkdown(markdown).replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n- \n+/g, '\n- ')
    .replace(/\u0000(\d+)\u0000/g, (_, i) => `\`\`\`${fences[Number(i)].info}\n${fences[Number(i)].code}\n\`\`\``)
    .trim();
}

/** Plain one-line text of an HTML fragment: what search matches and quotes. */
export function htmlToPlain(html) {
  return decodeEntities(
    stripNonText(html)
      .replace(/<(?:\/?(?:p|div|li|tr|td|th|pre|h[1-6]|ul|ol|table|br|section))\b[^>]*>/gi, ' ')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A heading's id from its text: lowercase ASCII words joined by '-'
 * ("Server & TLS" → "server-tls", "useRouter()" → "userouter"). Explicit
 * ids in the page source win; this names the headings that have none.
 */
export function slugify(text) {
  const slug = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug === '' ? 'section' : slug;
}

/**
 * `slugify(text)`, made unique against `taken` (ids already on the page,
 * then each one this hands out): "setup", "setup-2", "setup-3". Adds the
 * result to `taken`. The build and the browser call this in the same
 * heading order with the same starting set, so they agree on every id.
 */
export function uniqueSlug(text, taken) {
  const base = slugify(text);
  let slug = base;
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
  taken.add(slug);
  return slug;
}

/**
 * What is wrong with the ids of a rendered page, for the build to refuse:
 * an h2/h3 in the article without an explicit id (its `#` link and the
 * search index would depend on a slug computed in the browser), and any
 * id used twice in the document (chrome included - a heading named
 * "sidebar" would collide with the sidebar). One message per problem.
 */
export function idProblems(html) {
  const problems = [];
  for (const match of articleHtml(html).matchAll(/<h([23])\b([^>]*)>([\s\S]*?)<\/h\1>/gi)) {
    if (!/\bid="[^"]+"/.test(match[2])) {
      problems.push(`<h${match[1]}> without an id: "${stripTags(match[3]).replace(/\s+/g, ' ').trim()}"`);
    }
  }
  const seen = new Set();
  // Ids inside scripts (serialized props) are data, not elements.
  const markup = html.replace(/<script\b[\s\S]*?<\/script>/gi, '');
  for (const [, id] of markup.matchAll(/<[a-z][\w-]*\b[^>]*?\sid="([^"]*)"/gi)) {
    if (seen.has(id)) problems.push(`id="${id}" is used more than once`);
    seen.add(id);
  }
  return problems;
}
