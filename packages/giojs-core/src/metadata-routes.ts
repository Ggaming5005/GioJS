/**
 * giojs-core/src/metadata-routes.ts
 *
 * The app-root metadata conventions: app/sitemap.ts → /sitemap.xml,
 * app/robots.ts → /robots.txt, app/manifest.ts → /manifest.webmanifest.
 * Each module's default export is the data (or a function returning or
 * resolving to it); this module serializes it. The worker answers these
 * paths like route handlers (ssr.ts), and `gio export` writes the same
 * files (export.ts).
 *
 * The generators receive no request: their output is the same for every
 * visitor, so it is always safe to share - cached for `revalidate` seconds
 * (default 3600) like a page exporting `revalidate`.
 */
import type { IPCRequest, IPCResponse } from './context.ts';
import { resolveMetadataUrl } from './metadata.ts';
import { logger } from './logger.ts';
import { createErrorDigest, describeError } from './mode.ts';

export type MetadataRouteKind = 'sitemap' | 'robots' | 'manifest';

export type ChangeFrequency =
  | 'always'
  | 'hourly'
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'yearly'
  | 'never';

/** One `<url>` of app/sitemap.ts. */
export interface SitemapEntry {
  /** Absolute, or relative to GIO_SITE_URL. */
  url: string;
  lastModified?: string | Date;
  changeFrequency?: ChangeFrequency;
  /** 0.0 - 1.0 */
  priority?: number;
  /** Translations of this URL: `{ languages: { de: 'https://example.com/de' } }`. */
  alternates?: { languages?: Record<string, string> };
}

export type Sitemap = SitemapEntry[];

export interface RobotsRule {
  userAgent?: string | string[];
  allow?: string | string[];
  disallow?: string | string[];
  crawlDelay?: number;
}

/** What app/robots.ts returns. */
export interface Robots {
  rules: RobotsRule | RobotsRule[];
  /** Absolute, or relative to GIO_SITE_URL. */
  sitemap?: string | string[];
  host?: string;
}

/** What app/manifest.ts returns: a Web App Manifest, serialized as-is. */
export type Manifest = Record<string, unknown>;

/** The convention types under one name: `MetadataRoute.Sitemap`, `MetadataRoute.Robots`, ... */
export declare namespace MetadataRoute {
  export type Sitemap = SitemapEntry[];
  export type Robots = import('./metadata-routes.ts').Robots;
  export type Manifest = Record<string, unknown>;
}

export interface MetadataRouteModule {
  default?: unknown;
  /** Seconds to cache the output; false caches until the next deploy, 0 not at all. */
  revalidate?: number | false;
}

/** A discovered app/sitemap.*, app/robots.* or app/manifest.*. */
export interface MetadataRouteEntry {
  kind: MetadataRouteKind;
  /** Absolute filesystem path, for logs. */
  filePath: string;
  load: () => Promise<MetadataRouteModule>;
}

export type MetadataRoutes = Partial<Record<MetadataRouteKind, MetadataRouteEntry>>;

/** URL path and response content type of each convention. */
export const METADATA_ROUTE_PATHS: Readonly<Record<MetadataRouteKind, string>> = {
  sitemap: '/sitemap.xml',
  robots: '/robots.txt',
  manifest: '/manifest.webmanifest',
};

const CONTENT_TYPES: Readonly<Record<MetadataRouteKind, string>> = {
  sitemap: 'application/xml; charset=utf-8',
  robots: 'text/plain; charset=utf-8',
  manifest: 'application/manifest+json; charset=utf-8',
};

/**
 * Crawlers fetch these files a few times a day at most, and generating a
 * sitemap typically queries every post in a database - an hour keeps
 * crawler bursts off the worker while new content still shows up the same
 * day. A module that needs fresher output exports its own `revalidate`.
 */
export const DEFAULT_METADATA_REVALIDATE = 3600;

/** The convention whose URL is `path`, if any. */
export function metadataRouteKindForPath(path: string): MetadataRouteKind | null {
  for (const [kind, url] of Object.entries(METADATA_ROUTE_PATHS) as Array<
    [MetadataRouteKind, string]
  >) {
    if (url === path) return kind;
  }
  return null;
}

/** The module's data: its default export, called (and awaited) when it is a function. */
export async function metadataRouteData(mod: MetadataRouteModule): Promise<unknown> {
  const exported = mod.default;
  return typeof exported === 'function' ? await (exported as () => unknown)() : exported;
}

const CHANGE_FREQUENCIES: ReadonlySet<string> = new Set([
  'always',
  'hourly',
  'daily',
  'weekly',
  'monthly',
  'yearly',
  'never',
]);

/**
 * Characters XML 1.0 forbids outright (most C0 controls, lone surrogates,
 * U+FFFE/U+FFFF): dropped, so a stray control character in a database
 * title can never make the whole sitemap unparseable.
 */
// eslint-disable-next-line no-control-regex
const XML_INVALID_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Escape text for an XML element or a double- or single-quoted attribute. */
export function escapeXml(value: string): string {
  return value
    .replace(XML_INVALID_CHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function siteBase(siteUrl: string | undefined): URL | undefined {
  if (siteUrl === undefined || siteUrl === '') return undefined;
  try {
    return new URL(siteUrl);
  } catch {
    return undefined;
  }
}

function lastModifiedText(value: string | Date): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError('sitemap lastModified is an invalid Date');
    return value.toISOString();
  }
  return value;
}

/**
 * Serialize app/sitemap.ts output as a sitemaps.org urlset (with
 * xhtml:link alternates). Throws on an entry that is not a valid sitemap
 * entry, naming it - a 500 with that message in the log beats a sitemap
 * search engines silently reject.
 */
export function serializeSitemap(
  data: unknown,
  siteUrl: string | undefined,
  warnRelative: (url: string) => void = () => {},
): string {
  if (!Array.isArray(data)) {
    throw new TypeError(`app/sitemap must return an array of { url, ... } entries, got ${typeof data}`);
  }
  const base = siteBase(siteUrl);
  const entries = data as unknown[];
  const hasAlternates = entries.some(
    e => typeof e === 'object' && e !== null && (e as SitemapEntry).alternates?.languages !== undefined,
  );
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${
      hasAlternates ? ' xmlns:xhtml="http://www.w3.org/1999/xhtml"' : ''
    }>`,
  ];
  entries.forEach((raw, index) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new TypeError(`sitemap entry ${index} is not an object`);
    }
    const entry = raw as SitemapEntry;
    if (typeof entry.url !== 'string' || entry.url === '') {
      throw new TypeError(`sitemap entry ${index} has no url`);
    }
    lines.push('<url>');
    lines.push(`<loc>${escapeXml(resolveMetadataUrl(entry.url, base, warnRelative))}</loc>`);
    for (const [lang, href] of Object.entries(entry.alternates?.languages ?? {})) {
      lines.push(
        `<xhtml:link rel="alternate" hreflang="${escapeXml(lang)}" href="${escapeXml(
          resolveMetadataUrl(href, base, warnRelative),
        )}"/>`,
      );
    }
    if (entry.lastModified !== undefined) {
      lines.push(`<lastmod>${escapeXml(lastModifiedText(entry.lastModified))}</lastmod>`);
    }
    if (entry.changeFrequency !== undefined) {
      if (!CHANGE_FREQUENCIES.has(entry.changeFrequency)) {
        throw new TypeError(
          `sitemap entry ${index} has an invalid changeFrequency "${String(entry.changeFrequency)}"`,
        );
      }
      lines.push(`<changefreq>${entry.changeFrequency}</changefreq>`);
    }
    if (entry.priority !== undefined) {
      const priority = entry.priority;
      if (typeof priority !== 'number' || !(priority >= 0 && priority <= 1)) {
        throw new TypeError(`sitemap entry ${index} priority must be a number from 0 to 1`);
      }
      lines.push(`<priority>${priority}</priority>`);
    }
    lines.push('</url>');
  });
  lines.push('</urlset>');
  return lines.join('\n') + '\n';
}

/**
 * One robots.txt value. Each directive is one line, so a value holding a
 * line break could smuggle in directives of its own (`/x\nDisallow: /`):
 * refused instead of written.
 */
function robotsValue(field: string, value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new TypeError(`robots ${field} must be a string`);
  }
  const text = String(value);
  if (/[\r\n]/.test(text)) {
    throw new TypeError(`robots ${field} must be a single line: ${JSON.stringify(text)}`);
  }
  return text;
}

function toList<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** Serialize app/robots.ts output as robots.txt. */
export function serializeRobots(
  data: unknown,
  siteUrl: string | undefined,
  warnRelative: (url: string) => void = () => {},
): string {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new TypeError(`app/robots must return { rules, sitemap?, host? }, got ${typeof data}`);
  }
  const robots = data as Robots;
  const base = siteBase(siteUrl);
  const blocks: string[] = [];
  for (const rule of toList(robots.rules)) {
    const lines: string[] = [];
    const agents = toList(rule.userAgent);
    for (const agent of agents.length > 0 ? agents : ['*']) {
      lines.push(`User-Agent: ${robotsValue('userAgent', agent)}`);
    }
    for (const allow of toList(rule.allow)) lines.push(`Allow: ${robotsValue('allow', allow)}`);
    for (const disallow of toList(rule.disallow)) {
      lines.push(`Disallow: ${robotsValue('disallow', disallow)}`);
    }
    if (rule.crawlDelay !== undefined) {
      if (typeof rule.crawlDelay !== 'number' || !(rule.crawlDelay >= 0)) {
        throw new TypeError('robots crawlDelay must be a non-negative number');
      }
      lines.push(`Crawl-delay: ${rule.crawlDelay}`);
    }
    blocks.push(lines.join('\n'));
  }
  const trailer: string[] = [];
  if (robots.host !== undefined) trailer.push(`Host: ${robotsValue('host', robots.host)}`);
  for (const sitemap of toList(robots.sitemap)) {
    const url = robotsValue('sitemap', sitemap);
    trailer.push(`Sitemap: ${resolveMetadataUrl(url, base, warnRelative)}`);
  }
  if (trailer.length > 0) blocks.push(trailer.join('\n'));
  return blocks.join('\n\n') + '\n';
}

/** Serialize app/manifest.ts output (a plain object) as JSON. */
export function serializeManifest(data: unknown): string {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new TypeError(`app/manifest must return an object, got ${typeof data}`);
  }
  return JSON.stringify(data, null, 2);
}

/** Relative URLs already warned about (once per URL per process). */
const warnedRelative = new Set<string>();

function warnRelativeUrl(kind: MetadataRouteKind): (url: string) => void {
  return url => {
    if (warnedRelative.has(url)) return;
    warnedRelative.add(url);
    logger.warn(
      `app/${kind} returned a relative URL but GIO_SITE_URL is not set - crawlers need absolute URLs`,
      { url },
    );
  };
}

/** Generate a convention file's body (also used by `gio export`). */
export async function generateMetadataRoute(
  entry: MetadataRouteEntry,
  siteUrl: string | undefined = process.env.GIO_SITE_URL,
): Promise<{ body: string; contentType: string; revalidate: number | false | undefined }> {
  const mod = await entry.load();
  const data = await metadataRouteData(mod);
  const body =
    entry.kind === 'sitemap'
      ? serializeSitemap(data, siteUrl, warnRelativeUrl('sitemap'))
      : entry.kind === 'robots'
        ? serializeRobots(data, siteUrl, warnRelativeUrl('robots'))
        : serializeManifest(data);
  return { body, contentType: CONTENT_TYPES[entry.kind], revalidate: mod.revalidate };
}

/** revalidate → cacheMaxAge, with the same `false` = one year rule as pages. */
export function metadataRouteMaxAge(revalidate: unknown): number {
  if (revalidate === undefined) return DEFAULT_METADATA_REVALIDATE;
  if (revalidate === false) return 31536000;
  if (typeof revalidate === 'number' && Number.isFinite(revalidate) && revalidate > 0) {
    return Math.floor(revalidate);
  }
  return 0;
}

/**
 * Answer a request for a convention file (GET/HEAD only). A generator that
 * throws answers a never-cached 500; the details go to the log under the
 * digest, like a failing route handler.
 */
export async function renderMetadataRoute(
  req: IPCRequest,
  entry: MetadataRouteEntry,
): Promise<IPCResponse> {
  const base = { id: req.id, cacheable: false, cacheMaxAge: 0 };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return {
      ...base,
      status: 405,
      headers: { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' },
      body: 'Method Not Allowed',
    };
  }
  try {
    const { body, contentType, revalidate } = await generateMetadataRoute(entry);
    const maxAge = metadataRouteMaxAge(revalidate);
    return {
      id: req.id,
      status: 200,
      headers: { 'content-type': contentType },
      body,
      cacheable: maxAge > 0,
      cacheMaxAge: maxAge,
    };
  } catch (err) {
    const digest = createErrorDigest();
    logger.error('metadata route failed', {
      path: req.path,
      file: entry.filePath,
      digest,
      ...describeError(err),
    });
    return {
      ...base,
      status: 500,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: `Internal Server Error (ref ${digest})`,
    };
  }
}
