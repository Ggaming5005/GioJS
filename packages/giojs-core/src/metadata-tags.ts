/**
 * giojs-core/src/metadata-tags.ts
 *
 * Renders resolved page metadata (metadata.ts) as React elements. The tags
 * are plain serializable descriptors so they can travel in the hydration
 * envelope: the server renders them inside the #__gio tree, React 19 hoists
 * the <title>/<meta>/<link> elements into <head>, and the client runtime
 * renders the same descriptors at the same tree position - hydration adopts
 * the server's head elements, and when a later navigation renders another
 * page's tags React removes the old ones and inserts the new ones.
 *
 * Browser-safe: imports only React.
 */
import React from 'react';

/** One head element. `attrs` are React prop names (`hrefLang`, not `hreflang`). */
export type MetadataTag =
  | { tag: 'title'; text: string }
  | { tag: 'meta'; attrs: Record<string, string> }
  | { tag: 'link'; attrs: Record<string, string> };

/**
 * The only attributes a descriptor may set. The envelope is server output,
 * but it is still JSON read back from the page: nothing in it may become
 * an event handler, dangerouslySetInnerHTML or any other live prop.
 */
const ALLOWED_ATTRS: ReadonlySet<string> = new Set([
  'name',
  'property',
  'content',
  'media',
  'rel',
  'href',
  'hrefLang',
  'sizes',
  'type',
  'color',
  'title',
]);

function safeAttrs(attrs: unknown): Record<string, string> | null {
  if (typeof attrs !== 'object' || attrs === null || Array.isArray(attrs)) return null;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(attrs as Record<string, unknown>)) {
    if (ALLOWED_ATTRS.has(name) && typeof value === 'string') out[name] = value;
  }
  return out;
}

/**
 * Keep only well-formed descriptors (the client reads them from JSON).
 * Returns [] for anything that is not an array.
 */
export function sanitizeMetadataTags(value: unknown): MetadataTag[] {
  if (!Array.isArray(value)) return [];
  const tags: MetadataTag[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (record['tag'] === 'title' && typeof record['text'] === 'string') {
      tags.push({ tag: 'title', text: record['text'] });
    } else if (record['tag'] === 'meta' || record['tag'] === 'link') {
      const attrs = safeAttrs(record['attrs']);
      if (attrs !== null) tags.push({ tag: record['tag'], attrs });
    }
  }
  return tags;
}

/** A key that stays put when the same tag carries a new value on another page. */
function tagKey(tag: MetadataTag, index: number): string {
  if (tag.tag === 'title') return 'title';
  const a = tag.attrs;
  const identity = a['name'] ?? a['property'] ?? a['rel'] ?? '';
  return `${tag.tag}:${identity}:${a['hrefLang'] ?? a['media'] ?? a['sizes'] ?? ''}:${index}`;
}

/** The descriptors as React elements; every value is escaped by React. */
export function metadataElements(tags: readonly MetadataTag[]): React.ReactNode[] {
  return tags.map((tag, index) =>
    tag.tag === 'title'
      ? React.createElement('title', { key: tagKey(tag, index) }, tag.text)
      : React.createElement(tag.tag, { key: tagKey(tag, index), ...tag.attrs }),
  );
}

interface MetadataTagsProps {
  tags: readonly MetadataTag[];
  /**
   * False renders nothing at this position. The server uses it when there
   * is no root layout: no <head> exists in the React tree to hoist into, so
   * ssr.ts writes the tags into the document prefix instead - while the
   * element stays in the tree, keeping its shape (and useId) identical to
   * the client's.
   */
  render?: boolean;
}

function MetadataTags({ tags, render = true }: MetadataTagsProps): React.ReactNode {
  if (!render || tags.length === 0) return null;
  return React.createElement(React.Fragment, null, ...metadataElements(tags));
}

/**
 * The tree inside #__gio with the page's metadata tags in front of it.
 * Server (ssr.ts) and client (client-runtime.ts) both wrap with this, so the
 * two trees have the same shape. The shape is the same with no tags too:
 * the client runtime renders every soft navigation into one persistent root
 * (client-runtime.ts), and a wrapper that came and went with a page's tags
 * would remount the whole route tree - shared layouts and their state
 * included - between a page with metadata and one without.
 */
export function withMetadata(
  inner: React.ReactNode,
  tags: readonly MetadataTag[] | undefined,
  options: { render?: boolean } = {},
): React.ReactNode {
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(MetadataTags, {
      tags: tags ?? [],
      ...(options.render === false ? { render: false } : {}),
    }),
    inner,
  );
}
