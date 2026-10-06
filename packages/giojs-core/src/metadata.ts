/**
 * giojs-core/src/metadata.ts
 *
 * Per-page metadata: `export const metadata` / `export async function
 * generateMetadata(ctx, { props })` on layouts and pages, resolved root
 * layout → nested layouts → page into the head tags metadata-tags.ts renders.
 *
 * Merge rule: shallow and leaf-first - a segment that sets a top-level field
 * (`openGraph`, `robots`, ...) replaces the whole value from above; `null`
 * clears it. Titles are the exception: a layout's `title.template` ('%s |
 * Site') applies to titles set BELOW it, `title.default` is the fallback for
 * descendants that set none, and `title.absolute` ignores every template.
 *
 * Relative URLs (openGraph url/images, twitter images, canonical and
 * alternate languages) resolve against the deepest `metadataBase`, else
 * GIO_SITE_URL. Never against the request's Host header: a cached page
 * printing whatever Host a client sent could be poisoned for everyone.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import type { GsspContext } from './router.ts';
import { metadataElements, type MetadataTag } from './metadata-tags.ts';

/** `{ default, template }` in a layout, or `{ absolute }` anywhere. */
export interface TitleTemplate {
  /** Fallback title for descendants that set none. */
  default?: string;
  /** Applied to titles set below this segment; `%s` is replaced by the title. */
  template?: string | null;
  /** Used as-is, ignoring every template above. */
  absolute?: string;
}

export interface MetadataAuthor {
  name?: string;
  url?: string | URL;
}

export interface OpenGraphImage {
  url: string | URL;
  width?: number | string;
  height?: number | string;
  alt?: string;
  type?: string;
}

export interface OpenGraphMetadata {
  title?: string;
  description?: string;
  url?: string | URL;
  siteName?: string;
  images?: string | URL | OpenGraphImage | Array<string | URL | OpenGraphImage>;
  /** 'website', 'article', ... */
  type?: string;
  locale?: string;
}

export interface TwitterImage {
  url: string | URL;
  alt?: string;
}

export interface TwitterMetadata {
  card?: 'summary' | 'summary_large_image' | 'app' | 'player';
  title?: string;
  description?: string;
  images?: string | URL | TwitterImage | Array<string | URL | TwitterImage>;
  /** @handle of the site. */
  site?: string;
  /** @handle of the content creator. */
  creator?: string;
}

export interface AlternatesMetadata {
  canonical?: string | URL | null;
  /** Locale (or 'x-default') → URL, rendered as `<link rel="alternate" hreflang>`. */
  languages?: Record<string, string | URL>;
}

export interface RobotsDirectives {
  index?: boolean;
  follow?: boolean;
  noarchive?: boolean;
  nosnippet?: boolean;
  noimageindex?: boolean;
  nocache?: boolean;
  'max-snippet'?: number;
  'max-image-preview'?: 'none' | 'standard' | 'large';
  'max-video-preview'?: number;
}

export interface RobotsMetadata extends RobotsDirectives {
  /** Rendered as `<meta name="googlebot">`. */
  googleBot?: string | RobotsDirectives;
}

export interface IconDescriptor {
  url: string | URL;
  type?: string;
  sizes?: string;
  media?: string;
  /** Overrides the rel the group implies (e.g. 'mask-icon'). */
  rel?: string;
  color?: string;
}

type IconList = string | URL | IconDescriptor | Array<string | URL | IconDescriptor>;

export interface IconsMetadata {
  icon?: IconList;
  apple?: IconList;
  shortcut?: IconList;
}

export interface ThemeColorDescriptor {
  color: string;
  media?: string;
}

/** What a layout or page exports as `metadata` (or returns from generateMetadata). */
export interface Metadata {
  /** Base for relative URLs; the deepest segment's wins, else GIO_SITE_URL. */
  metadataBase?: string | URL | null;
  title?: string | TitleTemplate | null;
  description?: string | null;
  keywords?: string | string[] | null;
  authors?: MetadataAuthor | MetadataAuthor[] | null;
  openGraph?: OpenGraphMetadata | null;
  twitter?: TwitterMetadata | null;
  alternates?: AlternatesMetadata | null;
  robots?: string | RobotsMetadata | null;
  icons?: IconList | IconsMetadata | null;
  /** URL of the web app manifest (`app/manifest.ts` serves /manifest.webmanifest). */
  manifest?: string | URL | null;
  themeColor?: string | ThemeColorDescriptor | ThemeColorDescriptor[] | null;
  /** Extra `<meta name={key} content={value}>` tags. */
  other?: Record<string, string | number | Array<string | number>> | null;
}

/**
 * The context generateMetadata receives: the same one getServerSideProps
 * gets, with the same tracking - reading `ctx.cookies`, `ctx.ip`,
 * `ctx.host`, `ctx.scheme` or a credential header makes the render personal.
 */
export type MetadataContext = GsspContext;

/** generateMetadata's second argument. */
export interface MetadataExtras {
  /**
   * Pages only: the props the page component renders with (what
   * getServerSideProps returned, or `{ params, searchParams }`) - reuse them
   * instead of fetching the same data twice. Undefined for layouts.
   */
  props?: Record<string, unknown>;
}

export type GenerateMetadata = (
  ctx: MetadataContext,
  extras: MetadataExtras,
) => Metadata | Promise<Metadata>;

/** The metadata-related exports of a layout or page module. */
export interface MetadataModule {
  metadata?: unknown;
  generateMetadata?: unknown;
}

/** Metadata after resolution: one value per field, titles templated. */
export interface ResolvedMetadata extends Omit<Metadata, 'title' | 'metadataBase'> {
  title?: string;
  metadataBase?: URL;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `value` when it is a plain object (not a string, array, URL or null), keeping its type. */
function objectOf<T extends object>(value: T | string | URL | null | undefined): T | undefined {
  return isRecord(value) && !(value instanceof URL) ? value : undefined;
}

/**
 * One segment's metadata: the static `metadata` export with whatever
 * generateMetadata returned merged over it (field by field). `ctx` is only
 * touched when the module exports generateMetadata.
 */
export async function segmentMetadata(
  mod: MetadataModule,
  ctx: () => MetadataContext,
  extras: MetadataExtras,
): Promise<Metadata | undefined> {
  const staticMetadata = isRecord(mod.metadata) ? (mod.metadata as Metadata) : undefined;
  if (typeof mod.generateMetadata !== 'function') return staticMetadata;
  const generated: unknown = await (mod.generateMetadata as GenerateMetadata)(ctx(), extras);
  if (!isRecord(generated)) {
    if (generated === undefined || generated === null) return staticMetadata;
    throw new Error(`generateMetadata must return an object, got ${typeof generated}`);
  }
  return { ...staticMetadata, ...(generated as Metadata) };
}

function applyTemplate(template: string | undefined, title: string): string {
  // split/join: a '$&' in the title must not act as a replacement pattern.
  return template === undefined ? title : template.split('%s').join(title);
}

function parseBase(value: string | URL | null | undefined): URL | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Merge the segments' metadata, outermost (root layout) first, page last.
 * `siteUrl` (GIO_SITE_URL) is the metadataBase when no segment sets one.
 */
export function resolveMetadata(
  segments: ReadonlyArray<Metadata | undefined>,
  siteUrl?: string,
): ResolvedMetadata {
  const merged: Record<string, unknown> = {};
  let title: string | undefined;
  let template: string | undefined;
  for (const segment of segments) {
    if (segment === undefined) continue;
    for (const [key, value] of Object.entries(segment)) {
      if (key === 'title' || value === undefined) continue;
      if (value === null) delete merged[key];
      else merged[key] = value;
    }
    const segmentTitle = segment.title;
    if (segmentTitle === undefined) continue;
    // The template in force here is the one set ABOVE this segment.
    const inherited = template;
    if (segmentTitle === null) {
      title = undefined;
    } else if (typeof segmentTitle === 'string') {
      title = applyTemplate(inherited, segmentTitle);
    } else if (isRecord(segmentTitle)) {
      if (typeof segmentTitle.absolute === 'string') {
        title = segmentTitle.absolute;
      } else if (typeof segmentTitle.default === 'string') {
        title = applyTemplate(inherited, segmentTitle.default);
      }
      if (segmentTitle.template === null) template = undefined;
      else if (typeof segmentTitle.template === 'string') template = segmentTitle.template;
    }
  }
  const resolved = merged as ResolvedMetadata;
  const base = parseBase(merged['metadataBase'] as string | URL | undefined) ?? parseBase(siteUrl);
  if (base !== undefined) resolved.metadataBase = base;
  else delete resolved.metadataBase;
  if (title !== undefined) resolved.title = title;
  return resolved;
}

/** Whether `url` carries a scheme (or is protocol-relative). */
function isAbsoluteUrl(url: string): boolean {
  return /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(url) || url.startsWith('//');
}

/**
 * Resolve a metadata URL against `base`: relative paths join the base's
 * path (a base of https://example.com/blog makes '/og.png'
 * https://example.com/blog/og.png - sites served under a sub-path keep
 * working). Absolute URLs are kept; without a base, relative ones stay
 * relative and `onRelative` is told.
 */
export function resolveMetadataUrl(
  value: string | URL,
  base: URL | undefined,
  onRelative?: (url: string) => void,
): string {
  if (value instanceof URL) return value.href;
  if (isAbsoluteUrl(value)) {
    return value.startsWith('//') && base !== undefined ? new URL(value, base).href : value;
  }
  if (base === undefined) {
    onRelative?.(value);
    return value;
  }
  const path = base.pathname.replace(/\/+$/, '') + '/' + value.replace(/^\.?\/+/, '');
  return new URL(path, base.origin).href;
}

function toList<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function robotsContent(directives: RobotsDirectives): string {
  const tokens: string[] = [];
  if (directives.index !== undefined) tokens.push(directives.index ? 'index' : 'noindex');
  if (directives.follow !== undefined) tokens.push(directives.follow ? 'follow' : 'nofollow');
  for (const flag of ['noarchive', 'nosnippet', 'noimageindex', 'nocache'] as const) {
    if (directives[flag] === true) tokens.push(flag);
  }
  for (const key of ['max-snippet', 'max-image-preview', 'max-video-preview'] as const) {
    const value = directives[key];
    if (value !== undefined) tokens.push(`${key}:${value}`);
  }
  return tokens.join(', ');
}

/** `name`/`property` meta, skipped when the value is missing or empty. */
function meta(
  tags: MetadataTag[],
  key: 'name' | 'property',
  id: string,
  content: string | number | undefined,
): void {
  if (content === undefined || content === '') return;
  tags.push({ tag: 'meta', attrs: { [key]: id, content: String(content) } });
}

function link(tags: MetadataTag[], attrs: Record<string, string | undefined>): void {
  const clean: Record<string, string> = {};
  for (const [name, value] of Object.entries(attrs)) {
    if (value !== undefined && value !== '') clean[name] = value;
  }
  tags.push({ tag: 'link', attrs: clean });
}

/**
 * The head tags for resolved metadata, in a stable order. `onRelativeUrl`
 * hears about URLs that had to stay relative (no metadataBase).
 */
export function metadataToTags(
  resolved: ResolvedMetadata,
  onRelativeUrl?: (url: string) => void,
): MetadataTag[] {
  const tags: MetadataTag[] = [];
  const base = resolved.metadataBase;
  const url = (value: string | URL): string => resolveMetadataUrl(value, base, onRelativeUrl);

  if (resolved.title !== undefined) tags.push({ tag: 'title', text: resolved.title });
  meta(tags, 'name', 'description', resolved.description ?? undefined);
  const keywords = toList(resolved.keywords);
  if (keywords.length > 0) meta(tags, 'name', 'keywords', keywords.join(', '));
  for (const author of toList(resolved.authors)) {
    meta(tags, 'name', 'author', author.name);
    if (author.url !== undefined) link(tags, { rel: 'author', href: url(author.url) });
  }

  const robots = objectOf(resolved.robots);
  if (typeof resolved.robots === 'string') {
    meta(tags, 'name', 'robots', resolved.robots);
  } else if (robots !== undefined) {
    meta(tags, 'name', 'robots', robotsContent(robots));
    const googleBot = robots.googleBot;
    meta(
      tags,
      'name',
      'googlebot',
      typeof googleBot === 'string'
        ? googleBot
        : googleBot !== undefined
          ? robotsContent(googleBot)
          : undefined,
    );
  }

  const alternates = objectOf(resolved.alternates);
  if (alternates !== undefined) {
    if (alternates.canonical !== undefined && alternates.canonical !== null) {
      link(tags, { rel: 'canonical', href: url(alternates.canonical) });
    }
    for (const [lang, href] of Object.entries(alternates.languages ?? {})) {
      link(tags, { rel: 'alternate', hrefLang: lang, href: url(href) });
    }
  }

  const og = objectOf(resolved.openGraph);
  if (og !== undefined) {
    meta(tags, 'property', 'og:title', og.title);
    meta(tags, 'property', 'og:description', og.description);
    if (og.url !== undefined) meta(tags, 'property', 'og:url', url(og.url));
    meta(tags, 'property', 'og:site_name', og.siteName);
    meta(tags, 'property', 'og:locale', og.locale);
    meta(tags, 'property', 'og:type', og.type);
    for (const image of toList(og.images)) {
      const descriptor: OpenGraphImage =
        typeof image === 'string' || image instanceof URL ? { url: image } : image;
      meta(tags, 'property', 'og:image', url(descriptor.url));
      meta(tags, 'property', 'og:image:type', descriptor.type);
      meta(tags, 'property', 'og:image:width', descriptor.width);
      meta(tags, 'property', 'og:image:height', descriptor.height);
      meta(tags, 'property', 'og:image:alt', descriptor.alt);
    }
  }

  const twitter = objectOf(resolved.twitter);
  if (twitter !== undefined) {
    meta(tags, 'name', 'twitter:card', twitter.card);
    meta(tags, 'name', 'twitter:site', twitter.site);
    meta(tags, 'name', 'twitter:creator', twitter.creator);
    meta(tags, 'name', 'twitter:title', twitter.title);
    meta(tags, 'name', 'twitter:description', twitter.description);
    for (const image of toList(twitter.images)) {
      const descriptor: TwitterImage =
        typeof image === 'string' || image instanceof URL ? { url: image } : image;
      meta(tags, 'name', 'twitter:image', url(descriptor.url));
      meta(tags, 'name', 'twitter:image:alt', descriptor.alt);
    }
  }

  const icons = resolved.icons;
  const iconGroups: Array<[string, IconList | undefined]> =
    isRecord(icons) && !('url' in icons)
      ? [
          ['icon', (icons as IconsMetadata).icon],
          ['shortcut icon', (icons as IconsMetadata).shortcut],
          ['apple-touch-icon', (icons as IconsMetadata).apple],
        ]
      : [['icon', (icons ?? undefined) as IconList | undefined]];
  for (const [rel, list] of iconGroups) {
    for (const icon of toList(list)) {
      const descriptor: IconDescriptor =
        typeof icon === 'string' || icon instanceof URL ? { url: icon } : icon;
      // Icons stay same-origin relative unless given absolute: the browser
      // resolves them against the page, which is always right.
      link(tags, {
        rel: descriptor.rel ?? rel,
        href: descriptor.url instanceof URL ? descriptor.url.href : descriptor.url,
        type: descriptor.type,
        sizes: descriptor.sizes,
        media: descriptor.media,
        color: descriptor.color,
      });
    }
  }

  if (resolved.manifest !== undefined && resolved.manifest !== null) {
    link(tags, {
      rel: 'manifest',
      href: resolved.manifest instanceof URL ? resolved.manifest.href : resolved.manifest,
    });
  }

  for (const theme of toList(resolved.themeColor)) {
    const descriptor: ThemeColorDescriptor = typeof theme === 'string' ? { color: theme } : theme;
    if (descriptor.color === '') continue;
    tags.push({
      tag: 'meta',
      attrs: {
        name: 'theme-color',
        content: descriptor.color,
        ...(descriptor.media !== undefined ? { media: descriptor.media } : {}),
      },
    });
  }

  for (const [name, value] of Object.entries(resolved.other ?? {})) {
    for (const content of toList(value)) meta(tags, 'name', name, content);
  }
  return tags;
}

/**
 * The tags as static HTML (rendered and escaped by React), for documents
 * whose <head> no React component renders - ssr.ts writes them into the
 * document prefix when the app has no root layout.
 */
export function metadataTagsHtml(tags: readonly MetadataTag[]): string {
  if (tags.length === 0) return '';
  return renderToStaticMarkup(React.createElement(React.Fragment, null, ...metadataElements(tags)));
}

// ── duplicate <title> handling ───────────────────────────────────────────────

/** Exactly what React renders for a <title> holding `text`. */
export function titleHtml(text: string): string {
  return renderToStaticMarkup(React.createElement('title', null, text));
}

const TITLE_ELEMENT_RE = /<title\b[^>]*>[\s\S]*?<\/title>/g;
const HEAD_END = '</head>';

/**
 * Keep only the metadata title (`keep`, as titleHtml rendered it) among the
 * <title> elements of a document's <head>; a root layout's hand-written
 * title goes. Browsers, crawlers and React's own hydration all take the
 * FIRST <title>, which would be the root layout's. React escapes title text,
 * so a title's content can never contain `</title>`. Returns the html and
 * how many titles were dropped; nothing changes when `keep` is not there.
 */
export function dedupeHeadTitles(html: string, keep: string): { html: string; dropped: number } {
  const headEnd = html.indexOf(HEAD_END);
  if (headEnd === -1) return { html, dropped: 0 };
  const head = html.slice(0, headEnd);
  if (!head.includes(keep)) return { html, dropped: 0 };
  let kept = false;
  let dropped = 0;
  const cleaned = head.replace(TITLE_ELEMENT_RE, element => {
    if (!kept && element === keep) {
      kept = true;
      return element;
    }
    dropped++;
    return '';
  });
  return dropped === 0 ? { html, dropped } : { html: cleaned + html.slice(headEnd), dropped };
}

/**
 * Head preambles larger than this pass through untouched: the dedupe is a
 * nicety and must never hold a huge response in memory.
 */
const MAX_HEAD_BUFFER = 256 * 1024;

/**
 * dedupeHeadTitles over a streamed render: buffers React's output until
 * `</head>` (part of the shell flush), fixes the head, then passes every
 * later chunk straight through. Pull-based with no timers, so whatever the
 * shell flush made readable stays readable within the same macrotask - the
 * PPR shell boundary (ipc.ts) is detected exactly as without it.
 */
export function dedupeHeadTitlesStream(
  source: ReadableStream<Uint8Array>,
  keep: string,
  onDropped: (count: number) => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffered = '';
  let headDone = false;
  // Everything goes through the one streaming decoder, so a multi-byte
  // character split across chunks is never cut in two.
  const emit = (controller: ReadableStreamDefaultController<Uint8Array>, text: string): void => {
    if (text !== '') controller.enqueue(encoder.encode(text));
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        const { done, value } = await reader.read();
        if (headDone) {
          if (done) {
            emit(controller, decoder.decode());
            controller.close();
          } else {
            emit(controller, decoder.decode(value, { stream: true }));
          }
          return;
        }
        if (!done) buffered += decoder.decode(value, { stream: true });
        else buffered += decoder.decode();
        if (done || buffered.includes(HEAD_END) || buffered.length > MAX_HEAD_BUFFER) {
          headDone = true;
          const result = dedupeHeadTitles(buffered, keep);
          if (result.dropped > 0) onDropped(result.dropped);
          emit(controller, result.html);
          buffered = '';
          if (done) controller.close();
          return;
        }
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
