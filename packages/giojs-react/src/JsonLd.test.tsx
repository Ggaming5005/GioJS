/**
 * packages/giojs-react/src/JsonLd.test.tsx
 *
 * <JsonLd> output: a non-executable ld+json data block whose JSON can never
 * close the script element, round-tripping to the same data.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { JsonLd, serializeJsonLd } from './JsonLd.tsx';

function scriptBody(html: string): string {
  const match = html.match(/^<script type="application\/ld\+json"(?: id="[^"]*")?>([\s\S]*)<\/script>$/);
  expect(match).not.toBeNull();
  return match![1]!;
}

describe('JsonLd', () => {
  it('renders a script data block with the JSON', () => {
    const data = { '@context': 'https://schema.org', '@type': 'Article', headline: 'Hello' };
    const html = renderToStaticMarkup(<JsonLd data={data} id="article-ld" />);
    expect(html).toBe(
      '<script type="application/ld+json" id="article-ld">{"@context":"https://schema.org","@type":"Article","headline":"Hello"}</script>',
    );
    expect(JSON.parse(scriptBody(html))).toEqual(data);
  });

  it('escapes everything that could end the element or start markup', () => {
    const hostile = {
      headline: '</script><script>alert(1)</script>',
      comment: '<!-- x --> & <![CDATA[',
      separators: 'a\u2028b\u2029c',
    };
    const html = renderToStaticMarkup(<JsonLd data={hostile} />);
    const body = scriptBody(html);
    expect(body).not.toMatch(/[<>&\u2028\u2029]/);
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(body).toContain('\\u003c/script\\u003e');
    // Same data for any JSON parser.
    expect(JSON.parse(body)).toEqual(hostile);
  });

  it('accepts a list of objects and renders nothing for undefined data', () => {
    expect(JSON.parse(scriptBody(renderToStaticMarkup(<JsonLd data={[{ a: 1 }, { b: 2 }]} />)))).toEqual([
      { a: 1 },
      { b: 2 },
    ]);
    expect(serializeJsonLd(undefined)).toBeUndefined();
    expect(renderToStaticMarkup(<JsonLd data={undefined as never} />)).toBe('');
  });
});
