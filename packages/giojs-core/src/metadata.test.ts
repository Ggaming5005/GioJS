/**
 * giojs-core/src/metadata.test.ts
 *
 * Metadata resolution: the leaf-wins shallow merge, title templates,
 * metadataBase URL resolution, the tags each field renders, and the
 * duplicate-<title> cleanup for root layouts that still hand-write one.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  dedupeHeadTitles,
  dedupeHeadTitlesStream,
  metadataTagsHtml,
  metadataToTags,
  resolveMetadata,
  resolveMetadataUrl,
  segmentMetadata,
  titleHtml,
  type Metadata,
} from './metadata.ts';
import { sanitizeMetadataTags, type MetadataTag } from './metadata-tags.ts';
import type { GsspContext } from './router.ts';

function tagsFor(segments: Array<Metadata | undefined>, siteUrl?: string): MetadataTag[] {
  return metadataToTags(resolveMetadata(segments, siteUrl));
}

/** Compact `key=value` view of the tags. */
function summary(tags: MetadataTag[]): string[] {
  return tags.map(tag => {
    if (tag.tag === 'title') return `title=${tag.text}`;
    const a = tag.attrs;
    const key = a['name'] ?? a['property'] ?? a['rel'];
    const extra = a['hrefLang'] ?? a['media'] ?? a['sizes'];
    return `${key}${extra !== undefined ? `[${extra}]` : ''}=${a['content'] ?? a['href']}`;
  });
}

describe('title resolution', () => {
  const root: Metadata = { title: { default: 'Acme', template: '%s | Acme' } };

  it('uses the layout default when no descendant sets a title', () => {
    expect(resolveMetadata([root, undefined]).title).toBe('Acme');
  });

  it("applies the nearest ancestor's template to a descendant's title", () => {
    expect(resolveMetadata([root, { title: 'Pricing' }]).title).toBe('Pricing | Acme');
  });

  it("never applies a segment's own template to its own title", () => {
    expect(
      resolveMetadata([{ title: { default: 'Docs', template: '%s - Docs' } }]).title,
    ).toBe('Docs');
  });

  it('nested templates: the deepest template above the page wins', () => {
    const docs: Metadata = { title: { default: 'Docs', template: '%s - Docs' } };
    expect(resolveMetadata([root, docs, undefined]).title).toBe('Docs | Acme');
    expect(resolveMetadata([root, docs, { title: 'Install' }]).title).toBe('Install - Docs');
  });

  it('absolute ignores every template', () => {
    expect(resolveMetadata([root, { title: { absolute: 'Just This' } }]).title).toBe('Just This');
  });

  it('null clears an inherited title; template: null stops templating', () => {
    expect(resolveMetadata([root, { title: null }]).title).toBeUndefined();
    const plain: Metadata = { title: { template: null } };
    expect(resolveMetadata([root, plain, { title: 'Raw' }]).title).toBe('Raw');
  });

  it('replaces every %s and treats $ in titles literally', () => {
    const tpl: Metadata = { title: { template: '%s · %s' } };
    expect(resolveMetadata([tpl, { title: "$& costs $1" }]).title).toBe('$& costs $1 · $& costs $1');
  });
});

describe('merge rule', () => {
  it('leaf wins per top-level field and nested objects are replaced, not merged', () => {
    const resolved = resolveMetadata([
      { description: 'root', openGraph: { siteName: 'Acme', type: 'website' } },
      { openGraph: { title: 'Post' } },
    ]);
    expect(resolved.description).toBe('root');
    expect(resolved.openGraph).toEqual({ title: 'Post' });
  });

  it('null removes an inherited field; undefined inherits it', () => {
    const resolved = resolveMetadata([
      { description: 'root', keywords: ['a'] },
      { description: null, keywords: undefined } as unknown as Metadata,
    ]);
    expect(resolved.description).toBeUndefined();
    expect(resolved.keywords).toEqual(['a']);
  });
});

describe('metadataBase', () => {
  it('resolves relative URLs against the deepest metadataBase', () => {
    const tags = tagsFor([
      { metadataBase: 'https://root.example' },
      { metadataBase: 'https://docs.example', alternates: { canonical: '/guide' } },
    ]);
    expect(summary(tags)).toEqual(['canonical=https://docs.example/guide']);
  });

  it('falls back to GIO_SITE_URL, and a layout base beats it', () => {
    const page: Metadata = { openGraph: { url: '/p', images: ['/og.png'] } };
    expect(summary(tagsFor([page], 'https://site.example'))).toEqual([
      'og:url=https://site.example/p',
      'og:image=https://site.example/og.png',
    ]);
    expect(summary(tagsFor([{ metadataBase: 'https://base.example' }, page], 'https://site.example'))[0]).toBe(
      'og:url=https://base.example/p',
    );
  });

  it('joins the base path, keeps absolute URLs, and reports relative ones without a base', () => {
    const base = new URL('https://example.com/blog/');
    expect(resolveMetadataUrl('/og.png', base)).toBe('https://example.com/blog/og.png');
    expect(resolveMetadataUrl('og.png?v=2', base)).toBe('https://example.com/blog/og.png?v=2');
    expect(resolveMetadataUrl('https://cdn.example/x.png', base)).toBe('https://cdn.example/x.png');
    expect(resolveMetadataUrl('//cdn.example/x.png', base)).toBe('https://cdn.example/x.png');
    expect(resolveMetadataUrl(new URL('https://u.example/a'), base)).toBe('https://u.example/a');
    const onRelative = vi.fn();
    expect(resolveMetadataUrl('/og.png', undefined, onRelative)).toBe('/og.png');
    expect(onRelative).toHaveBeenCalledWith('/og.png');
  });

  it('ignores a metadataBase that is not an http(s) URL', () => {
    expect(resolveMetadata([{ metadataBase: 'javascript:alert(1)' }]).metadataBase).toBeUndefined();
    expect(resolveMetadata([{ metadataBase: 'not a url' }], 'https://ok.example').metadataBase?.href).toBe(
      'https://ok.example/',
    );
  });
});

describe('tags', () => {
  it('renders every field in a stable order', () => {
    const tags = tagsFor(
      [
        {
          title: 'Home',
          description: 'Welcome',
          keywords: ['react', 'rust'],
          authors: [{ name: 'Gio', url: '/about' }],
          robots: { index: false, follow: true, 'max-snippet': -1, googleBot: { index: true, nocache: true } },
          alternates: { canonical: '/', languages: { 'en-US': '/en', de: 'https://example.de/' } },
          openGraph: {
            title: 'OG',
            description: 'OG desc',
            url: '/',
            siteName: 'Acme',
            locale: 'en_US',
            type: 'website',
            images: [{ url: '/og.png', width: 1200, height: 630, alt: 'Acme' }],
          },
          twitter: { card: 'summary_large_image', site: '@acme', creator: '@gio', images: { url: '/tw.png', alt: 'T' } },
          icons: { icon: [{ url: '/icon.png', sizes: '32x32', type: 'image/png' }], apple: '/apple.png' },
          manifest: '/manifest.webmanifest',
          themeColor: [{ color: '#fff', media: '(prefers-color-scheme: light)' }, { color: '#000', media: '(prefers-color-scheme: dark)' }],
          other: { 'google-site-verification': 'abc', rating: ['general', 'safe'] },
        },
      ],
      'https://example.com',
    );
    expect(summary(tags)).toEqual([
      'title=Home',
      'description=Welcome',
      'keywords=react, rust',
      'author=Gio',
      'author=https://example.com/about',
      'robots=noindex, follow, max-snippet:-1',
      'googlebot=index, nocache',
      'canonical=https://example.com/',
      'alternate[en-US]=https://example.com/en',
      'alternate[de]=https://example.de/',
      'og:title=OG',
      'og:description=OG desc',
      'og:url=https://example.com/',
      'og:site_name=Acme',
      'og:locale=en_US',
      'og:type=website',
      'og:image=https://example.com/og.png',
      'og:image:width=1200',
      'og:image:height=630',
      'og:image:alt=Acme',
      'twitter:card=summary_large_image',
      'twitter:site=@acme',
      'twitter:creator=@gio',
      'twitter:image=https://example.com/tw.png',
      'twitter:image:alt=T',
      'icon[32x32]=/icon.png',
      'apple-touch-icon=/apple.png',
      'manifest=/manifest.webmanifest',
      'theme-color[(prefers-color-scheme: light)]=#fff',
      'theme-color[(prefers-color-scheme: dark)]=#000',
      'google-site-verification=abc',
      'rating=general',
      'rating=safe',
    ]);
    // og tags use property=, twitter tags name=.
    expect(tags.find(t => t.tag === 'meta' && t.attrs['property'] === 'og:title')).toBeDefined();
    expect(tags.find(t => t.tag === 'meta' && t.attrs['name'] === 'twitter:card')).toBeDefined();
  });

  it('accepts robots and icons shorthands', () => {
    expect(summary(tagsFor([{ robots: 'noindex, nofollow', icons: '/favicon.ico', themeColor: '#123' }]))).toEqual([
      'robots=noindex, nofollow',
      'icon=/favicon.ico',
      'theme-color=#123',
    ]);
  });

  it('escapes every value through React', () => {
    const html = metadataTagsHtml(
      tagsFor([{ title: '</title><script>alert(1)</script>', description: '"><img src=x onerror=alert(1)>' }]),
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;/title&gt;&lt;script&gt;');
    expect(html).toContain('content="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"');
  });

  it('client-side sanitizing drops unknown attributes and malformed entries', () => {
    expect(
      sanitizeMetadataTags([
        { tag: 'meta', attrs: { name: 'x', content: 'y', onLoad: 'alert(1)', dangerouslySetInnerHTML: { __html: 'z' } } },
        { tag: 'script', attrs: { src: '/x.js' } },
        { tag: 'title', text: 5 },
        'junk',
        { tag: 'title', text: 'ok' },
      ]),
    ).toEqual([
      { tag: 'meta', attrs: { name: 'x', content: 'y' } },
      { tag: 'title', text: 'ok' },
    ]);
    expect(sanitizeMetadataTags({ tag: 'title' })).toEqual([]);
  });
});

describe('segmentMetadata', () => {
  const ctx = {} as GsspContext;

  it('merges generateMetadata over the static export and passes ctx and props', async () => {
    const generateMetadata = vi.fn(async () => ({ title: 'Generated' }));
    const result = await segmentMetadata(
      { metadata: { title: 'Static', description: 'kept' }, generateMetadata },
      () => ctx,
      { props: { id: 1 } },
    );
    expect(result).toEqual({ title: 'Generated', description: 'kept' });
    expect(generateMetadata).toHaveBeenCalledWith(ctx, { props: { id: 1 } });
  });

  it('never creates the context for a static export', async () => {
    const makeCtx = vi.fn(() => ctx);
    expect(await segmentMetadata({ metadata: { title: 'S' } }, makeCtx, {})).toEqual({ title: 'S' });
    expect(makeCtx).not.toHaveBeenCalled();
    expect(await segmentMetadata({ metadata: 'nope' }, makeCtx, {})).toBeUndefined();
  });

  it('rejects a generateMetadata that returns a non-object', async () => {
    await expect(
      segmentMetadata({ generateMetadata: () => 'title' }, () => ctx, {}),
    ).rejects.toThrow(/must return an object/);
  });
});

describe('duplicate <title> cleanup', () => {
  const keep = titleHtml('Page | Site');

  it('renders titles exactly as React does', () => {
    expect(titleHtml(`Tom & "Jerry" <it's>`)).toBe('<title>Tom &amp; &quot;Jerry&quot; &lt;it&#x27;s&gt;</title>');
  });

  it('keeps only the metadata title in the head', () => {
    const html = `<!DOCTYPE html><html><head><meta charSet="utf-8"/><title>Hand</title>${keep}</head><body><svg><title>icon</title></svg></body></html>`;
    const result = dedupeHeadTitles(html, keep);
    expect(result.dropped).toBe(1);
    expect(result.html).toBe(
      `<!DOCTYPE html><html><head><meta charSet="utf-8"/>${keep}</head><body><svg><title>icon</title></svg></body></html>`,
    );
  });

  it('changes nothing without a head or without the metadata title', () => {
    expect(dedupeHeadTitles('<p>x</p>', keep)).toEqual({ html: '<p>x</p>', dropped: 0 });
    const other = '<html><head><title>A</title><title>B</title></head></html>';
    expect(dedupeHeadTitles(other, keep)).toEqual({ html: other, dropped: 0 });
  });

  it('streams: the head may span chunks, multi-byte text survives, later chunks pass through', async () => {
    const encoder = new TextEncoder();
    const doc = `<html><head><title>Hand</title>${keep}</head><body>héllo 🌍 wörld</body></html>`;
    const bytes = encoder.encode(doc);
    // Cut every 7 bytes: splits the head and multi-byte characters.
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
        controller.close();
      },
    });
    const onDropped = vi.fn();
    const out = await new Response(dedupeHeadTitlesStream(source, keep, onDropped)).text();
    expect(out).toBe(doc.replace('<title>Hand</title>', ''));
    expect(onDropped).toHaveBeenCalledWith(1);
  });

  it('streams: cancelling the wrapper cancels the render', async () => {
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({ pull() {}, cancel });
    await dedupeHeadTitlesStream(source, keep, () => {}).cancel('gone');
    expect(cancel).toHaveBeenCalledWith('gone');
  });
});
