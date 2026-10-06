/**
 * packages/giojs-react/src/JsonLd.tsx
 *
 * Structured data for search engines: `<JsonLd data={{ '@context':
 * 'https://schema.org', '@type': 'Article', ... }} />` renders a
 * `<script type="application/ld+json">`. The type makes it a data block the
 * browser never executes, so it needs no CSP nonce.
 *
 * The JSON is written as raw script text, where HTML escaping does not
 * apply: a string value holding `</script>` (a user's post title) would end
 * the element early and let the rest run as markup. `<`, `>` and `&` are
 * therefore written as JSON unicode escapes - the same data to any JSON
 * parser - and so are U+2028/U+2029, which some JavaScript tooling still
 * reads as line breaks.
 */
import React from 'react';

/** Any JSON-serializable value: one schema.org object, or a list/graph of them. */
export type JsonLdData = Record<string, unknown> | ReadonlyArray<Record<string, unknown>>;

export interface JsonLdProps {
  data: JsonLdData;
  /** Optional element id (e.g. to find it in tests). */
  id?: string;
}

/** JSON for a script data block: nothing in it can close the element. */
export function serializeJsonLd(data: unknown): string | undefined {
  return JSON.stringify(data)
    ?.replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function JsonLd({ data, id }: JsonLdProps): React.ReactElement | null {
  const json = serializeJsonLd(data);
  if (json === undefined) return null;
  return (
    <script
      type="application/ld+json"
      {...(id !== undefined ? { id } : {})}
      dangerouslySetInnerHTML={{ __html: json }}
    />
  );
}
